import localFont from 'next/font/local';

// Self-hosted, subset woff2 files (see README.md). Exposed as CSS variables and plugged
// into the design tokens in app/globals.css. JetBrains Mono is declared with the editor (step 5),
// which loads only Plus Jakarta Sans and JetBrains Mono.

export const plusJakartaSans = localFont({
  src: './PlusJakartaSans.woff2',
  weight: '200 800',
  style: 'normal',
  display: 'swap',
  variable: '--font-plus-jakarta-sans',
});

export const sourceSerif4 = localFont({
  src: [
    { path: './SourceSerif4.woff2', weight: '200 900', style: 'normal' },
    { path: './SourceSerif4-Italic.woff2', weight: '200 900', style: 'italic' },
  ],
  display: 'swap',
  variable: '--font-source-serif-4',
});
