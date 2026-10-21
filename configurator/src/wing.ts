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
