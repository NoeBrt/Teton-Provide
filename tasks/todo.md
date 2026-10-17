# Task Checklist

Status: software checkpoint S and follow-up review/TDD/scale verification complete.
The 38 tests pass in debug and release, including 15 host-preflight CLI tests;
demo, three benchmark trials, and a 300-second recovery soak have captured
evidence in `demo/` and `docs/BENCHMARKS.md`. Tasks 4-7 remain hardware-gated;
their commands are planned acceptance commands, not currently available targets.
The real demo uses a phone configurator and a headless Ubuntu computer; no
Jetson is required. Graphical technician UX is required for final acceptance.

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
`demo/`, `README.md`.
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

Command: `cargo run --bin audit-host --locked --offline`; optional `hciN` argument.
Evidence: `demo/host-preflight.txt` (blocked), `demo/host-audit-verification.txt`,
and `demo/tdd-host-audit.txt`. No radio or provisioning acceptance is implied.

**Description:** Inspect the Ubuntu device and any Linux diagnostic configurator
using the README commands; confirm adapter capabilities and Rust/libdbus/BlueZ
compatibility. Audit the actual phone's OS and client preparation separately.

**Acceptance criteria:**

- [ ] Identify device, OS, BlueZ, radios, NetworkManager ownership, and usable D-Bus APIs.
- [ ] Resolve/build `bluer` with `bluetoothd` behind the optional `ble` feature;
  lock tested crates and document native build prerequisites and ARM64 differences.
- [ ] Required host access is available; otherwise record the exact unpassed gate.
- [ ] Confirm phone OS, Bluetooth permissions, and a client that starts offline;
  choose native or browser access based on verified platform/build constraints.

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

- [ ] `TETON-DEMO-001` advertises a fixed service UUID discoverable by another machine.
- [ ] The endpoint accepts only `hello`; malformed writes fail without raw payload logging.
- [ ] Startup failure and normal shutdown cleanly report/release registrations.

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

## 6a. Phone hello round trip

**Description:** Use the selected phone client to discover the headless Ubuntu
device, connect, send only `hello`, and read `world`. This is a transport probe,
not the final provisioning UI.

**Acceptance criteria:**

- [ ] Prepared client starts with Internet disabled and no shared LAN.
- [ ] Actual phone discovers/connects/exchanges hello with the Ubuntu device.
- [ ] Disconnect/reconnect succeeds; no device screen, SSH, credentials, or
  technical operator commands are required to complete the exchange.

**Verification:** Record phone OS/client versions, offline startup, repeated
successful GATT exchanges, and retry after disconnect. A generic BLE diagnostic
app may help feasibility testing but does not replace submitted configurator code.
**Dependencies:** 4, 5.
**Files:** Phone adapter under `configurator/` once selected, `README.md`,
`demo/phone-hello.txt`, `docs/DECISIONS.md`; do not create empty directories now.
**Scope:** Medium; choose exact platform files after task 4.

## 7. Host service lifecycle and radio evidence

**Description:** Install the real device service with appropriate host permissions;
validate restart/reboot and collect honest hardware evidence.

**Acceptance criteria:**

- [ ] Service restart and device reboot restore discovery and successful hello exchange.
- [ ] Repeated reconnects pass, with Internet disabled and no shared LAN.
- [ ] Journal and demo evidence contain no secrets or arbitrary payloads.

**Verification:** `systemctl status teton-provisioning --no-pager`;
`journalctl -u teton-provisioning`; repeat the documented real round trip.
**Dependencies:** 5, 6a; reboot access must be available without losing the only recovery path.
**Files:** `device/systemd/teton-provisioning.service`, `README.md`,
`demo/ble-hello.txt`, `docs/DECISIONS.md`.
**Scope:** Medium, four files. Verify service permissions rather than assuming root is necessary.

## Checkpoint H: real transport milestone

- [ ] Tasks 4, 5, 6a, and 7 pass on phone + device; simulation evidence remains distinct.
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

Reports: `docs/REVIEW.md`, `docs/BENCHMARKS.md`; evidence: `demo/tdd-scaled.txt`,
`demo/verification-tests.txt`, `demo/benchmark-scaled.txt`, `demo/benchmark-scaled.csv`.
Hardware tasks 4-7 remain open.

## Later scope, not implementation tasks yet

After checkpoint H, write a focused plan for authenticated credential transfer,
real NetworkManager activation/IP verification, and failure-safe retries.
Then deliver technician UX, scaling/security documentation, and final evidence.
Preserve the original challenge's real-network requirement throughout.
The final phone and Ubuntu graphical flow must guide device identification,
SSID/password entry, progress, verified success, and actionable failures/retry.
Test it without operator commands or a screen on the device. This is a required
acceptance criterion; implement it after transport/security/network gates, rather
than treating the CLI or a generic Bluetooth diagnostic app as the final interface.
