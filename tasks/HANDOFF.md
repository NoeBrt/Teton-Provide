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

## Step 14 — Device service unit, README for reviewers, Wi-Fi QR scan

- systemd: `device/systemd/iot-device.service` runs as system user `iot` with `StateDirectory=iot-device`,
  hardening, and a polkit grant for its NetworkManager profile (`.pkla` for polkit 0.105 / Ubuntu 22.04, `.rules`
  for 24.04); `device/systemd/install.sh` installs everything. Verified with `systemd-analyze verify`; not
  installed yet (needs sudo on noe-lab). Install keeps the staged identity so the printed label stays valid.
- `README.md` rewritten for the reviewers: hardware table, Ubuntu setup, staging, demo, reset, tests, evidence.
- Configurator: the site form reads a standard Wi-Fi QR code (`parseWifiQr`, shared `QrCamera` with a Settings
  path after a camera refusal); Set up on a sensor without the provisioning characteristic (already set up, or
  not staged) now says so instead of "The Bluetooth link failed". Code review (9 findings) fixed: quoted values
  ending in an escaped backslash, data after `;;`, a last field without `;`, WPA3 transition codes (`T:SAE`),
  typed `retrieveServices`, camera permission dead end, Save hidden while scanning, camera component split.
- Evidence: `npm test` 39/39, typecheck, lint; Rust 40 and 70 tests unchanged. `ACTUAL` (user, iPhone 15 Pro):
  the real network's Wi-Fi QR fills the site form. The iPhone runs this build; free signature until 2026-10-26.
- noe-lab: a hello-only device instance runs by hand (`STATE_DIRECTORY=/tmp/iot-hello-only`) so the app has a
  sensor to show; stop it before installing the service.
- Next owner: the user runs `sudo device/systemd/install.sh wlo1` and copies `state/identity` (README); then
  restart/reboot and offline hello evidence; then the cable and the real join with `btmon`.

## Step 15 — First real setups from the iPhone; BlueZ battery plugin stall fixed

- noe-lab: Ethernet (`eno1`, 192.168.1.13) is now the admin link; the NetworkManager sharing profile that ran a
  DHCP server on the home LAN no longer autoconnects. Service installed (`iot-device`, user `iot`).
- Evidence (`ACTUAL`): offline hello against the systemd service (`demo/service-offline-hello.txt`); service
  restart restores hello; two real setups with `btmon` recording (`demo/real-join.txt`). Run 1: the device joined
  the site network but the phone never got the result: BlueZ's battery plugin read the iPhone's Battery Level,
  iOS required encryption, BlueZ sent an SMP Security Request, pairing failed, and BlueZ never answered the
  phone's next read. Fix: `bluetoothd --noplugin=battery` (drop-in written by `install.sh`) and a 2 min grace
  so Try again recovers a lost result. Run 2: **Device connected** with the address on the iPhone; the capture
  holds the credentials only in an encrypted 68-byte write and no SMP traffic; SSID bytes absent.
- Not run: the password-bytes check (`demo/check_capture.py`, needs the user's password), wrong password and
  absent network on hardware, reboot (waits for the user's jobs), Android. Known leak: message sizes reveal the
  SSID and password lengths; pad the Provision request to a fixed size if that matters.

## Step 16 — 200 sensors: certified sensors, technician codes, batch setup

- Requirements settled in one session (Q1–Q24, decision 27): threat is a rogue device in range; labels dropped;
  IoT device certificates checked offline by the app inside Noise `XX`; technician codes signed by a separate
  authority, delivered as a `provide://technician/<hex>` link or QR, behind Face ID, 30 days, per customer, checked
  by the sensor with the firmware build date as clock floor; reconfiguration with rollback; "Set up all ready
  sensors in range", three at a time (six since step 18), stop on site-wide errors; counters, filters, Retry failed. Sensor ID is
  `IOT-` + 10 hex digits (40 bits) instead of the 6 first proposed, to avoid collisions in large fleets.
- Device: `src/authority.rs` (certificates, codes, Ed25519 via `ed25519-dalek` 2.2), `src/provision.rs` rewritten
  (XX, identity files, token phase, encrypted refusal reasons), `device/wifi.rs` two alternating profile UUIDs with
  rollback, `device/main.rs` reconfiguration and advertised state, `device/stage.rs` init/install,
  `device/authority.rs` (init, public, certify, issue). Demo authorities in `~/noe-ws/iot-authority` on noe-lab
  (0600, outside the repository).
- App: `authority.ts`, `noise.ts` (XX initiator; a failed step poisons the later ones), `setup.ts` (certificate,
  key, ID and customer checks before the code leaves), `batch.ts`, `flow.ts`, `TechnicianSheet.tsx`, deep link
  scheme `provide`. `LabelScanner.tsx` removed.
- Evidence: Rust 40 default and 80 with `ble,stage` tests, clippy clean (noe-lab); app 48 tests, typecheck, lint.
  `SIMULATION`: iOS Simulator "IoT 16 Pro", Release build with a temporary harness (removed afterwards, not in
  the repository): 20 fake sensors, each a Noise `XX` responder in JavaScript with its own key and a certificate
  from a throwaway demo authority; one impostor (copied certificate) and one other-customer sensor; screens and
  55 s video in `docs/architecture/`. The video exposed a bug: after a batch, **Set up all ready** offered the
  refused sensors again; fixed (Retry failed covers them).
- Pending: staging noe-lab with a certificate (`~/noe-ws/stage-lab.sh`, needs the user's sudo), a code on the
  iPhone, and the real run; wrong password, absent network and rollback on hardware; reboot; Android.

## Step 17 - Review, ship checks and holder-bound codes

- Review round 1 (commits `52644b3` and `f980486`): a code review and a security review, then 11 fresh agents
  checked every finding against the code before anything was fixed. 26 held (8 confirmed, 18 partially confirmed,
  none refuted; after re-rating 2 important, 5 medium, 14 low, 5 nit). The two important ones: a batch that outlived
  the app's lock (iOS auto-lock during a long batch) failed every remaining sensor as "rejected" instead of stopping,
  and a result that came back after the app left the foreground read the cleared site and kept the password in
  memory. Fixed in the working tree: the batch stops with **locked** and keeps the screen awake (`expo-keep-awake`);
  the flow keeps a hash of the network, never the password; a single setup updates its batch entry; an expired code
  shows as expired; one sheet at a time; spoken filter labels; the impostor-reply vector. Device: a first-protocol
  `identity` still loads, the working-profile record and the rollback agree after a failed write, a garbled marker
  leaves the profiles alone, at most 64 stored results, `stage install` refuses a technician authority that is not
  one, `authority issue` caps codes at 30 days and refuses a key file open to the group, one hex parser, the
  `clock-floor` file, and the accepted name and refusal reasons in the log. A5 (every card redrawn) is `d462ef4`.
  Left as is: A10 (two waiting mechanisms in the app, low) and S7a (extra password copies in device memory, nit).
- Holder-bound codes (S1, medium): tokens are version 2 (`iot-technician-token/2`) and name a holder X25519 key
  that `authority issue` generates with each code. The phone uses its private half as its Noise static key; the
  sensor refuses a token whose holder is not the key the phone proved, so a sensor that records a token cannot
  present it. Version 1 tokens are refused on both sides. The largest message 3 is 499 B (asserted). The snow vectors
  add the holder key, a wrong-holder token and its refusal, and an impostor's reply.
- Review round 2, on the fixes: 11 findings, all low or nit, all confirmed and fixed, among them: an unreadable
  marker takes the profile NetworkManager has active, a failed directory sync after the rename no longer rolls back,
  the floor write runs off the GATT runtime, `write_new` removes a partial file, a second sheet waits until the
  first is gone, the docs follow the version 2 token.
- Performance (`d462ef4`,
  [docs/BENCHMARKS.md](../docs/BENCHMARKS.md#configurator-with-200-sensors-in-range-2026-10-20)): memoized sensor
  cards and scan updates applied every 500 ms. With 200 fake sensors in the iOS Simulator (Release,
  Hermes): 15.6 to 1.9 renders/s, JS busy 45 % to 3-4 %, JS lag p95 unchanged at 17 ms.
- Ship review (`d462ef4` and the working tree), three agents: five-axis code review **APPROVE** (0 critical,
  0 important); security audit 0 critical, 0 high, 1 medium, 2 low, 4 info; test engineer ran 21 TypeScript and
  18 Rust mutations, 9 survived. Fixed after it: the clock floor rises no faster than the uptime, so a clock spoofed
  forward cannot lock codes out; the batch guard moved into `SetupFlow.batchRequest`; a scanned code never shows in
  the text field and a new code's details appear only once checked; the old Keychain info entry is deleted;
  `stage install` rewrites a first-protocol `identity` without its label secret; the device logs the BLE MTU when a
  session starts. New tests cover 7 of the 9 surviving mutants: floor at startup (`initial_floor`), 30-day cap and
  key-file mode (`device/authority.rs`), garbled marker (`startup_profile`), no password after a lost result, the
  network key includes the SSID, the first stop reason is the one reported (the three app tests fail on their
  mutants; the Rust ones were not re-mutated).
- Code import inside the app only (user decision, from the audit's medium finding: whichever app claims `provide://`
  receives the whole code). `authority issue` prints the bare code `<token hex>.<holder private key hex>` as text and
  QR (`authority::code_text`); the app registers no `provide` scheme and reads no incoming URL (only Expo's default
  bundle-ID and dev-client schemes remain; `app.json`, and `ios/provide/Info.plist` in the local native project,
  gitignored), so no link can carry the code; it reads codes only with its own camera or from a paste; a pasted code
  with the old prefix still works. The vectors carry the printed `code`, which `authority.test.ts` reads as is.
- Evidence: Rust 40 default and 88 with `ble,stage` tests, clippy clean (noe-lab, throwaway copy, deleted); app 59
  tests, typecheck, lint. `ACTUAL`: [demo/real-reconfigure.txt](../demo/real-reconfigure.txt), commit `52644b3` with a
  version 1 code opened through the old link: the iPhone gave noe-lab a new network, 5.8 s from request to success.
- NOT_RUN: holder-bound codes and in-app import on hardware; a failed reconfiguration rolling back, wrong password
  and absent network on hardware; reboot; Android. Not done: clearing the clipboard after a paste (`expo-clipboard`
  is not a dependency), a Keychain round-trip test, tests for the `write_new` cleanup and the directory sync.
  `npm audit --omit=dev`: 25 findings (18 high), all in the build toolchain, none at runtime. Screenshot 3 and the
  video in `docs/architecture/` still show the link.
- Next owner: rebuild the app (the native project lost the scheme and has the new permission strings) and the
  device; `stage install` on noe-lab; issue a new code, print the bare QR, scan it in **provide.**, then the real run.
  Commit `demo/real-reconfigure.txt` with this step (`git add`): it is untracked.

## Step 18 - Overall of the sensors in range

- Request (user): the most aesthetic and ergonomic view of many sensors, compatible with the current design, with the
  current design still available in a corner.
- Tried first, never committed (backups in a scratchpad, outside the repository): a design canvas with five
  approaches in the real **provide.** layout (A summary and failures by cause, B the wing as tiles, C dense list with
  search by the end of the ID, D find a sensor by its signal, E end-of-visit report), compared by a judge panel.
  Built: A as an **overview** (progress card with a check line, failures by cause with **Retry N**, the sensors
  working now, folded groups), B as a **wall** (one tile per sensor, problems pinned) and a switch at the corner of
  the sensor list back to the cards, about 470 lines. Checked in the Simulator with 200 fake sensors.
- Technician's feedback on that build: they like the original card list best. They want an overall with the same
  ergonomics, easy access to the sensors not set up, set up and with errors, no emoji, and the original design
  philosophy kept. The overview, the wall, the switch and their media were removed
  ([decision 28](../docs/DECISIONS.md#28-overall-of-the-sensors-in-range)).
- Built (uncommitted, on `dea35be`):
  - `configurator/src/wing.ts`, outside React like `flow.ts`: `groupOf(state, batchEntry)` puts each sensor in one
    group, set up, error or not set up: this session's result first, from a batch or a setup by hand; otherwise
    online is set up, offline is an error (set up, but not on its Wi-Fi), anything else is not set up. A sensor that
    joined but now advertises offline is an error. The advertisement never turns a failure into set up (an impostor
    can advertise online). `minutesLeft`: the pace so far, once 10 sensors have finished. `wing.test.ts`: 2 tests.
  - `configurator/src/Summary.tsx`: a card in the original style. Title "N set up of M in range" in two tones like the
    screen title; one line, the batch's progress ("3 in progress · 126 waiting · about 1 min left") or what is left
    ("R ready to set up · P not prepared", then "· U state unknown" when older firmware advertises no state); a bar
    (set up in ink, errors in red, the rest blank); three tabs **Set up**, **Errors**, **Not set up** with their
    counts and a shape each (filled ink, filled red, hollow), no symbols.
    Tab roles, spoken "Errors, 8", text capped at ×1.3.
  - `App.tsx`: the card shows when more than `AUTO_FOLD_AFTER` (4) sensors are in range or a batch has run (step 19:
    only past 4 sensors). Its tabs replace the filter pills (All, a tick, a cross, an hourglass emoji): a tap filters
    the cards, a second tap shows all, a tab at 0 is disabled. A tab whose group empties was deselected, and the list
    sorted errors first, then not set up, then set up, failures grouped by cause (both replaced in step 19: a
    selected tab stays on, the list keeps the scan order, only the Errors tab groups by cause). The time left counts
    only the current batch (`batchStarted` holds its start and size). A setup by hand is kept like a batch result:
    **Retry failed** also appears after one fails, with no batch needed, and the sensor leaves **Set up all ready**
    and counts under Errors, so a sensor that is not genuine is no longer retried by that button.
- Checked in the iOS Simulator (`SIMULATION`) with 200 fake sensors, each with a real Noise `XX` responder (temporary
  harness, not in the repository; demo mode replaced it in step 19). Before the batch: 6 set up, 4 not prepared, 190
  ready. The batch ends with 182 connected and 8 refused (3 cannot see the network, 3 not genuine, 2 of another
  customer): "188 set up of 200 in range", Errors 8, Not set up 4, **Retry failed (5)** (the 3 not genuine are left
  out). iPhone 16 Pro during the batch: 64 / 3 / 133, "3 in progress · 126 waiting · about 1 min left". Errors tab:
  only the refused sensors, each with its reason. iPhone SE with accessibility-large text, during the batch: 40 / 1 /
  159; the title, the line and "Not set up" wrap, the card stays on the first screen. Screens
  `docs/architecture/08-overall-running.png` to `11-overall-se-large-text.png`, video `overall-200-sensors.mp4` (55 s
  at 2x speed: the batch, then the three tabs). Step 19 replaced these media with demo-mode captures and removed
  `09-overall-done.png`; the numbers above (64 / 3 / 133, "3 in progress") describe the step 18 build, which ran
  three links.
- Evidence: app 61 tests at this step (2 in `wing.test.ts`; 68 after step 19), `npx tsc --noEmit` and `npx expo lint`
  clean, run again for these docs. Docs: `docs/ARCHITECTURE.md` (flow, 200 devices, what is proven, code map),
  decision 28, README (demo step 6, evidence), `tasks/compliance.md`.
- Limits: a sensor set up before but offline counts as an error; no Retry per cause (the Errors tab groups by cause,
  **Retry failed** covers them); the time left assumes a steady pace; screens 5 to 7 and `demo-simulator.mp4` still
  show the old filter pills.
- Still open at this step, FIXED in step 19: when a batch stopped (`WrongPsk`, code locked or expired), the queued
  sensors were marked stopped only after the ones in progress finished (up to the 60 s join timeout). `runBatch` now
  takes the queue out when `stopReason` is first set (test "a stop marks the queue at once").
- The app is installed on the technician's iPhone. NOT_RUN: the overall there with many real sensors; no real sensor
  has gone through it yet.
- Next owner: use the overall on the technician's iPhone with real sensors; commit `Summary.tsx`, `wing.ts`,
  `wing.test.ts`, the screens and the video (all untracked).

## Step 19 - Batch at the pace of a wing, demo mode, test bench

- Goal: set up a wing faster, show the app with a wing and no sensors, and measure it over real Bluetooth.
  Decisions [29](../docs/DECISIONS.md#29-batch-at-the-pace-of-a-wing) and
  [30](../docs/DECISIONS.md#30-demo-mode-in-the-app-and-the-lab-bench).
- List and overall (`App.tsx`, `Summary.tsx`, uncommitted on `dea35be`):
  - The overall card shows only past 4 sensors in range (no longer "or after a batch"). A selected tab stays on (the
    deselect rule is gone); it keeps what it showed and adds the sensors that join its group. The list keeps the scan
    order; only the Errors tab, when tapped, groups by cause.
  - Past 4 sensors each sensor is a compact row (group shape, one status line, signal); a tap opens it in place into
    the full card, a second tap folds it.
  - Not set up tab: an **IN PROGRESS** block on top, one fixed slot per running sensor (kept while the sensor is in
    the block; an empty slot is kept until reused). Running sensors leave the list below, which is what is left to
    do; finished ones belong to Set up or Errors. A row opened while in progress stays in the block with its result
    until closed.
  - List header "SENSORS · N", "NOT SET UP · N", "SET UP · N" or "ERRORS · N" with a refresh icon, hidden while
    anything runs: drops sensors not heard for 15 s (`STALE_MS`), never one in the batch; while paused it only
    resumes the search.
  - Launch: title and radar, then the code and site rows (from launch, before any sensor), then the sensors after the
    intro (`INTRO_MS`, 1.4 s). Panel height and radar size animate after the first layout. When the list gets crowded
    the radar folds to compact at once, so the overall card shows whole; a batch folds it once (1.2 s), never per
    sensor.
- Batch (`batch.ts`, `setup.ts`): `BATCH_CONCURRENCY` 6 (was 3; a sensor holds a link about 7.5 s, so 200 take about
  8 min at 3 and about 4 at 6; not measured on hardware). Link failures (timeout, rejected, `Busy`, `unknown`) go back
  to the queue up to `RETRIES` (2) more times, with the same attempt ID when needed, never after a stop. A stop marks
  the queue at once. **Add N to the batch** adds the sensors found meanwhile (`BatchControl.add`, de-duplicated, not
  after a stop). The scan continues during runs (the stop per run was removed). Status poll every 500 ms. During a
  batch, **Test** stays available on sensors the batch is not working on; **Set up** by hand stays disabled.
- Credentials: the code and the site password stay in memory and are locked again when the app comes back after more
  than 2 minutes away (`LOCK_AFTER_MS`), instead of as soon as it leaves; a short switch no longer stops a batch.
- Demo mode (`src/demo.ts`, `demo.test.ts`): tap the logo and confirm; the chip reads DEMO; the logo or the chip
  leaves; `-demo 1` (simctl) starts in it. 200 simulated sensors on a fake radio, each running the sensor side of
  Noise `XX` with a certificate from a demo authority whose seeds are public (0x51, 0x52), trusted only on the demo
  radio; a remount separates the modes. Demo code and site in memory; nothing saved is read or written; the code and
  site sheets never open. Discovery is gradual: about half in 4 s, the rest over a minute. Audited: no path pairs the
  demo authority with the real radio; `demo.test.ts` shows demo sensors refused under the real `DEVICE_AUTHORITY`.
- Test bench (`lab/`, kept out of the app): `iot_sim.py` (Bumble, Python 3.10) takes noe-lab's hci0 through the HCI
  user channel and shows 200 sensors over real Bluetooth. Identities from `mint-lab.sh` (`stage init` and
  `authority certify` for `LAB`, 194 to 196 for `OTHER`, keys in 0600 files in `~/noe-ws/lab-sensors`, certified by
  the real device authority), rotated over the advertising sets the MT7921 enables (it reports 20, enabled 16 at
  once; 6 kept free for the phone's links). GATT and Noise byte for byte (`--selftest` replays
  `configurator/src/noise-vectors.json`); simulated join outcomes per identity (ok 5.5 s, slow, not in range, busy,
  timeout, online, offline, clone); `wrong-password` gives `WrongPsk`. `sim-lab.sh` (sudo) stops `iot-device` and
  `bluetooth`, runs the simulator and gives hci0 back on exit. A technician code for `LAB` and `DEMO` was issued (30
  days).
- Measured on the bench (`ACTUAL_BLE`, simulated sensors, iPhone app; run log on noe-lab, not in the repository): a
  run with 14 advertising sets and a 3 s cycle had 84 provisioning sessions and 79 joins, against 20 sessions in the
  run before the retries and the faster cycle. The bench's sensors are on air part of the time, so its connect
  latency is worse than real sensors'.
- Media (`SIMULATION`, demo mode, iPhone 16 Pro unless said): `08-overall-running.png` (batch running, compact rows,
  Add 2 to the batch), `09-overall-in-progress.png` (Not set up tab, IN PROGRESS · 6), `10-overall-errors.png` (after
  a batch: Errors tab, 3 errors grouped by cause, list header with the refresh icon, Set up all ready and Retry
  failed), `11-overall-se-large-text.png` (iPhone SE, accessibility-large, during a batch: Add 19 to the batch),
  `overall-200-sensors.mp4` (42 s at 2x speed: discovery, a batch with sensors added, the Not set up tab, the Errors
  tab). `09-overall-done.png` removed.
- Evidence: app 68 tests (12 in `batch.test.ts`, 3 in `demo.test.ts`), `npm run typecheck` and `npm run lint` clean,
  run for these docs. The 2-minute lock has no test. Docs: README (status, step 4 and 6, demo mode, test bench, tests,
  evidence), `docs/ARCHITECTURE.md`, decisions 26 to 30, `docs/SECURITY.md` (in-memory lock, demo authority, bench
  identities, root simulator), `tasks/compliance.md`.
- Still open: measure six links and scanning during runs on the bench and with real sensors (iOS connects were
  thought more reliable without a concurrent scan); release the link during the join; a concurrency that adapts to
  failures. The models beyond one phone are documented in `docs/ARCHITECTURE.md` ("Beyond one phone"), none built.
- NOT_RUN: the overall, six links and the scan during runs with many real sensors; the current protocol against the
  real device service with a holder-bound code.
- Next owner: run a batch on the bench with real timing logs, then with real sensors; commit `Summary.tsx`, `wing.ts`,
  `wing.test.ts`, `demo.ts`, `demo.test.ts`, `lab/` and the media in `docs/architecture/` (all untracked). Do not add
  the challenge PDF at the repository root.

## Desktop T3 — Tauri shell resumed in Codex, 2026-10-21

- Preserved Claude's uncommitted Tauri 2 shell, CLI lockfile and the two sheet-key fixes in App.tsx. T1/T2 and
  checkpoint A (`7eb3d2a`) were not repeated. npm desktop scripts now enter `desktop/`, where Tauri finds its config.
- `ACTUAL_HOST` PASS: existing `provide-desktop --demo` process, native Provide window 1280×800; window-only
  [capture](../docs/desktop/t3-native-before.png). `--demo` reaches the shared React app. The native window exposes
  the stretched mobile layout and a large empty radar area; these are T7 work, not evidence of a usable desktop UI.
- Checks: 70 JS tests, typecheck, Expo lint, `cargo clippy --all-targets -- -D warnings` PASS. iPhone baseline captured
  locally before layout changes (real mode, no BLE on Simulator); the demo comparison follows at T7.
- The already running dev process was reused. Launch from configurator with cargo on PATH:
  `npm run desktop:dev -- -- -- --demo` (npm, Tauri runner, then app arguments). From desktop directly:
  `../node_modules/.bin/tauri dev -- -- --demo`. Release export/bundle is T8.
- NOT_RUN: real desktop BLE, keychain persistence, webcam QR, native batch playtest. Browser radio is still unavailable
  and browser secret storage still volatile at this step. No noe-lab service was stopped. Challenge PDF excluded.
- Next: T7 first, as now requested, then T4/T5/T6, checkpoint B where hardware/authorization allow, T8 and checkpoint C.

## Desktop icon — iOS artwork, macOS container, 2026-10-22

- User-requested interruption before T7: reused `configurator/assets/icon.png` exactly; its SHA-256 remains
  `d88e8c95a882dca99d472f1bf76bf75eb9ccdcf3ee44409d11b15d076b932c34` (iOS unchanged).
- `desktop/make-icons.swift` deterministically draws the same black/white artwork into an 824 px squircle on a
  transparent 1024 px canvas, and regenerates the dev PNGs and every ICNS size (16–1024). No image model or dependency.
  Its pixel assertions check transparent corners and opaque artwork, including the small sizes. Run on macOS with
  `swift configurator/desktop/make-icons.swift` from the repository root.
- PASS: icon generation, 70 JS tests, typecheck, lint, Tauri debug `.app` build; bundled ICNS byte-for-byte equals the
  source ICNS. Provide relaunched in demo mode; macOS's registered running icon was inspected and
  [captured](../docs/desktop/icon-running-macos.png). On this macOS version the OS adds a glass surround to a legacy
  packaged ICNS; the checked-in image itself is a white squircle with transparent margins. Dock is auto-hidden and its
  accessibility query timed out; a literal Dock screenshot is NOT_RUN. No Dock preferences were changed.
- The first packaged build exposed TypeScript scanning compressed generated Tauri JavaScript: tsconfig now excludes
  `desktop/src-tauri/target`, `gen`, and `dist` (source checks remain on). The subsequent typecheck and lint pass.
- T7 changes are preserved separately and remain uncommitted. Real BLE/keychain/webcam remain T4–T6 work.

## Desktop T7 (in progress) — card opening without distortion, 2026-10-22

- User report: opening a sensor card on desktop is slow and its text is stretched. Cause: Reanimated's web
  `LinearTransition` animates a size change by scaling the view, so the text and the buttons are drawn squashed for the
  whole 450 ms transition.
- Fix (`App.tsx`): `layout` is `undefined` on the web, so the card opens at once; iOS keeps its transition unchanged.
  The desktop column style `cell` is memoized per width: a fresh object each render redrew all 200 memoized cards.
- Measured with Playwright in Chrome, demo at 1280×800, 4 rows (script in the session scratchpad, not shipped). Before:
  Test drawn 17.2 px high on its first frame (44 px when settled), 27–28 scaled frames, settled 529–645 ms after the
  click, frames up to 70 ms. After: Test 44 px from the first frame, 0 scaled frames, open in 12–19 ms, frames up to
  32 ms. Frame captures (open at 40 ms, Test result, fold, opening during a batch) show sharp text; no console error.
- Checks: 70 JS tests, typecheck, lint PASS. Not rerun: the iPhone Simulator (no change on iOS: `Platform.OS` guard and
  a `cell` that stays `undefined` there).
- Still open from `tasks/desktop-ux-audit.md`: web ARIA expanded/selected, reveal of a lower row, toolbar height during a
  batch, list scroll on tab change, dialog height, short-window sidebar, double caption, then T4–T6, T8, checkpoint C.
- Playwright playtest (`configurator/desktop/playtest.mjs`, Metro on 8081, Chrome) now also checks the opening: 20
  frames with no scaled card and Test at 44 px on its first frame. Full run PASS (open without distortion, Test,
  batch with six slots, Add, Retry, tabs, Refresh, widths 320 to 2560, keyboard dialogs, no console error); the
  `docs/desktop/t7-*` captures and `playtest.json` were regenerated by this run.
- Installed on the MacBook: `npm run desktop:build -- --bundles app` (release, `expo export -p web` embedded, 8.7 MB)
  copied to `/Applications/Provide.app`; launched with `--demo`, the desktop layout shows (window capture checked). The
  build first refused `@tauri-apps/api` 2.12.4 against the `tauri` crate 2.11.6 (latest 2.x on crates.io): pinned
  `~2.11.1`. Unsigned and not notarized (T8). Launchpad: the iOS build products (Simulator and device `provide.app`,
  old `ProvisioningBLE.app`) were unregistered and deleted, as were the build copies of the desktop app, so only
  `/Applications/Provide.app` is listed. Rebuilding for the Simulator recreates them under `configurator/ios/build/`.
- Unfold animation on desktop (user request: as on mobile). On the web, `SensorCard` is a clipping frame (`s.frame`,
  card background and radius) around its content; the frame's height follows the content with `withTiming(RESIZE)`
  (450 ms, the iOS curve), so the card, the fold and the result drawer animate without scaling the text. The first
  measure sets the height at once. iOS keeps `LinearTransition` unchanged. Playwright (Chrome, 1280×800): opening
  56 → 143 px over about 470 ms, folding back the same way, Test at 44 px on every frame, 0 scaled frames; captures
  mid-opening, mid-fold and with the drawer growing on Test show sharp text. Full playtest PASS, 70 tests, typecheck,
  lint PASS. `/Applications/Provide.app` rebuilt and reinstalled with it.
- Blank window at launch (user report), FIXED. Cause: in the Tauri window WebKit's user agent has no "Safari", so
  expo-font polls with fontfaceobserver, which hangs in WebKit until its 12 s timeout; `App.tsx` rendered nothing until
  then. Found with a temporary bridge sending page errors and state to stderr (removed; `main.rs` unchanged): bundle
  ran, `document.fonts.status` loaded, no text after 8 s. Fix: on the web the first render no longer waits for
  `useFonts` (fonts are local and in place before the intro ends; iOS unchanged). Three launches of the installed app:
  the screen is shown with Onest at 2 s.
- Each build is now clean: `npm run desktop:build` deletes `dist/` and the release bundle first (user request; a stale
  `dist/` can mix exports).
- Press feedback and short animations on desktop (user request: each action, feedback, short and fluid animation):
  `src/feedback.web.ts` (`src/feedback.ts` empty on iOS) adds CSS to every button, tab and row: pointer cursor, hover
  opacity 0.86, press 0.72 plus scale 0.97 on buttons and tabs (rows only dim), 120 ms transitions run by the browser,
  none under reduced motion. The card unfolds in `UNFOLD` (220 ms, ease-out) instead of 450 ms. Playwright: feedback
  at mousedown; open starts 35 to 42 ms after the click and settles at about 225 ms, fold the same; hover/press styles
  measured. Full playtest, 70 tests, lint, clippy PASS; clean build installed in `/Applications`.
- Seen in the installed app, not changed yet: without a radio the desktop says "Open the Provide desktop app to use
  Bluetooth" (written for the browser); T4 replaces it with the real radio.
- Two Provide icons in Launchpad (user report): macOS registers the build output `target/release/bundle/macos/Provide.app`
  besides `/Applications/Provide.app`. Removed the build copies (release and debug) from LaunchServices and disk.
  New `npm run desktop:install`: clean build, then moves the bundle into `/Applications` (a move, not a copy, so no
  second app remains). Use it instead of copying by hand.

## Desktop T4 — Bluetooth bridge (btleplug), 2026-10-22

- User report: the desktop app said "Open the Provide desktop app to use Bluetooth" (the browser's message; no radio).
- `desktop/src-tauri/src/ble.rs`: btleplug 0.13 (was 0.11.8 in the uncommitted manifest; 0.13 builds on Rust 1.88),
  commands `ble_state`, `ble_scan` (service filter, rounds of N seconds then a `ble-stop` event, an old round's timer
  never stops a new one), `ble_stop_scan`, `ble_connect`, `ble_services`, `ble_write` (with response, whole value),
  `ble_read`, `ble_disconnect`; events `ble-discover` (id, name, RSSI, manufacturer data keyed `ffff` like
  react-native-ble-manager) and `ble-state`. Peripherals are kept by id from discovery. Direct `futures` dependency
  (already in the graph through btleplug). `Info.plist` declares `NSBluetoothAlwaysUsageDescription`.
- `src/ble.web.ts`: `bridge(tauri)` gives App.tsx react-native-ble-manager's calls over `window.__TAURI__`; a plain
  browser still has no radio. Tests: `src/ble-bridge.test.ts` (advertisement to Peripheral, commands, unsubscribe),
  Rust `cargo test` (manufacturer key, state name). 72 JS tests, typecheck, lint, clippy `-D warnings` PASS.
- `ACTUAL_HOST`: installed with `npm run desktop:install`; the app shows "Looking for IoT sensors…" with the radar,
  no Bluetooth warning; the bundle's Info.plist carries the usage string.
- NOT_RUN: discovery and Test against IOT-AFD042F349. `iot-device` on noe-lab is inactive since 2026-10-21 08:50
  (stopped cleanly, likely by the bench), and starting it needs the user's sudo password (only iot-deploy and
  iot-reset are NOPASSWD). Then: Test → "world", Set up with a technician code (code in memory until T5).
- Empty right half while searching (user report): before the first sensor, the desktop list column shows `Waiting`
  (App.tsx): "SENSORS · 0", a line (searching: sensors show as soon as heard; otherwise the radar's caption) and six
  placeholder rows in the list's columns, pulsing one after another (CSS `data-pulse` in `src/feedback.web.ts`, none
  under reduced motion, hidden from assistive technology). It fades in with the code and site rows (`afterDot`), so
  the launch order is kept; the first sensors replace it. Playwright: placeholders pulse with 0/150/300 ms delays and
  are gone once sensors are listed; full playtest, 72 tests, lint PASS; installed with `desktop:install`.
- Each new build is ad-hoc signed with a new signature, so macOS asks for the Bluetooth permission again ("Provide would
  like to use Bluetooth"); until the user allows, the app shows "Search paused." Signing (T8) keeps the permission
  across updates.

## Factory on the MacBook, Floware sensor staged as a IoT sensor, 2026-10-22

- User decision: the MacBook is the factory machine. The device and technician authority keys were copied from
  noe-lab to `~/noe-ws/iot-authority` on the Mac (scp, 0600 files, directory 0700, outside the repository); they now
  exist on both machines. `target/release/authority public` on the Mac prints the keys in `configurator/src/authority.ts`.
- Build for the sensor (the factory flashes binaries, the sensor compiles nothing): Colima (Homebrew) runs Docker on
  the Mac; `ubuntu:22.04` arm64 container, README's `cargo build --release --features ble,stage --locked` on
  `git archive HEAD` in `~/noe-ws/factory-build` (Colima only shares the home folder). glibc 2.35, as on the Jetson.
- Sensor: Floware FLWR-O-019, Jetson L4T R36.3 (Ubuntu 22.04, aarch64), USB-C networking (`en11` on the Mac,
  sensor at 192.168.55.1), user `floware`; the password stays in a 0600 file read through SSH_ASKPASS and sudo's stdin,
  never in argv. Adding an SSH key to the sensor was refused by the permission classifier; not done.
- Installed with `device/systemd/install.sh wlan0` from `~/iot-factory` on the sensor: `iot` system user,
  `/usr/local/bin/iot-device` and `iot-stage`, unit enabled, polkit rule, bluetoothd without the battery plugin
  (drop-in `/etc/systemd/system/bluetooth.service.d/iot-device.conf`). `stage init` gave IOT-7B09F20339 (public key
  d01a60df…ed36), certified on the Mac for `DEMO`, `stage install` with the technician authority key; the journal
  shows "IOT-7B09F20339 advertising on hci0".
- `ACTUAL_HOST` + `ACTUAL_BLE`: Provide on the Mac (desktop, btleplug) lists IOT-7B09F20339, "Ready to set up",
  -52 dBm.
- Before Set up: the sensor's Wi-Fi is on `FLWR-002_5G`; a setup makes it join the chosen site Wi-Fi instead. To undo
  the install: `systemctl disable --now iot-device`, remove the two binaries, the unit, the polkit files, the
  bluetooth drop-in, `/var/lib/iot-device` and the `iot` user.
- Next: the technician's part in Provide on the Mac (Test, technician code by paste since webcam QR is T6, site Wi-Fi,
  Set up). The code and site stay in memory until the keychain bridge (T5).

## Desktop layouts, resizing, discovery speed and the webcam, 2026-10-22

- Layout matrix (Playwright, Chrome, demo; script in the session scratchpad): 9 sizes × launch and crowded, plus a
  resize sequence during a batch. Fixed:
  - Desktop window under ~700 px tall: the left column cut off the code and site rows; it now scrolls (`s.sidebar`
    is a ScrollView).
  - Crossing 900 px: no fade (appear animations are skipped for 600 ms after a layout switch, `unlessSwitched`);
    a crowded phone list opens already folded, scrolled through the list itself on the next frame (the UI-thread
    scroll still targeted the removed desktop list), and `y` restarts from the new list (a stale `y` showed a compact
    circle above an unscrolled list, the user's screenshot).
  - Web phone layout: the circle follows the scroll (no compact lock on the web, which has no contentInset: the list
    scrolled past the lock and left a gap); a list resting compact stays compact when a resize moves `travel`.
  - macOS app only: WKWebView does not send visualViewport resize events, so `useWindowDimensions` lagged (phone
    layout at 1100 px, desktop at 420). The layout now follows the body's measured width; `src/viewport.web.ts`
    still forwards window resizes for the dialogs.
  - Live resize: desktop columns are CSS grid (`repeat(auto-fill, minmax(320px, 1fr))`) instead of widths computed
    from an onLayout (a frame late, cards overflowed then jumped); the web card frame animates only within 400 ms of
    its own state change (open, fold, link, result), not on re-wrap.
  - Evidence: 27 layouts with 2 flagged rows that scrolled under the compact bar (by design, checked visually); resize
    sequence in WebKit and Chrome, 0 gaps; scroll back up: circle 48 → 176 → 304 px, gap 12 to 56 px; 147-step drag:
    0 frames off content, 0 cards outside their column, 0 unequal rows; native app, sizes 1280/880/600/1100/900×600/
    420/1440 through a temporary self-resize hook (removed): correct layout at each.
- Discovery (user: "slow here"; sometimes Bluetooth had to be toggled):
  - Bridge: macOS reports a known sensor's later advertisements as RssiUpdate/manufacturer/services events unless the
    packet carries a name; they are now sightings too (throttled to one report per sensor per 250 ms), so a sensor
    dropped from the list comes back without toggling Bluetooth. The advertised name now comes before the cached one
    (the Mac showed FLWR-O-019).
  - Sensor: macOS heard the Jetson every 9 s (BlueZ default interval 1.28 s; btmon). The advertisement now asks
    400-500 ms, honoured only with `bluetoothd --experimental` (install.sh). Measured (CoreBluetooth, 20 s): default
    3-4 sightings, first at 9.4 s; 100-150 ms: 33-39 sightings, first at 1.3 s, but the name (scan response) never
    reached the Mac; 152.5-211 ms: same, no name; 400-500 ms: 6-9 sightings, nearly all with the name, first at 1.6
    to 6.4 s. Deployed on FLWR-O-019 (drop-in updated by hand there). Device clippy and tests PASS in the Ubuntu 22.04
    container; noise vectors test PASS in the repository. noe-lab not redeployed.
- Webcam (subagents): "Allow the camera" did nothing because the bundle lacked `NSCameraUsageDescription` (added to
  `Info.plist`); the preview was 0 px high on the web (fixed in `QrCamera.tsx`, iOS defaults); a refusal now explains
  System Settings. The decoder (barcode-detector/zxing-wasm, through expo-camera) fetched its wasm from jsdelivr:
  now served from the app (`src/zxing.web.ts`, `public/zxing_reader.wasm` copied by `postinstall`, gitignored;
  `src/zxing.test.ts` checks its hash against barcode-detector's); `barcode-detector` 3.2.3 is a direct dependency.
  Chrome with a fake camera and jsdelivr blocked: decoded in 13 ms (before: not decoded in 20 s).
- Checks: 73 JS tests, typecheck, lint, clippy, full playtest PASS; installed with `desktop:install`.
- NOT_RUN: camera in the native window (needs the user to allow it), Test and Set up from the Mac on FLWR-O-019.
  Each rebuild asks for the Bluetooth permission again (ad-hoc signature, T8).

## Desktop: compact view after a resize, waves during a resize, 2026-10-23

- User: after a horizontal resize the phone layout must show the list with the circle compact (their screenshot as the
  default). Web, phone layout, at least one sensor: any window resize folds to compact at once, through the list's own
  scroll element, retried up to 10 frames until it reaches `travel` (a list just mounted by a desktop→phone switch is
  not laid out yet; an effect cleanup on a late `travel` change cancelled the first attempt). A list resting compact
  follows `travel` when a late re-measure (title re-wrap) moves it. Scrolling up still brings the large circle back.
  Replaces the crowded-only fold on a switch and the earlier travel effect.
- User: resizing paused the page's animations. Chrome keeps 72-86 fps while resizing (JavaScript not saturated), so
  the freeze is the macOS app's WebKit, which stops animation frames during a window drag. `src/Radar.web.tsx`: the
  same radar with its waves and the dot's emission as CSS keyframes (transform and opacity, run by the compositor,
  off under reduced motion); its size still follows the scroll through Reanimated; iOS keeps `Radar.tsx`.
- Found while testing: Metro kept an old resolution of `./src/Radar` for the page's bundle variant (lazy, Hermes)
  after `Radar.web.tsx` was added; restarted with `--clear`. Packaged builds export fresh and are not affected.
- Evidence (fresh Metro): layout matrix 27 layouts, 0 findings; resize sequences 0 gaps (WebKit, Chrome); horizontal
  resize 600→500 and desktop→700: circle 48 px, list 12 px below (WebKit, Chrome); scroll back up 48 → 176 → 304 px;
  147-step drag 0 defects; no fade; radar waves captured every 200 ms; 73 tests, lint, full playtest PASS. Native,
  through a temporary self-resize hook (removed): compact with the list below after 1280→700, 700→560, 1280→640.
- NOT_RUN: a real window drag in the app (needs the user's hand: Accessibility is not granted to the terminal).
- iPhone (user request, 2026-10-23): Release build with `xcodebuild` (team 8C5KXQ32WA from the Apple Development
  certificate; the regenerated project had none) and `devicectl device install` on "iPhone de Noé" (iPhone 15 Pro).
  It carries the shared fixes (sheet keys, `Sheet`, `QrCamera` box); iOS discovery code is unchanged (the faster
  discovery is the sensor's 400-500 ms interval and the desktop bridge). The build copy was unregistered from macOS
  LaunchServices so it does not appear in Launchpad.
- "This is not a genuine IoT sensor" on the iPhone against IOT-7B09F20339 (user report, 2026-10-23). The check is
  `deviceId(certificate.publicKey) !== sensorName` (setup.ts). The name travels only in the scan response; a packet
  without it made the app fall back to the system's cached name, the Jetson's adapter alias FLWR-O-019, so the ID
  check failed (a Mac scan then saw 10 sightings in 20 s, none with the name). Fixes:
  - App (iOS and desktop): `keepAdvertised` (probe.ts, test in probe.test.ts) keeps the last advertised name and
    state byte when a packet lacks them, on discovery and against the listed sensor. 74 tests, typecheck, lint PASS.
    Reinstalled on the iPhone (Release, launched) and in /Applications.
  - Sensor: `adapter.set_alias(name)` at startup (a failure only logs), so the cached name is the sensor's ID.
    Built and clippy-clean for the Jetson; NOT deployed: the USB link to FLWR-O-019 dropped (`en11` gone, ssh times
    out), so its journal for the failed attempt was not read either. Deploy with the factory steps once reachable.
- Sensor name, resolved (2026-10-23): the Jetson's kernel (5.15.136-tegra) never sends the scan response
  (`LE Set Extended Scan Response Data`) when BlueZ uses per-advertisement intervals (`--experimental`); with the
  interval as BlueZ's default (`main.conf [LE]`) it is sent, but Apple devices then still did not request it at
  400-500 ms (Mac: 0 names in 9-20 sightings). BlueZ's own default (1.28 s): first sighting 0.7-1.3 s, 7/8 and 19/19
  sightings with the name. The earlier 9 s first sighting did not reproduce. So the interval change is removed
  everywhere (device/main.rs, install.sh `--experimental`, the sensor's drop-in, main.conf restored from its backup).
  Kept: the adapter alias = sensor ID (the cached name becomes IOT-… after a connection) and `keepAdvertised` in
  the app. Deployed on FLWR-O-019 over Wi-Fi (192.168.1.15: the sensor rebooted ~00:01, USB networking did not come
  back, it is on the user's Wi-Fi through the `iot-provisioned` profile, so a setup succeeded before the reboot;
  that boot's journal is gone). Incident: one deploy installed an empty binary (wrong source path, unchecked pipe);
  reinstalled within minutes, `test -s` now guards the install.
- Refresh button (user request; subagent): one clockwise turn in 550 ms with a slight overshoot on each tap (UI
  thread, continues from the current angle on a second tap, none under reduced motion); iOS haptics: light impact on
  press, success after the refresh (`expo-haptics` 57.0.3, native: pods installed, iPhone rebuilt). Chrome: 0° →
  379° → 360° settled at 627 ms; 74 tests, typecheck, lint PASS. iPhone app rebuilt, installed and launched; desktop
  reinstalled.
- QR detection (user request: manual focus and autofocus): `QrCamera.tsx` keeps continuous autofocus (expo-camera's
  iOS default) and adds a centered frame with "Center the code · tap to focus"; a tap runs one focus pass now
  (`autofocus="on"`, which focuses once at the center) for 1.5 s, then hands back to continuous focus, with a pulse
  of the frame and a light haptic. Limits: expo-camera exposes no lens position, focus point or pinch zoom for the
  inline camera, so a focus slider or tap-at-point focus needs native code (or Apple's full-screen DataScanner through
  `CameraView.launchScanner`). Chrome fake camera: decoded in 8 ms with the frame shown and a tap; 74 tests,
  typecheck, lint PASS. iPhone rebuilt and installed; desktop reinstalled. NOT_RUN: a real scan on the iPhone.
- Pending: the side-by-side video (desktop + mirrored iPhone) waits for the user to unlock iPhone Mirroring; the
  sensor reset is done right before recording (it drops the sensor off the Wi-Fi until the setup).
- Desktop camera mirrored, QR "not working" (user report): the Mac has no back camera, so expo-camera opens the front
  one and mirrors its preview (CSS scaleX(-1)); a code held to it moves the wrong way. Decoding reads the unmirrored
  frames (`detector.detect(video)`). Fixes, web only: the preview is shown unmirrored (`video { transform: none }` in
  feedback.web.ts); once the stream runs, the track is asked for 1920×1080 (expo-camera requests no size, so WebKit
  opens the webcam at its default, often 640×480, too coarse for the dense technician code). Native WKWebView check
  through a temporary hook (removed): the shipped decoder read a test QR drawn to a canvas in 33 ms. Chrome fake
  camera: preview transform none, decoded. NOT_RUN: the real Mac webcam (resolution reached, scanning a printed code).
- Desktop scanning made practical (user request): `src/QrImport.web.tsx` (`QrImport.tsx` renders nothing on iOS),
  shown under the camera in both sheets, even when the camera is refused: paste an image anywhere while the sheet is
  open (⌘V: a screenshot or an image copied from Preview), drop an image on the window, or "Choose an image…"; decoded
  locally with the shipped decoder (`globalThis.BarcodeDetector`, src/zxing.web.ts), the image never stored; an image
  without a code says so. Chrome with the native detector removed (as in WKWebView): paste 191 ms, drop 25 ms, file
  30 ms, no-code message shown, no page error. 74 tests, typecheck, lint PASS; desktop reinstalled. NOT_RUN: the
  same in the macOS app window by hand.
- Technician code paste field, passkey style (user request): placeholder "■■■■-■■■■-■■■■-■■■■", the pasted code
  shown as dots (`secureTextEntry`, single line, no autocorrect or autofill) with "Code pasted · N characters,
  hidden" beneath; Save still checks it. The code (~300 characters) is pasted whole: per-character boxes would not
  fit. Chrome: input type password, invalid code refused, no page error; 74 tests, typecheck, lint PASS. iPhone and
  desktop reinstalled.
- Code field as segmented cells (user request, frontend-design): `CodeCells` in TechnicianSheet.tsx, 4 groups of 4
  small cells (white, `C.line` outline) separated by dashes in `C.tone`, on the field's `C.card`; blue outline when
  focused; the cells fill in ink as the code comes in (one cell per ~19 characters, a ~300-character code fills all
  16), stepping left to right in ~0.2 s, at once under reduced motion. A transparent field over the cells takes the
  paste; the code is never shown. Chrome: empty, focused, mid-fill and filled captured; 16 cells filled; Save still
  refuses an invalid code; 74 tests, typecheck, lint PASS. iPhone and desktop reinstalled. NOT_RUN: a long-press
  paste on the iPhone by hand.
- Code field refined (user: frontend skills plus web research, in the app's style). References: shadcn input-otp
  (joined slots, ring on the active slot, blinking caret, discreet separator) and Twilio's OTP guides (paste must
  work; for long keys one field over the cells). Now: 4 joined blocks of 4 cells on `C.card` with white hairline
  dividers, an 8 px `C.tone` bar between blocks, the next cell to fill gets the blue ring and a blinking caret
  (still under reduced motion), filled cells show an ink dot; under it, a valid code shows "✓ name · customers ·
  valid until …" on mint (not secret), an invalid one the reason in red, a partial one its length. Chrome at 1280
  and 390 px: empty, focused, invalid, valid captured with a 1-day "Test" DEMO code (0600 file, deleted); 74 tests,
  typecheck, lint PASS. iPhone and desktop reinstalled.
- Code slots (user request): each of the 16 slots is outlined alike (8 px radius, 1.5 px `C.line` outline on
  `C.card`), 5 px apart, the next one to fill only turns blue (same width, nothing moves); separators sit between
  four equal groups and slots keep a 3:4 shape (max 36 px wide), so all slots are the same size at any width
  (≈26×34 px in the desktop dialog, ≈14×19 px at 390 px). Chrome captures at both widths; tests, typecheck, lint
  PASS; iPhone and desktop reinstalled.
- Code slots doubled (user: the code is much longer than the slots): 32 slots in 2 rows of 4 groups of 4 (same slot
  size), about 10 characters per slot; a code that parses fills all 32 whatever its length (297 for a "Test"/DEMO
  code), a partial or invalid one fills at most 31 with the caret on the next. Chrome at 1280 and 390 px; tests,
  typecheck, lint PASS; iPhone and desktop reinstalled.
- Code field adapted to the code's length (user, after the 305-character breakdown): the slots are gone. Empty: a
  paste area (dashed `C.tone` outline on `C.card`, "Paste your technician code", "Click here, then ⌘V" on desktop or
  "Press and hold here, then Paste" on iOS; blue solid outline when focused; a transparent field over it takes the
  paste). Pasted: a card with what the code is for, never the code: mint "✓ name", customers and expiry, "N
  characters, hidden", or the reason on the warning colours; "Clear" brings the area back. Chrome at 1280 and 390
  px: empty, focused, invalid, cleared, valid (1-day "Test" DEMO code, 0600 file deleted); tests, typecheck, lint
  PASS; iPhone and desktop reinstalled.
- FLWR-O-019 back in the desktop app, then "not genuine" (2026-10-23 01:39). The sensor was fine (alias still
  IOT-7B09F20339; back online after a failed join). macOS caches the name read over GATT (BlueZ serves the system
  `Name`, FLWR-O-019, there, not the alias), and the bridge passed that cache as the advertised name. Decision: a
  sensor's ID comes only from its advertised name, never a system or cached name.
  - Bridge: `ble-discover` carries `name` (system, display only) and `advertised` (scan response) apart;
    `ble.web.ts` maps only `advertised` to `advertising.localName`, as react-native-ble-manager does on iOS.
  - `setup.ts`: no advertised ID → `unidentified` before connecting (nothing sent); the batch retries it
    (`RETRIED`); the card says to try again in a moment. App passes `advertising.localName`, not `nameOf`.
  - Tests: setup.test.ts (unidentified: nothing written, retried), ble-bridge.test.ts (cached name never becomes
    localName), Rust heard(). 75 tests, typecheck, lint, clippy PASS; iPhone and desktop reinstalled.
- The same attempt failed `NotInRange`: the sensor's working profile is SSID `Livebox-5FFC`; the desktop "Noé
  Home" site must use that exact network name.
- Simplest fix for the test (user's call, instead of a 5-byte ID in the advertisement): the Floware sensor's
  Bluetooth system name is its ID. `/etc/bluetooth/main.conf` `Name = IOT-7B09F20339` (original kept as
  `main.conf.before-iot-name`) and the bluetoothd drop-in now `--noplugin=battery,hostname` (BlueZ's hostname
  plugin forced FLWR-O-019); `bluetoothctl show`: Name and Alias IOT-7B09F20339. Hostname unchanged. App: setup
  takes the advertised name, else the system name (both device-declared; the certificate decides); `unidentified`
  only with neither. Mac after the bluetooth restart: 10/11 sightings with the advertised name; the Mac's cached
  name updates at its next connection. Not yet in install.sh (temporary on this sensor). 75 tests, typecheck, lint
  PASS; iPhone and desktop reinstalled.

## Review, simplification, second review, push (2026-10-23)

- First review in parallel (code reviewer, security auditor): no Critical/High. Fixed:
  - Security: CSP for packaged builds (`tauri.conf.json`: self, `wasm-unsafe-eval` for the QR decoder, inline styles
    with `dangerousDisableAssetCspModification: ["style-src"]` since Tauri's nonces disabled them, `mediastream:`/`blob:`
    for the camera, Tauri IPC; `devCsp` null for Metro); the bridge (`ble.rs`) only scans for, lists and reads/writes
    the IoT service (another service: "Only IoT sensors can be scanned for"), clamps the scan length to 60 s,
    fills `heard_at`/`known` only after the filter and prunes `heard_at`, reports a failed event stream.
    `docs/SECURITY.md` describes the name compared (advertised, else the system's) and `unidentified`.
  - Robustness: haptics `.catch`; the resize fold only on the web phone layout with sensors, and the radar follows
    the list's real offset; Save hidden while a pasted code is unusable (its card says why); a tap restarts the
    focus pass; `postinstall` in Node (Windows); `desktop:install` copies before replacing; `setBodyW` web only.
  - Kept by decision: setup compares the certificate with `advertising.localName ?? sensor.name`.
- Simplification: `@tauri-apps/api` removed (unused); `Radar.web.tsx` imports `DOTS`/`HOLD`/`HOLD_SCALE`/`RELEASE`;
  `DESKTOP_MIN_WIDTH` in `src/theme.ts` (App, Sheet); `src/pasteKey.ts` (⌘V on a Mac, Ctrl+V elsewhere); fragments and
  sheet contents re-indented; `pasteInput`; stale comments fixed; `cargo fmt`.
- Checked: CSP in the packaged app through a temporary hook (removed): renders, `ble_state` on, QR decoded, another
  service refused, no style violation after the fix. 75 tests, typecheck, lint, clippy, `cargo fmt --check`, device
  clippy in the Ubuntu 22.04 container; playtest PASS (updated for the code card); layout matrix 0 findings; resize
  sequences 0 gaps; horizontal resize compact; 147-step drag clean.
- Second review: APPROVE, ready. Two of its optional suggestions applied (event subscription failures logged; the fold
  waits for the list). Left for later: `capabilities/default.json` could narrow `core:default` to
  `core:event:default` (to test in the app with Bluetooth allowed); `Sheet` could take the measured layout from App.
- Deployed (2026-10-23 02:14, pushed tip): FLWR-O-019 runs the committed device build (Ubuntu 22.04 container from
  `git archive HEAD`), advertising IOT-7B09F20339, Name and Alias IOT-7B09F20339; iPhone Release build installed
  (launch refused while the phone was locked); `/Applications/Provide.app` reinstalled. `desktop:install` now also
  unregisters the build copy from LaunchServices (`0760e77`), which had come back as a second Provide.

## Primary advertisement identity — approved and deployed, 2026-10-23

- User explicitly confirmed the shared protocol correction and deployment. It supersedes the earlier decision
  to rely on a renamed Bluetooth adapter. Scope: `tasks/sensor-identity-proposal.md`; SPEC records the exception
  to the unchanged-iPhone/provisioning-logic boundaries.
- Primary manufacturer data is `[state][5 SHA-256(public key) bytes]` under test company `0xFFFF`. Total legacy
  advertisement: 31/31 bytes. Default Rust tests cover the payload/budget; BLE tests pin advertisement options.
- Shared `sensorId` and `sensorLabel` identify display, saved-site lookup and setup. Setup accepts advertising
  data and derives the claim itself. No OS-name or scan-response-name fallback; missing/malformed identity
  prevents connection. State-only firmware returns non-retried `old-firmware` with update guidance.
- Certificate signature, Noise-proven key, full 40-bit certified ID and customer still gate message 3. No new
  dependency. Demo and Python bench use the same bytes. Runtime alias mutation removed; existing sensor name
  configuration was left alone because correctness no longer depends on it.
- COMMAND_FIXTURE PASS: RED before implementation; 86 JS tests, 85 Ubuntu ARM64 Rust tests (ble,stage), 4 desktop
  Rust tests, typecheck, lint, fmt, Clippy, Python simulator selftest. Independent review found no blocker;
  its bridge-fixture coverage note was addressed with the new payload and shared-parser assertion.
- The deployed apps retain the pre-existing, tested Claude working-tree changes; the identity commit isolates
  this correction and does not commit those unrelated edits.
- Deployed firmware to FLWR-O-019; installed `/Applications/Provide.app` and the signed Release on the physical
  iPhone 15 Pro (launch succeeded). iOS Simulator Release demo built, launched and visually checked.
- ACTUAL_HOST / ACTUAL_BLE PASS: btmon records 31 bytes, manufacturer `027b09f20339`; Mac receives the correct ID
  in 4/4 reports despite absent advertised name and cached FLWR-O-019. Before: 6 reports with state only, no name.
- ACTUAL_BLE / ACTUAL_WIFI: observed Mac UI hello at 12:59:48, Wi-Fi setup at 13:00:52, IP 192.168.1.15; device
  journal independently confirms hello, accepted technician and connected attempt. Deployment did not initiate
  these UI operations or change the requested Wi-Fi. Evidence and hashes: `demo/identity-advertisement.txt`.
- Rollback artifacts: `/private/tmp/Provide.before-identity.app` on Mac;
  `/usr/local/bin/iot-device.before-identity-20261023` on FLWR-O-019. Firmware is hash-checked before install;
  deployment restores the binary if restart/active checks fail. These backups have not been restored in a drill.
- NOT_RUN: real iPhone provisioning after update, Windows/Linux desktop radios, new bench batch, state-transition
  radio capture. Noe-lab left unchanged; updated apps need the new firmware for provisioning there too.
- Limits: zero advertising headroom, static ID visible to passive listeners, company `0xFFFF` remains test-only.

## Refresh feedback and scan restart — 2026-10-23

- User reported a frozen list and no visible response to Refresh. RED browser regression confirmed that clicking
  during an active search did not start a new scan: the handler only pruned stale rows and set an already-false
  paused flag. Errors from scan startup were swallowed; the arrow's short rotation was the only visual feedback.
- Refresh now restarts discovery and displays `Refreshing…` until that round ends, then `List updated`. Startup
  rejection displays `Search failed · retry`; retry remains reachable with zero sensors on desktop and phone.
  The button exposes busy/disabled state, has a 44-point target, uses contrasting muted text, and keeps textual
  feedback with Reduce Motion. Existing rows and active/batch results are preserved.
- Scan startup and cancellation share a promise chain. The old listener is removed before stopping, and the new
  one is attached only after queued cancellation finishes. An in-flight start cannot outlive its cancellation.
  Demo scan deadlines are cleared on restart, stop and mode exit, preventing old deadlines ending a new scan.
- Review caught the old demo deadline, slow-start cancellation and empty-list retry cases. Each received a RED
  regression and a fix; final independent review approved with no remaining blocker.
- COMMAND_FIXTURE PASS: 87 JS tests, typecheck and lint. `desktop/refresh-check.mjs` runs the real UI with an isolated
  fake Tauri radio in WebKit at 1280 px and Chromium at 390 px/Reduce Motion: restart, delayed old stop, pending
  start, live card update, paused search, completion, rejection and empty-list recovery. No page errors.
- Deployed the signed iPhone Release (installation and launch succeeded) and `/Applications/Provide.app`; iOS
  Simulator Release built and demo launched. ACTUAL_BLE/UI: clicked Refresh in the installed Mac app against
  IOT-7B09F20339; the cycle completed and the screenshot showed `List updated`. No Wi-Fi setup initiated.
- Rollback: `/private/tmp/Provide.before-refresh.app`. No firmware or noe-lab changes. Existing Claude working-tree
  changes retained outside this commit. NOT_RUN: physical iPhone Refresh interaction, Windows/Linux desktop.
- Existing desktop storage remains memory-only (`secureStore.web.ts`, T5 pending); restarting the desktop app
  loses its in-memory technician code/site. This limitation was surfaced to the user, not changed by this fix.
