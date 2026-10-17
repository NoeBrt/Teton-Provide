# Implementation Plan: Rust Transport and Phone Configurator

## Objective and current scope

Use Rust to align with the fleet language reported by the user, then deliver a
repeatable, clearly labeled simulation
of device discovery, connection, `hello` exchange, and recoverable failures.
No Jetson is available. The simulation is a development aid; real BLE and
real Wi-Fi remain required for the final challenge submission.

The final operator is non-technical. The user's demo runs from a phone to a
headless Ubuntu computer, optionally replaced by a Jetson later. A guided
graphical interface is mandatory; the CLI is a development/diagnostic tool.
Support the same workflow on an Ubuntu configurator. Confirm the phone OS and
offline client installation before fixing its adapter or UI framework.

The shared contract and software transport now run without third-party crates.
All 23 tests and the labeled demo pass locally; baseline/scale benchmark trials,
a 300-second recovery soak, and skill-based review/TDD verification are complete. Tasks are tracked
in [todo.md](todo.md); architecture choices live in
[ARCHITECTURE.md](../docs/ARCHITECTURE.md) and their history in
[DECISIONS.md](../docs/DECISIONS.md).

## Dependency order

```text
Shared hello contract
        |
        v
Simulated discovery + local exchange
        |
        v
Failure injection + reconnect + simulated restart
        |
        v
SOFTWARE CHECKPOINT: labeled, repeatable demo

Phone client feasibility + Linux host/radio access (Ubuntu PC is sufficient)
        |
        v
Hardware audit -> bluer peripheral -> selected phone client
        |
        v
RADIO CHECKPOINT: actual hello + reconnect + service restart/reboot
        |
        v
Secure-channel decision -> real Wi-Fi -> required graphical UX -> submission evidence
```

## Implementation slices

1. **Contract:** shared Rust library byte handler and input-rejection tests.
   One Cargo package; no BLE dependency.
2. **Demo:** separate configurator/device flows connected through bounded
   standard-library channels and synthetic discovery. A worker handles requests;
   a Cargo example produces a labeled round trip. No Tokio dependency is needed.
3. **Recovery and measurements:** injected timeout/disconnect, retries, and simulated
   device replacement. Check behavior with assertions, then benchmark the same
   transport and run a bounded soak. Capture actual durations/results without
   treating software timings as radio or fleet throughput.
4. **Phone feasibility and real endpoint:** confirm phone OS, client preparation,
   offline startup and permissions. Inspect the Ubuntu device, pin compatible
   dependencies, and expose the same handler through BlueZ using `bluer`.
   Optional Linux diagnostics may also use `bluer`; the phone needs its platform
   adapter. The primary demo requires only the phone and the Ubuntu device.
5. **Host lifecycle:** install the service and verify normal reconnect, restart,
   reboot, and offline operation from the selected phone. No device screen or
   terminal should be needed after technical setup.

The software checkpoint is complete. Real radio work requires usable host access
and an available phone, but does not require a Jetson. Docker is optional
and does not block any software task. Add a container runner only for a demonstrated
reproducibility need; do not build a privileged Bluetooth lab by default.

### Current independent slice: host preflight

Add a dependency-free Rust `audit-host [hciN]` diagnostic that runs read-only
Ubuntu commands with finite deadlines. Check adapter power and the local GATT /
advertising APIs on the same adapter, plus a Wi-Fi device managed by NetworkManager.
Emit only constructed statuses, never command output, SSIDs, MACs, or secrets.
An affirmative result means prerequisites observed, not a successful radio test.
Tests exercise the executable's exit status and output, substituting commands
only at the operating-system boundary. Capture the actual restricted-host result.
This prepares task 4 without starting credential, security, or UI implementation.

## Verification strategy

Use Cargo's test harness: handler/lifecycle unit tests beside the code and
integration tests in `tests/simulation.rs`. Fault injection controls dropped
replies and disconnects; receive deadlines use real time. Assert results, not
tight latency thresholds. Each session has two capacity-one channels. Reject
oversized input before copying; on closure, drop the reply receiver, drop the
request sender, then join the worker. A timeout invalidates the session and
fresh connections cannot receive stale replies. Device stop prevents discovery
and subsequent requests; an already pending wait retains its deadline.

Run `RUSTUP_TOOLCHAIN=stable cargo test --all-targets --locked --offline`,
`RUSTUP_TOOLCHAIN=stable cargo fmt --all -- --check`, and
`RUSTUP_TOOLCHAIN=stable cargo clippy --all-targets --locked --offline -- -D warnings`.
The local `stable` compiler reports 1.88.0; check its version before using that
override elsewhere. Run the labeled demo with
`RUSTUP_TOOLCHAIN=stable cargo run --example simulation --locked --offline`.

Benchmark/soak use `examples/benchmark.rs` and the actual `src/simulation.rs`.
Run in release mode, retain bounded waits, and record host, commands, sample
counts, elapsed time, and results. Keep successful exchange measurements distinct
from timeout/recovery scenarios. Repeated fault/restart checks demonstrate only
software cleanup. Capture sanitized output under `demo/` with a prominent
`SIMULATION` label; do not fabricate an overnight duration or extrapolate to BLE.

Tests must not silently skip hardware assertions and then report hardware
success. Maintain separate software and hardware evidence. Tasks 4-7 commands
in `todo.md` remain specifications; their binary targets and `ble` feature do not
exist yet. When hardware work starts, keep its dependencies optional so default
software tests never build libdbus or connect to BlueZ.

The manifest, exact Rust 1.88.0 toolchain pin, and dependency-free Cargo.lock now
exist. Standard Ubuntu reproduction must preinstall that compiler with Rustfmt
and Clippy: Cargo's `--offline` does not disable rustup downloads. The current
simulator needs no crate downloads. Future BLE builds need resolved, cached or
vendored dependencies and native libraries before they can build offline.

## Risks and unresolved gates

| Risk | Mitigation |
| --- | --- |
| Fake transport hides GATT/driver failures | Separate radio checkpoint with actual two-machine evidence |
| Device ABI/BlueZ differs from laptop | Inspect before building; validate native ARM64 build and libdbus compatibility |
| Future crate graph exceeds installed compiler or is unavailable offline | Resolve BLE dependencies against Rust 1.88; cache/vendor and commit a tested Cargo.lock |
| Docker/socket restrictions persist | Socket-free simulation; optional container packaging only |
| Simulation becomes a second product | Reuse handler; keep only fault injection and wiring in the fake adapter |
| Security is bolted onto plaintext provisioning | Credential endpoint blocked until authenticated-channel review and tests |
| A desktop-only client misses the phone demo | Confirm phone OS, install/start client offline, prove harmless exchange before full UI |
| A web page on the target is unreachable before Wi-Fi | Prepare the phone client beforehand; never assume a shared LAN or phone access to desktop localhost |
| No Wi-Fi hardware by submission | Explicitly report incomplete challenge; simulated success cannot replace real evidence |

The follow-up verification uses the installed `code-review`, `tdd`, and
`performance-optimization` skills. The review compares the fixed pre-code plan
with the software checkpoint on separate Standards and Spec axes. New tests
use the existing public protocol/session interfaces and the bounded batch API;
record actual red/green output and an isolated mutation check. The scaled
benchmark runs 1/20/50/200/1,000 simulated jobs with 1/4/8 concurrent clients,
three independent processes, and seven measured batches per case. Report
queue-inclusive completion separately from service time; keep concurrency bounded
and retain raw data. See `docs/REVIEW.md` and `docs/BENCHMARKS.md` for results.

The phone OS/client, actual device adapter capability, host permissions, and
authenticated channel remain open. Confirm them before claiming radio reliability
or enabling credentials. The final interface must cover label-based selection,
SSID/password entry, progress, verified network success, and actionable retry
without commands or on-device screen interaction; see decision 15 and the
technician-interface section of `docs/ARCHITECTURE.md`.
