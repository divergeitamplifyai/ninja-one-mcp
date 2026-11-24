/**
 * Cross-organization fan-out with a concurrency cap.
 *
 * MSP questions ("which clients are exposed to X?") read every organization.
 * Unbounded parallelism trips the vendor's rate limit for every integration on
 * the account, and one failing organization must not sink the whole answer. So
 * work runs at most `limit` at a time, and each organization gets its own row:
 * a value, or the error that stopped it.
 */

import { formatError } from './errors.js';

export type FanOutRow<T, R> = { item: T; ok: true; value: R } | { item: T; ok: false; error: string };

export async function fanOut<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<FanOutRow<T, R>[]> {
  const rows = new Array<FanOutRow<T, R>>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      const item = items[index] as T;
      try {
        rows[index] = { item, ok: true, value: await work(item) };
      } catch (error) {
        rows[index] = { item, ok: false, error: formatError(error) };
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker());
  await Promise.all(workers);
  return rows;
}
