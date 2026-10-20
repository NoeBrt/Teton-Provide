// A technician serves several facilities over the year: each saved site is a name they chose and the network
// to join there. The password is stored apart, behind Face ID (src/SiteSheet.tsx), and never listed.
export type Site = { id: string; name: string; ssid: string };
/** The network the sensors join, once its password is unlocked for this session (memory only). */
export type SiteNetwork = { ssid: string; password: string };

/** Adds or edits a site; it goes first, so the latest one is the easiest to pick. */
export const upsertSite = (sites: Site[], site: Site): Site[] => [site, ...sites.filter(s => s.id !== site.id)];

export const removeSite = (sites: Site[], id: string): Site[] => sites.filter(s => s.id !== id);
