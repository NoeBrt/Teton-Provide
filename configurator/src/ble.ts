import { PermissionsAndroid, Platform, TurboModuleRegistry } from 'react-native';
import type BleManagerInstance from 'react-native-ble-manager';

// Expo Go ships without this native module and the library throws on import,
// so it is loaded only when present; the screen then explains instead of crashing.
export const BleManager: typeof BleManagerInstance | null = TurboModuleRegistry.get('BleManager')
  ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- a static import would throw in Expo Go
    require('react-native-ble-manager').default
  : null;

// Android grants Bluetooth at run time only: "Nearby devices" (scan, connect) from Android 12, location before it. The
// manifest declares them (react-native-ble-manager's plugin). A refusal leaves the radio unusable, and the header
// chip says so. iOS asks on first use by itself.
const permitted =
  Platform.OS === 'android'
    ? PermissionsAndroid.requestMultiple(
        Number(Platform.Version) >= 31
          ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
          : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION],
      ).then(() => undefined)
    : Promise.resolve();

// Started once per JS runtime: the library must not create a second CoreBluetooth manager
// (Fast Refresh re-runs App.tsx, not this module).
export const bleStarted = BleManager ? permitted.then(() => BleManager.start({ showAlert: false })) : null;
