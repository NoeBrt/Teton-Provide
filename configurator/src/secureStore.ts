// Secret storage seam. iOS: the Keychain through expo-secure-store, Face ID where asked (`requireAuthentication`).
// The desktop build uses secureStore.web.ts instead (the system keychain through Tauri).
export { canUseBiometricAuthentication, deleteItemAsync, getItemAsync, setItemAsync, WHEN_UNLOCKED_THIS_DEVICE_ONLY } from 'expo-secure-store';
