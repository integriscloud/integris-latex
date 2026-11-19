#!/bin/sh
# Entry point of a compilation sandbox (one disposable container per job).
# Usage: compile.sh <pdf|xe|lua> <main file path> <seconds>
# stdin: tar of the project files (and the cache of the previous run); stdout: tar holding
# "status" (exit code, duration, free space) and the results under "work/". Nothing else is printed:
# the worker reads stdout as data and caps its size.
set -u
umask 077

engine=$1
main=$2
seconds=$3

# LuaLaTeX runs the Lua guard (sandbox.lua) before the first line of the document.
pretex=
case $engine in
  pdf) flag=-pdf ;;
  xe) flag=-xelatex ;;
  lua) flag=-lualatex pretex="-pretex=\\directlua{dofile('/opt/integris/sandbox.lua')}" ;;
  *) exit 64 ;;
esac
case $seconds in
  '' | *[!0-9]*) exit 64 ;;
esac
# The worker has already checked the path; refuse anything odd again (latexmk has no "--").
case $main in
  '' | /* | -* | *..* | *[!A-Za-z0-9._/\ -]*) exit 64 ;;
esac

cd /work || exit 70
# Regular files only, owned by the sandbox user; an entry that is not a plain relative file
# makes the run fail (the worker writes the archive, this is a second check).
tar -x -f - --no-same-owner --no-same-permissions --no-overwrite-dir -m 2>/dev/null || exit 71
mkdir -p /tmp/integris || exit 70
# Room for the status taken now: the document may fill /tmp (its font cache is writable) and the
# status, rewritten in place below, must still fit.
printf '%256s' '' >/tmp/integris/status || exit 70
# LuaLaTeX font names database, built with the image (see the Dockerfile).
cp -R /opt/integris/texmf-var /tmp/texmf-var || exit 70

start=$(date +%s%N)
# TERM to the whole process group when the plan's duration is over, KILL 3 s later.
timeout -s TERM -k 3 "$seconds" \
  latexmk -norc -r /opt/integris/latexmkrc "$flag" ${pretex:+"$pretex"} -interaction=nonstopmode \
  -file-line-error -synctex=1 "$main" </dev/null >/dev/null 2>&1
code=$?
end=$(date +%s%N)

# Free space left in the working directory: a full one means the output was too large (TeX then
# fails without a clear message, often with a truncated log).
free=$(df -Pk /work | tail -n 1 | tr -s ' ' | cut -d ' ' -f 4)
printf 'exit=%s\nms=%s\nfree_kb=%s\n' "$code" "$(((end - start) / 1000000))" "$free" >/tmp/integris/status

job=$(basename "$main" .tex)
# A huge log is cut to its first 2 MB and last 6 MB: the worker reads results in memory.
log=/work/$job.log
if [ -f "$log" ] && [ "$(wc -c <"$log")" -gt 8388608 ]; then
  # Without room for the copy, the log is dropped rather than kept whole.
  if { head -c 2097152 "$log"; printf '\n\n[...]\n\n'; tail -c 6291456 "$log"; } >/tmp/integris/log 2>/dev/null; then
    cat /tmp/integris/log >"$log"
  else
    : >"$log"
  fi
  rm -f /tmp/integris/log
fi
# Results: the PDF, the log and SyncTeX of the main file, and the intermediate files kept as cache.
# Only regular files are listed, never links; the worker checks every entry again. The main
# file's PDF, log and SyncTeX are taken at the top only (TeX writes them in the current directory):
# a figure named like the job in a subfolder is not a result.
cd /work || exit 70
# Cache files over 5 MB are left out (the cache is an optimisation, never needed).
find . -type f \( -path "./$job.pdf" -o -path "./$job.log" -o -path "./$job.synctex.gz" \
  -o \( -size -5120k \( -name '*.aux' -o -name '*.bbl' -o -name '*.bcf' -o -name '*.blg' \
  -o -name '*.toc' -o -name '*.lof' -o -name '*.lot' -o -name '*.out' -o -name '*.idx' \
  -o -name '*.ind' -o -name '*.ilg' -o -name '*.nav' -o -name '*.snm' -o -name '*.run.xml' \
  -o -name '*.fls' -o -name '*.fdb_latexmk' \) \) \) -print0 2>/dev/null |
  tar -c -f - --format=pax --null --no-recursion \
    -C /tmp/integris status \
    -C /work --transform 's,^\./,work/,' -T - 2>/dev/null
