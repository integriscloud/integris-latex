import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';

/**
 * Compile job processor. Compilation (step 6) runs latexmk inside a disposable gVisor container,
 * never in this process. Until then every job fails without retry.
 */
export async function processCompileJob(job: Job): Promise<never> {
  throw new UnrecoverableError(`Compilation is not implemented yet (step 6), job ${job.id}.`);
}
