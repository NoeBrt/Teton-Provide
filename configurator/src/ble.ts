import { TurboModuleRegistry } from 'react-native';
import type BleManagerInstance from 'react-native-ble-manager';

// Expo Go ships without this native module and the library throws on import,
// so it is loaded only when present; the screen then explains instead of crashing.
export const BleManager: typeof BleManagerInstance | null = TurboModuleRegistry.get('BleManager')
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- a static import would throw in Expo Go
    require('react-native-ble-manager').default
  : null;

// Started once per JS runtime: the library must not create a second CoreBluetooth manager
// (Fast Refresh re-runs App.tsx, not this module).
export const bleStarted = BleManager?.start({ showAlert: false }) ?? null;
