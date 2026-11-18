#!/usr/bin/env bash
# PreToolUse: refuse any edit of secrets, environment files or git internals.
set -uo pipefail
FILE=$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write((j.tool_input&&j.tool_input.file_path)||"")}catch{}})')
[ -z "$FILE" ] && exit 0
case "$FILE" in
  *.env.example) exit 0 ;;
  *.env|*.env.*|*/secrets/*|*/.git/*|*.pem|*.key)
    echo "Blocked: $FILE is a protected file (secrets, env or git internals). Ask the user to edit it manually." >&2
    exit 2 ;;
esac
exit 0
