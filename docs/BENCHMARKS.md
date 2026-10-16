# Software Simulation Measurements

Measured code: `5f3f4cc2a8fe083cf3b87bf41c3c1ed3fbcf85e0`.
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

## Endurance and validation

An independent review checked session cleanup, stale-reply rejection, benchmark
percentiles, and error accounting. The 18 tests pass in debug and release modes;
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

## Limits

Five minutes is a bounded development soak, not an overnight reliability claim.
Thread/channel timing does not predict BLE scheduling, reconnect behavior,
cryptography, systemd recovery, Wi-Fi activation, or capacity for 200 devices.
No physical device authentication or secret transfer is exercised. Those remain
separate gates requiring actual supported hardware and a reviewed secure channel.
