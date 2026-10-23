# File uploader (Cloudflare Worker → Amazon S3)

A single web page, served by a Cloudflare Worker, that lets someone with a passphrase upload one large file (5 GB and more, up to S3's 5 TiB limit) into an S3 bucket.

## How it works

- The Worker serves the page, checks the passphrase, and signs requests. **File data never passes through the Worker**, so Worker request size and CPU limits don't apply.
- The browser splits the file into parts of at least 64 MiB. A 5 GB file is about 80 parts. The browser sends 4 parts at a time straight to S3 using presigned URLs that expire after 1 hour.
- Failed parts are retried automatically. If the connection drops or the page is closed, the sender can choose the same file again and press **Upload file**, and the upload continues from the last finished part.
- Uploaded files land in `s3://<bucket>/uploads/<date>/<random>-<file name>`.

## Setup

### 1. S3 bucket

**CORS** (Bucket → Permissions → Cross-origin resource sharing): paste `aws/s3-cors.json`. The `ExposeHeaders: ETag` line is required: without it, every upload fails at the end.

**Lifecycle rule** (recommended): `aws/lifecycle.json` deletes parts left behind by abandoned uploads after 7 days, so you don't pay for them.

```sh
aws s3api put-bucket-cors --bucket file-manager-zivoke --cors-configuration '{"CORSRules": '"$(cat aws/s3-cors.json)"'}'
aws s3api put-bucket-lifecycle-configuration --bucket file-manager-zivoke --lifecycle-configuration file://aws/lifecycle.json
```

### 2. IAM user

Attach `aws/iam-policy.json` (with your bucket name) to the IAM user as an inline policy. The user can only upload into `uploads/`. It cannot read, list, or delete files.

### 3. Worker

Edit `wrangler.toml` and set `AWS_REGION` and `S3_BUCKET` to match your bucket. Then:

```sh
npm install
npx wrangler login
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
npx wrangler secret put UPLOAD_PASSPHRASE
npx wrangler deploy
```

Send the Worker URL and the passphrase to the sender separately.

Never commit the access keys or the passphrase. They live only in Wrangler secrets, or in a local, git-ignored `.dev.vars` file for `wrangler dev`.

## Troubleshooting

The page shows the actual S3 error. Worker logs (Cloudflare → Workers → this Worker → Observability) show the same message.

| Message | Fix |
| --- | --- |
| `Missing settings: …` | Set the named secret or variable and redeploy. |
| `S3 … failed: AccessDenied` | IAM policy is missing, or the bucket name or prefix is wrong. |
| `S3 … failed: SignatureDoesNotMatch` / `InvalidAccessKeyId` | Wrong or inactive access key, or the secret was pasted with extra spaces. |
| `AuthorizationHeaderMalformed` / `PermanentRedirect` | `AWS_REGION` doesn't match the bucket's region. |
| `…hid its ETag…` or `Network error … check the bucket CORS rules` | Fix the bucket CORS rules (step 1). |

## Local testing

`test/mock-s3.mjs` is a small S3 multipart mock that you can run instead of real S3. Set `S3_ENDPOINT=http://127.0.0.1:9000` in `.dev.vars`, then run `node test/mock-s3.mjs 9000 ./mock-data` alongside `npx wrangler dev`.
