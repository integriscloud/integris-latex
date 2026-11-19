# Integris LaTeX — instructions for Claude Code

Collaborative LaTeX editor (Overleaf-like) for West Africa, hosted by Integris Cloud at
`latex.integriscloud.com`. Mobile-money payments (LigdiCash), FR/EN UI, student–supervisor
submission workflow. The functional source of truth is `docs/spec.md` (Integris LaTeX — Spécification V1).
If a rule is missing or ambiguous there, STOP and ask; never invent business rules.

## Stack
- Monorepo: pnpm workspaces + Turborepo, TypeScript everywhere, Node.js 22 LTS.
- `apps/web`     Next.js (App Router), next-intl (fr default, en), CodeMirror 6, Yjs client, PDF.js
- `apps/api`     NestJS REST API, OpenAPI (Swagger), Zod validation, BullMQ producer
- `apps/collab`  Hocuspocus (Yjs) WebSocket server, auth checked on every connection
- `apps/worker`  BullMQ consumer, runs latexmk inside a disposable gVisor container
- `packages/db`  Prisma schema + client (PostgreSQL)
- `packages/shared` Zod schemas, types, constants (plans, roles, statuses), i18n keys
- `packages/ui`  shared React components
- Infra: PostgreSQL, Redis (sessions, queues, rate limits), MinIO (files, PDFs, compile cache)

## Dev server (latex-dev)
- Fixed local ports: web 3000, api 4000, collab 1234 (WebSocket path `/collab`), Postgres 5432, Redis 6379,
  MinIO 9000/9001. Nginx on the host serves https://test-latex.integriscloud.com and proxies `/` → 3000,
  `/api/` → 4000, `/collab` → 1234. Do not change these ports; do not touch Nginx or the firewall.
- Docker publishes ports on 127.0.0.1 only (daemon default). gVisor runtime `runsc` is installed.
- Only test credentials on this server (LigdiCash sandbox, test SMTP). Never put production secrets here.

## Commands
- `pnpm install` · `pnpm dev` · `pnpm build` · `pnpm lint` · `pnpm test` · `pnpm test:e2e`
- `pnpm db:migrate` · `pnpm db:seed` · `docker compose -f docker/dev.yml up -d`

## Working rules
- Run `pnpm build` and `pnpm test` before proposing a commit. Commit ONLY when explicitly asked,
  at a logical completion point (end of a plan step).
- Follow the step order in `docs/spec.md` → "Plan de développement". Do not start a step before
  the previous one meets its "Terminée quand" criterion.
- When modifying an existing file, output the complete file, not a partial diff.
- For complex text transformations across files, write a small Python script rather than sed.
- Code, identifiers, commits and comments in English. Every user-facing string goes through
  next-intl with both `fr` and `en` keys — no hard-coded UI text.
- Amounts are integers in XOF (FCFA). Never use floats for money. Prices are TTC.
- Browser target: `.browserslistrc` (Chrome, Android WebView, Samsung Internet and Firefox of the last 3 years, Safari iOS 15+;
  docs/spec.md, "Navigateurs"). Browser code, pages and workers, dependencies included, only uses what these
  versions support or a polyfill loaded first (`apps/web/src/lib/polyfills.ts`); no regexp lookbehind.
  `pnpm --filter @integris/web check:browsers` (after the build, in CI) and the `chromium-120` e2e project must pass.
- Plans, prices and quotas are read from the database (`Plan` table), never hard-coded.

## Design (docs/design/)
- Visual source of truth: `docs/design/ecrans-html/` (static mockups, one file per screen; open
  `docs/design/index.html`) and `docs/design/tokens/tokens.css` (design system "vert toge et or").
- Mockups are visual references, NOT code to copy: rebuild each screen with React components in
  `packages/ui` that read the tokens. No inline styles in app code.
- Import `tokens.css` once in `apps/web` (global CSS) and use the CSS variables everywhere
  (`--action`, `--fond`, `--t-texte`, `--espace-4`, `--r-lg`…). Never hard-code a color or size
  that exists as a token.
- Fonts: Plus Jakarta Sans (UI), Source Serif 4 (titles/documents), JetBrains Mono (code), self-hosted
  woff2 via `next/font/local`, latin-ext subset, `font-display: swap`. No Google Fonts at runtime.
  The editor page loads only Plus Jakarta Sans and JetBrains Mono.
- Icons: Lucide (`lucide-react`), 24 px grid, stroke 1.75.
- Accessibility: real `<button>`, `<a>`, `<label>`; `aria-label` on icon-only buttons; 44 px touch
  targets; text contrast ≥ 4.5:1; success states always carry a check icon.
- Motion: only opacity/transform with the token durations and curve; respect `prefers-reduced-motion`.
- Breakpoints 360 / 600 / 960 / 1280; the side menu overlays content on phones.
- Product name in the mockups is "[Nom du produit]": always render "Integris LaTeX" (i18n key).
- Sample names, numbers and prices in mockups are placeholders: real values come from the API
  and the `Plan` table.
- When a screen needed by a plan step has no mockup yet, build it from existing components and
  tokens, keep it plain, and list it in the step report as "screen without mockup".
- If a mockup shows a feature or rule absent from docs/spec.md, do NOT implement it: report it.

## Security rules (non-negotiable)
- Compilation: one disposable container per job, gVisor runtime, `--network none`, read-only rootfs
  except the workdir, non-root user, `--cap-drop ALL`, CPU/memory/pids/time/output-size limits,
  TeX `openin_any=p` / `openout_any=p`, restricted shell-escape only. Never run TeX on the app server.
- Workers only reach Redis and MinIO; no app secrets on worker machines.
- Sessions: server-side in Redis, cookie `__Host-session` (Secure, HttpOnly, SameSite=Lax),
  never scoped to `.integriscloud.com`.
- User content (PDFs, images) served from the sibling subdomain `latex-files.integriscloud.com`
  (never a subdomain of `latex.`), via short-lived signed URLs, no cookies, headers
  `Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox`,
  `X-Content-Type-Options: nosniff`, and `Content-Disposition: attachment` for anything that is not
  a PDF or a raster image. Never render user SVG inline.
- Servers talk over public IPs: every connection between servers uses TLS (internal CA, certificates
  verified). Postgres `hostssl` + scram from the app server only; Redis TLS port only with ACL users
  `api` and `worker` (worker restricted to queue keys); MinIO with one access key per service.
  The firewall flow matrix in docs/spec.md ("Réseau et pare-feu") is the source of truth.
- Authorization checked server-side on every API request AND every collab WebSocket connection.
- Payments: verify LigdiCash webhook, re-check status with the LigdiCash API before activating,
  idempotent processing keyed on the transaction id. Never activate from client-side data.
- OTP: rate limits per phone, per IP and per day; CAPTCHA after failures; allowed country codes configurable.
- Uploads: check real MIME type and size; max 10 MB per file; allowed extensions only.
- Write an `AuditLog` entry for seats, roles, payments, shares and validations.
- A plan owner never gets access to members' project content.

## Key business rules (summary — details in docs/spec.md)
- Plans: FREE, STANDARD, TEAM (2–10 seats), BUSINESS (10+ seats). Owner occupies a seat.
  Only TEAM/BUSINESS owners (and up to 5 BUSINESS admins) attach accounts.
- Quotas are per seat, never pooled; usage is charged to the project owner; best quota wins
  when a user holds several seats.
- A released seat is reassignable only after 30 days.
- Over quota → block with a clear message and an upgrade offer. No automatic overage billing.
- Unpaid/expired → 7-day grace, then FREE; nothing deleted, over-limit projects become read-only.
- Paid STANDARD is paused (and extended) while the user holds a TEAM/BUSINESS seat.
- Upgrade immediate with proration credit; downgrade at period end; extra seats prorated.
- All payments on-platform via LigdiCash; BUSINESS is self-serve with automatic price calculation.
- Receipts: PDF, sequential numbering, sent by email only (email required and verified at first payment).
- Project roles: OWNER, EDITOR, SUPERVISOR (UI "Encadrant": comment, suggest, validate, set deadlines),
  REVIEWER (comment/suggest only), VIEWER (UI "Lecteur"). V1 permissions are project-level.
- One person can have several spaces (personal + each organization, with role student/teacher/admin):
  "Choisir son espace" after login (skipped if only one), switchable from the side menu.
- BUSINESS: a teacher who self-declares membership stays PENDING_APPROVAL until an org admin confirms.
  Members can be invited in bulk by CSV import (Excel in V2). Groups are shown as "Classes et filières".
- Exam papers (BUSINESS only, V1): ASSIGNMENT projects (subject, private answer key, marking scheme);
  only the frozen compiled subject PDF is sent to the SECRETARY members of the target group.
  PrintRequest statuses SCHEDULED → READY → OPENED → PRINTED → HANDED_OVER (or CANCELED).
  The server refuses any access to a subject before `availableFrom`, for every user including admins.
  Preview PDFs carry a server-generated nominative watermark; the clean print file is served through a
  one-time link valid 10 minutes. Every action writes an append-only `PrintEvent` (who, when, IP).
  Subject PDFs live in a separate private bucket, never behind a public or long-lived URL.
  The answer key and marking scheme never leave the teacher's project.
- Out of V1 even if shown in mockups: institution SSO, Excel import.
- Submissions: frozen version at send; statuses DRAFT → SUBMITTED → IN_REVIEW → FEEDBACK_SENT
  → REVISED → VALIDATED; only a supervisor validates; validation locks the submitted files.
