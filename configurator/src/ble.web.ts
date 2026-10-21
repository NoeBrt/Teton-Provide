// Bluetooth seam, desktop. ponytail: no radio until the Tauri bridge (tasks/desktop-plan.md T4); the app shows its
// "Bluetooth unavailable" state, and demo mode brings its own simulated radio.
import type BleManagerInstance from 'react-native-ble-manager';

export const BleManager: typeof BleManagerInstance | null = null;
export const bleStarted: Promise<void> | null = null;
