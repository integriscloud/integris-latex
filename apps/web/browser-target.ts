import browserslist from 'browserslist';
import type { BrowserMinimums } from './src/lib/browsers/outdated';

/**
 * Oldest version of each engine family in .browserslistrc (docs/spec.md, "Navigateurs"), read
 * when the app is built. Android versions follow the desktop Chrome and Firefox numbers.
 */
export function browserMinimums(): BrowserMinimums {
  const oldest = (names: string[]) => {
    const versions = browserslist(undefined, { path: import.meta.dirname })
      .map((entry) => entry.split(' '))
      .filter(([name]) => names.includes(name!))
      // "15.0-15.1": the first version of a range.
      .map(([, version]) => parseFloat(version!.split('-')[0]!));
    if (!versions.length) throw new Error(`.browserslistrc has no ${names.join('/')} version`);
    return Math.min(...versions);
  };
  return {
    chrome: oldest(['chrome', 'and_chr', 'android']),
    firefox: oldest(['firefox', 'and_ff']),
    samsung: oldest(['samsung']),
    ios: oldest(['ios_saf']),
  };
}
