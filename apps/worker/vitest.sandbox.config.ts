import { defineConfig } from 'vitest/config';

// Malicious suite and 80-page thesis: real gVisor sandboxes (Docker, runsc and the TeX Live image
// required, pnpm texlive:build).
export default defineConfig({
  test: {
    include: ['sandbox-tests/**/*.test.ts'],
    maxConcurrency: 4,
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // The suites print their report (outcomes, durations) at the end.
    silent: false,
  },
});
