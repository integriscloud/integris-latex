#!/usr/bin/env python3
"""Adds the `location /exam/` block of the files domain on latex-dev (step 13).

Exam subjects (watermarked preview, one-time print file) are served by the API's files server
under /exam/, like compiled PDFs under /pdf/. Run as root:

    sudo python3 scripts/nginx/add-exam-location.py

What it does, in this order:
  - does nothing when a `location /exam/` block already exists;
  - finds the `location / { auth_basic off; return 404; }` block of the HTTPS server (the one
    with `listen 443`), and refuses without changing anything unless there is exactly one;
  - saves the file next to it (<file>.bak-<date>), inserts the block just before, and checks the
    configuration with `nginx -t`; if the check fails, the saved file is put back;
  - prints the inserted block. Nginx is not reloaded: run `systemctl reload nginx` afterwards.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime

CONFIG = "/etc/nginx/sites-available/test-latex-files"

# Same rules as /pdf/: no auth, read only, no cookie or credential sent or set, client address.
BLOCK = """    location /exam/ {
        auth_basic off;
        limit_except GET OPTIONS { deny all; }

        proxy_pass http://127.0.0.1:4100;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Cookie "";
        proxy_set_header Authorization "";
        proxy_hide_header Set-Cookie;
        proxy_buffering off;
        proxy_read_timeout 60s;
    }

"""

# The final catch-all of the HTTPS server, as written in the file (indentation free).
CATCH_ALL = re.compile(
    r"^[ \t]*location[ \t]+/[ \t]*\{[ \t]*\n"
    r"[ \t]*auth_basic[ \t]+off;[ \t]*\n"
    r"[ \t]*return[ \t]+404;[ \t]*\n"
    r"[ \t]*\}[ \t]*\n",
    re.MULTILINE,
)


def fail(message: str) -> None:
    print(f"Refusé, rien n'a été modifié : {message}", file=sys.stderr)
    sys.exit(1)


def server_blocks(text: str) -> list[tuple[int, int]]:
    """Start and end offsets of each top-level `server { ... }` block (braces counted)."""
    blocks = []
    for match in re.finditer(r"^server[ \t]*\{", text, re.MULTILINE):
        depth = 0
        for index in range(match.end() - 1, len(text)):
            if text[index] == "{":
                depth += 1
            elif text[index] == "}":
                depth -= 1
                if depth == 0:
                    blocks.append((match.start(), index + 1))
                    break
        else:
            fail("accolades non équilibrées dans un bloc server")
    return blocks


def main() -> None:
    if os.geteuid() != 0:
        fail("lancez le script avec sudo")
    if not os.path.isfile(CONFIG):
        fail(f"{CONFIG} est introuvable")
    with open(CONFIG, encoding="utf-8") as handle:
        text = handle.read()

    if re.search(r"^[ \t]*location[ \t]+/exam/", text, re.MULTILINE):
        print(f"Le bloc location /exam/ existe déjà dans {CONFIG} : rien à faire.")
        return

    https = [
        (start, end)
        for start, end in server_blocks(text)
        if re.search(r"^[ \t]*listen[ \t]+443\b", text[start:end], re.MULTILINE)
    ]
    if len(https) != 1:
        fail(f"{len(https)} bloc(s) server avec « listen 443 » au lieu d'un seul")
    start, end = https[0]
    places = list(CATCH_ALL.finditer(text, start, end))
    if len(places) != 1:
        fail(
            f"{len(places)} bloc(s) « location / {{ auth_basic off; return 404; }} » "
            "dans le server 443 au lieu d'un seul"
        )
    at = places[0].start()
    updated = text[:at] + BLOCK + text[at:]

    backup = f"{CONFIG}.bak-{datetime.now():%Y%m%d-%H%M%S}"
    shutil.copy2(CONFIG, backup)
    # Written beside the file, then renamed over it: never a half-written configuration.
    directory = os.path.dirname(CONFIG)
    handle, temporary = tempfile.mkstemp(dir=directory, prefix=".test-latex-files.")
    with os.fdopen(handle, "w", encoding="utf-8") as output:
        output.write(updated)
    shutil.copymode(backup, temporary)
    os.replace(temporary, CONFIG)

    check = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
    if check.returncode != 0:
        shutil.copy2(backup, CONFIG)
        print(check.stderr, file=sys.stderr)
        fail(f"nginx -t a échoué ; {CONFIG} a été remis comme avant ({backup})")

    print(f"Sauvegarde : {backup}")
    print(f"Bloc inséré dans {CONFIG}, avant « location / » du server 443 :\n")
    print(BLOCK.rstrip("\n"))
    print("\nnginx -t : configuration valide. Rechargez Nginx : sudo systemctl reload nginx")


if __name__ == "__main__":
    main()
