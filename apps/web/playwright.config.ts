import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // One worker: every test comes from 127.0.0.1, and the anti-abuse counters per IP (failed codes,
  // CAPTCHA) of one suite would otherwise disturb the sign-ups of another.
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'pnpm start',
        url: 'http://127.0.0.1:3000',
        reuseExistingServer: true,
      },
});
