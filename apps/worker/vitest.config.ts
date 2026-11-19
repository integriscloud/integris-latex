import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The malicious suite and the thesis test (sandbox-tests/) need Docker and gVisor:
    // pnpm test:malicious, pnpm test:thesis.
    include: ['src/**/*.test.ts'],
  },
});
