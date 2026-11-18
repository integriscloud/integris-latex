import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveQueue, type SaveSnapshot, type SendResult, worstStatus } from './save-queue';

type Send = (text: string, etag: string) => Promise<SendResult>;

function setup(send: Send) {
  const states: SaveSnapshot[] = [];
  const spy = vi.fn(send);
  const queue = new SaveQueue({
    text: 'v0',
    etag: 'e0',
    send: spy,
    onChange: (state) => states.push(state),
  });
  return { queue, send: spy, last: () => states.at(-1)! };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('SaveQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves 2 s after the last keystroke with the version it is based on', async () => {
    let n = 0;
    const { queue, send, last } = setup(async () => ({ ok: true, etag: `e${++n}` }));
    queue.edit('v1');
    await vi.advanceTimersByTimeAsync(1500);
    queue.edit('v2');
    await vi.advanceTimersByTimeAsync(1999);
    expect(send).not.toHaveBeenCalled();
    expect(last()).toEqual({ status: 'pending', dirty: true, errorCode: undefined });
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledExactlyOnceWith('v2', 'e0');
    expect(last()).toMatchObject({ status: 'saved', dirty: false });
    queue.edit('v3');
    queue.saveNow();
    await flush();
    expect(send).toHaveBeenLastCalledWith('v3', 'e1');
  });

  it('goes back to saved when the text returns to the stored one', async () => {
    const { queue, send, last } = setup(async () => ({ ok: true, etag: 'e1' }));
    queue.edit('v1');
    queue.edit('v0');
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).not.toHaveBeenCalled();
    expect(last().status).toBe('saved');
  });

  it('saves again what was typed during a request', async () => {
    let resolve!: (result: SendResult) => void;
    const { queue, send, last } = setup(() => new Promise<SendResult>((done) => (resolve = done)));
    queue.edit('v1');
    queue.saveNow();
    expect(last().status).toBe('saving');
    queue.edit('v2');
    queue.saveNow();
    resolve({ ok: true, etag: 'e1' });
    await flush();
    expect(send).toHaveBeenLastCalledWith('v2', 'e1');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps the text offline and retries with a growing delay', async () => {
    let online = false;
    const { queue, send, last } = setup(async (text) =>
      online ? { ok: true, etag: `saved:${text}` } : { ok: false, reason: 'network' },
    );
    queue.edit('v1');
    queue.saveNow();
    await flush();
    expect(last()).toMatchObject({ status: 'offline', dirty: true });
    await vi.advanceTimersByTimeAsync(1000); // 2nd try
    await vi.advanceTimersByTimeAsync(2000); // 3rd try
    expect(send).toHaveBeenCalledTimes(3);
    queue.edit('v2');
    await vi.advanceTimersByTimeAsync(3999);
    expect(send).toHaveBeenCalledTimes(3);
    online = true;
    await vi.advanceTimersByTimeAsync(1); // 4 s after the 3rd try
    expect(send).toHaveBeenLastCalledWith('v2', 'e0');
    expect(last()).toMatchObject({ status: 'saved', dirty: false });
  });

  it('caps the retry delay and retries at once when the browser is back online', async () => {
    let online = false;
    const { queue, send } = setup(async () =>
      online ? { ok: true, etag: 'e1' } : { ok: false, reason: 'network' },
    );
    queue.edit('v1');
    queue.saveNow();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 16000);
    expect(send).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(7);
    online = true;
    queue.online();
    await flush();
    expect(send).toHaveBeenCalledTimes(8);
  });

  it('stops on a conflict until the user reloads or overwrites', async () => {
    const results: SendResult[] = [
      { ok: false, reason: 'conflict' },
      { ok: true, etag: 'e2' },
    ];
    const { queue, send, last } = setup(async () => results.shift()!);
    queue.edit('mine');
    queue.saveNow();
    await flush();
    expect(last().status).toBe('conflict');
    queue.edit('mine 2');
    queue.saveNow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
    queue.overwrite('e1');
    await flush();
    expect(send).toHaveBeenLastCalledWith('mine 2', 'e1');
    expect(last().status).toBe('saved');

    queue.reload('theirs', 'e9');
    expect(last()).toMatchObject({ status: 'saved', dirty: false });
    expect(queue.version).toBe('e9');
  });

  it('keeps a refusal until a manual retry', async () => {
    const results: SendResult[] = [
      { ok: false, reason: 'error', code: 'storage_limit' },
      { ok: true, etag: 'e1' },
    ];
    const { queue, send, last } = setup(async () => results.shift()!);
    queue.edit('v1');
    queue.saveNow();
    await flush();
    expect(last()).toMatchObject({ status: 'error', errorCode: 'storage_limit' });
    queue.edit('v2');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
    queue.saveNow();
    await flush();
    expect(last()).toMatchObject({ status: 'saved', errorCode: undefined });
  });

  it('reports the status needing most attention', () => {
    expect(worstStatus(['saved', 'pending'])).toBe('pending');
    expect(worstStatus(['offline', 'saving', 'conflict'])).toBe('conflict');
    expect(worstStatus([])).toBe('saved');
  });
});
