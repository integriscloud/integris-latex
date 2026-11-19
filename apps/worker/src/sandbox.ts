import type { EngineValue, WorkerEnv } from '@integris/shared';
import { spawn } from 'node:child_process';
import { readTar, type TarEntry, TarError } from './tar.js';

/** Engine flag understood by docker/texlive/compile.sh. */
const ENGINE_FLAGS: Record<EngineValue, string> = {
  PDFLATEX: 'pdf',
  XELATEX: 'xe',
  LUALATEX: 'lua',
};

/** Uid of the `tex` user of the image (docker/texlive/Dockerfile). */
const SANDBOX_USER = '10001:10001';

/** Time given to start and stop a gVisor container on top of the plan's duration. */
const GRACE_SECONDS = 20;

const LABEL = 'integris.compile=1';

export type SandboxRun =
  | { kind: 'finished'; exitCode: number; durationMs: number; freeKb: number; files: TarEntry[] }
  | { kind: 'timeout'; durationMs: number }
  | { kind: 'memory'; durationMs: number }
  | { kind: 'output_too_large'; durationMs: number }
  | { kind: 'failed'; detail: string };

export interface SandboxRequest {
  /** Unique container name suffix (the compilation id). */
  id: string;
  /** Worker running the container: only its own leftovers are removed on restart. */
  worker: string;
  engine: EngineValue;
  mainFile: string;
  seconds: number;
  /** Tar of the project files and the cache. */
  input: Buffer;
}

export type SandboxLimits = Pick<
  WorkerEnv,
  | 'SANDBOX_IMAGE'
  | 'SANDBOX_RUNTIME'
  | 'COMPILE_CPUS'
  | 'COMPILE_MEMORY_MB'
  | 'COMPILE_PIDS'
  | 'COMPILE_WORKDIR_MB'
  | 'COMPILE_TMP_MB'
  | 'COMPILE_MAX_PDF_MB'
>;

/**
 * `docker run` arguments of one compilation (CLAUDE.md, "Security rules"): gVisor, no network,
 * read-only root, non-root user, no capability, no privilege gain, CPU, memory (no swap),
 * process and file limits, the working directory and /tmp in size-limited memory, no log driver
 * (stdout carries the results and must not be kept by Docker), and an empty environment besides
 * the image's (HOME, TMPDIR, LANG).
 */
export function sandboxArgs(
  name: string,
  limits: SandboxLimits,
  request: SandboxRequest,
): string[] {
  const workBytes = limits.COMPILE_WORKDIR_MB * 1024 * 1024;
  return [
    'run',
    '--interactive',
    `--name=${name}`,
    `--label=${LABEL}`,
    `--label=integris.worker=${request.worker}`,
    `--runtime=${limits.SANDBOX_RUNTIME}`,
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    `--user=${SANDBOX_USER}`,
    `--cpus=${limits.COMPILE_CPUS}`,
    `--memory=${limits.COMPILE_MEMORY_MB}m`,
    `--memory-swap=${limits.COMPILE_MEMORY_MB}m`,
    `--pids-limit=${limits.COMPILE_PIDS}`,
    '--ulimit=nofile=1024:1024',
    `--ulimit=fsize=${workBytes}:${workBytes}`,
    '--ulimit=core=0:0',
    `--tmpfs=/work:rw,nosuid,nodev,size=${limits.COMPILE_WORKDIR_MB}m,mode=0700,uid=10001,gid=10001`,
    `--tmpfs=/tmp:rw,nosuid,nodev,size=${limits.COMPILE_TMP_MB}m,mode=1777`,
    '--log-driver=none',
    '--hostname=sandbox',
    // No resolver of the host shown in /etc/resolv.conf, and no shared memory segment.
    '--dns=127.0.0.1',
    '--ipc=none',
    limits.SANDBOX_IMAGE,
    ENGINE_FLAGS[request.engine],
    request.mainFile,
    String(request.seconds),
  ];
}

/** The docker CLI gets no variable of the worker (Redis and MinIO credentials) but PATH. */
const dockerEnv = () => ({ PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' });

function docker(args: string[], timeoutMs = 30_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('docker', args, { env: dockerEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < 4096) stdout += chunk;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', () => undefined);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
  });
}

/** Removes containers left by this worker when it stopped in the middle of a job. */
export async function removeLeftoverSandboxes(worker: string): Promise<number> {
  const { stdout } = await docker([
    'ps',
    '--all',
    '--quiet',
    `--filter=label=${LABEL}`,
    `--filter=label=integris.worker=${worker}`,
  ]);
  const ids = stdout.split('\n').filter(Boolean);
  if (ids.length) await docker(['rm', '--force', ...ids]);
  return ids.length;
}

function parseStatus(entry: TarEntry | undefined) {
  if (!entry) return null;
  const values = new Map(
    Buffer.from(entry.data)
      .toString('utf8')
      .split('\n')
      .map((line) => line.split('=') as [string, string]),
  );
  const number = (key: string) => {
    const value = Number(values.get(key));
    return Number.isFinite(value) ? value : null;
  };
  const exitCode = number('exit');
  const durationMs = number('ms');
  const freeKb = number('free_kb');
  return exitCode === null || durationMs === null || freeKb === null
    ? null
    : { exitCode, durationMs, freeKb };
}

/**
 * Runs one compilation in a disposable container and returns its results. stdout is read with a
 * cap (the working directory size plus a margin), the container is killed past the plan's
 * duration plus a grace period, then always removed.
 */
export async function runSandbox(
  limits: SandboxLimits,
  request: SandboxRequest,
): Promise<SandboxRun> {
  const name = `integris-compile-${request.id}`;
  // The PDF, the log (cut at 8 MB by compile.sh), SyncTeX and the cache (files under 5 MB).
  const maxOutput = (limits.COMPILE_MAX_PDF_MB + 128) * 1024 * 1024;
  const started = Date.now();
  const elapsed = () => Date.now() - started;

  const chunks: Buffer[] = [];
  let outputBytes = 0;
  let overflow = false;
  let timedOut = false;

  const code = await new Promise<number | 'spawn_error'>((resolve) => {
    const child = spawn('docker', sandboxArgs(name, limits, request), {
      env: dockerEnv(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const kill = () => {
      void docker(['kill', name]);
      // If the docker CLI itself hangs, the job slot must still come back.
      setTimeout(() => child.kill('SIGKILL'), 15_000).unref();
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        kill();
      },
      (request.seconds + GRACE_SECONDS) * 1000,
    );
    child.stdout.on('data', (chunk: Buffer) => {
      if (overflow) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutput) {
        overflow = true;
        chunks.length = 0;
        kill();
        return;
      }
      chunks.push(chunk);
    });
    // The container may stop before reading all its input (invalid archive): not an error here.
    child.stdin.on('error', () => undefined);
    child.stdin.end(request.input);
    child.on('error', () => {
      clearTimeout(timer);
      resolve('spawn_error');
    });
    child.on('close', (exit) => {
      clearTimeout(timer);
      resolve(exit ?? -1);
    });
  });

  try {
    if (code === 'spawn_error') return { kind: 'failed', detail: 'docker could not be started' };
    const inspect = await docker(['inspect', '--format={{.State.OOMKilled}}', name]);
    if (inspect.stdout.trim() === 'true') return { kind: 'memory', durationMs: elapsed() };
    if (overflow) return { kind: 'output_too_large', durationMs: elapsed() };
    if (timedOut) return { kind: 'timeout', durationMs: request.seconds * 1000 };
    if (code !== 0) return { kind: 'failed', detail: `sandbox exited with ${code}` };

    let files: TarEntry[];
    try {
      const output = Buffer.concat(chunks);
      chunks.length = 0;
      files = readTar(output, {
        maxEntries: 5000,
        maxEntryBytes: limits.COMPILE_WORKDIR_MB * 1024 * 1024,
      });
    } catch (error) {
      return { kind: 'failed', detail: error instanceof TarError ? error.message : 'bad output' };
    }
    const status = parseStatus(files.find((entry) => entry.name === 'status'));
    if (!status) return { kind: 'failed', detail: 'no status' };
    // timeout(1) exits with 124 after TERM, 137 when KILL was needed.
    if (status.exitCode === 124 || status.exitCode === 137) {
      return { kind: 'timeout', durationMs: status.durationMs };
    }
    return {
      kind: 'finished',
      exitCode: status.exitCode,
      durationMs: status.durationMs,
      freeKb: status.freeKb,
      files: files.filter((entry) => entry.name.startsWith('work/')),
    };
  } finally {
    await docker(['rm', '--force', name]);
  }
}
