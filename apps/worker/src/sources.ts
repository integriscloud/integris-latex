import {
  allowedExtensionOf,
  type CompileJob,
  MAX_PROJECT_FILE_BYTES,
  normalizeProjectPath,
} from '@integris/shared';
import type { TarEntry } from './tar.js';

/** Why the sources of a job could not be used. */
export class SourcesError extends Error {
  constructor(
    readonly reason: 'invalid' | 'unavailable',
    message: string,
  ) {
    super(message);
  }
}

const PARALLEL_DOWNLOADS = 8;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Reads a response body, failing as soon as it goes over `size` bytes; it must be exactly `size`. */
async function readExactly(response: Response, size: number): Promise<Uint8Array> {
  const data = new Uint8Array(size);
  let received = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new SourcesError('unavailable', 'Empty response');
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.length > size) {
      await reader.cancel();
      throw new SourcesError('invalid', 'File larger than announced');
    }
    data.set(value, received);
    received += value.length;
  }
  if (received !== size) throw new SourcesError('invalid', 'File smaller than announced');
  return data;
}

/**
 * Downloads the project files of a job through their presigned URLs. Each path must be a
 * normalized project path with an allowed extension, each size at most 10 MB and the total at
 * most `maxTotalBytes`; URLs must point at the configured MinIO (no redirect followed). Nothing is
 * written to disk: the files go into the sandbox as a tar on its stdin.
 */
export async function downloadSources(
  job: CompileJob,
  options: { minioOrigin: string; maxTotalBytes: number },
): Promise<TarEntry[]> {
  const paths = new Set<string>();
  let total = 0;
  for (const file of job.files) {
    if (normalizeProjectPath(file.path) !== file.path || !allowedExtensionOf(file.path)) {
      throw new SourcesError('invalid', 'Invalid file path');
    }
    if (paths.has(file.path)) throw new SourcesError('invalid', 'Duplicate file path');
    paths.add(file.path);
    if (file.size > MAX_PROJECT_FILE_BYTES) throw new SourcesError('invalid', 'File too large');
    total += file.size;
    if (new URL(file.url).origin !== options.minioOrigin) {
      throw new SourcesError('invalid', 'File URL outside the storage');
    }
  }
  if (total > options.maxTotalBytes) throw new SourcesError('invalid', 'Project too large');

  const entries: TarEntry[] = new Array<TarEntry>(job.files.length);
  let next = 0;
  let failed = false;
  const download = async () => {
    while (next < job.files.length && !failed) {
      const index = next++;
      const file = job.files[index]!;
      let response: Response;
      try {
        response = await fetch(file.url, {
          redirect: 'error',
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch {
        throw new SourcesError('unavailable', 'Download failed');
      }
      // An expired link (the job waited more than 5 minutes) answers 403.
      if (!response.ok) {
        await response.body?.cancel();
        throw new SourcesError('unavailable', `Download answered ${response.status}`);
      }
      entries[index] = { name: file.path, data: await readExactly(response, file.size) };
    }
  };
  // The first failure stops the other downloads.
  await Promise.all(
    Array.from({ length: PARALLEL_DOWNLOADS }, () =>
      download().catch((error: unknown) => {
        failed = true;
        throw error;
      }),
    ),
  );
  return entries;
}
