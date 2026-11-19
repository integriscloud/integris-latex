import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';
import { outdatedBrowserScript } from './outdated';

const MINIMUMS = { chrome: 120, firefox: 120, samsung: 24, ios: 15 };
const script = outdatedBrowserScript(MINIMUMS);

/** Runs the script for a user agent; true when it shows the banner. */
function shows(userAgent: string, extra: { maxTouchPoints?: number; fetch?: boolean } = {}) {
  let shown = false;
  const banner = { removeAttribute: () => (shown = true) };
  const window = {
    Promise,
    fetch: extra.fetch === false ? undefined : () => undefined,
  };
  new Function('navigator', 'document', 'window', script)(
    { userAgent, maxTouchPoints: extra.maxTouchPoints ?? 0 },
    { getElementById: () => banner },
    window,
  );
  return shown;
}

const chrome = (version: number) =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`;

describe('outdated browser banner', () => {
  it('is plain ES5, so it runs where the app bundles cannot', () => {
    expect(() => parse(script, { ecmaVersion: 5 })).not.toThrow();
  });

  it('compares Chrome, Android WebView and Chromium-based browsers by their engine', () => {
    expect(shows(chrome(119))).toBe(true);
    expect(shows(chrome(120))).toBe(false);
    expect(
      shows(
        'Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.5481.153 Mobile Safari/537.36',
      ),
    ).toBe(true);
    expect(shows(`${chrome(131)} Edg/131.0.0.0`)).toBe(false);
  });

  it('uses the Samsung Internet version, not its Chrome engine', () => {
    const samsung = (version: number, engine: number) =>
      `Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/${version}.0 Chrome/${engine}.0.0.0 Mobile Safari/537.36`;
    expect(shows(samsung(24, 117))).toBe(false);
    expect(shows(samsung(23, 115))).toBe(true);
  });

  it('checks Firefox and KaiOS', () => {
    const firefox = (version: number) =>
      `Mozilla/5.0 (X11; Linux x86_64; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`;
    expect(shows(firefox(115))).toBe(true);
    expect(shows(firefox(143))).toBe(false);
    expect(
      shows('Mozilla/5.0 (Mobile; LYF/F300B/LYF-F300B; rv:48.0) Gecko/48.0 Firefox/48.0 KAIOS/2.5'),
    ).toBe(true);
  });

  it('checks the iOS version for every browser of an iPhone or iPad', () => {
    const iphone = (os: string, browser = 'Version/15.0 Mobile/15E148 Safari/604.1') =>
      `Mozilla/5.0 (iPhone; CPU iPhone OS ${os} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ${browser}`;
    expect(shows(iphone('15_0'))).toBe(false);
    expect(shows(iphone('14_8'))).toBe(true);
    expect(shows(iphone('14_8', 'CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1'))).toBe(true);
    // An iPad asks for the desktop site: a Mac agent, with touch.
    const ipad =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1 Safari/605.1.15';
    expect(shows(ipad, { maxTouchPoints: 5 })).toBe(true);
  });

  it('always shows it to Opera Mini and UC Browser', () => {
    expect(
      shows(
        'Opera/9.80 (Android; Opera Mini/7.6.40234/191.308; U; fr) Presto/2.12.423 Version/12.16',
      ),
    ).toBe(true);
    expect(
      shows(
        'Mozilla/5.0 (Linux; U; Android 10; en-US; SM-A105F) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 UCBrowser/13.4.0.1306 Mobile Safari/537.36',
      ),
    ).toBe(true);
  });

  it('trusts an unknown browser unless it lacks basic features', () => {
    expect(shows('SomeBrowser/1.0')).toBe(false);
    expect(shows('SomeBrowser/1.0', { fetch: false })).toBe(true);
  });
});
