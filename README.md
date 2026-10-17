# IoT Provisioning Challenge

Current phase: a working, tested Rust software simulation of the harmless
transport milestone. **Real BLE and Wi-Fi provisioning are not implemented.**

No Jetson is currently available. The local simulator discovers a synthetic
device, connects through bounded memory channels, exchanges `hello`/`world`,
and closes its worker. It supports fault injection and recoverable failures.

- [Selected stack and architecture](docs/ARCHITECTURE.md)
- [Implementation plan](tasks/plan.md)
- [Task checklist and acceptance criteria](tasks/todo.md)
- [Counter-review and decision history](docs/DECISIONS.md)
- [Benchmark methodology and results](docs/BENCHMARKS.md)
- [Skill-based review and TDD verification](docs/REVIEW.md)

The real milestone still requires actual advertisements, GATT exchanges,
reconnect, service restart, and reboot on two machines. The simulator accepts
only `hello`; it never configures a network or accepts credentials.

## Run and test the simulation

Install the Rust toolchain once, before offline work:

```sh
rustup toolchain install 1.88.0 --profile minimal --component rustfmt --component clippy
```

From this repository, no Cargo dependencies need downloading:

```sh
cargo run --example simulation --locked --offline
cargo test --all-targets --locked --offline
cargo fmt --all -- --check
cargo clippy --all-targets --locked --offline -- -D warnings
cargo build --release --examples --locked --offline
```

The example prints `SIMULATION`, synthetic discovery, a local connection,
`REQUEST hello -> RESPONSE world`, and confirmation that its worker was joined.
The prepared binary `target/release/examples/simulation` runs without Cargo,
Rustup, root access, Bluetooth, or Internet.

This session only has a toolchain named `stable`, reporting Rust 1.88.0; its
Rustup directory is read-only. We run the same checks here with
`RUSTUP_TOOLCHAIN=stable cargo ...`. This override selects the installed compiler
and matches the committed pin. On another machine, prepare the named toolchain
above. Cargo's `--offline` does not prevent Rustup from installing a missing toolchain.

## Observed environment

The development session exposes Ubuntu 22.04.5 LTS, Rust/Cargo 1.88.0,
BlueZ 5.64, and nmcli 1.36.6. Bluetooth `hci0` and Wi-Fi `wlo1` are visible
through sysfs. Rustfmt and Clippy are installed. Access to host D-Bus and
network sockets is restricted.
Jetson model, software versions, radio capabilities, and connectivity remain
unverified. Docker CLI 27.0.3 is present, but its daemon is inaccessible in this
session. `pkg-config` detects libdbus 1.12.20. Only the x86-64 Rust target is
installed. The simulation builds with no third-party crates; hardware dependencies
have not been resolved or built.

## Development approach

Use Rust with Cargo's built-in tests, following the user's report that the
fleet uses Rust. The simulator uses `std::sync::mpsc` and one worker thread per
connection because Tokio is not cached and crate downloads are unavailable here.
The planned hardware adapters use Tokio and
`bluer` for both BlueZ GATT roles, and later `dbus`/`dbus-tokio` for
NetworkManager. systemd will manage the real device binary. `Cargo.lock` and
the Rust 1.88.0 pin are committed. See decision 12 for the simulation runtime change.

One Cargo package contains `src/protocol.rs` (shared byte handler),
`src/simulation.rs` (fake discovery and connection lifecycle),
`examples/simulation.rs` (demo), and tests in `tests/simulation.rs` and beside
library code. `src/simulation/batch.rs` adds bounded batches, tested through its
public API in `tests/scaled.rs`. Future `device/` and `configurator/` binaries and `bluer` will be
gated behind a `ble` feature; that feature is not present yet.

Both channel queues hold at most one message; requests are capped at 20 bytes
before allocation. A session accepts one request at a time. Invalid input is
rejected without echoing it; the session remains usable. Timeout or disconnect
closes the session and joins its worker before returning; retry uses fresh channels.

Stopping/dropping a fake device invalidates discovery, new connections, and
subsequent requests on old sessions. In-flight requests retain their existing
deadline. A replacement fake device is rediscovered. This is a model of restart,
not evidence of a systemd restart or machine reboot. Docker remains optional.

## Benchmarks and endurance

```sh
cargo run --release --example benchmark --locked --offline
cargo run --release --example benchmark --locked --offline -- --scale
cargo run --release --example benchmark --locked --offline -- --soak 300
```

The default command checks and times exchanges on a reused session separately
from connect/exchange/close operations. `--scale` measures batches of 1, 20, 50,
200, and 1,000 independent fake device jobs at 1, 4, and 8 concurrent clients.
It checks every reply, exact job coverage, and the observed concurrency bound.
Batch time includes queueing, client-pool setup, and worker cleanup; per-job
service and completion percentiles distinguish processing from queue wait.

`--soak` mixes valid requests,
invalid input, timeout, disconnect, retry, and simulated restart for the requested
duration (1-3600 seconds). Failures outside the expected injected outcomes cause
a nonzero exit. Prepared binaries can run these checks without Cargo or Rustup.

These are local thread/channel measurements. Commands, environment, raw output,
and bounded-run evidence are retained in `demo/`; see the benchmark report for
the measured scope and limitations. No wireless, credential protection, network
activation, systemd, or 200-device throughput is measured.

The current 23 tests pass in debug/release. Two independent review axes and a
focused review of the scaling additions found no blocking defect. TDD verification
also caught a response-test weakness using an isolated mutation; the hardened
test now checks the literal wire contract. See the review report and raw traces.

## Hardware audit

When hardware is available, run these read-only commands from a host terminal
on **each machine**, labeling which output belongs to the configurator and
which belongs to the device:

```sh
uname -a
cat /etc/os-release
cat /etc/nv_tegra_release 2>/dev/null || true
cat /proc/device-tree/model 2>/dev/null || true
bluetoothd --version
bluetoothctl list
bluetoothctl show
rfkill list
systemctl status bluetooth --no-pager
nmcli general status
nmcli device status
ip link
busctl --system tree org.bluez
busctl --system tree org.freedesktop.NetworkManager
```

Using the adapter path returned above (often `/org/bluez/hci0`), inspect:

```sh
busctl --system introspect org.bluez /org/bluez/hci0 org.bluez.LEAdvertisingManager1
busctl --system introspect org.bluez /org/bluez/hci0 org.bluez.GattManager1
```

These checks identify APIs; they do not prove working advertising or GATT.
Next verify an actual device advertisement and a configurator BLE scan,
then implement the harmless round trip against the observed stack. Record
adapter paths, setup steps, failures, and repeated successes. Avoid capturing
nearby patients' or staff members' device identifiers in submission evidence.

## Milestone acceptance

- Device advertises a recognizable demo identity and service UUID.
- Configurator discovers, connects, sends `hello`, and receives a response.
- Disconnect/reconnect works without a manual Bluetooth reset.
- Device service restart and reboot restore the endpoint.
- Operation works with Internet disconnected and no shared LAN.
- Journal evidence shows outcomes without secrets or arbitrary payload logging.

The tested offline setup must include the toolchain, Cargo dependencies, and
built binaries prepared beforehand; provisioning itself must not download
packages or contact external services. `--locked` pins dependency resolution;
offline builds also require a populated cache or vendored dependencies.

## Next phases

After the real first milestone passes, select authenticated credential protection,
integrate NetworkManager, test real Wi-Fi joining and failure paths, then add
technician UX and the scaling discussion. The full challenge is not complete.
