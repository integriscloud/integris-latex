import { parseEnv, workerEnvSchema } from '@integris/shared';
import { describe, expect, it } from 'vitest';
import { sandboxArgs } from './sandbox.js';

describe('sandboxArgs', () => {
  const env = parseEnv(workerEnvSchema, {
    REDIS_URL: 'redis://127.0.0.1:6379',
    MINIO_WORKER_ACCESS_KEY: 'test',
    MINIO_WORKER_SECRET_KEY: 'test-secret',
  });
  const args = sandboxArgs('integris-compile-c1', env, {
    id: 'c1',
    worker: 'compile-1',
    engine: 'LUALATEX',
    mainFile: 'chapitres/main.tex',
    seconds: 120,
    input: Buffer.alloc(0),
  });

  it('isolates the compilation as CLAUDE.md requires', () => {
    for (const flag of [
      '--runtime=runsc',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--user=10001:10001',
      '--cpus=2',
      '--memory=2048m',
      '--memory-swap=2048m',
      '--pids-limit=128',
      '--log-driver=none',
      '--ipc=none',
      '--label=integris.worker=compile-1',
    ]) {
      expect(args).toContain(flag);
    }
    expect(args).toContain(
      '--tmpfs=/work:rw,nosuid,nodev,size=1024m,mode=0700,uid=10001,gid=10001',
    );
    // No variable of the worker reaches the container, and nothing is mounted from the host.
    expect(args.some((arg) => arg.startsWith('--env') || arg.startsWith('-e'))).toBe(false);
    expect(args.some((arg) => arg.startsWith('--volume') || arg.startsWith('--mount'))).toBe(false);
  });

  it('passes the engine, the main file and the duration last, after the image', () => {
    expect(args.slice(-4)).toEqual(['integris/texlive:2026', 'lua', 'chapitres/main.tex', '120']);
  });
});
