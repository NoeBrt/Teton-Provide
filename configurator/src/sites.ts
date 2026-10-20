import { credentialError } from './provision.ts';
import type { SensorState } from './probe.ts';

// A technician serves several facilities over the year: each saved site is a name they chose and the network
// to join there. The password is stored apart, behind Face ID (src/SiteSheet.tsx), and never listed.
export type Site = { id: string; name: string; ssid: string };
/** The network the sensors join, once its password is unlocked for this session (memory only). */
export type SiteNetwork = { ssid: string; password: string };

/** Adds or edits a site; it goes first, so the latest one is the easiest to pick. */
export const upsertSite = (sites: Site[], site: Site): Site[] => [site, ...sites.filter(s => s.id !== site.id)];

export const removeSite = (sites: Site[], id: string): Site[] => sites.filter(s => s.id !== id);

/** The sensors this phone set up: sensor name → site id, so a card can name the site later. Not secret. */
// ponytail: a sensor reset in the workshop and set up elsewhere by another phone keeps this phone's old site name.
export type Setups = Record<string, string>;

/** The line under a sensor's name, from its advertised state and the site this phone set it up on, if any. */
export function stateText(state: SensorState, site: string | null): string {
  const where = site ?? 'its Wi‑Fi';
  switch (state) {
    case 'ready': return 'Ready to set up';
    case 'online': return `✓ Set up · connected to ${where}`;
    case 'offline': return `Set up · not connected to ${where}`;
    case 'not-staged': return 'Not prepared for setup';
  }
}

// `KEY:value;` with `\` escaping `\ ; , : "` inside the value; the last field may omit its `;`.
const WIFI_FIELD = /([A-Z]+):((?:\\.|[^\\;])*)(?:;|$)/g;
// A value in double quotes (some generators quote an SSID that looks like hex).
const QUOTED = /^"((?:\\.|[^\\"])*)"$/;

/**
 * Reads a standard Wi-Fi QR code (`WIFI:T:WPA;S:<network>;P:<password>;;`), as shown by Android's Wi-Fi sharing and
 * guest Wi-Fi posters. Returns the network, or a message for the technician: the sensors join WPA2 with a password.
 */
export function parseWifiQr(text: string): SiteNetwork | { error: string } {
  const body = text.trim();
  if (!body.startsWith('WIFI:')) return { error: 'This is not a Wi-Fi QR code.' };
  const fields = new Map<string, string>();
  const content = body.slice(5);
  for (const match of content.matchAll(WIFI_FIELD)) {
    const [whole, key, raw] = match;
    if (!fields.has(key)) fields.set(key, (QUOTED.exec(raw)?.[1] ?? raw).replace(/\\(.)/g, '$1'));
    if (content[match.index + whole.length] === ';') break; // `;;` ends the code
  }
  const type = (fields.get('T') ?? 'WPA').toUpperCase();
  if (type === 'NOPASS') return { error: 'This network has no password. The sensors need a WPA2 network with a password.' };
  // SAE is how Android shares WPA2/WPA3 transition networks; the sensor joins them with WPA2. A WPA3-only network
  // then fails at join time, with the device's own message.
  if (type !== 'WPA' && type !== 'WPA2' && type !== 'SAE') {
    return { error: 'The sensors join WPA2 networks with a password; this QR code is for another kind of network.' };
  }
  const network = { ssid: fields.get('S') ?? '', password: fields.get('P') ?? '' };
  const problem = credentialError(network.ssid, network.password);
  return problem ? { error: problem } : network;
}
