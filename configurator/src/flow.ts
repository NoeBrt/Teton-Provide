// The setup sequence for the technician, outside React so it holds its own state (no stale closures):
// site Wi-Fi once per visit → this sensor's label once → join. It decides; App.tsx shows and runs.
import type { Label } from './noise.ts';
import { isUnsettled, type SetupResult } from './setup.ts';
import type { SiteNetwork } from './sites.ts';

export type Action =
  | { kind: 'ask-network' }
  | { kind: 'scan-label'; sensorId: string }
  | { kind: 'join'; sensorId: string; label: Label; site: SiteNetwork; attempt: Uint8Array | undefined }
  | { kind: 'busy' };

export class SetupFlow {
  network: SiteNetwork | null;
  private labels = new Map<string, Label>(); // scanned this visit, memory only
  private unsettled = new Map<string, { attempt: Uint8Array; site: SiteNetwork }>(); // results the phone lost
  private waitingForNetwork: string | null = null;
  private scanning: string | null = null;
  private running: string | null = null;

  constructor(network: SiteNetwork | null) {
    this.network = network;
  }

  /** The technician tapped Set up on this sensor. */
  request(sensorId: string): Action {
    if (this.running) return { kind: 'busy' };
    if (!this.network) {
      this.waitingForNetwork = sensorId;
      return { kind: 'ask-network' };
    }
    const label = this.labels.get(sensorId);
    if (!label) {
      this.scanning = sensorId;
      return { kind: 'scan-label', sensorId };
    }
    return this.join(sensorId, label, this.network);
  }

  /** The site Wi-Fi was saved; resumes the sensor that asked for it, if any. */
  networkSaved(site: SiteNetwork): Action | null {
    this.network = site;
    const sensorId = this.waitingForNetwork;
    this.waitingForNetwork = null;
    return sensorId ? this.request(sensorId) : null;
  }

  cancelNetwork() {
    this.waitingForNetwork = null;
  }

  /** A QR label was read for this sensor. Repeated reports of the same scan are ignored. */
  labelScanned(sensorId: string, label: Label): Action | null {
    if (this.scanning !== sensorId || !this.network) return null;
    this.scanning = null;
    this.labels.set(sensorId, label);
    return this.join(sensorId, label, this.network);
  }

  cancelScan() {
    this.scanning = null;
  }

  finished(sensorId: string, result: SetupResult) {
    this.running = null;
    if (!result.ok && result.reason === 'not-authenticated') this.labels.delete(sensorId); // rescan next time
    if (isUnsettled(result) && !result.ok && result.attempt) this.unsettled.set(sensorId, { attempt: result.attempt, site: this.network! });
    else this.unsettled.delete(sensorId);
  }

  private join(sensorId: string, label: Label, site: SiteNetwork): Action {
    const previous = this.unsettled.get(sensorId);
    const same = previous && previous.site.ssid === site.ssid && previous.site.password === site.password;
    this.running = sensorId;
    return { kind: 'join', sensorId, label, site, attempt: same ? previous.attempt : undefined };
  }
}
