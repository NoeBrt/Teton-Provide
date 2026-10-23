// Sets up many sensors with one tap: a queue run a few at a time. A failure that holds for every sensor (the site
// password, the technician token) stops new starts; one that belongs to a single sensor does not.
import type { SetupFailure, SetupResult, SetupStep } from './setup.ts';

export type BatchState = 'queued' | 'running' | 'ok' | 'failed' | 'stopped';
// `step`: where a failure happened, so a timeout reads as "not responding" or "did not join" (setup.ts).
export type BatchEntry = { state: BatchState; reason?: SetupFailure; step?: SetupStep; ipv4?: string };
export type BatchSummary = { ok: number; failed: number; stopped: number; stopReason?: SetupFailure };

/** Failures that would repeat on every remaining sensor (`locked`: leaving the app locked the code and the site password). */
export const STOPS_BATCH: readonly SetupFailure[] = ['WrongPsk', 'token-invalid', 'token-expired', 'locked'];
/** Link failures (nothing settled on the sensor): it goes back to the end of the queue, resumed with the same attempt
 * by the flow, up to RETRIES more times; only then does it count as failed. Wi-Fi failures and refusals are final. */
export const RETRIED: readonly SetupFailure[] = ['timeout', 'rejected', 'unidentified', 'Busy', 'unknown'];
export const RETRIES = 2;
// Six BLE links at once: the join (~5.5 s) dominates and iOS holds more links; to confirm on the noe-lab test bench
// (tools/iot_sim.py) and with real sensors, since the links share one radio.
export const BATCH_CONCURRENCY = 6;

/** Filled by runBatch: `add` puts more sensors (found while it runs) at the end of the queue; ignored after a stop. */
export type BatchControl = { add?: (ids: string[]) => void };

export async function runBatch(
  ids: string[],
  setupOne: (id: string) => Promise<SetupResult>,
  onChange: (id: string, entry: BatchEntry) => void,
  concurrency = BATCH_CONCURRENCY,
  control: BatchControl = {},
): Promise<BatchSummary> {
  const queue = [...ids];
  const summary: BatchSummary = { ok: 0, failed: 0, stopped: 0 };
  const tries = new Map<string, number>();
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
      } else if (RETRIED.includes(result.reason) && (tries.get(id) ?? 0) < RETRIES && !summary.stopReason) { // never after a stop
        tries.set(id, (tries.get(id) ?? 0) + 1);
        queue.push(id);
        onChange(id, { state: 'queued' });
      } else {
        summary.failed++;
        onChange(id, { state: 'failed', reason: result.reason, step: result.step });
        if (STOPS_BATCH.includes(result.reason) && !summary.stopReason) {
          summary.stopReason = result.reason;
          // The rest of the queue is marked at once, not after the sensors still in progress finish (up to the join
          // timeout): the counts and the time left stop counting them as waiting.
          for (const queued of queue.splice(0)) {
            summary.stopped++;
            onChange(queued, { state: 'stopped', reason: result.reason });
          }
          control.add = undefined; // nothing more joins a stopped batch
        }
      }
    }
  };
  // Workers stop when the queue is empty; sensors added later start new ones, up to `concurrency` at once.
  const workers: Promise<void>[] = [];
  let active = 0;
  const spawn = () => {
    // Counted first: a worker takes its sensor from the queue as soon as it starts.
    const more = summary.stopReason ? 0 : Math.min(concurrency - active, queue.length);
    for (let i = 0; i < more; i++) {
      active++;
      workers.push(worker().finally(() => { active--; }));
    }
  };
  const known = new Set(ids);
  control.add = more => {
    if (summary.stopReason) return;
    for (const id of more) {
      if (known.has(id)) continue; // two taps before the next render
      known.add(id);
      queue.push(id);
      onChange(id, { state: 'queued' });
    }
    spawn();
  };
  spawn();
  while (workers.length) await Promise.all(workers.splice(0));
  control.add = undefined;
  return summary;
}
