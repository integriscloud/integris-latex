/**
 * Oldest version of each engine family in the browser target (.browserslistrc, docs/spec.md,
 * "Navigateurs"), computed when the app is built (next.config.ts) and compared with the
 * browser's user agent by `outdatedBrowserScript`.
 */
export interface BrowserMinimums {
  /** Chrome, Chrome for Android, Android WebView, and Chromium-based browsers by their engine. */
  chrome: number;
  firefox: number;
  samsung: number;
  /** iOS (every browser of an iPhone or iPad uses the system's WebKit). */
  ios: number;
}

/** Element of the outdated-browser banner, hidden until the script shows it. */
export const OUTDATED_BANNER_ID = 'outdated-browser';

/** The minimums inlined in the build by next.config.ts. */
export function buildMinimums(): BrowserMinimums {
  return JSON.parse(process.env.BROWSER_MINIMUMS ?? '{}') as BrowserMinimums;
}

/**
 * Inline script of every page: shows the banner in a browser older than the target, or one that
 * is known to be too limited (Opera Mini, UC Browser). It is written in ES5 because it must run
 * where the app's bundles cannot, and it never blocks the page: an unknown browser is trusted
 * unless it lacks basic features. Each family is tested before the generic Chrome version,
 * since Samsung Internet, iOS browsers and others also name Chrome or Safari in their agent.
 */
export function outdatedBrowserScript(minimums: BrowserMinimums): string {
  return `(function () {
  try {
    var min = ${JSON.stringify(minimums)};
    var ua = navigator.userAgent;
    var version = function (pattern) {
      var match = pattern.exec(ua);
      return match ? parseFloat(match[1] + '.' + (match[2] || '0')) : null;
    };
    var old = false;
    var found;
    if (/Opera Mini|OPiOS|UCBrowser|UCWEB|UBrowser\\//.test(ua)) {
      old = true;
    } else if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
      found = version(/OS (\\d+)_(\\d+)/);
      if (found === null) found = version(/Version\\/(\\d+)\\.?(\\d+)?/);
      old = found !== null && found < min.ios;
    } else if ((found = version(/SamsungBrowser\\/(\\d+)/)) !== null) {
      old = found < min.samsung;
    } else if ((found = version(/Firefox\\/(\\d+)/)) !== null) {
      old = found < min.firefox;
    } else if ((found = version(/Chrom(?:e|ium)\\/(\\d+)/)) !== null) {
      old = found < min.chrome;
    } else if (/Safari\\//.test(ua) && (found = version(/Version\\/(\\d+)\\.?(\\d+)?/)) !== null) {
      old = found < min.ios;
    }
    if (!old && !(window.Promise && window.fetch && Array.prototype.includes)) old = true;
    if (old) document.getElementById('${OUTDATED_BANNER_ID}').removeAttribute('hidden');
  } catch (error) {}
})();`;
}
