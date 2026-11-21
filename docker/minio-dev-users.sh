#!/usr/bin/env bash
# Creates the MinIO access keys of the services on latex-dev, each limited to its buckets
# (docs/spec.md, "Réseau et pare-feu"). Safe to run several times.
#   api:    read/write "projects", read "templates" (write official templates under org/),
#           read/write "exam-papers" (frozen exam subjects), read/delete "compile-output" and
#           delete "compile-cache" (erasing a project); presigns the GET URLs of compile jobs.
#   worker: read/write "compile-output" and "compile-cache" only; NO right on "projects".
# Needs the stack running (docker compose -f docker/dev.yml up -d) and the buckets created by
# `pnpm db:seed`. Keys come from the environment or, when unset, from the repository root .env.
set -euo pipefail
cd "$(dirname "$0")/.."

read_env() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n 1; }
export MINIO_API_ACCESS_KEY=${MINIO_API_ACCESS_KEY:-$(read_env MINIO_API_ACCESS_KEY)}
export MINIO_API_SECRET_KEY=${MINIO_API_SECRET_KEY:-$(read_env MINIO_API_SECRET_KEY)}
export MINIO_WORKER_ACCESS_KEY=${MINIO_WORKER_ACCESS_KEY:-$(read_env MINIO_WORKER_ACCESS_KEY)}
export MINIO_WORKER_SECRET_KEY=${MINIO_WORKER_SECRET_KEY:-$(read_env MINIO_WORKER_SECRET_KEY)}
: "${MINIO_API_ACCESS_KEY:?missing (see .env.example)}" "${MINIO_API_SECRET_KEY:?missing}"
: "${MINIO_WORKER_ACCESS_KEY:?missing (see .env.example)}" "${MINIO_WORKER_SECRET_KEY:?missing}"

docker compose -f docker/dev.yml exec -T \
  -e MINIO_API_ACCESS_KEY -e MINIO_API_SECRET_KEY -e MINIO_WORKER_ACCESS_KEY -e MINIO_WORKER_SECRET_KEY \
  minio bash -c '
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
      "Resource": ["arn:aws:s3:::projects", "arn:aws:s3:::compile-output", "arn:aws:s3:::compile-cache"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::templates/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::templates/org/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::exam-papers/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": ["arn:aws:s3:::receipts/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::compile-output/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::compile-cache/*"]
    }
  ]
}
POLICY
  cat > /tmp/integris-worker-policy.json <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::compile-output/*", "arn:aws:s3:::compile-cache/*"]
    }
  ]
}
POLICY
  for service in api worker; do
    policy=integris-$service
    mc admin policy create local "$policy" "/tmp/$policy-policy.json" >/dev/null
    rm -f "/tmp/$policy-policy.json"
  done
  mc admin user add local "$MINIO_API_ACCESS_KEY" "$MINIO_API_SECRET_KEY" >/dev/null
  mc admin policy attach local integris-api --user "$MINIO_API_ACCESS_KEY" >/dev/null 2>&1 || true
  mc admin user add local "$MINIO_WORKER_ACCESS_KEY" "$MINIO_WORKER_SECRET_KEY" >/dev/null
  mc admin policy attach local integris-worker --user "$MINIO_WORKER_ACCESS_KEY" >/dev/null 2>&1 || true
  echo "MinIO users \"$MINIO_API_ACCESS_KEY\" (integris-api) and \"$MINIO_WORKER_ACCESS_KEY\" (integris-worker) ready."
'
