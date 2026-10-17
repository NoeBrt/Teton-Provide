# Technical Counter-Review

Audit date: 2026-10-17. Updated scope: **no Jetson currently available; define the
stack and plan a software simulation first**. Earlier decisions below preserve
the original audit. Sections 7-10 record the simulation-first plan; section 11
supersedes their Python choices with Rust. Section 12 records the executable
offline simulation. Section 15 corrects the demo roles and makes graphical
technician UX mandatory. Radio acceptance remains pending.

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
