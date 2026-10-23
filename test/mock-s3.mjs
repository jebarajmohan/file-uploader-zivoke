// Minimal in-memory S3 multipart mock with CORS, for local end-to-end testing only.
// It does not verify signatures. Usage: node test/mock-s3.mjs <port> <outDir>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const port = Number(process.argv[2] || 9000);
const outDir = process.argv[3] || './mock-s3-data';
fs.mkdirSync(outDir, { recursive: true });
const uploads = new Map(); // uploadId -> { key, parts: Map<n, {etag, file, size}> }

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'PUT, GET, POST, DELETE',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': 'ETag',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
  const send = (status, body = '', headers = {}) => {
    res.writeHead(status, { ...cors, 'content-type': 'application/xml', ...headers });
    res.end(body);
  };
  if (req.method === 'OPTIONS') return send(200);

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method === 'POST' && q.has('uploads')) {
      const id = crypto.randomUUID();
      uploads.set(id, { key, parts: new Map() });
      return send(200, `<InitiateMultipartUploadResult><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    const up = uploads.get(q.get('uploadId'));
    if (!up) return send(404, '<Error><Code>NoSuchUpload</Code><Message>no upload</Message></Error>');
    if (req.method === 'PUT') {
      const n = Number(q.get('partNumber'));
      const etag = '"' + crypto.createHash('md5').update(body).digest('hex') + '"';
      const file = path.join(outDir, `${q.get('uploadId')}.${n}`);
      fs.writeFileSync(file, body);
      up.parts.set(n, { etag, file, size: body.length });
      return send(200, '', { etag });
    }
    if (req.method === 'GET') {
      const parts = [...up.parts].sort((a, b) => a[0] - b[0])
        .map(([n, p]) => `<Part><PartNumber>${n}</PartNumber><ETag>${p.etag.replace(/"/g, '&quot;')}</ETag><Size>${p.size}</Size></Part>`).join('');
      return send(200, `<ListPartsResult><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`);
    }
    if (req.method === 'DELETE') { uploads.delete(q.get('uploadId')); return send(204); }
    if (req.method === 'POST') {
      const listed = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>(.*?)<\/ETag>/g)];
      const finalPath = path.join(outDir, 'complete-' + path.basename(up.key));
      fs.writeFileSync(finalPath, '');
      for (const [, n, etag] of listed) {
        const p = up.parts.get(Number(n));
        if (!p || p.etag !== etag.replace(/&quot;/g, '"')) return send(200, '<Error><Code>InvalidPart</Code><Message>bad part</Message></Error>');
        fs.appendFileSync(finalPath, fs.readFileSync(p.file));
        fs.unlinkSync(p.file);
      }
      uploads.delete(q.get('uploadId'));
      return send(200, `<CompleteMultipartUploadResult><Location>${finalPath}</Location><Key>${up.key}</Key></CompleteMultipartUploadResult>`);
    }
    send(400, '<Error><Code>Bad</Code></Error>');
  });
}).listen(port, () => console.log('mock S3 on', port));
