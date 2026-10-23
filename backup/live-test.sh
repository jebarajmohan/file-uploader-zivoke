#!/bin/bash
# Step 3 live test: 70 MiB multipart upload through the deployed Worker.
# Needs UPLOAD_PASSPHRASE exported (never printed) and an admin `aws login` for the check and cleanup.
set -euo pipefail
U=https://file-manager-zivoke-upload.mohan-569.workers.dev
BUCKET=file-manager-zivoke
export AWS_DEFAULT_REGION=us-east-1
DIR=$(cd "$(dirname "$0")" && pwd)
F="$DIR/deploy-test.bin"
: "${UPLOAD_PASSPHRASE:?export UPLOAD_PASSPHRASE first}"

api() { curl -sS -X POST -H 'content-type: application/json' -H "x-upload-passphrase: $UPLOAD_PASSPHRASE" -d "$2" "$U/api/$1"; }
js() { python3 -I -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

echo "== GET /: $(curl -s -o /dev/null -w '%{http_code}' $U/)"
echo "== wrong passphrase: $(curl -s -w ' [%{http_code}]' -X POST -H 'content-type: application/json' -H 'x-upload-passphrase: wrong' -d '{}' $U/api/check)"
echo "== right passphrase: $(api check '{}')"

[ -f "$F" ] || head -c 73400320 /dev/urandom > "$F"
SIZE=$(stat -f %z "$F")
CREATE=$(api create "{\"name\":\"deploy-test.bin\",\"size\":$SIZE,\"type\":\"application/octet-stream\"}")
echo "== create: $CREATE"
KEY=$(echo "$CREATE" | js 'd["key"]'); UID_=$(echo "$CREATE" | js 'd["uploadId"]')
PS=$(echo "$CREATE" | js 'd["partSize"]'); PC=$(echo "$CREATE" | js 'd["partCount"]')
NUMS=$(python3 -I -c "print(list(range(1,$PC+1)))")
SIGN=$(api sign-parts "{\"key\":\"$KEY\",\"uploadId\":\"$UID_\",\"partNumbers\":$NUMS}")

PARTS="["
for ((n=1; n<=PC; n++)); do
  URL=$(echo "$SIGN" | js "(d['urls'].get('$n') if isinstance(d['urls'],dict) else d['urls'][$n-1])")
  OFF=$(( (n-1)*PS )); LEN=$(( SIZE-OFF < PS ? SIZE-OFF : PS ))
  dd if="$F" bs=1048576 skip=$(( OFF/1048576 )) count=$(( (LEN+1048575)/1048576 )) 2>/dev/null | head -c $LEN > "$DIR/part.$n"
  H=$(curl -sS -D - -o /dev/null -X PUT -H "Origin: $U" --data-binary @"$DIR/part.$n" "$URL")
  CODE=$(echo "$H" | head -1 | awk '{print $2}')
  ETAG=$(echo "$H" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)
  ACAO=$(echo "$H" | grep -i '^access-control-expose-headers:' | tr -d '\r' || true)
  echo "== part $n: HTTP $CODE etag=$ETAG ${ACAO:-(no expose-headers)}"
  rm -f "$DIR/part.$n"
  PARTS+="{\"PartNumber\":$n,\"ETag\":$(python3 -I -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$ETAG")},"
done
PARTS="${PARTS%,}]"
echo "== complete: $(api complete "{\"key\":\"$KEY\",\"uploadId\":\"$UID_\",\"parts\":$PARTS}")"
echo "== S3 object:"; aws s3api head-object --bucket $BUCKET --key "$KEY" --query '[ContentLength,ETag]' --output text
echo "KEY=$KEY"
