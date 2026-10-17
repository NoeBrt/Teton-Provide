# Implementation Plan: Rust Simulated Transport First

## Objective and current scope

Use Rust to align with the fleet language reported by the user, then deliver a
repeatable, clearly labeled simulation
of device discovery, connection, `hello` exchange, and recoverable failures.
No Jetson is available. The simulation is a development aid; real BLE and
real Wi-Fi remain required for the final challenge submission.

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

Hardware availability + host access
        |
        v
Hardware audit -> bluer peripheral -> bluer configurator
        |
        v
RADIO CHECKPOINT: actual hello + reconnect + service restart/reboot
        |
        v
Secure-channel decision -> real Wi-Fi -> technician UX -> submission evidence
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
4. **Real endpoint:** inspect actual hardware, pin compatible dependencies, expose
   the same handler through BlueZ using `bluer` on both ends.
5. **Host lifecycle:** install the service and verify normal reconnect, restart,
   reboot, and offline operation without resetting Bluetooth manually.

Stop after the software checkpoint until hardware is available. Docker is optional
and does not block any software task. Add a container runner only for a demonstrated
reproducibility need; do not build a privileged Bluetooth lab by default.

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

The future device model, adapter capability, host permissions, and authenticated
channel remain open. These do not block the harmless simulation. Confirm them
before claiming radio reliability or enabling credentials.
