# Spec: Provide on desktop (Windows, macOS, Linux)

## Objective

Technicians set up IoT sensors from a computer as they do from an iPhone: same app, same screens, same flow, same
security, same demo mode. The desktop build is a second packaging of `configurator/`, not a second app: the provisioning
logic, the batch, the summary and the demo stay the same TypeScript. Only the platform adapters change, and the layout
adapts to a wide window.

Users: IoT technicians and facility staff with a laptop that has Bluetooth Low Energy (most laptops since 2015).

### Acceptance criteria

1. One Tauri 2 app, built from `configurator/`, runs on macOS (Apple silicon and Intel), Windows 10/11 and Linux
   (Ubuntu 22.04 or later with BlueZ), and installs from an unsigned bundle (`.dmg`, `.msi`, `.AppImage`/`.deb`).
2. With real sensors, on each system: discovery lists the IoT sensors (service UUID filter, name, state byte, signal);
   Test answers "world"; Set up runs the real Noise XX handshake, certificate and code checks, and the Wi-Fi request;
   Set up all ready runs a batch; Retry failed, Add N to the batch, Refresh and the tabs behave as on the iPhone.
   Evidence: on macOS, a run against the noe-lab sensor (`ACTUAL`) and a batch against the lab bench; Windows and
   Linux are `NOT_RUN` until machines are available (see Decisions).
3. Demo mode (tap the logo, or launch with `--demo`) shows the 200 simulated sensors and runs batches, unchanged.
4. Secrets: the site passwords, the site list, the setups map and the technician code are stored in the system
   keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service), never in a file, `localStorage`, argv or
   a log. No extra prompt on each use (decided), so the keychain's own lock is the protection; in memory, the code and
   password lock again after 2 minutes away (`LOCK_AFTER_MS`, unchanged).
5. The technician code is added by webcam QR scan or by pasting it, as on the iPhone (scan or paste).
6. Layout adapted to the desktop: the same components, arranged for a window from 900 to 2560 px wide, checked with
   screenshots at 1280×800 and 1920×1080 and a hands-on run (playtest) in demo mode on each system. Under 900 px it
   is the phone layout.
7. The iPhone app is unchanged: it still builds, its 68 tests pass, and a Simulator run in demo mode looks the same.

## Capability map (build order)

| Id | Capability | Depends on | Testable on its own by |
| --- | --- | --- | --- |
| D1 | **Web rendering**: the app runs in a browser through react-native-web, with the demo radio | none | `expo start --web`, demo mode, screenshots |
| D2 | **Platform seams**: `radio`, `secureStore` and `QrCamera` chosen per platform (`.web.ts` files), iOS untouched | D1 | iOS Simulator unchanged; web build uses the web seams |
| D3 | **Tauri shell**: a Tauri 2 window loads the web build; `npm run desktop:dev` / `desktop:build` | D1 | the demo runs in the window on macOS |
| D4 | **Bluetooth bridge**: Rust `btleplug` commands and events behind the web `radio` seam (scan, state, connect, discover, read, write, disconnect) | D2, D3 | Test and Set up against the noe-lab sensor |
| D5 | **Keychain bridge**: Rust `keyring` commands behind the web `secureStore` seam | D2, D3 | save a site, restart, unlock |
| D6 | **Webcam QR**: `QrCamera.web.tsx` with `getUserMedia` and a JS QR decoder; paste unchanged | D2 | scan the printed LAB+DEMO code |
| D7 | **Desktop layout**: wide-window arrangement of the same components | D1 | screenshots, playtest |
| D8 | **Packaging and CI**: GitHub Actions matrix (macOS, Windows, Ubuntu) runs the tests and builds unsigned bundles | D3 to D6 | CI artifacts install on each system |

## Commands

```sh
cd configurator
npm test                      # the 68 logic tests (unchanged) plus the web-seam tests
npx tsc --noEmit && npx expo lint
npx expo start --web          # D1: the app in a browser (demo mode only: no Bluetooth in a plain browser)
npm run desktop:dev           # D3+: Tauri window with hot reload
npm run desktop:build         # unsigned bundle for the current system
(cd desktop/src-tauri && cargo test && cargo clippy -- -D warnings)
```

## Project structure

```
configurator/
  App.tsx, src/*.ts(x)        unchanged logic and screens; imports go through the seams below
  src/radio.ts                seam: react-native-ble-manager on iOS (what src/ble.ts exports today)
  src/radio.web.ts            seam: Tauri bridge on desktop (invoke + events), same calls App.tsx makes
  src/secureStore.ts          seam: expo-secure-store on iOS
  src/secureStore.web.ts      seam: Tauri keyring bridge on desktop
  src/QrCamera.web.tsx        webcam scan on desktop (QrCamera.tsx stays for iOS)
  desktop/src-tauri/          Tauri 2 app: Cargo.toml, tauri.conf.json, src/{main.rs, ble.rs, keychain.rs}
.github/workflows/desktop.yml D8
```

## Code style

- Same as the repo: TypeScript strict, comments say why, `ponytail:` marks a deliberate shortcut with its ceiling.
- A seam is a module with the same exported names on each platform; App.tsx does not branch on the platform except
  for the layout (D7). Example:

```ts
// src/radio.web.ts: the calls App.tsx makes on react-native-ble-manager, over Tauri.
export const BleManager = {
  scan: (o: { serviceUUIDs: string[]; seconds: number }) => invoke('ble_scan', o),
  connect: (id: string) => invoke('ble_connect', { id }),
  write: (id: string, service: string, characteristic: string, data: number[]) => invoke('ble_write', { id, service, characteristic, data }),
  // ...
};
```

- Rust: `cargo fmt`, `clippy -D warnings`, no `unwrap` on device input; errors become strings the app already maps.

## Testing strategy

- **Logic**: the existing 68 tests run unchanged (they never touch a platform).
- **Seams**: unit tests for the web radio's mapping (btleplug advertisement → the `Peripheral` shape App.tsx reads:
  `advertising.localName`, `manufacturerData.ffff.bytes[0]`, `rssi`), with a fake `invoke`.
- **Rust**: `cargo test` for the advertisement mapping and the keychain round trip (behind a feature on CI runners
  that have no Secret Service).
- **Visual**: screenshots of the web build and the Tauri window at 1280×800 and 1920×1080, demo mode, before and after
  a batch, each tab; iOS Simulator screenshots to prove the phone app did not change.
- **Playtest**: on each system, demo mode by hand (open rows, tabs, add during a batch, refresh), then real Bluetooth
  against the noe-lab sensor and the lab bench. Results recorded in `docs/EVALUATION.md` with evidence tags.

## Boundaries

- **Always**: keep the provisioning logic (`setup.ts`, `noise.ts`, `authority.ts`, `flow.ts`, `batch.ts`, `probe.ts`,
  `provision.ts`, `demo.ts`, `wing.ts`) untouched by the desktop work; run tests, tsc, lint and the iOS Simulator
  check before each commit; keep secrets out of argv, files, logs and screenshots.
- **Ask first**: any dependency beyond `react-dom`, `react-native-web`, `@expo/metro-runtime`, `@tauri-apps/api`,
  `@tauri-apps/cli`, `jsqr` (JS) and `tauri`, `btleplug`, `keyring`, `tokio`, `serde`, `uuid` (Rust); buying signing
  certificates; changing the sensor protocol; stopping iot-device on noe-lab.
- **Never**: a second copy of the screens or the logic for desktop; weakening a check to make a platform work; adding
  the challenge PDF; committing secrets or bench keys.

## Risks

- **Write size**: the app writes Noise messages up to 512 bytes in one GATT write. CoreBluetooth and BlueZ negotiate a
  large MTU or use long writes; Windows (WinRT) negotiates MTU itself. To confirm on each system with the real sensor.
- **Concurrent links**: laptop chips often hold fewer links than an iPhone (Windows commonly 3 to 7). The batch keeps 6;
  if links fail, lower it per platform (measured on the bench).
- **Scan on Linux**: BlueZ through btleplug reports advertisements without duplicates by default; the app relies on
  repeated reports to follow a sensor's state. Mitigated by restarting scan rounds, as on iOS.
- **Linux secret storage** needs a running Secret Service (GNOME Keyring or KWallet); without one, saving fails with a
  clear message instead of falling back to a file.
- **Webcam QR**: WKWebView (macOS), WebView2 (Windows) and WebKitGTK (Linux) differ in camera support; paste remains.

## Decisions

1. **Validation machines**: only a MacBook for now. macOS is validated on it (screenshots, playtest, real Bluetooth
   against the noe-lab sensor and bench). Windows and Linux bundles are built and their tests run in CI (D8); their
   real-Bluetooth runs stay `NOT_RUN` until a Windows PC and a second Linux machine (or a USB dongle on noe-lab) exist.
2. **Desktop layout (D7)**: radar and requirements on the left, summary, tabs and list on the right, list items in
   columns as wide as a phone row; confirmed or changed on the first screenshots.

## Approved protocol correction, 2026-10-23

The user confirmed implementation and deployment of the shared sensor-identity correction after reviewing
`docs/development/sensor-identity-proposal.md`. This supersedes the earlier name/cache workaround and makes a scoped
exception to the unchanged-iPhone/provisioning-logic boundaries above: iPhone and desktop derive the claimed ID
from `manufacturerData.ffff.bytes[1..6]`, with state at `[0]`. Neither OS nor scan-response names identify sensors.
The certificate, proven-key and customer checks still precede the technician token. The demo and Python bench
use the same layout. State-only firmware is refused with update guidance; apps and firmware deploy together.
The primary legacy advertisement is exactly 31 bytes; extra fields require revisiting the protocol budget.
