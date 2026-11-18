#!/usr/bin/env bash
# Creates the MinIO access key of the API on latex-dev, limited to its buckets:
# read and write on "projects", read only on "templates". Safe to run several times.
# Needs the stack running (docker compose -f docker/dev.yml up -d) and the buckets created by
# `pnpm db:seed`. MINIO_API_ACCESS_KEY and MINIO_API_SECRET_KEY come from the environment or,
# when unset, from the repository root .env.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  key=${MINIO_API_ACCESS_KEY:-$(sed -n 's/^MINIO_API_ACCESS_KEY=//p' .env)}
  secret=${MINIO_API_SECRET_KEY:-$(sed -n 's/^MINIO_API_SECRET_KEY=//p' .env)}
  export MINIO_API_ACCESS_KEY=$key MINIO_API_SECRET_KEY=$secret
fi
: "${MINIO_API_ACCESS_KEY:?missing (see .env.example)}" "${MINIO_API_SECRET_KEY:?missing}"

docker compose -f docker/dev.yml exec -T -e MINIO_API_ACCESS_KEY -e MINIO_API_SECRET_KEY minio bash -c '
  set -euo pipefail
  mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
  cat > /tmp/integris-api-policy.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::projects/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::projects"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::templates/*"]
    }
  ]
}
POLICY
  mc admin policy create local integris-api /tmp/integris-api-policy.json >/dev/null
  rm -f /tmp/integris-api-policy.json
  mc admin user add local "$MINIO_API_ACCESS_KEY" "$MINIO_API_SECRET_KEY" >/dev/null
  mc admin policy attach local integris-api --user "$MINIO_API_ACCESS_KEY" >/dev/null 2>&1 || true
  echo "MinIO user \"$MINIO_API_ACCESS_KEY\" ready (policy integris-api)."
'
