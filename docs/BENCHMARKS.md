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
