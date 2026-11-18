import localFont from 'next/font/local';

// Self-hosted, subset woff2 files (see README.md). Exposed as CSS variables and plugged
// into the design tokens in app/globals.css. JetBrains Mono (code, SMS code boxes) is not
// preloaded: browsers fetch it only on pages that use it. Source Serif 4 lives in serif.ts so
// that the editor page, which only loads these two faces, never imports it.

export const plusJakartaSans = localFont({
  src: './PlusJakartaSans.woff2',
  weight: '200 800',
  style: 'normal',
  display: 'swap',
  variable: '--font-plus-jakarta-sans',
});

export const jetBrainsMono = localFont({
  src: './JetBrainsMono.woff2',
  weight: '100 800',
  style: 'normal',
  display: 'swap',
  preload: false,
  variable: '--font-jetbrains-mono',
});
