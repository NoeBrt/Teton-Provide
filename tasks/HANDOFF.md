# Engineering Handoff

Record each verified increment here. Keep `PASS`, `FAIL`, `BLOCKED`, and
`NOT_RUN` distinct. Evidence classes are `SIMULATION`, `COMMAND_FIXTURE`,
`ACTUAL_HOST`, `ACTUAL_BLE`, and `ACTUAL_WIFI`; fixture results never advance a
hardware gate. Every behavior change needs a red/green regression, independent
review, and a measurement of the affected path. Document measurement limits.

## Step 0 — Adversarial baseline, 2026-10-17

- Revision: `d3217fa`; phone → secure BLE → headless Ubuntu Rust service → target
  Wi-Fi. SoftAP is excluded. The user now requires both Android and iPhone.
- Evidence: `SIMULATION` and `COMMAND_FIXTURE` **PASS**, 38 tests with
  `RUSTUP_TOOLCHAIN=stable cargo test --all-targets --locked --offline`.
- Three independent agents reviewed feasibility, existing code, and requirements.
  Actionable findings: an exited command parent can escape the audit deadline;
  non-UTF-8 benchmark argv can panic and echo input. Both require regressions.
- `ACTUAL_HOST` **BLOCKED**: fresh BlueZ/NetworkManager bus calls are prohibited;
  network sockets/netlink are unavailable. Sysfs visibility does not prove BLE.
- BLE build **BLOCKED**: required crates are absent and the crates index cannot
  resolve. A temporary-manifest experiment confirms even a disabled optional
  dependency breaks default offline resolution. Preserve the tested manifest.
- `ACTUAL_BLE`, secure transfer, Android/iPhone operation, and `ACTUAL_WIFI`:
  **NOT_RUN**. No real provisioning or radio-capacity claim is supported.
- Next owner: implementation agent. Reproduce and fix the audit deadline at its
  public CLI, then obtain independent review and matched before/after timings.
  Review secure-channel feasibility for both phone platforms before locking the
  mobile framework; runtime security and credentials remain gated after hello.

## Step 1 — Bound stdout lifetime after command-parent exit

- Revision: `7e6c407`.
- Changed: `device/audit.rs`, public CLI regressions, and setup documentation.
  A draining Bash pipeline preserves GNU timeout supervision; quoted argv,
  pipefail, and privileged shell mode preserve failure and environment boundaries.
- Evidence class: `COMMAND_FIXTURE` **PASS**. Actual red/green and startup-code
  mutation failure: [trace](../demo/tdd-audit-deadline.txt).
- Verification: all 40 Rust tests pass in debug/release; Rustfmt and
  `cargo clippy --all-targets --locked --offline -- -D warnings` pass with the
  installed `stable` override. Seventeen tests exercise the public audit CLI.
- Review: fresh-context correctness/security review and follow-up found no
  unresolved issue; inherited startup/functions were also independently tested.
- Measurement: 48 controlled runs, [method/results](../docs/BENCHMARKS.md#audit-supervision-repair-command-fixtures).
  Normal median 7.596 → 14.451 ms; exited-parent median 6013.658 ms/false PASS →
  4008.137 ms/correct TIMEOUT. Extra startup cost is an accepted correctness trade-off.
- `ACTUAL_HOST` **BLOCKED** after the repair; see the separate
  [host result](../demo/host-preflight-continuation.txt). `ACTUAL_BLE`, secure
  transfer, Android/iPhone operation, and `ACTUAL_WIFI` remain **NOT_RUN**.
- Next owner: implementation agent. Fix benchmark non-UTF-8 argv at the public
  executable boundary, then review/measure it and align dual-platform acceptance.

## Step 2 — Redact invalid benchmark argv

- Revision: `4eff13c`.
- Changed: `examples/benchmark.rs` reads OS arguments with fallible UTF-8
  conversion; `tests/benchmark_cli.py` checks the actual release executable.
- Evidence class: `COMMAND_FIXTURE` **PASS**. The [public red/green trace](../demo/tdd-benchmark-cli.txt)
  shows old panic exit 101, then successful checks for help and three invalid
  argument cases after the repair. No input is echoed on failure.
- Review: an independent fresh-context reviewer found no issue and reran all
  four public CLI cases plus four existing benchmark unit tests successfully.
- Measurement: [84 startup calls](../docs/BENCHMARKS.md#benchmark-cli-argument-repair-startup-only)
  confirm help is unchanged and invalid-byte argv changes from panic/leak to
  controlled exit 1/static usage. Timing ranges overlap; no speed claim.
- Valid-path verification: three release `--scale` processes pass 45 scenario
  summaries and 80,073 measured synthetic jobs plus 11,439 warmup jobs. See the
  [raw output](../demo/benchmark-scaled-continuation.txt). This does not measure
  actual BLE or fleet capacity.
- Gates: actual host remains **BLOCKED**; Android/iPhone BLE, authenticated
  transfer, and actual Wi-Fi remain **NOT_RUN**. The core simulation is unchanged.
- Next owner: implementation agent. Finish dual-platform acceptance review,
  update current setup instructions, and record
  remaining host/dependency prerequisites before any real BLE implementation.

## Step 3 — Dual-platform acceptance and final handoff

- Runtime revision: `4eff13c`; this step changes documentation only. Android and
  iPhone are both required, with prepared offline clients and separate physical
  evidence; the Ubuntu configurator alternative remains. No framework is selected.
- Updated artifacts: README, architecture, decisions 19-20, plan, and checklist.
  Review authenticated bootstrap/library feasibility before framework selection.
  Before credential bytes leave a client, require an established authenticated
  and encrypted channel and validate confidentiality, integrity, and peer identity.
- Final success must use fresh authenticated status tied to the requested target
  connection/current attempt and its assigned IP. Recover interrupted results
  before success/resubmission; old/fallback connections never establish success.
- Review: independent requirements review found a P2 ambiguity (authentication
  alone did not explicitly require encryption). The current architecture, plan,
  checklist, and decision now close it; follow-up found no remaining concrete issue.
- Verification: [final checks](../demo/continuation-verification.txt) record
  40 Rust tests in debug/release, four real-executable CLI cases, Rustfmt, Clippy,
  and the full release build. Final binary hashes match the measured binaries.
  Documentation-only changes use static review and `git diff --check`; they add
  no runtime TDD or benchmark claim. Steps 1-2 retain their separate red/green,
  mutation, review, and measurement evidence.
- Gates: software/fixtures **PASS**; actual host access and BLE dependency
  resolution **BLOCKED**; Android/iPhone runtime, `ACTUAL_BLE`, authenticated
  credential transfer, and `ACTUAL_WIFI` **NOT_RUN**. No new endurance run occurred.
- Next owner: a developer with actual Ubuntu host access. From this repository,
  run `./target/release/audit-host` outside the restricted session and retain its
  constructed result. Resolve/cache the full pinned BLE graph and pass default
  plus BLE-enabled locked offline builds before adding the real endpoint.
- Then hand back to implementation: expose only harmless `hello`/`world` using
  the actual BlueZ callbacks and existing handler, with explicit GATT read/write
  semantics and recovery tests. Prove discovery/reconnect/restart/reboot from the
  prepared phones. A generic diagnostic app may prove feasibility but cannot
  replace submitted configurator source. Runtime security/credentials remain gated.

## Step 4 — Real BlueZ hello endpoint, first unrestricted host run

- Revision: uncommitted on `a9551fa`. This session reaches crates.io, BlueZ, and
  NetworkManager, which lifts the Step 0-3 access and dependency blockers.
- Changed: optional `ble` feature (`bluer` 0.17.4 `bluetoothd`, Tokio 1.53; 79
  locked packages), `device/main.rs`, shared GATT UUIDs in `src/protocol.rs`,
  `device/systemd/iot-device.service`, README run/install steps, decision 21.
- Evidence class: `ACTUAL_HOST` **PARTIAL**. `audit-host` passes GATT, advertising,
  and NetworkManager Wi-Fi; Bluetooth is soft-blocked by rfkill and BlueZ 5.64
  answers `Busy` to power-on. See [host run](../demo/host-ble-endpoint.txt).
  Unblocking needs root; no advertisement was emitted.
- `COMMAND_FIXTURE` **PASS**: six slot-logic unit tests; four mutations are each
  caught ([trace](../demo/tdd-ble-device.txt)). 46 Rust tests pass in debug and
  release; Rustfmt, Clippy with and without `ble`, and the four CLI cases pass.
  Default builds compile no third-party crate.
- Review: independent fresh-context review approved after one fix (three slot
  mutations escaped the first tests; fixed). Accepted limits: an `hci0` removal
  without a `bluetoothd` restart leaves the process unregistered (code `shortcut`
  note); a Bluetooth address is not authentication; bluer's internal logs could
  print device paths if a logger is ever installed. Restart propagation through
  `Requires=` is unverified on the host.
- Measurement: none. The change adds no hot path; radio latency needs hardware.
- Gates: `ACTUAL_BLE`, Android/iPhone, service restart/reboot, secure transfer,
  and `ACTUAL_WIFI` remain **NOT_RUN**. ARM64 is not built.
- Next owner: someone at the machine with sudo and a phone. Run
  `sudo rfkill unblock bluetooth`, rerun `audit-host`, start `target/release/device`,
  and use nRF Connect on Android and on iPhone to discover `IOT-DEMO-001`,
  write `hello`, read `world`, disconnect, and reconnect. Record sanitized results
  in `demo/phone-hello.txt`. Then install the unit and test restart/reboot (task 7).

## Step 5 — IoT styling, UI test, host inventory, credential bootstrap review

- Revision: uncommitted on `a9551fa`, together with Step 4.
- Changed: `docs/architecture-demo.html` restyled after example.com (palette from its
  CSS; free Onest embedded, OFL, as a stand-in for the licensed Wallop face; CSP
  gains `font-src data:`). New `demo/ui-playwright.mjs`, `docs/SECURITY.md`.
- Evidence class: `SIMULATION` **PASS** for the mockup: Playwright 1.48.2 Chromium,
  PC 1440 px, iPhone 13 and Pixel 7 emulation, both previews, all five outcomes and
  retries, password cleared, targets ≥ 44 px, no overflow or CSP errors
  ([results](../demo/mockup-playwright.txt)). Real Safari/WebKit not tested.
- `ACTUAL_HOST`: sanitized inventory in [host-inventory](../demo/host-inventory.txt):
  HP Victus, MediaTek MT7921 (BLE and Wi-Fi on one chip), peripheral role,
  20 advertising instances. Bluetooth still soft-blocked by rfkill.
- Security review: `docs/SECURITY.md` rejects OS pairing options on sourced
  platform facts and recommends `Noise_NKpsk2` with key and secret on the label.
  An independent security review raised two High findings (label as a permanent
  bearer token across reboots; label substitution) and four Medium ones; all are
  folded in as single-use provisioning, a signed manifest for fleet rollout,
  per-connection state, payload-bound attempt IDs, and staging-only key creation.
- Gates unchanged: `ACTUAL_BLE`, Android/iPhone, systemd lifecycle, secure transfer,
  and `ACTUAL_WIFI` remain **NOT_RUN**; nothing in `docs/SECURITY.md` is built.
- Next owner: unchanged from Step 4 (rfkill unblock in a real terminal, phone probes).

## Step 6 — Solution report (PDF) and extended interface tests

- Revision: uncommitted on `a9551fa`, together with Steps 4-5.
- Changed: `demo/ui-playwright.mjs` adds axe-core WCAG 2.1 AA scans (three screens,
  three formats) and a keyboard-only run; Playwright and axe paths come from
  `PLAYWRIGHT`/`AXE`. New `docs/report/` (HTML source, build script, screenshots,
  embedded Onest) producing `docs/rapport-solution.pdf` (9 A4 pages, French).
- Evidence class: `SIMULATION` **PASS**, 79 mockup checks, 0 failures, 0 axe
  violations ([results](../demo/mockup-playwright.txt)). An axe sanity page with
  planted defects reports four violations, so the scan is live. Real Safari and
  physical phones are not tested.
- The report states the challenge is incomplete: no credential transfer and no
  real Wi-Fi connection are evidenced. Gates are unchanged from Step 5.

## Step 7 — Real BlueZ registration on the unblocked host

- Revision: uncommitted on `a9551fa`; no code change since Step 4.
- The user unblocked Bluetooth with `sudo rfkill unblock bluetooth` in a separate
  terminal (`!` commands cannot answer a sudo password prompt).
- Evidence class: `ACTUAL_HOST` **PASS**. `audit-host` passes 4/4. While
  `target/release/device` runs, BlueZ reports the adapter powered, one active LE
  advertisement, and the service UUID on the adapter; after SIGINT both are released
  ([run](../demo/host-ble-endpoint.txt)). The adapter stays powered after exit.
- Still `NOT_RUN`: discovery and `hello` exchange from Android and iPhone,
  reconnect, systemd restart/reboot, secure transfer, `ACTUAL_WIFI`.
- Next owner: someone with a phone next to the machine. Start
  `./target/release/device`, then in nRF Connect connect to `IOT-DEMO-001`,
  write the text `hello`, read `world`; disconnect and repeat. Record model, OS,
  app version, and outcomes in `demo/phone-hello.txt`.

## Step 8 — Site network once, room-by-room provisioning

- Revision: uncommitted on `a9551fa`. Trigger: user review against the challenge PDF
  (thousands of devices, 200 per wing, several sensors per room).
- Decision 22 and `docs/SECURITY.md`: the site profile is entered once per
  intervention and kept in phone secure storage; the label secret stays per device.
  WPA2-Personal shares one password across sensors (accepted for the demo);
  production should use per-device EAP-TLS or PPSK issued by Smith.
- `docs/architecture-demo.html` now models: site network → room (scan up to four
  labels, one button) → one status per sensor, targeted retry, next room without
  credentials, sensor ↔ room recorded. `docs/ARCHITECTURE.md` updated.
- Evidence class: `SIMULATION` **PASS**, 91 Playwright checks, 0 failures, 0 axe
  violations; six checks provision room 215 without re-entering credentials
  ([results](../demo/mockup-playwright.txt)). PDF report rebuilt (9 pages) with the
  new screens and the Step 7 host result.

## Step 9 — Expo configurator: BLE hello probe for iPhone

- Revision: uncommitted on `a9551fa`. Trigger: user asked for a native Android and
  iPhone app and will test from an iPhone only; the stack review (GitHub
  `iot-ai`, job posts) shows Expo + React Native + TypeScript for mobile and Rust
  Smith for the fleet. Decision 23.
- Changed: `configurator/` (Expo SDK 58, RN 0.88, `react-native-ble-manager` 12.5,
  Onest font, IoT palette). `src/probe.ts` holds the transport-agnostic probe with
  per-step deadlines (iOS connects never time out by themselves); `App.tsx` scans by
  service UUID, tests a sensor, and keeps a 10-line journal for evidence.
- Evidence class: `COMMAND_FIXTURE` **PASS**: 6 probe tests with a fake link, 6
  mutations caught ([trace](../demo/tdd-configurator.txt)); `tsc`, `expo lint`,
  `expo-doctor` 20/20; iOS prebuild shows the French Bluetooth usage string and
  bundle ID; the iOS JavaScript export compiles. Node 22.23 installed with nvm.
- Review: independent review asked for two fixes (success text contrast on mint;
  tests need Node 22.18+ type stripping) and suggested others: iOS error objects,
  single `start()`, double-tap guard, VoiceOver announcement, font fallback. All
  applied. Unverified until a phone runs: whether iOS shows the scan-response name.
- Not run: any iPhone build or install (needs the user's Expo login and a paid
  Apple Developer account), `ACTUAL_BLE` from the app.
- Next owner: the user. Follow `configurator/README.md`: `eas login`,
  `eas device:create`, `eas build -p ios --profile development`, install from the
  QR code, `npx expo start`. Meanwhile nRF Connect on the iPhone can already probe
  `./target/release/device`.

## Step 10 — Expo Go preview, EAS link, and Mac handover

- Revision: branch `feat/ble-device-and-configurator` (first push of Steps 4-10).
- The configurator moved from Expo SDK 58 to **SDK 57**: the App Store Expo Go
  rejected SDK 58. `tsc`, `expo lint`, 6 tests, and `expo-doctor` 21/21 pass.
- The BLE library now loads only when its native module exists (`src/ble.ts`), so
  Expo Go shows the UI with « Bluetooth indisponible dans Expo Go » instead of
  crashing. Verified by the user on an iPhone through `npx expo start --go --tunnel`
  (tunnel mode: the workstation's ufw firewall blocks LAN port 8081).
- EAS: logged in as `noeeebt`; project linked (`app.json` › `extra.eas.projectId`).
  No EAS iOS build: the user has no paid Apple Developer Program membership.
- Path forward without the paid program: build and sign on the user's Mac with a
  free Apple ID (`npx expo run:ios --device`, 7-day signature). See
  `configurator/README.md`.
- Gates: `ACTUAL_HOST` **PASS** (Step 7); `ACTUAL_BLE` still **NOT_RUN** (neither
  nRF Connect nor the app has completed hello/world from a phone yet).
- Next owner (on the Mac):
  1. Clone, check out `feat/ble-device-and-configurator`, install the configurator
     on the iPhone as described in `configurator/README.md`.
  2. On the Ubuntu workstation: `cargo build --release --features ble --bin device`
     then `./target/release/device` (Bluetooth must be unblocked: `rfkill list`).
  3. In the app: Rechercher les capteurs → Tester `IOT-DEMO-001`; expect
     « world » reçu. Repeat, disconnect, reconnect. Record iPhone model, iOS version,
     app commit, and the journal lines in `demo/phone-hello.txt` (`ACTUAL_BLE`).
  4. Then: install the systemd unit and test restart/reboot (task 7); after that,
     the Noise channel per `docs/SECURITY.md`, then NetworkManager activation
     reusing Smith's connectivity guard (decision 23).

## Step 11 — First real BLE exchange from the iPhone app; configurator UI iteration

- Revision: uncommitted `configurator/` changes on top of `85f8b61` (branch
  `feat/ble-device-and-configurator`). Device binary unchanged (`85f8b61`).
- Mac setup: Xcode 27.1, CocoaPods 1.17.0, Node 22.22; app built in Release with `xcodebuild`
  (JavaScript bundled, no Metro) and signed with a free Apple ID (Personal Team, 7-day signature);
  installed with `xcrun devicectl device install app`. `npx expo prebuild -p ios` regenerates `ios/`.
- Evidence class: `ACTUAL_BLE` **PASS** for discovery, hello/world, and reconnect after a device service
  restart: iPhone 15 Pro, iOS 27.0, noe-lab Ubuntu 22.04.5 / BlueZ 5.64; six `hello exchanged` over two
  service runs, registrations released on stop ([evidence](../demo/phone-hello.txt)).
  `NOT_RUN`: offline startup (Internet off, no shared LAN), systemd restart/reboot, Android.
  `NOT_RECORDED`: the on-phone error message while the service was stopped.
- Configurator changes, made at the user's explicit request before checkpoint H (the repo rule says no
  full UI before the radio milestone; no credentials, crypto, or Wi-Fi were added):
  automatic scan with a radar (`src/Radar.tsx`, Reanimated 4.5.1 on the UI thread); app renamed
  `provide.` with the IoT mark from example.com's header (`assets/iot-mark.png`; ask IoT before any
  public distribution); English UI; result and progress shown inside the tested sensor's card with a
  steady-height drawer and a 0.7 s minimum progress (UI only, `result.ms` stays real); scroll-driven
  radar (large ↔ compact follows the finger, native snapping, compact mode holds until a second gesture,
  auto-fold only above four sensors). Design history and choices: `docs/configurator/README.md`.
- Checks: `npm test` 6/6, `npm run typecheck`, `npm run lint`, `expo-doctor` 21/21. UI behaviour checked
  in the iOS Simulator with fake sensors (`SIMULATION`, recording `docs/configurator/simulator-flow.mp4`);
  fake data never ships in `App.tsx`.
- iPhone screen recording through `devicectl` is unsupported on this phone (CoreDevice error 1001);
  use the phone's own screen recording for the presentation.
- Open question sent to IoT: do production devices have BLE? If not, the fallback that creates no
  local network is a QR shown to the device camera (DPP needs Android; SoftAP creates a local network).
- Next owner: the user, then implementation.
  1. Repeat the iPhone run with Internet disabled and no shared LAN; record it in `demo/phone-hello.txt`.
  2. Install the systemd unit and test restart/reboot (task 7).
  3. Commit the configurator changes after review (nothing committed in this step).
  4. Then the Noise channel per `docs/SECURITY.md`, then NetworkManager activation.

## Step 12 — Provisioning committed; device review fixes 5-8

- Revision: `f2f6363` (Noise NKpsk2 provisioning, `stage`, NetworkManager activation, configurator sites and
  label scan) plus this step's device fixes. Branch `feat/ble-device-and-configurator`, not pushed.
- Fixes (`tasks/compliance.md`, review findings): the one-phone claim starts when the phone proves the label
  (first transport message decrypts), so a replayed first message no longer locks the device out; the
  provisioned marker and its directory are fsynced before success is reported, and a failed write deletes the
  profile and reports an error; the NetworkManager profile has a fixed UUID, starts without autoconnect, gets it
  only after success, and is deleted before each attempt, on failure and at startup while unprovisioned; join
  failures come from the device `StateChanged` signal instead of a 100 ms poll.
- Evidence class: `COMMAND_FIXTURE` **PASS** on noe-lab: `cargo test --features ble --bin device` 14/14 (the
  replay test failed first with `InProgress`), `cargo test --features stage` all pass, Clippy
  `--features ble,stage --all-targets` clean. Not run on hardware: none of the NetworkManager changes.
- noe-lab state: the running `device` (pid 3343956) is the Oct 17 hello-only build from
  `~/noe-ws/iot-provisioning`; the provisioning build and the staged identity live in `~/noe-ws/iot-dev`
  (`state/`, label `IOT-DEMO-001` printed on the YHK sticker printer). `eno1` has no cable yet.
- Next owner: implementation, once the Ethernet cable is in `eno1`.
  1. Stop the old binary; `cargo build --release --features ble` in `~/noe-ws/iot-dev`; run it with
     `STATE_DIRECTORY=state IOT_WIFI_INTERFACE=wlo1` while `btmon` records.
  2. From the iPhone: scan the printed label, **Set up**, expect **Device connected** with the IP; check the
     `iot-provisioned` profile holds it. Then wrong password, absent network, and the btmon grep for SSID and
     password bytes (constraints 2 and 3).
  3. systemd unit with `StateDirectory=` and NetworkManager permission (constraint 4), README, docs.

## Step 13 — Architecture writeup with diagrams, screens and video

- `docs/ARCHITECTURE.md` rewritten for the reviewers: system diagram, provisioning sequence, device states,
  channel decision tree and alternatives, credential protection, 200-device changes, the path taken, evidence
  table. Five Mermaid diagrams rendered without error with mermaid-cli 11.4.2. `docs/SECURITY.md` now states
  the implemented protocol and its deviations.
- Screens and video (`docs/architecture/`, `SIMULATION`): iOS Simulator "IoT 16 Pro" (iOS 27.0) running the
  Release app with a temporary harness, removed afterwards: fake radio and scripted taps; `IOT-DEMO-001`
  replays the snow transcript so the app's real Noise code runs; `IOT-DEMO-002` answers with a mismatched key.
  The harness is not in the repo; the real app was rebuilt and reinstalled on that simulator.
- Still open: README for Ubuntu (GAP), real join and btmon capture (cable), systemd unit, offline run, Android.
