# Task Checklist

Status: revised to Rust; no application implementation started. Commands below
are planned acceptance commands until their task is implemented. Keep the
existing incomplete tasks; this revision changes their stack, not their scope.

## 1. Shared hello contract

**Description:** Define the one byte-level handler reused by simulated and real devices.

**Acceptance criteria:**

- [ ] `hello` produces `world`; all other input is rejected without echo/logging.
- [ ] Tests cover empty, malformed, oversized, and credential-like input.
- [ ] One Cargo package and Rust 1.88.0 pin; no third-party dependency needed yet.

**Verification:** `cargo test --lib protocol --locked`; `cargo fmt --all -- --check`.
**Dependencies:** None.
**Files:** `src/lib.rs`, `src/protocol.rs`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`.
**Scope:** Medium, five files. Unit tests live beside the handler; Cargo generates the lockfile.

## 2. Local simulated round trip

**Description:** Run distinct device/configurator flows through bounded Tokio channels,
with synthetic discovery and the actual shared handler.

**Acceptance criteria:**

- [ ] `cargo run --example simulation --locked` shows discovery, connection, request, response, and close.
- [ ] Output says `SIMULATION`; no sockets, root, Docker, BLE, or Internet required.
- [ ] A focused test checks the returned response and finite wait deadlines.

**Verification:** `cargo run --example simulation --locked`;
`cargo test --example simulation --locked`.
**Dependencies:** 1.
**Files:** `examples/simulation.rs`, `Cargo.toml`, `Cargo.lock`, `README.md`.
**Scope:** Medium, four files. Add only the necessary Tokio features; tests live in the example.

## 3. Simulated failures and recovery

**Description:** Exercise a dropped response and a closed session, then retry
through a fresh connection; simulate replacing the device instance.

**Acceptance criteria:**

- [ ] Timeout and disconnect give bounded, explicit failures; no hanging tasks.
- [ ] Retry/new connection succeeds and receives no stale response from the old session.
- [ ] Simulated restart clears transient state and allows synthetic rediscovery.

**Verification:** `cargo test --example simulation --locked`; use Tokio's paused
test clock for timeout injection. Repeat the round trip 20 times in a bounded
test without real-time sleeps or flaky timing assertions.
**Dependencies:** 2.
**Files:** `examples/simulation.rs`, `Cargo.toml`, `Cargo.lock`, `demo/simulation.txt`, `README.md`.
**Scope:** Medium, five files. Enable Tokio `test-util` for tests; evidence records actual output.

## Checkpoint S: software demonstration

- [ ] Tasks 1-3 pass with `cargo test --all-targets --locked` and `git diff --check`.
- [ ] `cargo fmt --all -- --check` and `cargo clippy --all-targets --locked -- -D warnings` pass.
- [ ] Evidence labels discovery, disconnect, and restart as simulated.
- [ ] No claim of working BLE, secure provisioning, or Wi-Fi connection.

## 4. Audit available hardware and lock BLE dependencies

**Description:** Inspect the eventual device and configurator using the README
commands; confirm adapter capabilities and Rust/libdbus/BlueZ compatibility.

**Acceptance criteria:**

- [ ] Identify device, OS, BlueZ, radios, NetworkManager ownership, and usable D-Bus APIs.
- [ ] Resolve/build `bluer` with `bluetoothd` behind the optional `ble` feature;
  lock tested crates and document native build prerequisites and ARM64 differences.
- [ ] Required host access is available; otherwise record the exact unpassed gate.

**Verification:** README hardware audit; `cargo check --features ble --locked`
on both supported build environments after dependency resolution. Record versions/results.
**Dependencies:** Hardware availability and host access; follows checkpoint S.
**Files:** `docs/DECISIONS.md`, `README.md`, `Cargo.toml`, `Cargo.lock`.
**Scope:** Medium, four files. No shared LAN is required for the later BLE exchange.

## 5. Real device BLE hello endpoint

**Description:** Register a BlueZ service and advertisement, invoking the shared
handler through a read/write GATT characteristic.

**Acceptance criteria:**

- [ ] `IOT-DEMO-001` advertises a fixed service UUID discoverable by another machine.
- [ ] The endpoint accepts only `hello`; malformed writes fail without raw payload logging.
- [ ] Startup failure and normal shutdown cleanly report/release registrations.

**Verification:** `cargo test --features ble --bin device --locked`; live
advertisement discovery from the configurator, with sanitized evidence recorded.
**Dependencies:** 1, 4.
**Files:** `device/main.rs`, `device/ble.rs`, `src/protocol.rs`, `Cargo.toml`.
**Scope:** Medium, four files. No pairing/security or Wi-Fi implementation yet.

## 6. Real configurator BLE round trip

**Description:** Discover by service UUID using `bluer`, select the demo endpoint,
connect, write `hello` with acknowledgement, and read `world`.

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

## 7. Host service lifecycle and radio evidence

**Description:** Install the real device service with appropriate host permissions;
validate restart/reboot and collect honest hardware evidence.

**Acceptance criteria:**

- [ ] Service restart and device reboot restore discovery and successful hello exchange.
- [ ] Repeated reconnects pass, with Internet disabled and no shared LAN.
- [ ] Journal and demo evidence contain no secrets or arbitrary payloads.

**Verification:** `systemctl status iot-provisioning --no-pager`;
`journalctl -u iot-provisioning`; repeat the documented real round trip.
**Dependencies:** 6; reboot access must be available without losing the only recovery path.
**Files:** `device/systemd/iot-provisioning.service`, `README.md`,
`demo/ble-hello.txt`, `docs/DECISIONS.md`.
**Scope:** Medium, four files. Verify service permissions rather than assuming root is necessary.

## Checkpoint H: real transport milestone

- [ ] Tasks 4-7 pass on actual machines; hardware and simulation evidence remain distinct.
- [ ] Dependency/setup instructions reproduce the radio flow on supported Ubuntu.
- [ ] Rustfmt, tests, release build, and Clippy pass with `--features ble --locked` where applicable.
- [ ] Stop here before adding credentials, security implementation, or technician UI.

## Later scope, not implementation tasks yet

After checkpoint H, write a focused plan for authenticated credential transfer,
real NetworkManager activation/IP verification, and failure-safe retries.
Then deliver technician UX, scaling/security documentation, and final evidence.
Preserve the original challenge's real-network requirement throughout.
