// The setup sequence for the technician, outside React so it holds its own state (no stale closures):
// technician token once → site Wi-Fi once per visit → join, for one sensor or several at once (a batch).
// It decides; App.tsx shows and runs.
import type { Token } from './authority.ts';
import { isUnsettled, type SetupResult } from './setup.ts';
import type { SiteNetwork } from './sites.ts';

export type Action =
  | { kind: 'ask-token' }
  | { kind: 'ask-network' }
  | { kind: 'join'; sensorId: string; site: SiteNetwork; attempt: Uint8Array | undefined }
  | { kind: 'busy' };

export class SetupFlow {
  network: SiteNetwork | null;
  token: Token | null = null;
  private unsettled = new Map<string, { attempt: Uint8Array; site: SiteNetwork }>(); // results the phone lost
  private waiting: string | null = null; // a sensor whose Set up waits for the token or the site Wi-Fi
  private running = new Set<string>();

  constructor(network: SiteNetwork | null) {
    this.network = network;
  }

  /** The technician tapped Set up on this sensor (or a batch reached it). */
  request(sensorId: string): Action {
    if (this.running.has(sensorId)) return { kind: 'busy' };
    if (!this.token) {
      this.waiting = sensorId;
      return { kind: 'ask-token' };
    }
    if (!this.network) {
      this.waiting = sensorId;
      return { kind: 'ask-network' };
    }
    return this.join(sensorId, this.network);
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
    this.running.delete(sensorId);
    if (isUnsettled(result) && !result.ok && result.attempt) this.unsettled.set(sensorId, { attempt: result.attempt, site: this.network! });
    else this.unsettled.delete(sensorId);
  }

  private resume(): Action | null {
    const sensorId = this.waiting;
    this.waiting = null;
    return sensorId ? this.request(sensorId) : null;
  }

  private join(sensorId: string, site: SiteNetwork): Action {
    const previous = this.unsettled.get(sensorId);
    const same = previous && previous.site.ssid === site.ssid && previous.site.password === site.password;
    this.running.add(sensorId);
    return { kind: 'join', sensorId, site, attempt: same ? previous.attempt : undefined };
  }
}
