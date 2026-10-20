// Sets up many sensors with one tap: a queue run a few at a time. A failure that holds for every sensor (the site
// password, the technician token) stops new starts; one that belongs to a single sensor does not.
import type { SetupFailure, SetupResult } from './setup.ts';

export type BatchState = 'queued' | 'running' | 'ok' | 'failed' | 'stopped';
export type BatchEntry = { state: BatchState; reason?: SetupFailure; ipv4?: string };
export type BatchSummary = { ok: number; failed: number; stopped: number; stopReason?: SetupFailure };

/** Failures that would repeat on every remaining sensor (`locked`: leaving the app locked the code and the site password). */
export const STOPS_BATCH: readonly SetupFailure[] = ['WrongPsk', 'token-invalid', 'token-expired', 'locked'];
export const BATCH_CONCURRENCY = 3; // three BLE links at once; raise after measuring on real phones and APs

export async function runBatch(
  ids: string[],
  setupOne: (id: string) => Promise<SetupResult>,
  onChange: (id: string, entry: BatchEntry) => void,
  concurrency = BATCH_CONCURRENCY,
): Promise<BatchSummary> {
  const queue = [...ids];
  const summary: BatchSummary = { ok: 0, failed: 0, stopped: 0 };
  ids.forEach(id => onChange(id, { state: 'queued' }));
  const worker = async () => {
    // Check for a stop before taking the next sensor, so none is taken and then dropped.
    while (!summary.stopReason) {
      const id = queue.shift();
      if (id === undefined) return;
      onChange(id, { state: 'running' });
      let result: SetupResult;
      try {
        result = await setupOne(id); // inside the try: a synchronous throw is one failed sensor too
      } catch {
        result = { ok: false, step: 'connect', reason: 'rejected' };
      }
      if (result.ok) {
        summary.ok++;
        onChange(id, { state: 'ok', ipv4: result.ipv4 });
      } else {
        summary.failed++;
        onChange(id, { state: 'failed', reason: result.reason });
        if (STOPS_BATCH.includes(result.reason)) summary.stopReason ??= result.reason;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  for (const id of queue) {
    summary.stopped++;
    onChange(id, { state: 'stopped', reason: summary.stopReason });
  }
  return summary;
}
