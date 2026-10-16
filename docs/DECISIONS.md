# Technical Counter-Review

Audit date: 2026-10-17. Status: **feasibility gate blocked by environment access**.
Decisions below are provisional where hardware evidence is unavailable.

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
