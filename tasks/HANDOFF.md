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
