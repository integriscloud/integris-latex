# TeX Live image of the compilation sandbox (docs/spec.md, "Compilation"): the full distribution,
# one version a year, pinned by digest. Update deliberately, then rerun the malicious suite.
# Build: pnpm texlive:build (tag integris/texlive:2026). Compilations run it with gVisor (runsc),
# without network, read-only, as the unprivileged user below (apps/worker/src/sandbox.ts).
FROM texlive/texlive:latest-full@sha256:c21636aa13e86716d15dab4e352356cb0d34f9365d6091db066e5df71041d67b

# Unprivileged user of every compilation. No home, no shell, no password.
RUN useradd --uid 10001 --user-group --no-create-home --home-dir /nonexistent \
      --shell /usr/sbin/nologin tex

# Font caches are built once here: XeLaTeX and LuaLaTeX would otherwise rebuild them in every
# container (about 20 s). luaotfload only reads its names database from its writable cache, so
# compile.sh copies /opt/integris/texmf-var to /tmp/texmf-var (TEXMFVAR) before each run.
RUN fc-cache -fs \
 && mkdir -p /opt/integris/texmf-var \
 && TEXMFCACHE=/opt/integris/texmf-var luaotfload-tool --update --force \
 && chmod -R a+rX,go-w /opt/integris/texmf-var

COPY latexmkrc compile.sh sandbox.lua /opt/integris/
RUN chmod 0444 /opt/integris/latexmkrc /opt/integris/sandbox.lua && chmod 0555 /opt/integris/compile.sh

# TeX settings, in the top-level texmf.cnf (read before the distribution's): TeX writes only
# inside the project (no dot files, no "..", no absolute path; TEXMFOUTPUT stays unset) and only
# the restricted shell-escape commands below run. TeX Live's default list also allows latexminted
# (minted is refused by docs/spec.md), memoize-extract, gregorio, r-mpost and texosquery: they
# are left out. openin_any is set for completeness but has been a no-op since TeX Live 2026
# (see texmf-dist/web2c/texmf.cnf): reads are limited by the file permissions below instead.
RUN printf '%s\n' \
      'openin_any = p' \
      'openout_any = p' \
      'shell_escape = p' \
      'shell_escape_commands = bibtex,bibtex8,extractbb,kpsewhich,l3sys-query,makeindex,repstopdf' \
      'TEXMFVAR = /tmp/texmf-var' \
      'TEXMFHOME = /nonexistent' \
      'max_print_line = 10000' \
      'error_line = 254' \
      'half_error_line = 238' \
      >> /usr/local/texlive/2026/texmf.cnf

# Nothing outside the TeX trees, the fonts, the project and /tmp is readable by the sandbox user:
# \openin, \input, \pdffiledump and Lua cannot read /etc/passwd or the system configuration.
# /etc stays traversable (no listing) for the dynamic linker, fontconfig and Perl (latexmk, biber:
# Perl looks in /etc/perl first and stops on a permission error); links are skipped.
RUN chmod 0711 /etc \
 && find /etc -mindepth 1 -maxdepth 1 ! -type l ! -name fonts ! -name alternatives ! -name perl \
      ! -name ld.so.cache -exec chmod -R o-rwx {} + \
 && chmod -R o-rwx /var/lib /var/log /var/mail /var/spool /root /home /srv /mnt /media /opt/texlive 2>/dev/null; \
    chmod 0711 /var

# The only variables of a compilation (the worker passes no other): nothing to read from
# /proc/self/environ but these.
ENV HOME=/tmp \
    TMPDIR=/tmp \
    LANG=C.UTF-8

USER 10001:10001
WORKDIR /work
ENTRYPOINT ["/opt/integris/compile.sh"]
