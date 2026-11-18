# Prompts Claude Code — Integris LaTeX

## Étape 1 (session principale, en mode plan)
Lis CLAUDE.md et docs/spec.md en entier. Réalise l'étape 1 du « Plan de développement » :
monorepo pnpm + Turborepo avec apps/web, apps/api, apps/collab, apps/worker et packages/db,
packages/shared, packages/ui ; docker/dev.yml (PostgreSQL, Redis, MinIO) ; ESLint + Prettier ;
GitHub Actions (lint, typecheck, test, build) ; next-intl avec fr et en ; scripts pnpm de CLAUDE.md.
Place docs/schema.prisma dans packages/db mais ne lance pas encore les migrations (étape 2).
Propose d'abord ton plan. Critère de fin : `pnpm dev` lance les 4 apps et `pnpm build` passe.
Ne commit pas.

## Modèle pour chaque étape suivante
Lis la ligne N du « Plan de développement » de docs/spec.md et les sections de la spec qui la concernent.
Propose ton plan (fichiers, modèles, routes, tests). Après ma validation, implémente, écris les tests,
puis lance `pnpm build` et `pnpm test`. Termine en lançant le sous-agent security-reviewer et en
corrigeant ses constats critiques et élevés. Critère de fin : celui de la ligne N. Ne commit pas.

## Travail en parallèle (après l'étape 2)
git worktree add ../latex-auth   -b feat/step-3-4-auth-projects
git worktree add ../latex-editor -b feat/step-5-editor
git worktree add ../latex-worker -b feat/step-6-compile
Puis, dans chaque dossier, lancer `claude` avec le modèle d'étape ci-dessus.
Fusionner une branche à la fois dans main, après build, tests et security-reviewer.
