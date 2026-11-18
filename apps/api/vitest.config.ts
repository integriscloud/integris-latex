import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC emits decorator metadata, which Nest dependency injection needs.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts'],
    // Auth tests share the Redis test database (db 15) and flush it.
    fileParallelism: false,
  },
});
