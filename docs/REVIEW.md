# Skill-Based Review and Verification

## Scope and skills

The installed `using-agent-skills`, `code-review`, `tdd`, and
`performance-optimization` skills guided this verification. The fixed review
range is `b4aaae8...4e1b9fa`: the last Rust planning commit through the original
software checkpoint. The two review axes ran in separate fresh-context agents.
The specification came from the versioned README, architecture, and task files;
there is no external issue tracker for this local take-home repository.

Standards sources include the workspace AGENTS.md and the repository's documented
scope, interfaces, testing, simplicity, and evidence rules. Explicit Rust and
simulation instructions take precedence over older workspace assumptions.
The reports below concern that fixed snapshot; line references refer to it.

## Standards

No findings. The pinned diff has no documented-standard breaches or material baseline smells.

The shared handler remains separate from transport wiring; input is bounded before copying and rejected without echoing. Session closure drops both channels before joining workers, and retries use fresh channels. Tests cover malformed input, timeout, disconnect, stale replies, cleanup, and replacement-device recovery. No credentials, security protocol, UI, or unused transport framework was added. Documentation records the runtime decision, setup commands, measured evidence, and hardware gates.

Validation: all 18 tests passed from an isolated archive of 4e1b9fa with Rust 1.88.0; the pinned diff passes git diff --check.

Not checked: physical radios, service restart/reboot, or later working-tree changes; simulation cannot establish real transport reliability. Formatting and Clippy findings were excluded as tooling-enforced.

## Spec

No concrete Spec findings in the fixed diff `b4aaae8...4e1b9fa`.

(a) Missing or partial requirements: none identified within the authorized software checkpoint. The exact-input contract, bounded queues, payload rejection before copying, explicit failure results, session invalidation, fresh retries, and worker joining match `docs/ARCHITECTURE.md:78-88` and `tasks/todo.md:55-59`. Pending BLE, credentials, Wi-Fi, service installation, and UI follow the explicit instruction, “Stop after the software checkpoint until hardware is available” (`tasks/plan.md:60`).

(b) Unasked scope creep: none identified. The dependency-free simulator, fault injection, examples, benchmark, and evidence support the requested milestone without adding a transport framework or external-service dependency.

(c) Incorrect-looking implementations: none identified. Every measured exchange checks `world` (`examples/benchmark.rs:38-40`); reused sessions and fresh connect/request/close costs are distinct (`examples/benchmark.rs:198-207`). The retained 300.001-second soak evidence is accurately limited to software cleanup (`docs/BENCHMARKS.md:68-101`).

Validation: all 18 tests passed using `RUSTUP_TOOLCHAIN=stable cargo test --all-targets --locked --offline` in an isolated archive of the reviewed commit. Public integration tests cover malformed input, continued usability, timeout/disconnect invalidation, retry, restart, drop, and repeated exchanges; unit tests additionally observe stale-reply rejection and worker termination.

Not checked: a fresh Ubuntu installation, hardware, or another long soak. Concurrent stop during an already pending request is documented (`docs/ARCHITECTURE.md:87-88`) but lacks a direct regression test; the reviewed receive/online checks implement the stated behavior. Passing these tests cannot establish radio reliability or fleet capacity.

## TDD follow-up

Tests use the public byte handler, device/session API, and
`simulation::batch::run_batch(device_count, concurrency)`. No new private test
seam or transport mock was introduced. The sequence is retained in
[the actual red/green trace](../demo/tdd-scaled.txt):

1. RED: bounded batch API absent. GREEN: every queued task completes once with
   an observed peak within the client limit.
2. RED: invalid configuration silently returned a successful empty batch.
   GREEN: reject zero/oversized batches and zero/excessive concurrency before allocation.
3. Mutation check: in an isolated copy, changing `world` to `wrong` passed all
   four existing protocol tests. Their expected response reused the implementation
   constant. The hardened public handler test expects literal `hello`/`world`;
   it fails on that same mutation and passes with unchanged correct production code.
4. RED: public benchmark CLI rejects `--scale`. GREEN: the complete checked matrix runs.

Additional public regression coverage checks a 200-job batch, concurrency greater
than job count, and stop racing with a request. The latter permits the documented
timeout/disconnect outcomes and checks subsequent permanent session invalidation;
it does not force a specific thread interleaving.

## Scaling addition review

No findings in the scaling additions.

run_batch validates limits before allocation/spawning, assigns each job once through an atomic counter, and bounds each batch to 10,000 jobs and 32 client threads, each with at most one session worker. Every spawned client is joined even after another worker fails; session Drop preserves channel closure and joining on early returns.

Service timing covers device/session creation, literal hello/world validation, closure, and joining. Completion timing begins at batch submission and includes queue/startup delay; batch elapsed includes client creation and joins. Pooled percentiles and median/minimum/maximum rates are consistent with those definitions. The output explicitly distinguishes synthetic job indices and client concurrency from authenticated identities, BLE connections, and fleet capacity.

The literal protocol expectation removes the self-referential response check. The stop-race test accepts the documented timeout/disconnect outcomes and verifies permanent invalidation afterward.

Validation: all four scaled tests and eight simulation integration tests passed on Rust 1.88.0 using cargo test --test scaled --test simulation --locked --offline.

Not checked: forced thread-spawn failure/panic, physical transport, or later concurrent edits; error cleanup was inspected. The software benchmark cannot establish radio or production fleet reliability.

## Results and limits

All 23 tests pass in debug and release; formatting, Clippy with warnings denied,
and release builds pass. See [validation output](../demo/verification-tests.txt).
Three independent scaling processes checked 80,073 timed jobs across 45 scenario
summaries; no process failed. The [benchmark report](BENCHMARKS.md) defines
warmup, queue-inclusive completion, service time, and all measurements.

The formal fixed-snapshot axes have **0 Standards findings and 0 Spec findings**;
there is no worst finding on either axis. The separate TDD mutation check exposed
and closed a test weakness. Resource-exhaustion/panic cleanup was reviewed rather
than fault-injected. Fresh Ubuntu/ARM64 installation, BLE, Wi-Fi, device identity,
secure credentials, and systemd lifecycle remain unverified hardware gates.

## Host preflight review and follow-up

The next review pins `ce1b4b3..fd0fd89`, covering the read-only Rust host audit,
its public CLI tests, and preparation tasks. The separate Standards and Spec
agents found the following defects; `1c2d62e` closes them:

| Axis | Finding | Fix and verification |
| --- | --- | --- |
| Standards | P2: non-UTF-8 argv panicked and exposed the argument | `args_os` with controlled validation; public regression and independent targeted reproduction pass |
| Standards | P3: SIGKILL reported a generic command failure | Inspect Unix exit signal; an independently tested TERM-ignoring command stops in 4.012 s and reports TIMEOUT |
| Spec | P2: a query to `org.bluez` could start the service | Resolve current unique owner first; service-absent fixture checks no activation, positive fixture only accepts the unique destination |

Parent verification also reproduced a descendant retaining stdout after its
parent terminated on TERM: the audit took 12 seconds. Direct KILL of the read-only
process group at four seconds fixes this; the public regression passes. BlueZ
source review caught a capacity interpretation error: SupportedInstances already
counts free slots. A positive regression prevents subtracting active slots again.
All six actual red/green traces are retained in
[the TDD evidence](../demo/tdd-host-audit.txt).

Both agents reviewed the corrected commit and reported no remaining concrete
defect. The Standards agent reran targeted argument/deadline checks; the Spec
follow-up was static. The complete 38-test suite passes in debug/release,
alongside Rustfmt, Clippy, and release builds; see
[the commands and source hashes](../demo/host-audit-verification.txt).

The prepared release binary was also run against the actual environment at
`1c2d62e`; it returns exit 1 with failed BlueZ/NetworkManager service access.
[This actual result](../demo/host-preflight.txt) is separate from fixture tests.
No registration, radio exchange, phone compatibility, or real Wi-Fi join was
validated. Baseline simulation benchmarks were not repeated because the simulated
transport and benchmark code did not change.

## Adversarial continuation: audit supervision

Review base: `d3217fa`; reviewed runtime source SHA-256:
`829229dc4accf5af0b51bf3e1f3cadc8b1f2d6ef035d32fb8b447548285fb0a3`.
An independent code reviewer reproduced a same-group stdout holder after its
parent exited. The public CLI regression returned success after 12.02 seconds
before the repair and fails safely after 4.01 seconds afterward.

A fresh-context reviewer inspected all command callers, quoted argv boundaries,
pipeline exit propagation, shell environment isolation, output limits, and
D-Bus behavior; no unresolved correctness/security issue remained. It ran the
then-16 host tests and private startup/function/xtrace fixtures. After the retained
environment regression was added, follow-up static review accepted that test and
the dependency documentation. Main ran all 17 host tests. An isolated mutation
removing Bash `-p` makes the new environment regression fail.

All 40 Rust tests pass in debug and release; Rustfmt and Clippy with warnings
denied pass. The separate benchmark agent checked 48 before/after CLI runs;
normal startup costs about 7 ms more, while the pipe-holder case now returns a
correct timeout. See [measurement method](BENCHMARKS.md#audit-supervision-repair-command-fixtures)
and [TDD evidence](../demo/tdd-audit-deadline.txt).

The corrected binary's [actual host run](../demo/host-preflight-continuation.txt)
still fails because BlueZ/NetworkManager access is blocked. Fixture success does
not establish radio or Wi-Fi acceptance. External cross-model CLI review was
skipped for this autonomous pass; agents used separate contexts.
