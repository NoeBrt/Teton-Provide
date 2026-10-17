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
