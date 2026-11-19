#!/usr/bin/env node
// Compares the repository root .env with .env.example before `pnpm dev`: every variable set in
// .env.example (uncommented line) must be set, and not empty, in .env. Commented variables of
// .env.example are optional (their default is shown there). Exits 1 and lists what is missing.
//   pnpm dev:check-env
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const root = new URL('../', import.meta.url);
const examplePath = new URL('.env.example', root);
const envPath = new URL('.env', root);

const exampleText = readFileSync(examplePath, 'utf8');
const example = parseEnv(exampleText);
if (!existsSync(envPath)) {
  console.error('No .env at the repository root. Create it with: cp .env.example .env');
  process.exit(1);
}
const env = parseEnv(readFileSync(envPath, 'utf8'));

/** Comment lines right above a variable in .env.example: what it is and how to set it. */
function helpOf(name) {
  const lines = exampleText.split('\n');
  const index = lines.findIndex((line) => line.startsWith(`${name}=`));
  const help = [];
  let i = index - 1;
  // Variables of the same block share the comment above the first one.
  while (i >= 0 && /^[A-Z0-9_]+=/.test(lines[i])) i--;
  for (; i >= 0 && lines[i].startsWith('#'); i--) help.unshift(lines[i]);
  return help;
}

const missing = Object.keys(example).filter((name) => !env[name]);
const unknown = Object.keys(env).filter(
  (name) => !(name in example) && !exampleText.includes(`${name}=`),
);

if (unknown.length > 0) {
  console.log(`.env: not in .env.example (ignored by this check): ${unknown.join(', ')}`);
}
if (missing.length === 0) {
  console.log(`.env: OK (${Object.keys(example).length} required variables of .env.example set).`);
  process.exit(0);
}

console.error(`\n.env: ${missing.length} variable(s) of .env.example missing or empty:\n`);
for (const name of missing) {
  console.error(`  ${name}`);
  for (const line of helpOf(name)) console.error(`      ${line}`);
  console.error(`      example: ${name}=${example[name]}`);
}
console.error(
  '\nAdd them to .env (development values only, see .env.example), or run the setup script of' +
    ' the step that introduced them (scripts/dev-setup-step*.sh). Then run pnpm dev again.\n',
);
process.exit(1);
