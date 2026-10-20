# Technical Counter-Review

Audit date: 2026-10-17. Updated scope: **no Jetson currently available; define the
stack and plan a software simulation first**. Earlier decisions below preserve
the original audit. Sections 7-10 record the simulation-first plan; section 11
supersedes their Python choices with Rust. Section 12 records the executable
offline simulation. Section 15 corrects the demo roles and makes graphical
technician UX mandatory. Section 18 excludes SoftAP from the MVP and supersedes
earlier fallback guidance. Sections 19-20 require Android/iPhone coverage and
preserve offline builds while the BLE dependency graph is unavailable.
Radio acceptance remains pending.

## Evidence collected

| Check | Observed result |
| --- | --- |
| Workstation | `noe-lab`, x86-64, Ubuntu 22.04.5 LTS, kernel 6.8.0-138-generic |
| Python | 3.10.12 |
| BlueZ tools | `bluetoothd --version` and `bluetoothctl --version`: 5.64 |
| Bluetooth sysfs | `hci0`, `btusb`, USB product `13d3/3567/100` |
| Wi-Fi sysfs | `wlo1`, `mt7921e`, PCI ID `14C3:7961` |
| NetworkManager client | nmcli 1.36.6; daemon version/ownership unverified |
| BLE libraries | `pip show bleak dbus-next`: packages not found in current interpreter |
| D-Bus socket | `/run/dbus/system_bus_socket` exists; access denied |
| Bluetooth queries | `bluetoothctl list/show` abort with D-Bus connection assertion |
| Service status | `systemctl status bluetooth`: bus access denied |
| Radio status | `rfkill list`: `/dev/rfkill` unavailable |
| Network queries | nmcli: connection not permitted; `ip link`: netlink not permitted |
| Jetson access | `jetson-052`: socket not permitted; `jetson-052-via-arc`: connection closed |
| GitHub access | `gh api user`: cannot connect to api.github.com |
| Initial workspace | No project files or AGENTS.md; root `.git` is a read-only empty directory, not a Git repository |

No Jetson model, L4T/JetPack version, adapter, advertising support, BLE scan,
or real radio exchange has been verified. Restricted access is not evidence
of defective hardware. SSH aliases identify candidates, not confirmed challenge devices.
GitHub CLI reports its configured account as `NoeBrt`; authentication validity
cannot be established while the API is unreachable.

## 1. Local channel and hardware gate

**Decision:** Select transport from actual two-machine evidence.

**Original proposal:** Jetson BLE peripheral, Ubuntu laptop central.

**Final choice:** Retain BLE as a candidate; defer commitment and implementation
until the Jetson can be inspected and its advertisement discovered.

**Reason:** An `hci0` directory does not establish peripheral capability or reliability.
BlueZ exposes separate [advertising](https://github.com/bluez/bluez/blob/master/doc/org.bluez.LEAdvertisingManager.rst)
and [GATT registration](https://github.com/bluez/bluez/blob/master/doc/org.bluez.GattManager.rst)
APIs; check both, then exercise them over the air.

**Trade-off:** Delays executable code but avoids selecting a stack against imaginary hardware.
Consider SoftAP only if real BLE tests fail; it also needs an adapter capability audit.

**Evidence / test:** Workstation and SSH failures above. Next: host audit,
advertising registration, discovery, `hello` round trip, reconnect, restart, reboot.

## 2. Runtime and service management

**Decision:** Prefer host Python and systemd, subject to compatibility checks.

**Original proposal:** Python virtual environment, BlueZ, systemd; no Docker.

**Final choice:** Provisional agreement. Evaluate a BlueZ D-Bus peripheral
library and Bleak central implementation after the gate; pin tested versions.

**Reason:** Python exists locally; host services need BlueZ and later NetworkManager.
Containerization would introduce another deployment layer without removing host permissions.

**Trade-off:** Ubuntu package and D-Bus policy compatibility must be documented;
Jetson Python and BlueZ versions may require different dependency versions.

**Evidence / test:** Python 3.10.12 and BlueZ 5.64 locally. Jetson versions,
library behavior, least-privilege permissions, and systemd recovery untested.

## 3. NetworkManager integration

**Decision:** Compare secret handling and activation reporting before choosing an API.

**Original proposal:** Choose between nmcli and D-Bus based on simplicity.

**Final choice:** Deferred to the Wi-Fi phase. nmcli remains acceptable if
secrets avoid process arguments and temporary files are protected and cleaned up;
D-Bus is a candidate for typed status and in-process secret transfer.

**Reason:** A short subprocess call is insufficient justification if it exposes
passwords or reports success before address assignment. The official
[NetworkManager API](https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/gdbus-org.freedesktop.NetworkManager.html)
offers connection activation methods; compatibility must be checked on the device.

**Trade-off:** D-Bus introduces more integration code; nmcli requires careful
error handling and output interpretation. Neither eliminates authorization requirements.

**Evidence / test:** Only nmcli client version is known. Confirm device ownership,
target SSID, activated connection, and IP address without requiring Internet.

## 4. Authentication and provisioning exposure

**Decision:** Keep the transport probe harmless and separate from the future secure protocol.

**Original proposal:** Authenticate a device identity and encrypt credentials;
consider pairing or an application secure channel.

**Final choice:** No credentials or security protocol in milestone one.
For the next phase, evaluate an established authenticated channel with a
per-device identity verified from a physical label/QR. BLE names and RSSI are
discovery hints, not authentication. Do not assume pairing is MITM-resistant.

**Reason:** A demo name can be copied; unauthenticated key agreement cannot
establish the intended peer. Technician authorization and device authentication
are separate requirements. A public fingerprint alone does not authorize the sender.

**Trade-off:** Physical bootstrap adds an operator step. Final protocol, replay
rules, authorization, provisioning window, and post-success exposure remain undecided.

**Evidence / test:** No security claim or credential exchange yet. Later require
wrong-device, unauthorized-sender, tamper, replay, and secret-redaction tests.

## 5. Offline operation, scale, and scope

**Decision:** Prove one offline local exchange before building fleet features.

**Original proposal:** One-device MVP; site profiles and bounded provisioning
queues discussed for 200 devices.

**Final choice:** Agree. Preinstall dependencies; verify operation without Internet
or shared LAN. Document site credentials entered once, an authenticated device
manifest, staging versus corridor operation, bounded concurrency, and exceptions
in a later scaling document. Do not promise 200 simultaneous BLE connections.

**Reason:** Local radio operation and deployment throughput are different questions.
Hospital enterprise Wi-Fi may require EAP/certificates rather than an SSID/password;
the hotspot demo must state that scope explicitly.

**Trade-off:** Hotspot success will not prove hospital network compatibility or
bulk throughput. These need separate requirements and measurements.

**Evidence / test:** No offline radio test or bulk benchmark completed. Current
work stops before Wi-Fi, UI, cloud infrastructure, and advanced cryptography.

## 6. Repository and evidence integrity

**Decision:** Prepare a local repository and publish privately when GitHub access works.

**Original proposal:** One GitHub repository containing reproducible code and evidence.

**Final choice:** Use `teton-provisioning/` because the workspace root Git metadata
is unavailable. Private GitHub creation is authorized but not completed.

**Reason:** Neither hardware success nor remote publication can be inferred from
local documentation or failed access attempts.

**Trade-off:** Current deliverable is an audit baseline, not a finished submission.

**Evidence / test:** `gh api user` cannot reach GitHub. Publish only after confirming
the authenticated account and private visibility; review artifacts for secrets first.

## 7. Simulation before hardware

**Decision:** Proceed with software work while retaining an explicit hardware gate.

**Original proposal:** Block implementation until a Jetson advertisement is discovered.

**Final choice:** The user confirmed no Jetson is available and requested a stack
and plan first. Next implement a local `hello` simulator using in-memory
`asyncio.Queue` endpoints and synthetic discovery. Reuse the shared protocol handler
in the later real device adapter. No simulation has been implemented in this update.

**Reason:** Software behavior can be tested without pretending to have a radio.
Memory queues also work within this session's socket restrictions.

**Trade-off:** Simulated discovery, disconnects, and restarts do not validate
BlueZ, BLE timing/MTU, systemd recovery, offline wireless operation, or Wi-Fi joining.

**Evidence / test:** User instruction, 2026-10-17. Planned executable checks and
the distinct hardware acceptance checkpoint are in `tasks/todo.md`.

## 8. Docker boundary

**Decision:** Make Docker optional for packaging tests, not the simulation substrate.

**Original proposal:** Host service preferred; user suggested Docker for simulation.

**Final choice:** Native Python simulation first. Add an unprivileged container
test runner only if repeatable isolated execution becomes necessary and a Docker
engine is accessible. Do not mount host D-Bus or expose radios to the simulator.

**Reason:** Docker CLI 27.0.3 exists, but `docker version` cannot contact the
daemon. A container supplies neither a virtual Bluetooth controller nor a
Wi-Fi access point automatically. BlueZ's [VHCI emulator implementation](https://kernel.googlesource.com/pub/scm/bluetooth/bluez.git/+/master/emulator/vhci.c)
depends on the host virtual-controller device; it is a separate integration lab.

**Trade-off:** Initial simulation will not exercise container deployment or
Bluetooth emulation. A future container image must be prepared before offline use.

**Evidence / test:** Docker daemon socket unavailable/access denied. Optional
container validation should run the same tests with networking disabled and
without privileged mode; no container execution is claimed now.

## 9. Selected software stack

**Decision:** Use one Python async stack and one D-Bus library.

**Original proposal:** Python preferred, peripheral library undecided,
NetworkManager API deferred.

**Final choice:** Python 3.10 baseline; stdlib `asyncio` and `argparse`; pytest
for testing. For hardware, select Bleak for the central and `dbus-fast` for
device-side BlueZ service/advertisement exports. Select NetworkManager D-Bus
through the same library in the later Wi-Fi phase. Host systemd, no database.

**Reason:** [Bleak](https://bleak.readthedocs.io/en/latest/) is a GATT client,
not a peripheral server. Its [project metadata](https://github.com/hbldh/bleak/blob/develop/pyproject.toml)
declares Python >=3.10 and a Linux `dbus-fast` dependency. The
[dbus-fast service API](https://dbus-fast.readthedocs.io/en/latest/)
provides the other side of the D-Bus boundary. Reusing that library avoids
another peripheral framework and a separate NetworkManager subprocess interface.

**Trade-off:** Direct BlueZ exports need a small amount of explicit GATT plumbing.
All selected hardware libraries remain uninstalled and untested here. Exact
versions and ARM64 compatibility must be locked after installation checks.

**Evidence / test:** Local Python 3.10.12 and pytest 8.3.3; official API review.
Bleak documents BlueZ >=5.55, met by the workstation's tools, not yet verified on a device.

## 10. Repository and current delivery scope

**Decision:** Keep this delivery local and limited to stack/planning documentation.

**Original proposal:** Private GitHub repository and hardware-first milestone.

**Final choice:** Continue in the existing local `teton-provisioning/` Git
repository. Write `docs/ARCHITECTURE.md`, `tasks/plan.md`, and `tasks/todo.md`.
Do not change the existing workspace AGENTS.md or implement future features now.

**Reason:** The latest request explicitly asks to define the stack and plan
for now; a local repository already exists.

**Trade-off:** The next code milestone will be a software demonstration, not
completion of the original challenge. Security, real Wi-Fi, technician UI,
and the 200-device design remain later work.

**Evidence / test:** Existing local commit `cde588c`; review plan dependencies,
Markdown links, and Git whitespace checks before committing this documentation.

## 11. Rust to align with the fleet

**Decision:** Replace the Python implementation plan with Rust throughout.

**Original proposal:** Python, asyncio, pytest, Bleak, and dbus-fast.

**Final choice:** Rust 1.88.0/edition 2024, Tokio, Cargo tests, Rustfmt, and Clippy.
Use `bluer` with `bluetoothd` for both BLE roles, behind an optional `ble` feature.
In the later Wi-Fi phase, use `dbus`/`dbus-tokio` for NetworkManager, matching the
library family already used by `bluer`. One Cargo package: shared protocol
library, simulation example, and two explicit binary targets under `device/`
and `configurator/`. Retain systemd and optional Docker test packaging.

**Reason:** The user reports Teton's fleet uses Rust and explicitly requests
alignment. [BlueR (`bluer`)](https://docs.rs/bluer/0.17.4/bluer/) covers local
and remote GATT, advertising, and discovery using Tokio. Its
[manifest](https://docs.rs/crate/bluer/0.17.4/source/Cargo.toml.orig) declares
Rust >=1.75 and libdbus-based async dependencies; the installed compiler is newer.
Use a single Linux BLE library rather than separate role-specific wrappers.

**Trade-off:** Native libdbus build/link requirements and device ABI compatibility
must be tested. Optional hardware features isolate those requirements from the
simulation. The crate graph may impose a higher MSRV than bluer itself; pin only
after resolution/build against the selected compiler. Exact fleet dependencies
are unknown. No current code or stored data needs migration.

**Evidence / test:** Locally observed rustc/Cargo 1.88.0, Rustfmt 1.8.0-stable,
Clippy 0.1.88, and x86-64 target only. `pkg-config --modversion dbus-1` returns
1.12.20. Crate APIs/metadata reviewed; no application/crate build or ARM64 test
performed. README, architecture, task commands, file paths, and ignore rules
are revised; the existing AGENTS.md remains untouched.

## 12. Executable simulation without uncached crates

**Decision:** Use standard-library channels and threads for the simulator;
keep Tokio and bluer planned for real BLE.

**Original proposal:** Tokio channels/tests for the local software milestone.

**Final choice:** Dependency-free Rust library, software transport, demo, and
Cargo tests. `std::sync::mpsc::sync_channel(1)` provides each direction; one
worker runs the shared handler. Check input size before copying, use nonblocking
send plus finite receive deadlines, close the reply receiver before the request
sender, and join the worker on session closure. Timeout invalidates the session.

**Reason:** Tokio/bluer are absent from the Cargo cache; `curl` to the crate
index fails DNS. There is no `/dev/vhci` or `btvirt`. This implementation can
actually build/test offline and advances the software gate without replacing
the future BlueZ integration with claims about simulated radios.

**Trade-off:** Simulated thread/channel timings cannot predict Tokio, BLE,
crypto, Wi-Fi, or fleet throughput. Device stop invalidates sessions; an already
pending request retains its receive deadline. Hardware code remains unimplemented.
Rustup's compiler installation is separate from Cargo's offline dependency flag.

**Evidence / test:** Rust 1.88.0 via the installed `stable` toolchain;
`RUSTUP_TOOLCHAIN=stable cargo test --all-targets --locked --offline`, Clippy,
formatting, and demo pass. Independent agent review verified 14 tests and
session cleanup; subsequent validation/evidence will record the final suite.
The named 1.88.0 toolchain is pinned for reproducibility but must be preinstalled
on a new machine. No application dependency, privilege, or network is needed.

## 13. Measured software checkpoint, bounded endurance

**Decision:** Establish a reproducible simulation baseline and recovery evidence
without turning software timings into radio or fleet claims.

**Original proposal:** Continue autonomous tests and benchmarks during the night;
sub-agents explicitly authorized for collaboration.

**Final choice:** Three release benchmark processes, each with seven batches per
mode and checked responses; separately time reused-session exchange and full
connect/exchange/close. Run a bounded 300-second mixed-failure endurance test.
Keep commands, compiler, code commit, raw results, and resource snapshots in
`demo/`, with interpretation in `docs/BENCHMARKS.md`.

**Reason:** Fixed, checked work plus independent review gives a defensible
software milestone. Benchmarks retain validation and worker cleanup. No
optimization is justified by the present requirements; preserve the baseline.

**Trade-off:** Five minutes is not an overnight reliability test. Thread/channel
latency is not BLE/cryptographic/network throughput. A first statistics collector
failed on an empty `/proc` field; that incomplete observation is retained and
excluded. The corrected fresh run is the only reported endurance result.

**Evidence / test:** 18 tests pass in debug and release; Rustfmt, Clippy with
warnings denied, and a release build pass. Independent agents reviewed the
protocol, connection cleanup, timeout/late-reply behavior, benchmark percentiles,
and soak accounting. The completed 300.001-second run checked 609,640 successful
responses, 853,496 expected errors, and 853,496 closed/joined sessions with zero
unexpected errors. Hardware checkpoint H remains open.

## 14. Skill-based review, public-seam TDD, and scaled simulation

**Decision:** Verify the software checkpoint with the installed review/TDD/performance
skills and measure bounded multi-device workloads without implementing fleet management.

**Original proposal:** Review the existing code, scale the benchmark, and use TDD.

**Final choice:** Pin review to `b4aaae8...4e1b9fa`, using separate Standards/Spec
agents and local versioned requirements. Add a public software-batch API and
`benchmark --scale`: 1/20/50/200/1,000 independent fake jobs with 1/4/8 client
workers. Cap the API at 10,000 jobs and 32 clients per batch, assign each index
once, check literal responses, and join all workers even after an error. Record
actual red/green execution and check the response test with an isolated mutation.

**Reason:** A serial round-trip benchmark cannot describe queueing or contention.
Public-interface tests establish coverage, bounded load, and failure behavior;
an independent literal expectation detects an incorrect wire response that the
old implementation-constant-based test allowed. No dependency download is required.

**Trade-off:** This is a software workload harness with indexed jobs; it does
not test authenticated identities, radio discovery, Wi-Fi, or fleet capacity.
Client-pool/session thread creation contributes to measured latency. Resource
caps are per batch, so concurrent callers must also bound their aggregate load.
Thread-spawn/panic failure paths were reviewed, not deliberately exhausted.

**Evidence / test:** `642b849` strengthens protocol/stop tests; `d21d09e` adds
the bounded batch and CLI. Both review axes and a focused scaling review found
no blocking defect. All 23 tests pass in debug/release, with formatting, Clippy,
and release build passing. Three processes checked 80,073 timed jobs across
45 scenario summaries, all with zero exit status. For 200 jobs, medians of
per-process median batch times were 6.713/2.237/2.431 ms at 1/4/8 clients.
See `docs/REVIEW.md`, `docs/BENCHMARKS.md`, and raw evidence under `demo/`.

## 15. Phone configurator and headless Ubuntu device

**Decision:** Make the non-technical graphical workflow required, with the user's
phone as demo configurator and a headless Ubuntu PC as the first device target.

**Original proposal:** Ubuntu configurator first, Jetson device preferred, CLI
first and a small local interface only if needed; mobile deferred to production.

**Final choice:** Phone demo first; an Ubuntu configurator should offer the same
guided workflow. Keep Rust/BlueZ on the device and systemd for unattended startup.
Choose the phone adapter after verifying its OS, offline client availability,
and harmless GATT exchange. `bluer` remains Linux-only. Preserve the real transport
gate before implementing secure credentials, Wi-Fi activation, or the final UI.

**Reason:** The user explicitly requires a non-technical operator and phone demo
without an on-device screen. The original PDF, `Technical_Interview_Challenge_Platform.pdf`,
pages 1-2, allows a phone/second laptop and requires use by a non-developer.
A terminal workflow cannot satisfy that requirement. A headless Ubuntu computer
is an allowed device; waiting specifically for a Jetson is unnecessary.

**Trade-off:** A mobile client adds platform/build/distribution constraints.
A page hosted on the unprovisioned computer has no automatic route to the phone.
Web Bluetooth requires browser support, secure context, and offline preparation;
loading an HTTPS interface does not secure BLE credentials. Device identity must
work from a prepared physical label/bootstrap, without an on-device display.

**Evidence / test:** All three PDF pages extracted with `pdftotext -layout` and
reviewed, including an independent requirements review. The final evidence wording
allows simulated output, but page 1 still explicitly requires a real network
connection; retain that stricter acceptance criterion. Platform references and
the operator flow are recorded in `docs/ARCHITECTURE.md`. Phone OS, actual radio
exchange, mobile startup, and headless lifecycle remain unverified. Existing
simulation evidence is unchanged and does not claim to validate this interface.

## 16. Executable host preflight while real transport remains blocked

**Decision:** Deliver a read-only Rust diagnostic as task 4 preparation, without
replacing the actual BLE gate with another simulated success.

**Original proposal:** Run manual hardware commands once the actual host is usable.

**Final choice:** Add `audit-host [hciN]` with no Cargo dependencies. Resolve
BlueZ's current unique D-Bus name, then read power and GATT/advertising APIs on
that adapter. Require a free advertising instance and a NetworkManager-managed
Wi-Fi device, regardless of whether it is connected. Only print constructed
statuses. Bound each command group to four seconds, cap stdout at 8 KiB, discard
stderr, and reject invalid/non-UTF-8 arguments without echoing them.

**Reason:** Host D-Bus/sockets and dependency downloads remain unavailable here;
the prepared binary can qualify an actual Ubuntu terminal offline. Large
Bluetooth/network inventories can expose names and addresses unnecessarily.
BlueZ 5.64 [SupportedInstances](https://github.com/bluez/bluez/blob/5.64/src/advertising.c)
already counts remaining slots; do not subtract ActiveInstances again.
[nmcli 1.36.6](https://github.com/NetworkManager/NetworkManager/blob/1.36.6/src/nmcli/devices.c)
exposes the two selected fields. In [systemd 249](https://github.com/systemd/systemd/blob/v249/src/busctl/busctl.c),
ordinary get-property/introspect can autoactivate a well-known service; a unique
owner avoids starting BlueZ during an audit.

**Trade-off:** This depends on standard Ubuntu command formats and GNU timeout;
it is not the runtime BLE implementation. A point-in-time free slot does not
reserve it. Registration authorization, peripheral behavior, phone compatibility,
and radio reliability remain unverified. Trusted system commands must not detach
from the timeout process group. No radio libraries or UI are added.

**Evidence / test:** 38 tests pass in debug/release, including 15 public CLI
tests with command fixtures. Six recorded red/green cycles include capacity
semantics, a descendant retaining stdout after TERM, non-UTF-8 argument leakage,
and D-Bus autoactivation. Separate Standards/Spec reviews identified defects
that were reproduced and fixed. Rustfmt, Clippy, and release builds pass.
The actual prepared-binary run returns exit 1 because host service access is
blocked; see `demo/host-preflight.txt`, `demo/tdd-host-audit.txt`, and
`demo/host-audit-verification.txt`. This does not close checkpoint H.

## 17. Standalone architecture document and technician mockup

**Decision:** Provide a single offline HTML file combining the architecture and
an interactive illustration of the non-technical operator flow.

**Original proposal:** Defer the actual technician interface until transport,
credential protection, and real Wi-Fi activation have passed their gates.

**Final choice:** The user explicitly requests an HTML architecture/mockup now.
Add `docs/architecture-demo.html` with inline CSS/JavaScript, phone/desktop
previews, and simulated success, password, network, disconnect, and identity
outcomes. Keep the actual runtime implementation gated. Use French, a neutral
paper/green palette, one diagram, and a focused device/network/result workflow.

**Reason:** A shareable visual document makes the planned operator experience
reviewable without selecting a mobile framework or requiring access to radios.
The page opens directly from disk and has no external assets or dependencies.

**Trade-off:** This is not a Bluetooth configurator or evidence of successful
provisioning. It sends/stores no credentials, clears the password on submit,
and blocks outbound connections with CSP. Browser/client compatibility for
actual provisioning and the authenticated channel remain open.

**Evidence / test:** JavaScript syntax, HTML labels/IDs, self-contained resources,
and main text-color contrast pairs are checked. Fifteen dependency-free Rust
audit tests and the rest of the Rust suite are unchanged and not rerun here.
A separate review found retained SSID validation after reset; the reproduced
regression is fixed. All 12 DOM scenario groups pass under jsdom with controlled
timers, no DOM errors, no outbound requests, and no pending timers. See
`demo/mockup-dom-verification.md` for method, tested file hash, and limitations.
Chrome headless fails on a prohibited socket operation in this session; Firefox
is also blocked by its snap runtime path. DOM checks do not validate visual
layout, native browser accessibility, CSP enforcement, or physical provisioning.

## 18. Exclude SoftAP from the MVP

**Decision:** Keep BLE as the planned provisioning channel and exclude a
temporary Wi-Fi setup network from the demo.

**Original proposal:** Retain SoftAP as a fallback; a later comparison recommended
it for a local web interface without app installation.

**Final choice:** Supersede the SoftAP fallback guidance in decision 1 and the
interface discussion. Use direct BLE communication between the prepared
configurator and the headless Ubuntu device, subject to the real transport gate.
Prepare the client and its offline assets beforehand. A physical QR may carry
the device ID and authentication bootstrap data; it will not join a setup Wi-Fi
network.

**Reason:** The supplied challenge PDF, page 1, says "no shared local network at
the start of the process". Creating an AP afterward is a defensible interpretation,
but the user explicitly rejects that assessment risk. Avoid making the submission
depend on the jury accepting a temporary LAN. This does not assert that the PDF
explicitly bans SoftAP.

**Trade-off:** Giving up the device-hosted web interface requires a separately
prepared client. Browser BLE support or native installation must be verified on
the chosen phone. Client selection, authenticated credential protection, and
actual BLE reliability remain open. If BLE fails its gate, document the failure
and reassess hardware/client options; do not silently substitute SoftAP.

**Evidence / test:** PDF wording rechecked with `pdftotext` and the user's explicit
objection recorded on 2026-10-17. README and architecture fallback guidance are
aligned with this decision. This is a scope decision, not evidence of a passed
radio or real Wi-Fi test; existing simulation results remain unchanged.

## 19. Require Android and iPhone acceptance

**Decision:** Support both mobile platforms with a prepared offline configurator.

**Original proposal:** Select a phone adapter after the user identifies one OS.

**Final choice:** Android and iPhone are required; actual models/OS versions,
clients, build/signing/distribution, permissions, and physical evidence remain
to verify separately. Keep the Ubuntu alternative. Review authenticated-bootstrap
feasibility on both mobile platforms before selecting a framework; implement
security and transfer credentials only after the harmless real BLE milestone.
An established authenticated and encrypted channel is mandatory before any
credential bytes leave a client; confidentiality and integrity need explicit
validation alongside peer authentication.

**Reason:** The user explicitly confirms both platforms on 2026-10-17. Android
browser success cannot establish iPhone support. A trusted physical identity and
a viable offline channel must work with the headless device on both platforms.

**Trade-off:** Both platforms need preparation and real acceptance tests. Do not
choose an untested shared framework or create client scaffolding before its BLE
and authentication paths are feasible. A simulator or HTML mockup proves neither.

**Evidence / test:** An independent agent checked the official platform references
linked in `docs/ARCHITECTURE.md` and updated plan/checklist acceptance. Final
success needs fresh authenticated state for the requested connection and its IP;
an interrupted result needs authenticated status recovery before success/retry.
No Android/iPhone runtime or real Wi-Fi test has passed yet.

## 20. Preserve default offline builds before adding BLE crates

**Decision:** Resolve and test the complete BLE graph before changing the manifest.

**Original proposal:** Add optional `bluer` dependencies behind a `ble` feature so
default simulation checks remain independent of Bluetooth.

**Final choice:** Retain the dependency-free tested manifest for now. When crate
access is available, resolve compatible pinned dependencies, cache/vendor the
graph, and verify default and BLE-enabled locked offline builds before claiming
reproducibility. Do not substitute an unused fake GATT adapter or uncompiled source.

**Reason:** Fresh inspection finds no BLE/D-Bus runtime alternatives in the local
cache; a bounded crates-index request fails hostname resolution. In an isolated
manifest, even disabled optional `bluer` fails default offline resolution.
Feature gating avoids compilation, not dependency resolution.

**Trade-off:** The real endpoint remains blocked on host access and dependencies.
Software correctness, measurements, and planning can proceed without weakening
the offline baseline or pretending another simulation is radio evidence.

**Evidence / test:** Independent feasibility review: Rust/Cargo 1.88.0,
205 cached crates, required BLE/runtime crates absent, temporary-manifest
`cargo check --locked --offline` fails with package `bluer` unavailable.
Actual BlueZ/NetworkManager access remains prohibited; see the separate
`demo/host-preflight-continuation.txt` and `tasks/HANDOFF.md`.

## 21. Real BlueZ hello endpoint behind the `ble` feature

**Decision:** Add `bluer` 0.17.4 (`bluetoothd`) and Tokio as optional dependencies,
and a `device` binary that serves the shared handler over one GATT characteristic.

**Final choice:** One service, one characteristic with acknowledged write and read.
A single pending slot holds `(client address, response)`: every write clears it,
`hello` fills it, and a read returns `world` once and only to that client. Nonzero
offsets fail with `InvalidOffset`, other payloads with `NotSupported`. The binary
powers the default adapter, advertises `TETON-DEMO-001` plus the service UUID, and
unregisters on SIGINT/SIGTERM. The systemd unit uses `DynamicUser`, because
Ubuntu's BlueZ D-Bus policy allows the default context, and `Requires=bluetooth.service`,
because registrations do not survive a `bluetoothd` restart.

**Reason:** This session can reach crates.io, BlueZ, and NetworkManager, which lifts
decision 20's blockers. The full graph (79 packages) resolves on Rust 1.88. Default
builds still compile no third-party crate. Locked offline builds work once the
graph is fetched.

**Trade-off:** The single slot serializes concurrent clients, matching the contract.
Per-connection state and notifications are deferred to the secure protocol.
The default adapter is used; no adapter argument yet.

**Evidence / test:** Six unit tests in `device/main.rs`, four mutations caught
(`demo/tdd-ble-device.txt`); all suites, Rustfmt, and
Clippy with and without `ble`. Actual run: `demo/host-ble-endpoint.txt` (rfkill soft
block, BlueZ returns `Busy`). Over-the-air exchange remains `NOT_RUN`.

## 22. Enter the site network once; provision room by room

**Decision:** The technician enters (or receives) the site Wi-Fi profile once per
intervention, then provisions the sensors of each room as a batch by scanning
their labels. No credential is typed per device.

**Original proposal:** One device per flow: select a device, type SSID and
password, connect, repeat (the first mockup).

**Final choice:** Two kinds of secrets stay separate. The *site profile* (SSID and
WPA2 password, or per-device credentials) lives in the phone's secure storage
(Keychain or Keystore) for the intervention only. The *label secret* is unique
per device and only protects the BLE channel. Per room: enter the room number,
scan each sensor label, tap one button; the app provisions the sensors one at a
time and shows one status per sensor, with targeted retries. The app records
sensor ↔ room for Smith.

**Reason:** The challenge PDF targets "thousands of IoT devices", "200 devices
simultaneously in a hospital wing" and a non-technical facilities team; rooms hold
several sensors. Typing a password per device is slow and error-prone, and the
QR label already disambiguates sensors that advertise side by side.

**Trade-off:** With WPA2-Personal every device holds the same site password: one
compromised sensor exposes the network, and revoking one device means changing the
password everywhere. Production should prefer per-device credentials: EAP-TLS
certificates or per-device PSKs (PPSK/iPSK) issued through Smith. Storing the site
password on the phone during the intervention is an accepted, bounded exposure.

**Evidence / test:** Design and mockup only. The Playwright run must show a second
room provisioned without re-entering credentials and one status per sensor.

## 23. Expo React Native configurator, tested on iPhone

**Decision:** Build the phone configurator with Expo and React Native in
TypeScript, using `react-native-ble-manager` for Bluetooth.

**Original proposal:** No framework selected (decision 19); options were native
Swift/Kotlin, Flutter, React Native, Kotlin Multiplatform, or a web page.

**Final choice:** Expo SDK 57, React Native 0.86, development builds through EAS
(SDK 58 was dropped: the App Store Expo Go still runs SDK 57).
`react-native-ble-manager` 12.5 is a New Architecture TurboModule with an Expo
config plugin; upstream `react-native-ble-plx` only claims support up to Expo 51,
while SDK 55+ runs only on the New Architecture. The first version is the hello
probe in `configurator/`. The user will test physically on an iPhone only; the
code stays cross-platform, but Android has no physical evidence.

**Reason:** Teton's own mobile stack is Expo + React Native + TypeScript (their
mobile job post and their `street-food-safari` challenge). EAS builds iOS in the
cloud, so no Mac is needed, and development builds reload from a QR code. A web
page cannot work on iPhone: Safari has no Web Bluetooth.

**Trade-off:** iPhone installs need a paid Apple Developer account. The Noise
channel will run in TypeScript on the phone and in Rust (`snow`) on the device;
interoperability must be proven with the official Noise test vectors. Later, the
device's Wi-Fi apply should reuse Smith's connectivity guard and error names
(`WrongPSK`, `NotInRange`, `NmcliError`) so technician messages match Smith.

**Evidence / test:** `npm test` (6 probe tests, 6 mutations caught,
`demo/tdd-configurator.txt`), an independent review with its fixes applied, `tsc`, `expo lint`, `expo-doctor` 20/20, an iOS
prebuild with the Bluetooth usage string, and an iOS JavaScript export. No phone
has run the app yet.

## 24. Authenticate the sensor with its QR label for the MVP

**Superseded by [decision 27](#27-certified-sensors-and-technician-codes-for-200-devices)** (2026-10-20): labels do
not scale to 200 sensors.

**Decision:** The phone trusts a sensor only after a Noise `NKpsk2` handshake with the keys printed on that
sensor's QR label (`T1:<device id>:<public key>:<label secret>`, written by `stage`). Credentials are encrypted
only after that handshake succeeds.

**Original proposal:** Question raised on 2026-10-20: is the QR needed at all for a secure channel?

**Final choice:** Keep the QR label for the MVP. The alternatives below were reviewed and recorded for the
architecture writeup and for production.

| Alternative | Conclusion |
| --- | --- |
| **No proof** (anonymous key exchange, BLE "Just Works") | Rejected. It meets "no plaintext over the air" literally but anyone in range can advertise `TETON-DEMO-001`, receive the password, and even relay to the real sensor so the app still shows *Device connected*. It saves the technician one scan. |
| **Short code on the label** (8 digits, HomeKit style) + PAKE (SRP6a or SPAKE2) | Viable if Teton labels cannot carry a QR. Each wrong guess costs one live attempt. Needs a different protocol: `NKpsk2` requires a 256-bit secret that nobody can type. |
| **Sensor list sent by Smith** before the visit (IDs, keys, work order) | Production target for 200 devices: no secret on the label, authorization comes with the work order. Needs the phone to sync before the visit. |
| **Teton device attestation** (per-device key, certificate signed by a Teton CA, CA public key in the app; Matter's model) | Best long-term identity proof: nothing secret printed in patient rooms. Must be per-device (one shared fleet key extracted from one sensor would impersonate all), ideally in a secure element; the app must still match the certificate's device ID to the sensor in front of the technician, and Smith revokes stolen units. Authorization stays separate (single use, work order). |

**Reason:** The QR is built, tested byte for byte against snow, needs one scan from a non-developer, and stops
both a fake sensor and a real but different one. Changing the protocol now would delay the real Wi-Fi test.

**Trade-off:** A photographed label lets someone provision a sensor that is not yet provisioned (accepted risk,
`docs/SECURITY.md`); attestation or a Smith manifest removes it.

**Evidence / test:** `demo/tdd-provision.txt`, `configurator/src/setup.test.ts` (a sensor failing the handshake
never receives the credentials).

## 25. Channel if Teton's own sensors have no BLE

**Decision:** BLE stays the demo channel; its availability on Teton's production hardware is an assumption, asked
to Teton on 2026-10-20.

**Original proposal:** Decisions 1 and 18 chose BLE from the challenge constraints; nothing checked a real Teton
sensor. The challenge PDF names "your computer" as the device, which noe-lab satisfies (MT7921, BLE + Wi-Fi).

**Final choice:** Ranked fallbacks that create no shared local network:

| Fallback | Conclusion |
| --- | --- |
| **Phone shows a QR to the sensor's camera** (Teton sensors are camera based) | First fallback: optical, short range, works with an iPhone. One way only, so success needs feedback (LED, sound, or Smith once online); the QR must carry credentials encrypted with the label key. |
| **Wi-Fi Easy Connect (DPP)**, QR on the label as its bootstrap | The standard for this exact problem, no IP network. Android only as configurator: no iPhone, macOS or browser API. Driver support on the device unverified. |
| **SoftAP** (temporary access point on the sensor) | Works on any Wi-Fi hardware, but it is a shared local network created during the process; excluded by decision 18. |
| **USB** | No radio at all, but needs a port on a mounted sensor. |

**Reason:** The channel choice and its reasoning are graded (PDF); the hardware assumption must be explicit.

**Trade-off:** A camera channel would reuse the configurator, the label key and the NetworkManager code; only the
transport changes.

**Evidence / test:** None yet; depends on Teton's answer.

## 26. Saved sites behind Face ID

**Decision:** The configurator keeps several named sites (facility name, network, password). Each password is a
separate Keychain entry protected by Face ID (`biometryCurrentSet`), unlocked once per session, kept in memory
only and dropped when the app leaves the foreground.

**Original proposal:** Decision 22: one site profile per intervention, forgotten at the end.

**Final choice:** Supersedes the "one intervention" part of decision 22 at the user's request (a technician serves
several facilities a year). Saving is refused when Face ID is off; re-enrolling Face ID makes saved passwords
unreadable, so the site is entered again.

**Reason:** Retyping each facility's password at every visit is slow and error prone; protecting each entry with
Face ID limits what a lost or unlocked phone exposes.

**Trade-off:** A phone now holds several facilities' passwords. Production should replace them with expiring site
profiles issued by Smith, or per-device credentials (EAP-TLS, PPSK) so no shared password reaches the phone.

**Evidence / test:** `configurator/src/sites.test.ts`; simulator layout checks. Face ID itself is NOT_RUN (the
Simulator does not prompt).

## 27. Certified sensors and technician codes for 200 devices

**Decision:** Replace the QR label (decision 24) with two Teton authorities (Ed25519). Each sensor holds a
certificate for its static key, signed by the **device authority** for one customer; the phone checks it offline
inside a Noise `XX` handshake before anything secret leaves. Each technician holds a **technician code**, a token
signed by the **technician authority** that names them, lists the customers they may serve and expires after 30
days; the sensor checks it before it accepts any request. "Set up all ready sensors in range" runs the setups three
at a time.

**Original proposal:** Question raised on 2026-10-20: what blocks 200 sensors with the label protocol, and how does
a sensor get a unique ID on a channel that no malicious device can use to pass as a Teton sensor?

**Final choice:** Decided in one requirements session (questions Q1 to Q24):

| Question | Choice |
| --- | --- |
| Threat | A rogue device in radio range that advertises like a sensor (to collect the site password or mislead the technician). Labels are dropped: scanning 200 of them is the bottleneck. |
| Sensor identity | `TETON-` and 10 hex digits of SHA-256 of the sensor's static key (40 bits: no collision expected within a fleet; 6 digits would collide around 4,000 sensors). The certificate binds key, ID and customer. A secure element and Smith are out of scope for the demo. |
| Phone authorization | Personal phones, app reserved to technicians: a signed token, delivered as the code `<token hex>.<holder key hex>`, a QR code scanned inside the app or pasted text, kept in the Keychain behind Face ID, valid 30 days, scoped to customers, checked by the sensor. The first build delivered it as a `provide://technician/` link; the link was removed after the security review, since another app could claim the scheme and receive the code. Not bound to one phone, but bound to a holder key the code carries (added after review). The sensor's clock floor is the later of its firmware build date and the time it last recorded, and rises no faster than its uptime. |
| Reconfiguration | Allowed with a valid token. The device keeps two NetworkManager profiles and rolls back to the working one if the new network fails. |
| Batch | Every ready sensor in range, three BLE links at a time. A wrong site password or a refused token stops new starts; a failure that belongs to one sensor does not. Counters, filters (failures first) and **Retry failed**. |
| Rooms | Later, in Smith; not in the app. |
| Proof | A 200-sensor test with fakes, a Simulator video, one real run on noe-lab. |

**Reason:** The certificate removes per-sensor secrets and per-sensor scans, which is what a 200-sensor wing needs.
A rogue device cannot present a valid certificate for a key it can prove, and a copied certificate fails because the
copier does not hold that key. The token keeps a stolen or borrowed app from configuring sensors.

**Trade-off:** The device key sits in a 0600 file, not a secure element: whoever extracts it from one sensor can
impersonate that one sensor until Teton revokes it (revocation lists are not built). It cannot replay the tokens it
collects: each names a holder key whose private half only the code carries. A leaked code works for its customers
on any phone until it expires; 30 days bounds that. Import inside the app costs the one-tap link; Universal Links
would bring it back without a scheme another app can claim. The clock floor follows a clock set far ahead only as
fast as the uptime, so it cannot lock codes out, but after a long power-off it trails real time by the downtime.
The authorities' private keys must stay offline at Teton; the
demo keeps them in `~/noe-ws/teton-authority` on noe-lab (0600, outside the repository).

**Evidence / test:** `src/authority.rs` and `src/provision.rs` tests (impostor with a copied certificate, other
authority, other customer, expired and forged tokens, reconfiguration, rollback profile order);
`tests/noise_vectors.rs` with `configurator/src/noise.test.ts` (byte-for-byte interop); `configurator/src/setup.test.ts`
(the token never leaves for a sensor that fails the checks); `configurator/src/batch.test.ts` (200 fake sensors);
Simulator video `docs/architecture/demo-simulator.mp4`.
