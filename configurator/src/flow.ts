// The setup sequence for the technician, outside React so it holds its own state (no stale closures):
// technician token once → site Wi-Fi once per visit → join, for one sensor or several at once (a batch).
// It decides; App.tsx shows and runs.
import { sha256 } from '@noble/hashes/sha2.js';
import { toHex, type Token } from './authority.ts';
import { isUnsettled, type SetupResult } from './setup.ts';
import type { SiteNetwork } from './sites.ts';

export type Action =
  | { kind: 'ask-token' }
  | { kind: 'ask-network' }
  | { kind: 'join'; sensorId: string; site: SiteNetwork; attempt: Uint8Array | undefined }
  | { kind: 'busy' };

/** A code past its expiry counts as missing: the sensor would refuse it anyway. */
export const expired = (code: { expires: number }) => code.expires <= Date.now() / 1000;
// Which network an attempt was sent with, as a digest: the password stays here no longer than the app holds it.
const networkKey = (site: SiteNetwork) => toHex(sha256(new TextEncoder().encode(JSON.stringify([site.ssid, site.password, site.enterprise ?? null]))));

export class SetupFlow {
  network: SiteNetwork | null;
  token: Token | null = null;
  private unsettled = new Map<string, { attempt: Uint8Array; key: string }>(); // results the phone lost
  private waiting: string | null = null; // a sensor whose Set up waits for the token or the site Wi-Fi
  // Sensor → network key its join started with: the app may drop the network (left, site forgotten) before it ends.
  private running = new Map<string, string>();

  constructor(network: SiteNetwork | null) {
    this.network = network;
  }

  /** The technician tapped Set up on this sensor (or a batch reached it). */
  request(sensorId: string): Action {
    if (this.running.has(sensorId)) return { kind: 'busy' };
    if (!this.token || expired(this.token)) {
      this.waiting = sensorId;
      return { kind: 'ask-token' };
    }
    if (!this.network) {
      this.waiting = sensorId;
      return { kind: 'ask-network' };
    }
    return this.join(sensorId, this.network);
  }

  /**
   * A batch reached this sensor. A batch never asks: locked credentials (app left, site forgotten) or an expired code
   * stop it instead, and nothing is left waiting.
   */
  batchRequest(sensorId: string): Action | { kind: 'stop'; reason: 'locked' | 'token-expired' } {
    if (!this.token || !this.network) return { kind: 'stop', reason: 'locked' };
    if (expired(this.token)) return { kind: 'stop', reason: 'token-expired' };
    return this.request(sensorId);
  }

  /** The technician token was imported or unlocked; resumes the sensor that asked for it, if any. */
  tokenReady(token: Token): Action | null {
    this.token = token;
    return this.resume();
  }

  /** The site Wi-Fi was saved; resumes the sensor that asked for it, if any. */
  networkSaved(site: SiteNetwork): Action | null {
    this.network = site;
    return this.resume();
  }

  /** The token or site sheet was closed without a choice. */
  cancelWaiting() {
    this.waiting = null;
  }

  finished(sensorId: string, result: SetupResult) {
    const key = this.running.get(sensorId);
    this.running.delete(sensorId);
    if (isUnsettled(result) && !result.ok && result.attempt && key) this.unsettled.set(sensorId, { attempt: result.attempt, key });
    else this.unsettled.delete(sensorId);
  }

  private resume(): Action | null {
    const sensorId = this.waiting;
    this.waiting = null;
    return sensorId ? this.request(sensorId) : null;
  }

  private join(sensorId: string, site: SiteNetwork): Action {
    const key = networkKey(site);
    const previous = this.unsettled.get(sensorId);
    this.running.set(sensorId, key);
    return { kind: 'join', sensorId, site, attempt: previous?.key === key ? previous.attempt : undefined };
  }
}
