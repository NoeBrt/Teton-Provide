# Software Simulation Measurements

Baseline measured code: `5f3f4cc2a8fe083cf3b87bf41c3c1ed3fbcf85e0`.
Scaled follow-up: `d21d09e` (same compiler/host; details in its raw output).
Environment: Ubuntu 22.04.5, x86-64 AMD Ryzen 7 7840HS, rustc 1.88.0,
Cargo release profile. No third-party crates, radio, sockets, encryption, or
Wi-Fi configuration. CPU affinity/governor were uncontrolled on a shared workstation.

## Reproduction

Prepare the pinned Rust toolchain as described in the README, then run:

```sh
cargo build --release --examples --locked --offline
target/release/examples/simulation
target/release/examples/benchmark
target/release/examples/benchmark --soak 300
```

The measured session used `RUSTUP_TOOLCHAIN=stable` for Cargo commands because
the installed stable toolchain reports the pinned 1.88.0 version. Binaries run
without Rustup or Internet. `Cargo --offline` alone does not prepare a compiler.

## Benchmark method

Run three independent processes sequentially. Within each process and mode,
perform 200 checked warmup operations, then seven measured batches:

- Reused session: 5,000 sequential requests per batch; excludes connection setup.
- New session: 1,000 sequential connect/request/close operations per batch;
  includes worker creation and join, excludes the device object's creation.

Every operation checks the exact `world` response. Latency includes response
validation; throughput also includes clock/recording overhead. Buffer allocation,
sorting, printing, and warmup are outside measurement windows. Pooled latency
percentiles use nearest rank across all observed operations of a mode within
one process; throughput is the median of seven batch rates.

## Observed results

| Trial | Mode | Checked operations | Median latency, µs | p95 latency, µs | Median operations/s |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Reused session | 35,000 | 4.699 | 7.413 | 198,850.6 |
| 2 | Reused session | 35,000 | 4.719 | 6.902 | 203,570.2 |
| 3 | Reused session | 35,000 | 4.719 | 7.003 | 208,650.6 |
| 1 | New session | 7,000 | 28.173 | 51.908 | 30,020.5 |
| 2 | New session | 7,000 | 28.764 | 51.427 | 28,134.0 |
| 3 | New session | 7,000 | 27.692 | 48.652 | 30,257.3 |

All three processes exited successfully. These figures establish a baseline;
no performance optimization or threshold is justified by the current challenge.
The variation is visible in the raw per-batch results in
[benchmark.txt](../demo/benchmark.txt).

## Baseline endurance and validation

An independent review checked session cleanup, stale-reply rejection, benchmark
percentiles, and error accounting. At the baseline checkpoint, 18 tests passed in debug and release modes;
Rustfmt and Clippy with warnings denied pass. Release test evidence is in
[tests-release.txt](../demo/tests-release.txt).

The endurance runner repeats five checked successful responses and seven expected
error outcomes per cycle, including invalid input, connection rejection, dropped
reply, post-failure reuse rejection, and stopped-device requests. Every cycle
explicitly closes/joins seven distinct session workers and creates a replacement
fake device. Success requires every outcome to match; arbitrary errors do not count
as expected failures.

The completed run lasted **300.001 seconds**, with exit status zero:

| Outcome | Count |
| --- | ---: |
| Completed recovery cycles / simulated replacements | 121,928 |
| Checked successful responses | 609,640 |
| Expected injected/rejected error outcomes | 853,496 |
| Unexpected errors | 0 |
| Distinct session workers closed and joined | 853,496 |

The six `/proc` snapshots, taken at 45-second intervals from 45 to 270 seconds,
each reported two threads and 2,344 kB RSS. These snapshots show no growth at
the sampled instants; they cannot exclude transient peaks. `/usr/bin/time`
reported 9.41 seconds user CPU, 45.67 seconds system CPU, and a 2,176 kB
maximum RSS using its separate accounting interface. Retain both measurements
rather than treating either as an exact memory limit.

Raw evidence: [soak.txt](../demo/soak.txt),
[resource snapshots](../demo/soak-samples.tsv), and
[time resource report](../demo/soak-resources.txt).

A first resource sampler failed while reading an empty `/proc` field; that
observation attempt is retained as [incomplete](../demo/incomplete-soak-notice.txt)
and excluded from reported measurements. The sampler was corrected and the
fresh run above completed successfully. The failure affected evidence collection;
it establishes no result for the incomplete run.

## Scaled software workload

Run `target/release/examples/benchmark --scale` after the release build. Each
of three independent processes measures 15 cases: 1/20/50/200/1,000 queued
jobs at 1/4/8 concurrent clients. Each case has one full warmup batch, then
seven measured batches. There are **80,073 checked timed jobs** plus 11,439
warmup jobs; all processes exited zero. Every timed batch checks every exact
response, complete/nonduplicated task-index coverage, and the concurrency cap.

All jobs are available when the batch starts. Each job constructs a fake device,
connects, exchanges literal hello/world, closes the session, and joins its worker.
Batch time also includes client-pool creation and joining. Per-job service time
excludes queue wait; completion time is measured from batch submission and
includes it. The observed peak counts active clients, each with at most one
additional session-worker thread. This workload measures independent instances;
its indices do not test device identity or radio discovery.

The table shows the median of the three processes' per-case median batch times.
Raw results retain each process's seven-sample median/minimum/maximum throughput,
pooled service p50/p95, and pooled completion p95. Percentiles are per process;
no global p95 was inferred from the summarized CSV.

| Simulated jobs | 1 client, ms | 4 clients, ms | 8 clients, ms |
| ---: | ---: | ---: | ---: |
| 1 | 0.102 | 0.068 | 0.055 |
| 20 | 0.803 | 0.298 | 0.347 |
| 50 | 1.890 | 0.615 | 0.691 |
| 200 | 6.713 | 2.237 | 2.431 |
| 1,000 | 34.839 | 11.422 | 11.386 |

For 200 jobs, the per-process median batch ranges were 6.573-6.890 ms at one
client, 2.228-2.311 ms at four, and 2.307-2.581 ms at eight. Eight clients added
no clear benefit for that workload, while observed service p95 increased from
57.207-60.874 µs at four to 143.248-163.947 µs at eight. No implementation
optimization or production-radio setting was chosen from these software timings.

Evidence: [raw output](../demo/benchmark-scaled.txt),
[CSV](../demo/benchmark-scaled.csv), [23-test debug/release checks](../demo/verification-tests.txt),
and [review/TDD report](REVIEW.md). These follow-up measurements do not extend
the duration of the separate five-minute endurance run.

## Limits

Five minutes is a bounded development soak, not an overnight reliability claim.
Thread/channel timing does not predict BLE scheduling, reconnect behavior,
cryptography, systemd recovery, Wi-Fi activation, or capacity for 200 devices.
No physical device authentication or secret transfer is exercised. Those remain
separate gates requiring actual supported hardware and a reviewed secure channel.

## Audit supervision repair: command fixtures

The adversarial continuation found that an owner command can exit while its
same-group descendant keeps stdout open. The old audit waits for that descendant
and incorrectly reports success. A draining Bash pipeline now keeps GNU timeout
active until stdout closes. This is a correctness repair, not an optimization.

| Workload | Samples per binary | Before median (range), ms | After median (range), ms |
| --- | ---: | ---: | ---: |
| Normal audit, five mocked commands | 3 batches × 7 | 7.596 (5.935–8.730) | 14.451 (12.298–16.245) |
| Parent exits; stdout-holding child sleeps six seconds | 3 | 6013.658 (6010.825–6014.071), false success | 4008.137 (4007.198–4009.068), TIMEOUT failure |

All 48 runs check exact constructed output, empty stderr, exit code, and ordered
command calls. Correct failure skips owner-dependent Bluetooth checks, reducing
that case from five calls to two; its elapsed difference is not a throughput
comparison. Normal-path overhead is +6.855 ms (+90.2% on this short fixture).
Keep this measured cost to restore bounded behavior without a custom supervisor.

The before binary uses `d3217fa`; both binaries were built with
`RUSTUP_TOOLCHAIN=stable cargo build --release --bin audit-host --locked --offline`.
Environment: Linux x86_64, kernel 6.8.0-138-generic, 16 logical CPUs, Rust/Cargo
1.88.0, Python 3.10.12, GNU timeout 8.32, and `/bin/sh` resolving to dash.
`perf_counter_ns` surrounds each CLI process and output collection. Only busctl
and nmcli are mocked. Commands run with a private PATH, C locale, and a private
call-log variable. No compilation ran during measurement. Sequential samples
have no warmup, CPU pinning, randomized interleaving, or confidence intervals.

Evidence: [48 raw timings](../demo/benchmark-audit-deadline.csv),
[unchanged before/after harness](../demo/bench-audit-deadline.py), and
[red/green plus mutation trace](../demo/tdd-audit-deadline.txt). To replay, copy
the harness into a fresh private `/tmp` directory, then run
`python3 bench-audit-deadline.py before /absolute/baseline/audit-host` and
`python3 bench-audit-deadline.py after /absolute/corrected/audit-host` there.
Existing fixture directories are rejected to prevent stale-log reuse.

Measured source SHA-256, `device/audit.rs`:
`829229dc4accf5af0b51bf3e1f3cadc8b1f2d6ef035d32fb8b447548285fb0a3`.
Before/after binary SHA-256 values:
`ae7c915467467a9b5d7c3f7ff75d8774b77674f039b52b83bb74362f08c8b153` /
`5d60e5ee5b0117bbaca51cb9eb86f0c5e7ed89f47efe3ec9a2ebed5b4b2549e8`.
These are command-fixture measurements; no Bluetooth, phone, or Wi-Fi behavior
is measured. Descendants leaving the supervised group are outside this corpus.

## Benchmark CLI argument repair: startup only

The example now rejects non-UTF-8 argv through static usage instead of panicking
and echoing input. Three batches of seven processes per case and binary check
help and a raw-byte argument containing a synthetic canary: 84 calls total.

| Case | Before | After | Before/after median, ms |
| --- | --- | --- | ---: |
| `--help`, 21 calls per binary | Exit 0, exact usage | Same | 0.567 / 0.606 |
| Non-UTF-8 argv, 21 calls per binary | Exit 101, panic and canary present | Exit 1, static usage, neither present | 0.910 / 0.514 |

Timing ranges overlap: help 0.461–1.027 / 0.478–1.274 ms; invalid argv
0.479–1.120 / 0.481–0.941 ms. No speed improvement or regression is inferred.
The result is controlled, redacted failure. The core simulation is unchanged.

Both examples were built with `RUSTUP_TOOLCHAIN=stable cargo build --release
--example benchmark --locked --offline`, before from `d3217fa`. Runtime uses
Linux x86_64/kernel 6.8.0-138-generic, Python 3.10.12, Rust 1.88.0, 16 logical
CPUs, and only PATH=/usr/bin:/bin, LC_ALL=C, LANG=C, RUST_BACKTRACE=0. Bytes are
passed directly through subprocess argv; `perf_counter_ns` surrounds launch and
output collection. No compilation ran during measurement. There is no warmup,
pinning, randomized interleaving, or confidence interval.

Evidence: [84 timings and behavior flags](../demo/benchmark-cli-startup.csv),
[unchanged harness](../demo/bench-cli-startup.py), and
[public executable red/green trace](../demo/tdd-benchmark-cli.txt). Copy the
harness into a fresh private `/tmp` directory and run
`python3 bench-cli-startup.py before /absolute/baseline/benchmark`, then
`python3 bench-cli-startup.py after /absolute/corrected/benchmark`.
Each batch uses a fresh working directory. Retained results contain output
hashes/counts and behavior flags; the canary is deliberately fictitious.

Measured example source SHA-256:
`8549866e6a5714cdc9fa4e9b3272ca48e90b9dc582e03a4ed1ec1672d73b1220`.
Before/after binary SHA-256 values:
`1af60dace5c277136c43278e8495ec18949c0803f4d750b741399607e5d4a598` /
`8ba75f7c85880ddcc5f12fb88b2668e0d033d65f359b2f60ac1d70e51b2f8e70`.
This corpus executes no simulation workload or radio/network operation.

## Scale-path verification after argv repair

The same corrected release binary ran `--scale` in three separate sequential
processes. Each covers 1/20/50/200/1000 synthetic jobs at 1/4/8 clients, one
warmup batch and seven measured batches per case. All three processes exited 0
with empty stderr: 45 scenario summaries, 315 measured batches, 80,073 checked
measured jobs, and 11,439 warmup jobs. The agent checked scenario coverage,
counts, bounds, finite metrics, and percentile/rate ordering against raw output.

For 200 synthetic jobs, the median of three process-reported batch medians is
7.028 ms at one client, 2.363 ms at four, and 2.430 ms at eight. Each configuration
checks 4,200 measured jobs across 21 batches; observed peaks are 1/4/8. These are
batch measurements of thread/channel jobs, not pooled radio/device latencies.

Evidence: [raw output](../demo/benchmark-scaled-continuation.txt) and
[45 scenario rows](../demo/benchmark-scaled-continuation.csv). Reproduce with
`target/release/examples/benchmark --scale` three times after the release build.
The binary/source hashes are the startup-repair hashes above; runtime environment
is PATH=/usr/bin:/bin, LC_ALL=C, LANG=C, RUST_BACKTRACE=0 on the same host.
No compilation overlapped the measurements. No optimization or cross-version
throughput comparison is claimed: this verifies valid CLI dispatch and the
unchanged simulation. It adds no real BLE, security, or fleet-capacity evidence.
