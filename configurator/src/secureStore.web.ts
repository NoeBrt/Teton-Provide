// Secret storage seam, desktop: same calls as expo-secure-store. In the desktop window, the system keychain
// (desktop/src-tauri/src/secrets.rs), so the code and the site passwords survive a restart; in a plain browser (the
// web demo), memory only. `requireAuthentication` is ignored on purpose: the keychain's own lock protects the secrets
// (desktop spec, decision on unlocking).
type Options = { keychainAccessible?: unknown; requireAuthentication?: boolean; authenticationPrompt?: string };
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'when-unlocked-this-device-only';

export function secretStore(invoke?: Invoke) {
  const kept = new Map<string, string>();
  return {
    get: (key: string) => (invoke ? invoke<string | null>('secret_get', { key }) : Promise.resolve(kept.get(key) ?? null)),
    set: (key: string, value: string) => (invoke ? invoke<void>('secret_set', { key, value }) : Promise.resolve(void kept.set(key, value))),
    delete: (key: string) => (invoke ? invoke<void>('secret_delete', { key }) : Promise.resolve(void kept.delete(key))),
  };
}

const store = secretStore((globalThis as { __TAURI__?: { core: { invoke: Invoke } } }).__TAURI__?.core.invoke);

export const getItemAsync = (key: string, _options?: Options) => store.get(key);
export const setItemAsync = (key: string, value: string, _options?: Options) => store.set(key, value);
export const deleteItemAsync = (key: string, _options?: Options) => store.delete(key);
/** On iOS, saving needs Face ID on. On desktop the keychain's own lock is the protection, so it is always allowed. */
export const canUseBiometricAuthentication = () => true;
