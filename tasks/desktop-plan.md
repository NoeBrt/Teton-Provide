# Plan: Provide on desktop (SPEC.md, D1 to D8)

macOS is validated on the MacBook; Windows and Linux are built and tested in CI only (SPEC.md, Decisions).

## Dependency graph

```
D1 web rendering ──► D2 seams ──┬─► D4 Bluetooth bridge ─┐
        │                       ├─► D5 keychain bridge   ├─► checkpoint B (real setup from the Mac)
        └──► D3 Tauri shell ────┤                        │
                                └─► D6 webcam QR ────────┘
D1 ──► D7 desktop layout          D3..D6 ──► D8 packaging and CI
```

Seams found in the code (each a module with the same exports per platform; iOS keeps today's code):

| Seam | iOS (unchanged behaviour) | Desktop |
| --- | --- | --- |
| `src/ble.ts` → `ble.web.ts` | react-native-ble-manager | Tauri commands and events over btleplug |
| `src/secureStore.ts` → `.web.ts` | expo-secure-store (Keychain, Face ID) | Tauri commands over `keyring` (no prompt, decided) |
| `src/QrCamera.tsx` → `.web.tsx` | expo-camera | `getUserMedia` + `jsqr` |
| `src/ask.ts` → `.web.ts` | `Alert.alert` with buttons | a confirm dialog (RN's Alert does nothing on web) |
| demo at launch (App.tsx) | `-demo 1` (iOS defaults) | `--demo` argument, passed to the page by the shell |

## Phase 1: the app in a browser (D1, D2)

**T1. Web build of the app, demo mode.** Add `react-dom`, `react-native-web`, `@expo/metro-runtime` (expo install).
Web seams: `ble.web.ts` exports no radio yet (the app shows its "Bluetooth unavailable" state; the demo has its own
radio), `secureStore.web.ts` in memory for now (`ponytail:` until T5), `QrCamera.web.tsx` paste only (until T6),
`ask.web.ts` with `window.confirm`.
- Accept: `npx expo start --web` shows the app; tapping the logo starts the demo; a batch runs; tabs work.
- Verify: browser screenshots (Playwright or Chrome headless) at 1280×800; tsc, lint, 68 tests; iOS Simulator demo
  screenshot unchanged.

**T2. Seams on iOS, nothing changed.** App.tsx and the sheets import the seams; iOS files re-export today's modules.
- Accept: the iOS build and the Simulator run in demo mode look and behave as before (screenshots side by side).
- Verify: tests, tsc, lint, Simulator.

Checkpoint A: the same code runs on iOS and in a browser.

## Phase 2: Tauri window (D3)

**T3. Tauri 2 shell.** `configurator/desktop/src-tauri` (Cargo.toml, tauri.conf.json, main.rs); dev loads the Expo
web dev server, build loads `expo export -p web` output; `npm run desktop:dev` / `desktop:build`; `--demo` reaches the
page (initialization script); window 1280×800, minimum 400 wide.
- Accept: a native macOS window shows the app; the demo runs; `--demo` starts in it.
- Verify: window screenshot (`screencapture -l`), `cargo clippy -D warnings`.

## Phase 3: platform bridges (D4, D5, D6)

**T4. Bluetooth bridge.** Rust `ble.rs` over btleplug: start, state, scan by service UUID with repeated reports
(rounds), stop, connect, discover, write with response, read, disconnect; events for discovery, end of scan, state.
`ble.web.ts` gives App.tsx the same calls. macOS bundle declares `NSBluetoothAlwaysUsageDescription`.
- Accept: the MacBook lists TETON-AFD042F349 (noe-lab) with its name, state and signal; Test answers "world".
- Verify: TS test of the advertisement mapping with a fake `invoke`; `cargo test` of the Rust mapping; a real Test.

**T5. Keychain bridge.** Rust `keychain.rs` over `keyring` (service "dev.tetonchallenge.provide"); `secureStore.web.ts`
calls it. A Linux runner without Secret Service gets a clear error, never a file fallback.
- Accept: save a site, quit, relaunch: the site and its password are there; Keychain Access shows the entries.
- Verify: `cargo test` round trip (macOS), a manual restart.

**T6. Webcam QR.** `QrCamera.web.tsx` with `getUserMedia` and `jsqr`; macOS bundle declares
`NSCameraUsageDescription`; paste unchanged.
- Accept: scanning the printed LAB+DEMO code fills the technician code; the site QR works too.
- Verify: manual scan; the code never appears in a log or screenshot.

Checkpoint B: from the MacBook, the real noe-lab sensor is set up (Test, Set up, Reconfigure: `ACTUAL`), then a
batch against the lab bench (`ACTUAL_BLE`); write sizes up to 512 bytes and the number of links checked.

## Phase 4: desktop layout and delivery (D7, D8)

**T7. Desktop layout.** Over 900 px: radar and requirements on the left, summary, tabs and list on the right, list
items in phone-wide columns; under 900 px, the phone layout. Same components.
- Accept: screenshots at 1280×800 and 1920×1080 (before, during and after a batch, each tab, an open row); a playtest
  in demo mode by hand; the iPhone layout unchanged.
- Verify: screenshots compared; Simulator unchanged.

**T8. Packaging and CI.** `desktop:build` makes an unsigned `.dmg`; `.github/workflows/desktop.yml` runs the JS tests
and `cargo test` and builds `.msi`, `.deb`/`.AppImage` and `.dmg` on Windows, Ubuntu and macOS runners.
- Accept: CI green; the `.dmg` installs and runs on the MacBook.

Checkpoint C: docs (README, ARCHITECTURE, DECISIONS 31, SECURITY, compliance), review, commit.

## Risks carried from the spec

Write size on Windows, link count on laptops, Linux duplicate reports and Secret Service, webcam support per webview,
`Alert` on web (handled by the `ask` seam). Each is checked at the task that meets it.
