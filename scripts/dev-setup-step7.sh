#!/usr/bin/env bash
# Step 7 setup on latex-dev (collaboration, history). Run from the repository root:
#   scripts/dev-setup-step7.sh
# 1. Adds to .env the step-7 variables it lacks (random development values, never a duplicate).
# 2. Recreates the Redis container so that it declares the ACL user `collab` (docker/dev.yml)
#    and checks that this user may subscribe to collab:events and nothing else.
# 3. Applies the database migrations (pnpm db:migrate).
# Needs the stack running: docker compose -f docker/dev.yml up -d
set -uo pipefail

if [ ! -f package.json ] || [ ! -f docker/dev.yml ]; then
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

read_env() { sed -n "s/^$1=//p" .env | tail -n 1; }

# Existing lines are never changed. TEST VALUES ONLY (see .env.example).
add_env() {
  if grep -qE "^[[:space:]]*$1=" .env; then return; fi
  [ -n "$(tail -c 1 .env)" ] && echo >>.env
  echo "$1=$2" >>.env
  echo "    added $1"
  added=1
}

echo "Variables in .env:"
added=0
add_env COLLAB_INTERNAL_SECRET "$(openssl rand -hex 32)"
add_env REDIS_COLLAB_PASSWORD "$(openssl rand -hex 24)"
add_env COLLAB_REDIS_URL "redis://collab:$(read_env REDIS_COLLAB_PASSWORD)@127.0.0.1:6379"
[ "$added" = 1 ] || echo "    nothing to add"
if [ "$(read_env COLLAB_REDIS_URL)" != "redis://collab:$(read_env REDIS_COLLAB_PASSWORD)@127.0.0.1:6379" ]; then
  echo "    warning: COLLAB_REDIS_URL does not hold REDIS_COLLAB_PASSWORD (see .env.example)" >&2
fi

redis_ready() {
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose -f docker/dev.yml ps -q redis)" 2>/dev/null)" = healthy ] && return 0
    sleep 1
  done
  return 1
}

# The collab user answers PING and is refused any key and any other channel.
check_collab_user() {
  docker compose -f docker/dev.yml exec -T redis sh -c '
    as_collab() { REDISCLI_AUTH="$REDIS_COLLAB_PASSWORD" redis-cli --user collab "$@" 2>&1; }
    [ "$(as_collab PING)" = PONG ] || { echo "collab cannot log in"; exit 1; }
    as_collab GET any-key | grep -q NOPERM || { echo "collab reads keys"; exit 1; }
    as_collab PUBLISH collab:events x | grep -q NOPERM || { echo "collab publishes"; exit 1; }'
}

step "Redis with the ACL user collab (container recreated)" \
  sh -c 'docker compose -f docker/dev.yml up -d redis'
step "Redis ready" redis_ready
step "ACL user collab limited to collab:events" check_collab_user
step "Database migrations (pnpm db:migrate)" pnpm db:migrate

if [ "$failed" = 0 ]; then
  echo "Step 7 setup done. Restart pnpm dev so that the services read .env again."
else
  echo "Step 7 setup incomplete: see the errors above." >&2
  exit 1
fi
