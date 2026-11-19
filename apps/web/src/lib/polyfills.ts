// Polyfills of the browser target (docs/spec.md, "Navigateurs"; .browserslistrc)
// for what PDF.js uses without its own polyfill. Imported first by the PDF viewer and by the
// PDF.js worker: a worker gets neither these nor Next.js's polyfills of the page. Each module
// only installs itself when the browser lacks the method. `pnpm --filter @integris/web
// check:browsers` fails when the build uses a method of a newer browser with no polyfill.

// Firefox 121, Safari 17.4.
import 'core-js/modules/es.promise.with-resolvers.js';
// Safari 15.4 (the page has Next.js's `Array.at` and `Object.hasOwn`, the worker does not).
import 'core-js/modules/es.array.at.js';
import 'core-js/modules/es.array.find-last.js';
import 'core-js/modules/es.array.find-last-index.js';
import 'core-js/modules/es.typed-array.at.js';
import 'core-js/modules/es.typed-array.find-last.js';
import 'core-js/modules/es.typed-array.find-last-index.js';
import 'core-js/modules/es.string.at-alternative.js';
import 'core-js/modules/es.object.has-own.js';
import 'core-js/modules/web.structured-clone.js';
// Firefox 122, Safari 17.4.
import 'core-js/modules/es.array-buffer.transfer-to-fixed-length.js';
