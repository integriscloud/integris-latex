import localFont from 'next/font/local';

// Titles and documents (see fonts.ts). Imported by the site layout only, never by the editor.

export const sourceSerif4 = localFont({
  src: [
    { path: './SourceSerif4.woff2', weight: '200 900', style: 'normal' },
    { path: './SourceSerif4-Italic.woff2', weight: '200 900', style: 'italic' },
  ],
  display: 'swap',
  variable: '--font-source-serif-4',
});
