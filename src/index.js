import { AwsClient } from 'aws4fetch';
import PAGE_HTML from './page.html';

const MIB = 1024 * 1024;
const MIN_PART_SIZE = 64 * MIB;
const MAX_PARTS = 10000;
// S3's hard limit for a single object.
const MAX_OBJECT_SIZE = 5 * 1024 * 1024 * MIB;
// How long a presigned part URL stays valid.
const PART_URL_TTL_SECONDS = 3600;
const MAX_URLS_PER_REQUEST = 100;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return new Response(PAGE_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-frame-options': 'DENY',
        },
      });
    }

    if (!url.pathname.startsWith('/api/')) {
      return json({ error: 'Not found' }, 404);
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    const configError = checkConfig(env);
    if (configError) {
      console.error(configError);
      return json({ error: 'Upload service is not configured. ' + configError }, 500);
    }

    if (!(await passphraseMatches(request.headers.get('x-upload-passphrase'), env.UPLOAD_PASSPHRASE))) {
      return json({ error: 'Wrong upload passphrase.' }, 401);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Request body must be JSON.' }, 400);
    }

    const s3 = new S3(env);
    try {
      switch (url.pathname) {
        case '/api/check':
          return json({ ok: true });
        case '/api/create':
          return json(await createUpload(s3, env, body));
        case '/api/sign-parts':
          return json(await signParts(s3, body));
        case '/api/list-parts':
          return json(await listParts(s3, body));
        case '/api/complete':
          return json(await completeUpload(s3, body));
        case '/api/abort':
          return json(await abortUpload(s3, body));
        default:
          return json({ error: 'Not found' }, 404);
      }
    } catch (err) {
      if (err instanceof HttpError) {
        if (err.status >= 500) console.error(url.pathname, err.message);
        return json({ error: err.message }, err.status);
      }
      console.error(url.pathname, err && err.stack ? err.stack : String(err));
      return json({ error: 'Upload service error: ' + (err && err.message ? err.message : String(err)) }, 500);
    }
  },
};

function checkConfig(env) {
  const missing = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'S3_BUCKET', 'UPLOAD_PASSPHRASE']
    .filter((name) => !env[name]);
  return missing.length ? 'Missing settings: ' + missing.join(', ') : null;
}

async function createUpload(s3, env, body) {
  const size = Number(body.size);
  if (!Number.isSafeInteger(size) || size <= 0) throw new HttpError(400, 'File size is missing or invalid.');
  if (size > MAX_OBJECT_SIZE) throw new HttpError(400, 'File is larger than 5 TiB, the S3 maximum.');

  const name = sanitizeFileName(String(body.name || 'file'));
  const prefix = (env.S3_PREFIX || '').replace(/^\/+/, '');
  const date = new Date().toISOString().slice(0, 10);
  const key = `${prefix}${date}/${crypto.randomUUID().slice(0, 8)}-${name}`;
  const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(body.type || '') ? body.type : 'application/octet-stream';

  const xml = await s3.request('POST', key, { uploads: '' }, { 'content-type': contentType });
  const uploadId = xmlValue(xml, 'UploadId');
  if (!uploadId) throw new Error('S3 did not return an UploadId.');

  const partSize = choosePartSize(size);
  console.log(`Started upload ${key} (${size} bytes, ${Math.ceil(size / partSize)} parts)`);
  return { key, uploadId, partSize, partCount: Math.ceil(size / partSize) };
}

async function signParts(s3, body) {
  const { key, uploadId } = requireUpload(body);
  const partNumbers = Array.isArray(body.partNumbers) ? body.partNumbers : [];
  if (partNumbers.length === 0 || partNumbers.length > MAX_URLS_PER_REQUEST) {
    throw new HttpError(400, `Ask for between 1 and ${MAX_URLS_PER_REQUEST} parts at a time.`);
  }
  const urls = {};
  for (const n of partNumbers) {
    if (!Number.isInteger(n) || n < 1 || n > MAX_PARTS) throw new HttpError(400, 'Invalid part number.');
    urls[n] = await s3.presign('PUT', key, { partNumber: String(n), uploadId }, PART_URL_TTL_SECONDS);
  }
  return { urls };
}

async function listParts(s3, body) {
  const { key, uploadId } = requireUpload(body);
  const parts = [];
  let marker = '0';
  for (;;) {
    const xml = await s3.request('GET', key, { uploadId, 'max-parts': '1000', 'part-number-marker': marker });
    for (const block of xmlBlocks(xml, 'Part')) {
      parts.push({
        PartNumber: Number(xmlValue(block, 'PartNumber')),
        ETag: xmlValue(block, 'ETag'),
        Size: Number(xmlValue(block, 'Size')),
      });
    }
    if (xmlValue(xml, 'IsTruncated') !== 'true') break;
    marker = xmlValue(xml, 'NextPartNumberMarker');
  }
  return { parts };
}

async function completeUpload(s3, body) {
  const { key, uploadId } = requireUpload(body);
  const parts = Array.isArray(body.parts) ? body.parts : [];
  if (parts.length === 0 || parts.length > MAX_PARTS) throw new HttpError(400, 'Part list is missing or too long.');

  const sorted = parts
    .map((p) => ({ n: Number(p.PartNumber), etag: String(p.ETag || '') }))
    .sort((a, b) => a.n - b.n);
  for (const p of sorted) {
    if (!Number.isInteger(p.n) || p.n < 1 || !/^"?[0-9a-fA-F-]+"?$/.test(p.etag)) {
      throw new HttpError(400, 'Invalid part in part list.');
    }
  }
  const payload =
    '<CompleteMultipartUpload>' +
    sorted.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${escapeXml(p.etag)}</ETag></Part>`).join('') +
    '</CompleteMultipartUpload>';

  const xml = await s3.request('POST', key, { uploadId }, { 'content-type': 'application/xml' }, payload);
  console.log(`Completed upload ${key} (${sorted.length} parts)`);
  return { key, location: xmlValue(xml, 'Location') };
}

async function abortUpload(s3, body) {
  const { key, uploadId } = requireUpload(body);
  await s3.request('DELETE', key, { uploadId });
  console.log(`Aborted upload ${key}`);
  return { aborted: true };
}

function requireUpload(body) {
  const key = typeof body.key === 'string' ? body.key : '';
  const uploadId = typeof body.uploadId === 'string' ? body.uploadId : '';
  if (!key || !uploadId || key.length > 1024 || /\.\.|^\//.test(key)) {
    throw new HttpError(400, 'Missing or invalid upload key / uploadId.');
  }
  return { key, uploadId };
}

// Parts of at least 64 MiB, grown so the file never needs more than ~9,000 parts.
export function choosePartSize(size) {
  const needed = Math.ceil(size / (MAX_PARTS - 1000));
  return Math.max(MIN_PART_SIZE, Math.ceil(needed / MIB) * MIB);
}

export function sanitizeFileName(name) {
  const base = name.split(/[\\/]/).pop();
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(-200);
  return clean || 'file';
}

class S3 {
  constructor(env) {
    this.client = new AwsClient({
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      region: env.AWS_REGION,
      service: 's3',
    });
    // S3_ENDPOINT is optional (e.g. for S3-compatible storage); it uses path-style URLs.
    this.base = env.S3_ENDPOINT
      ? `${env.S3_ENDPOINT.replace(/\/+$/, '')}/${env.S3_BUCKET}`
      : `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com`;
  }

  url(key, query) {
    const u = new URL(`${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  async request(method, key, query, headers = {}, body) {
    const res = await this.client.fetch(this.url(key, query).toString(), { method, headers, body });
    const text = await res.text();
    // CompleteMultipartUpload can return 200 with an <Error> body.
    if (!res.ok || /<Error>/.test(text)) {
      const code = xmlValue(text, 'Code') || `HTTP ${res.status}`;
      const message = xmlValue(text, 'Message') || text.slice(0, 300);
      throw new HttpError(502, `S3 ${method} failed: ${code} - ${message}`);
    }
    return text;
  }

  async presign(method, key, query, expiresSeconds) {
    const u = this.url(key, query);
    u.searchParams.set('X-Amz-Expires', String(expiresSeconds));
    const signed = await this.client.sign(u.toString(), { method, aws: { signQuery: true } });
    return signed.url;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function passphraseMatches(given, expected) {
  if (!given || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function xmlValue(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? unescapeXml(m[1]) : '';
}

function xmlBlocks(xml, tag) {
  return xml.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g')) || [];
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeXml(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&');
}
