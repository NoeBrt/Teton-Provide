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
