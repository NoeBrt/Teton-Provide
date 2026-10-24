// The overall of the sensors in range, outside React (like flow.ts): the group each sensor is in, and a time estimate.
// Summary.tsx shows the groups; the card list filters on them.
import type { BatchEntry } from './batch.ts';
import type { SensorState } from './probe.ts';

/** Set up, needs attention, or not set up yet (ready, not prepared, waiting or in progress). */
export type Group = 'done' | 'failed' | 'left';

/** This session's result first (a batch or a setup by hand); otherwise what the sensor advertises. A sensor set up but
 * not on its Wi-Fi needs the technician, so it counts with the errors, even after a success here. The advertisement
 * never turns a failure into a success: an impostor can advertise 'online'. */
export function groupOf(state: SensorState | null, entry: BatchEntry | undefined): Group {
  if (entry?.state === 'ok' && state === 'offline') return 'failed'; // joined, then dropped off the network
  if (entry) return entry.state === 'ok' ? 'done' : entry.state === 'failed' || entry.state === 'stopped' ? 'failed' : 'left';
  return state === 'online' ? 'done' : state === 'offline' ? 'failed' : 'left';
}

/** Minutes left at the pace so far, once enough sensors have finished to trust it; null before. */
export function minutesLeft(startedMs: number, nowMs: number, finished: number, left: number): number | null {
  if (finished < 10 || left === 0 || nowMs <= startedMs) return null;
  return Math.max(1, Math.round(((nowMs - startedMs) / finished) * left / 60_000));
}

export const STALE_MS = 15_000; // Refresh drops the sensors not heard for this long

/** On Refresh, whether a sensor leaves the list: quiet for STALE_MS, and not queued or running. A finished result
 * (set up, failed, stopped) does not keep a sensor that is no longer there. */
export function isGone(lastHeardMs: number | undefined, nowMs: number, entry: BatchEntry | undefined, running: boolean): boolean {
  const busy = running || entry?.state === 'queued' || entry?.state === 'running';
  return !busy && nowMs - (lastHeardMs ?? 0) > STALE_MS;
}

/** Whether a sensor with a finished result here went back to ready since (reset on the bench): its result no longer
 * holds, so it is offered again with the ready ones. A failure that keeps advertising ready keeps its result. */
export function wasReset(before: SensorState | null | undefined, after: SensorState | null, entry: BatchEntry | undefined): boolean {
  const finished = entry?.state === 'ok' || entry?.state === 'failed' || entry?.state === 'stopped';
  return finished && before != null && before !== 'ready' && after === 'ready';
}

/** The batch results without these sensors' (dropped by Refresh, or reset since), so a sensor that comes back ready
 * is offered again; the same map when there is nothing to drop. */
export function without<T>(batch: Record<string, T>, ids: string[]): Record<string, T> {
  return ids.some(id => id in batch) ? Object.fromEntries(Object.entries(batch).filter(([id]) => !ids.includes(id))) : batch;
}
