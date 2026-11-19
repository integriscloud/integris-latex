#!/usr/bin/env bash
# Step 6 setup on latex-dev (compilation). Run from the repository root:
#   scripts/dev-setup-step6.sh
# 1. Adds to .env the step-6 variables it lacks (development values only, never a duplicate).
# 2. Builds the TeX Live sandbox image (pnpm texlive:build).
# 3. Creates the compilation buckets (pnpm db:seed) and the MinIO keys (pnpm minio:users).
# Needs the stack running: docker compose -f docker/dev.yml up -d
set -uo pipefail

if [ ! -f package.json ] || [ ! -d docker/texlive ]; then
  echo "Run this script from the repository root." >&2
  exit 1
fi
if [ ! -f .env ]; then
  echo "No .env at the repository root (cp .env.example .env first)." >&2
  exit 1
fi

failed=0
step() {
  local name=$1
  shift
  printf '%s… ' "$name"
  local log
  log=$(mktemp)
  if "$@" >"$log" 2>&1; then
    echo OK
  else
    echo "ERROR"
    tail -n 20 "$log" | sed 's/^/    /'
    failed=1
  fi
  rm -f "$log"
}

# Development values (TEST ONLY, see .env.example). Existing lines are never changed.
add_missing_env() {
  local added=0
  [ -n "$(tail -c 1 .env)" ] && echo >>.env
  while IFS='=' read -r name value; do
    if ! grep -qE "^[[:space:]]*${name}=" .env; then
      echo "${name}=${value}" >>.env
      echo "    added ${name}"
      added=1
    fi
  done <<'VARS'
MINIO_WORKER_ACCESS_KEY=integris-worker
MINIO_WORKER_SECRET_KEY=change-me-dev-minio-worker-secret
FILES_PUBLIC_URL=https://test-latex-files.integriscloud.com
VARS
  [ "$added" = 1 ] || echo "    nothing to add"
}

echo "Variables in .env:"
add_missing_env
step "TeX Live image (pnpm texlive:build, several minutes the first time)" pnpm texlive:build
step "Database and buckets (pnpm db:seed)" pnpm db:seed
step "MinIO keys api and worker (pnpm minio:users)" pnpm minio:users

if [ "$failed" = 0 ]; then
  echo "Step 6 setup done. Restart pnpm dev so that the API and the worker read .env again."
else
  echo "Step 6 setup incomplete: see the errors above." >&2
  exit 1
fi
