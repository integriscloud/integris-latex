import { API_PREFIX, parseEnv, PORTS, webEnvSchema } from '@integris/shared';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@integris/ui'],
  // The dev server is reached through the Nginx preview host on latex-dev.
  allowedDevOrigins: ['test-latex.integriscloud.com'],
  // Browser calls go to the same origin. Nginx routes /api/ to the API before Next.js; this
  // rewrite does the same when the web app is reached directly (local runs, Playwright).
  async rewrites() {
    const { API_INTERNAL_URL } = parseEnv(webEnvSchema, process.env);
    const api = API_INTERNAL_URL ?? `http://127.0.0.1:${PORTS.api}`;
    return [{ source: `/${API_PREFIX}/:path*`, destination: `${api}/${API_PREFIX}/:path*` }];
  },
  experimental: {
    // `/API/…` must not match the rewrite: Nginx matches `/api/` case-sensitively, so a
    // case-insensitive rewrite would let requests skip the Nginx rules for the API.
    caseSensitiveRoutes: true,
  },
  // No page may be framed by another site (clickjacking on sign-in and account pages).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
