// Secret storage seam, desktop: same calls as expo-secure-store. `requireAuthentication` is ignored on purpose: the
// system keychain's own lock protects the secrets (desktop spec, decision on unlocking).
// ponytail: kept in memory until the Tauri keychain bridge (desktop plan T5); nothing survives a restart.
type Options = { keychainAccessible?: unknown; requireAuthentication?: boolean; authenticationPrompt?: string };

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'when-unlocked-this-device-only';
const kept = new Map<string, string>();

export async function getItemAsync(key: string, _options?: Options): Promise<string | null> {
  return kept.get(key) ?? null;
}
export async function setItemAsync(key: string, value: string, _options?: Options): Promise<void> {
  kept.set(key, value);
}
export async function deleteItemAsync(key: string, _options?: Options): Promise<void> {
  kept.delete(key);
}
/** On iOS, saving needs Face ID on. On desktop the keychain's own lock is the protection, so it is always allowed. */
export const canUseBiometricAuthentication = () => true;
