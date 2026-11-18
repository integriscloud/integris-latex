import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { processCompileJob } from './compile.js';

describe('processCompileJob', () => {
  it('fails without retry until compilation exists', async () => {
    const job = { id: '42' } as Job;
    await expect(processCompileJob(job)).rejects.toBeInstanceOf(UnrecoverableError);
  });
});
