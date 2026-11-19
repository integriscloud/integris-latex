import { defineConfig, devices } from '@playwright/test';
import { existsSync } from 'node:fs';
import { chromium as chromium120 } from 'playwright-chromium-120';

const rootEnv = new URL('../../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

// e2e/https-front.mjs serves the public HTTPS URLs of the app and the files domain locally
// (latex-dev cannot reach its own public IP). Browsers use it as their proxy; Chrome never
// proxies 127.0.0.1, so the app itself is still reached directly by desktop and mobile.
const publicUrl = process.env.PUBLIC_WEB_URL ?? '';
const filesUrl = process.env.FILES_PUBLIC_URL ?? 'http://127.0.0.1:4100';
const frontPort = 3444;
const front = publicUrl.startsWith('https://');
const throughFront = front
  ? {
      proxy: { server: `http://127.0.0.1:${frontPort}`, bypass: '127.0.0.1,localhost' },
      ignoreHTTPSErrors: true,
    }
  : {};

export default defineConfig({
  testDir: './e2e',
  // One worker: every test comes from 127.0.0.1, and the anti-abuse counters per IP (failed codes,
  // CAPTCHA) of one suite would otherwise disturb the sign-ups of another.
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], ...throughFront } },
    { name: 'mobile', use: { ...devices['Pixel 7'], ...throughFront } },
    // Oldest Chrome of the browser target (docs/spec.md, "Navigateurs"): the Chromium 120 of
    // Playwright 1.40. It drops Secure cookies over plain HTTP, so it opens the app at its
    // public HTTPS URL through the front.
    ...(front
      ? [
          {
            name: 'chromium-120',
            // The journeys that load the heaviest browser code: editor, PDF.js, SyncTeX.
            testMatch: /(compile|editor)\.spec\.ts/,
            use: {
              ...devices['Desktop Chrome'],
              ...throughFront,
              baseURL: publicUrl,
              launchOptions: { executablePath: chromium120.executablePath() },
            },
          },
        ]
      : []),
  ],
  webServer: [
    ...(process.env.E2E_BASE_URL
      ? []
      : [{ command: 'pnpm start', url: 'http://127.0.0.1:3000', reuseExistingServer: true }]),
    ...(front
      ? [
          {
            command: `node e2e/https-front.mjs ${publicUrl} ${filesUrl} ${frontPort}`,
            port: frontPort,
            reuseExistingServer: true,
          },
        ]
      : []),
  ],
});
