#!/usr/bin/env bash
# PostToolUse: format the edited file, then lint it. Lint errors are sent back to Claude (exit 2).
set -uo pipefail
FILE=$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write((j.tool_input&&j.tool_input.file_path)||"")}catch{}})')
[ -z "$FILE" ] && exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0
[ -f node_modules/.bin/prettier ] || exit 0
case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.md|*.css|*.prisma) ;;
  *) exit 0 ;;
esac
pnpm exec prettier --write "$FILE" >/dev/null 2>&1 || true
case "$FILE" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs)
    [ -f node_modules/.bin/eslint ] || exit 0
    if ! OUT=$(pnpm exec eslint --fix "$FILE" 2>&1); then
      echo "ESLint errors in $FILE — fix them before continuing:" >&2
      echo "$OUT" | tail -40 >&2
      exit 2
    fi ;;
esac
exit 0
