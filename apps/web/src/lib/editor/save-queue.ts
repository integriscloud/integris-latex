/** Where the content of an open file stands against the stored version. */
export type SaveStatus = 'saved' | 'pending' | 'saving' | 'offline' | 'conflict' | 'error';

export type SendResult =
  | { ok: true; etag: string }
  /** No answer (network down, proxy error): retried automatically. */
  | { ok: false; reason: 'network' }
  /** The stored file changed since `etag`: the user decides. */
  | { ok: false; reason: 'conflict' }
  /** Refused for good (rights, quota, size…): retried only on demand. */
  | { ok: false; reason: 'error'; code: string };

export interface SaveSnapshot {
  status: SaveStatus;
  /** Unsaved changes are kept in memory. */
  dirty: boolean;
  errorCode?: string;
}

export interface SaveQueueOptions {
  text: string;
  etag: string;
  send: (text: string, etag: string) => Promise<SendResult>;
  onChange: (snapshot: SaveSnapshot) => void;
  /** Quiet time after the last keystroke before saving. */
  debounceMs?: number;
  /** First retry delay when offline, doubled on each failure up to `retryMaxMs`. */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

/**
 * Saves one file of the editor: 2 s after the last keystroke or at once on demand (Ctrl+S), one
 * request at a time, always sending the latest text with the version it is based on. Network
 * failures keep the text in memory and retry with a growing delay; a conflict or a refusal stops
 * until the user acts. Nothing is written to the device (offline mode is out of V1).
 */
export class SaveQueue {
  private text: string;
  /** Text known to be stored; null forces a save (conflict resolved by keeping this version). */
  private savedText: string | null;
  private etag: string;
  private status: SaveStatus = 'saved';
  private errorCode: string | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private saveAfterFlight = false;
  private failures = 0;
  private disposed = false;
  /** Callers of `flush` waiting for the outcome of the save. */
  private waiters: ((saved: boolean) => void)[] = [];
  private readonly debounceMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(private readonly options: SaveQueueOptions) {
    this.text = options.text;
    this.savedText = options.text;
    this.etag = options.etag;
    this.debounceMs = options.debounceMs ?? 2000;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
  }

  get dirty(): boolean {
    return this.text !== this.savedText;
  }

  get snapshot(): SaveSnapshot {
    return { status: this.status, dirty: this.dirty, errorCode: this.errorCode };
  }

  /** Version the next save is based on. */
  get version(): string {
    return this.etag;
  }

  /** The text changed in the editor. */
  edit(text: string): void {
    if (this.disposed) return;
    this.text = text;
    // Offline: the retry timer sends the latest text. Conflict or refusal: wait for the user.
    if (this.status === 'offline' || this.status === 'conflict' || this.status === 'error') {
      this.emit();
      return;
    }
    if (this.inFlight) {
      this.emit();
      return;
    }
    if (!this.dirty) {
      this.clearTimer();
      this.status = 'saved';
    } else {
      this.status = 'pending';
      this.schedule(this.debounceMs);
    }
    this.emit();
  }

  /** Save at once (Ctrl+S, "Retry"). Does nothing during a conflict. */
  saveNow(): void {
    if (this.disposed || this.status === 'conflict') return;
    if (this.inFlight) {
      this.saveAfterFlight = true;
      return;
    }
    if (this.status === 'error') {
      this.status = 'pending';
      this.errorCode = undefined;
    }
    this.clearTimer();
    void this.run();
  }

  /**
   * Saves at once and resolves with true once the text is stored, or false when it cannot be now
   * (offline, conflict, refused): a compilation must use what the user sees.
   */
  flush(): Promise<boolean> {
    if (this.disposed || this.status === 'conflict') return Promise.resolve(false);
    if (!this.dirty && !this.inFlight) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.waiters.push(resolve);
      this.saveNow();
    });
  }

  /** The browser is back online: retry without waiting for the next delay. */
  online(): void {
    if (this.status === 'offline' && !this.inFlight) {
      this.clearTimer();
      void this.run();
    }
  }

  /** Conflict resolved by loading the stored version: the local changes are dropped. */
  reload(text: string, etag: string): void {
    this.clearTimer();
    this.text = text;
    this.savedText = text;
    this.etag = etag;
    this.status = 'saved';
    this.errorCode = undefined;
    this.failures = 0;
    this.emit();
  }

  /** Conflict resolved by keeping the local text: saved on top of the stored version `etag`. */
  overwrite(etag: string): void {
    this.etag = etag;
    this.savedText = null;
    this.status = 'pending';
    this.errorCode = undefined;
    this.saveNow();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.settle(false);
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    if (this.inFlight || this.disposed) return;
    if (!this.dirty) {
      this.status = 'saved';
      this.emit();
      return;
    }
    const sent = this.text;
    this.inFlight = true;
    this.saveAfterFlight = false;
    this.status = 'saving';
    this.emit();
    let result: SendResult;
    try {
      result = await this.options.send(sent, this.etag);
    } catch {
      result = { ok: false, reason: 'network' };
    }
    this.inFlight = false;
    if (this.disposed) return;

    if (result.ok) {
      this.etag = result.etag;
      this.savedText = sent;
      this.failures = 0;
      if (!this.dirty) {
        this.status = 'saved';
      } else {
        // Typed during the request: save again after the usual quiet time (or now if asked).
        this.status = 'pending';
        this.schedule(this.saveAfterFlight ? 0 : this.debounceMs);
      }
    } else if (result.reason === 'network') {
      this.failures++;
      this.status = 'offline';
      this.schedule(Math.min(this.retryBaseMs * 2 ** (this.failures - 1), this.retryMaxMs));
    } else if (result.reason === 'conflict') {
      this.status = 'conflict';
    } else {
      this.status = 'error';
      this.errorCode = result.code;
    }
    this.emit();
  }

  private emit(): void {
    this.options.onChange(this.snapshot);
    if (this.status === 'saved' && !this.dirty) this.settle(true);
    else if (['offline', 'conflict', 'error'].includes(this.status)) this.settle(false);
  }

  private settle(saved: boolean): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve(saved);
  }
}

const STATUS_WEIGHT: Record<SaveStatus, number> = {
  saved: 0,
  pending: 1,
  saving: 2,
  offline: 3,
  error: 4,
  conflict: 5,
};

/** The status shown for several open files: the one that needs attention most. */
export function worstStatus(statuses: Iterable<SaveStatus>): SaveStatus {
  let worst: SaveStatus = 'saved';
  for (const status of statuses) if (STATUS_WEIGHT[status] > STATUS_WEIGHT[worst]) worst = status;
  return worst;
}
