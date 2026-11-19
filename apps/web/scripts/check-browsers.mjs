// Browser compatibility check of the client build (docs/spec.md, "Navigateurs"):
// every JavaScript file served to browsers is parsed by es-check against .browserslistrc. A
// syntax the oldest target cannot parse fails. A method or global missing from a target fails
// unless the build defines its polyfill (core-js `$({ … }, { name: … })` or Next.js
// `X.name = function`), or it is one of the few uses guarded by a feature test listed below.
// Run after `next build`: `pnpm --filter @integris/web check:browsers`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { runChecks } = require('es-check');
const esCheckLib = dirname(require.resolve('es-check'));
const { ES_FEATURES } = require(join(esCheckLib, 'constants/es-features/index.js'));

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(web, '../..');
const output = join(web, '.next');

/**
 * Features allowed without a polyfill when the same file holds the feature test that guards
 * them. Keep this list short and explained.
 */
const GUARDED = {
  // PDF.js uses Float16Array only after `typeof Float16Array !== "undefined"`.
  Float16Array: /typeof Float16Array/,
  // Only called inside core-js's own feature tests of its JSON.stringify polyfill.
  JSONRawJSON: /__core-js_shared__/,
  JSONIsRawJSON: /__core-js_shared__/,
};

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Name a polyfill defines for an es-check feature: its method, constructor or global. */
function definedName(feature) {
  const ast = ES_FEATURES[feature]?.astInfo;
  return ast?.property ?? ast?.callee ?? feature;
}

/** Whether the build defines a polyfill of `name` (core-js or Next.js style). */
function definesPolyfill(code, name) {
  const key = escape(name);
  return new RegExp(`[,(]\\{[^{}]*?\\b${key}:|\\.${key}\\s*=\\s*function`).test(code);
}

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

if (!existsSync(join(output, 'build-manifest.json'))) {
  console.error('check:browsers: no build found, run `next build` first.');
  process.exit(1);
}

// Next.js's `noModule` polyfills only run in browsers without ES modules, far below the target.
const manifest = JSON.parse(readFileSync(join(output, 'build-manifest.json'), 'utf8'));
const skipped = new Set((manifest.polyfillFiles ?? []).map((file) => join(output, file)));
const files = javascriptFiles(join(output, 'static')).filter((file) => !skipped.has(file));
const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
const build = [...sources.values()].join('\n');

const result = runChecks(
  [
    {
      checkBrowser: true,
      browserslistPath: join(root, '.browserslistrc'),
      checkFeatures: true,
      module: true,
      files,
    },
  ],
  {},
);

const problems = [];
const polyfilled = new Set();
for (const error of result.errors) {
  const file = relative(web, error.file);
  const features = error.err?.features;
  if (!features) {
    problems.push(`${file}: ${error.err?.message ?? 'cannot be parsed'}`);
    continue;
  }
  for (const feature of features) {
    if (GUARDED[feature]?.test(sources.get(error.file) ?? '')) continue;
    if (definesPolyfill(build, definedName(feature))) {
      polyfilled.add(feature);
      continue;
    }
    const browsers = (error.err.browserDetails?.[feature] ?? []).map(
      ({ name, version, requiredVersion }) => `${name} ${version} needs ${requiredVersion}`,
    );
    problems.push(`${file}: ${feature} without polyfill (${browsers.join(', ') || 'too recent'})`);
  }
}

console.log(`check:browsers: ${files.length} files checked against .browserslistrc.`);
if (polyfilled.size) console.log(`Polyfilled: ${[...polyfilled].sort().join(', ')}.`);
if (problems.length) {
  console.error(
    `\n${problems.length} problem(s): add a polyfill (src/lib/polyfills.ts) or avoid the feature.`,
  );
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}
console.log('No feature newer than the browser target.');
