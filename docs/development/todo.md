# Task Checklist

Status: software checkpoint S and follow-up review/TDD/scale verification complete.
The 40 Rust tests pass in debug and release, including 17 host-preflight CLI tests.
Four additional public release-executable CLI cases pass with Python 3.
The demo, three benchmark trials, and a 300-second recovery soak have captured
evidence in `evidence/` and `docs/BENCHMARKS.md`. Tasks 4-7 remain hardware-gated;
their commands are planned acceptance commands, not currently available targets.
The real demo requires Android and iPhone configurators and a headless Ubuntu
computer; no Jetson is required. Graphical technician UX on both mobile platforms
is required for final acceptance; keep the Ubuntu configurator alternative.

The installed `stable` compiler is Rust 1.88.0. The override below avoids rustup
trying to download the separately named toolchain in this offline environment.
Elsewhere, preinstall the pinned toolchain and Rustfmt/Clippy, or verify the
override compiler version before using it.

## 1. Shared hello contract

**Description:** Define the one byte-level handler reused by simulated and real devices.

**Acceptance criteria:**

- [x] `hello` produces `world`; all other input is rejected without echo/logging.
- [x] Tests cover empty, malformed, oversized, and credential-like input.
- [x] One Cargo package and Rust 1.88.0 pin; no third-party dependency needed.

**Verification:** `RUSTUP_TOOLCHAIN=stable cargo test --lib protocol --locked --offline`;
`RUSTUP_TOOLCHAIN=stable cargo fmt --all -- --check`.
**Dependencies:** None.
**Files:** `src/lib.rs`, `src/protocol.rs`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`.
**Scope:** Medium, five files. Unit tests live beside the handler; Cargo generates the lockfile.

## 2. Local simulated round trip

**Description:** Run distinct device/configurator flows through two capacity-one
standard-library channels and a worker thread, with synthetic discovery and the shared handler.

**Acceptance criteria:**

- [x] The simulation example shows discovery, connection, request, response, and close.
- [x] Output says `SIMULATION`; no sockets, root, Docker, BLE, or Internet required.
- [x] Focused tests check the returned response and finite wait deadlines.

**Verification:** `RUSTUP_TOOLCHAIN=stable cargo run --example simulation --locked --offline`;
`RUSTUP_TOOLCHAIN=stable cargo test --test simulation --locked --offline`.
**Dependencies:** 1.
**Files:** `src/lib.rs`, `src/simulation.rs`, `tests/simulation.rs`,
`examples/simulation.rs`, `README.md`.
**Scope:** Medium, five files. Shared simulation wiring supports the demo, tests, and measurements.

## 3. Simulated failures and recovery

**Description:** Exercise dropped/late responses and closed sessions, retry through
fresh connections, and simulate replacing the device instance. Measure this software
transport and run a bounded soak using the same implementation.

**Acceptance criteria:**

- [x] Timeout and disconnect give bounded, explicit failures; no hanging tasks.
- [x] Retry/new connection succeeds and receives no stale response from the old session.
- [x] Simulated restart clears transient state and allows synthetic rediscovery.
- [x] Release benchmark and bounded soak verify responses, exercise recovery, and record actual results.
- [x] Sanitized evidence states commands, host, sample counts, elapsed time, and simulation limitations.

**Verification:** `RUSTUP_TOOLCHAIN=stable cargo test --lib --test simulation --locked --offline`.
Unit tests cover late replies and worker joining; integration tests include 20
sessions of 20 exchanges. Use finite real-time receive deadlines without tight
timing assertions. Run `examples/benchmark.rs` with `--release --locked --offline`
after its harness is verified; capture benchmark and bounded-soak output separately.
Stop prevents discovery/new requests; an already pending wait keeps its deadline.
**Dependencies:** 2.
**Files:** `src/simulation.rs`, `tests/simulation.rs`, `examples/benchmark.rs`,
`evidence/`, `README.md`.
**Scope:** Medium. Evidence records actual output; no BLE or 200-device throughput claim.

## Checkpoint S: software demonstration

- [x] Tasks 1-3 pass with `RUSTUP_TOOLCHAIN=stable cargo test --all-targets --locked --offline` and `git diff --check`.
- [x] `RUSTUP_TOOLCHAIN=stable cargo fmt --all -- --check` and `RUSTUP_TOOLCHAIN=stable cargo clippy --all-targets --locked --offline -- -D warnings` pass.
- [x] Evidence labels discovery, disconnect, and restart as simulated.
- [x] No claim of working BLE, secure provisioning, or Wi-Fi connection.

## 4. Audit available hardware and lock BLE dependencies

Preparation slice (does not close the hardware gate):

- [x] Executable Rust audit reports selected-adapter power, GATT/advertising APIs,
  and NetworkManager-managed Wi-Fi without changing configuration.
- [x] Public CLI tests cover clean success, blocked/missing services, malformed
  output, timeout/output limits, invalid adapter input, and secret-safe errors.
- [x] Capture actual host result separately from command-fixture tests.
- [x] An exited command parent with stdout-holding descendants still times out;
  inherited shell startup/functions cannot replace audited commands.

Command: `cargo run --bin audit-host --locked --offline`; optional `hciN` argument.
Evidence: `evidence/real/host-preflight.txt` (blocked), `evidence/checks/host-audit-verification.txt`,
and `evidence/checks/tdd-host-audit.txt`. No radio or provisioning acceptance is implied.

**Description:** Inspect the Ubuntu device and any Linux diagnostic configurator
using the README commands; confirm adapter capabilities and Rust/libdbus/BlueZ
compatibility. Audit actual Android and iPhone models/OS versions and client
preparation separately; platform selection itself is settled.

**Acceptance criteria:**

- [x] Identify device, OS, BlueZ, radios, NetworkManager ownership, and usable D-Bus APIs.
  (`evidence/real/host-inventory.txt`.)
- [x] Resolve/build `bluer` with `bluetoothd` behind the optional `ble` feature;
  lock/cache the complete tested graph and document native prerequisites and ARM64
  differences. Verify both default and BLE-enabled locked offline builds; a disabled
  optional dependency still requires resolution. (x86-64 only; ARM64 not built.)
- [x] Required host access is available; otherwise record the exact unpassed gate.
  (Access available; gate: rfkill soft block, see `evidence/real/host-ble-endpoint.txt`.)
- [x] Before mobile framework selection, review an offline authenticated bootstrap
  for both Android and iPhone: trusted physical device identity, technician
  authorization, channel/library support, replay protection, and status recovery.
  This is feasibility/design review; no security implementation before checkpoint H.
  (Done: `docs/SECURITY.md` recommends Noise NKpsk2 with key and secret in the QR label.)
- [ ] Record model/OS versions, Bluetooth permission denial/retry, build/signing,
  distribution, and prepared client installation/startup offline for each platform.
  (iPhone: model/OS and Xcode free-account signing recorded in `evidence/real/phone-hello.txt`; permission denial,
  offline startup, and Android remain.)
  Select native/shared/browser access only against those verified constraints;
  Android browser support alone cannot satisfy the iPhone requirement.

**Verification:** README hardware audit; `cargo check --features ble --locked`
on the Ubuntu device after dependency resolution. Test a Jetson or additional
Linux configurator only if selected; record versions/results separately.
**Dependencies:** Hardware availability and host access; follows checkpoint S.
**Files:** `docs/DECISIONS.md`, `docs/ARCHITECTURE.md`, `README.md`, `Cargo.toml`, `Cargo.lock`.
**Scope:** Medium, five files. No shared LAN is required for the later BLE exchange.

## 5. Real device BLE hello endpoint

**Description:** Register a BlueZ service and advertisement, invoking the shared
handler through a read/write GATT characteristic.

**Acceptance criteria:**

- [x] `IOT-DEMO-001` advertises a fixed service UUID discoverable by another machine.
  (Discovered by service UUID from an iPhone 15 Pro running `configurator/`: `evidence/real/phone-hello.txt`.)
- [x] The endpoint accepts only `hello`; malformed writes fail without raw payload logging.
  (Unit-tested in `device/main.rs`; not yet exercised over the air.)
- [x] Startup failure and normal shutdown cleanly report/release registrations.
  (rfkill failure reported; SIGINT releases the advertisement and service UUID: `evidence/real/host-ble-endpoint.txt`.)

**Verification:** `cargo test --features ble --bin device --locked`; live
advertisement discovery from the configurator, with sanitized evidence recorded.
**Dependencies:** 1, 4.
**Files:** `device/main.rs`, `device/ble.rs`, `src/protocol.rs`, `Cargo.toml`.
**Scope:** Medium, four files. No pairing/security or Wi-Fi implementation yet.

## 6. Optional Linux diagnostic BLE round trip

**Description:** Discover by service UUID using `bluer`, select the demo endpoint,
connect, write `hello` with acknowledgement, and read `world`.
Use this task when a separate Linux configurator is available; it does not block
the phone demo or require a third machine.

**Acceptance criteria:**

- [ ] Real two-machine GATT exchange succeeds without Internet or a shared LAN.
- [ ] No device, ambiguous selection, disconnect, and timeout produce clear errors.
- [ ] Disconnect/reconnect works without resetting Bluetooth manually.

**Verification:** `cargo test --features ble --bin configurator --locked`;
`cargo run --features ble --bin configurator --locked` on real hardware.
Capture repeated exchanges/failures without nearby-device inventories.
**Dependencies:** 5.
**Files:** `configurator/main.rs`, `configurator/ble.rs`, `Cargo.toml`, `README.md`.
**Scope:** Medium, four files.

## 6a. Android and iPhone hello round trips

**Description:** Use a prepared client on each of Android and iPhone to discover
the headless Ubuntu device, connect, send only `hello`, and read `world`. This is
a transport probe, not the final provisioning UI.

**Acceptance criteria:**

- [ ] Android client starts offline, discovers/connects/exchanges hello, and reconnects.
  (Not physically tested by the user's decision on 2026-10-18; same code as iPhone.)
- [ ] iPhone client starts offline, discovers/connects/exchanges hello, and reconnects.
  (2026-10-19: discovery, 6 hello/world exchanges and reconnect after a device service restart PASS on an
  iPhone 15 Pro, iOS 27.0, Release build signed with a free Apple ID: `evidence/real/phone-hello.txt`. Still open:
  offline startup with Internet disabled and no shared LAN.)
- [ ] Both runs use Internet disabled and no shared LAN; no device screen, SSH,
  credentials, or technical operator commands are required to complete the exchange.

**Verification:** Record model/OS/client/build versions and installation method,
offline startup, repeated successful GATT exchanges, and retry after disconnect
separately for Android and iPhone. A generic BLE diagnostic
app may help feasibility testing but does not replace submitted configurator code.
**Dependencies:** 4, 5.
**Files:** Phone adapter under `configurator/` once selected, `README.md`,
`evidence/real/phone-hello.txt`, `docs/DECISIONS.md`; do not create empty directories now.
**Scope:** Medium; choose exact platform files after task 4.

## 7. Host service lifecycle and radio evidence

**Description:** Install the real device service with appropriate host permissions;
validate restart/reboot and collect honest hardware evidence.

**Acceptance criteria:**

- [ ] Service restart and device reboot restore discovery and successful hello exchange from both Android and iPhone.
- [ ] Repeated reconnects pass from each platform, with Internet disabled and no shared LAN.
- [ ] Journal and demo evidence contain no secrets or arbitrary payloads.

**Verification:** `systemctl status iot-provisioning --no-pager`;
`journalctl -u iot-provisioning`; repeat the documented real round trip.
**Dependencies:** 5, 6a; reboot access must be available without losing the only recovery path.
**Files:** `device/systemd/iot-provisioning.service`, `README.md`,
`evidence/ble-hello.txt`, `docs/DECISIONS.md`.
**Scope:** Medium, four files. Verify service permissions rather than assuming root is necessary.

## Checkpoint H: real transport milestone

- [ ] Tasks 4, 5, 6a, and 7 pass separately on Android + device and iPhone + device; simulation evidence remains distinct.
- [ ] Record optional task 6 separately if a Linux configurator is tested; do not claim desktop support from phone-only evidence.
- [ ] Dependency/setup instructions reproduce the radio flow on supported Ubuntu.
- [ ] Rustfmt, tests, release build, and Clippy pass with `--features ble --locked` where applicable.
- [ ] Stop here before adding credentials, security implementation, or technician UI.

## Follow-up: skill-based software verification

- [x] Independent Standards and Spec review of `b4aaae8...4e1b9fa`, with separate reports.
- [x] Public-interface TDD red/green trace; isolated response mutation exposes and closes a test gap.
- [x] Queue uniqueness, resource limits, 200-job coverage, and stop/request-race regressions.
- [x] Three release scale trials: 1/20/50/200/1,000 jobs, 1/4/8 clients, seven timed batches per case.
- [x] Check 80,073 timed jobs, retain raw data and queue/service latency definitions.
- [x] All 23 tests pass in debug/release; formatting, Clippy, and release build pass.

Reports: `docs/development/REVIEW.md`, `docs/BENCHMARKS.md`; evidence: `evidence/checks/tdd-scaled.txt`,
`evidence/checks/verification-tests.txt`, `evidence/simulation/benchmark-scaled.txt`, `evidence/simulation/benchmark-scaled.csv`.
Hardware tasks 4-7 remain open.

## Later scope, not implementation tasks yet

Review authenticated bootstrap feasibility for both platforms in task 4, before
framework selection. After checkpoint H, write a focused plan to validate and
implement authenticated and encrypted credential transfer, real NetworkManager activation/IP
verification, and failure-safe retries.
Then deliver technician UX, scaling/security documentation, and final evidence.
Preserve the original challenge's real-network requirement throughout.
Before credential bytes may leave a client, validate confidentiality, integrity,
and peer authentication of an established encrypted channel. Reject transfer
while these conditions are unmet; record the security tests and their outcomes.
The final Android, iPhone, and Ubuntu graphical flow must guide device identification,
SSID/password entry, progress, verified success, and actionable failures/retry.
Final acceptance on each mobile platform must show fresh authenticated device
status tied to the current attempt, the requested target connection active, and
its assigned IP. An old/fallback connection or cached address cannot count as
success; a fresh observation may report the same IP. Interrupt the result after
submission, reconnect/authenticate, and recover status for that attempt before
success or resubmission; unavailable status stays unknown. Include wrong password,
unavailable target, and old/fallback-network cases in physical failure testing.
Test it without operator commands or a screen on the device. This is a required
acceptance criterion; implement it after transport/security/network gates, rather
than treating the CLI or a generic Bluetooth diagnostic app as the final interface.
