import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ['@integris/ui'],
  // The dev server is reached through the Nginx preview host on latex-dev.
  allowedDevOrigins: ['test-latex.integriscloud.com'],
};

export default withNextIntl(nextConfig);
