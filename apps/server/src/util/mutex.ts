/**
 * Per-key async mutex: serializes all commands of one session so concurrent
 * taps / retries / background jobs can never interleave and corrupt state.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  isLocked(key: string): boolean {
    return this.tails.has(key);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry with exponential backoff. */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { retries: number; baseMs?: number; maxMs?: number; shouldRetry?: (err: unknown) => boolean; onRetry?: (err: unknown, attempt: number) => void },
): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.retries || (opts.shouldRetry && !opts.shouldRetry(err))) throw err;
      opts.onRetry?.(err, attempt);
      await sleep(Math.min(opts.maxMs ?? 10000, (opts.baseMs ?? 300) * 2 ** attempt));
      attempt++;
    }
  }
}
