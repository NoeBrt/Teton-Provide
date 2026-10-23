# Challenge evaluation

Status checked on **23 October 2026**. This page supersedes the [21 October matrix](development/compliance-2026-10-21.md), retained as development history. Tests, simulated results and hardware observations are separate evidence classes.

## Four required constraints

| Requirement | Implemented behavior | Evidence and remaining limits |
| --- | --- | --- |
| No internet, cloud relay or shared initial network | Local BLE GATT; a standalone configurator can run without Metro or a network connection. | [Offline hello](../evidence/real/service-offline-hello.txt) proves local radio communication with phone networking disabled. A complete offline encrypted setup still needs a recorded run. |
| Real Wi-Fi connection with the received credentials | The device activates a NetworkManager profile and returns the result and IP for that attempt. | [Current protocol, macOS → Linux](../evidence/real/identity-advertisement.txt): app result and device journal report success. [Earlier iPhone → Ubuntu run](../evidence/real/real-join.txt) uses the previous protocol. |
| No plaintext credentials over the air | Noise XX with device certificates and holder-bound technician codes; encrypted credentials only after authorization. | [Security design](SECURITY.md), interoperability and rejection tests. The [earlier capture summary](../evidence/real/real-join.txt) checked SSID absence. A fresh current-protocol capture checking both SSID and password remains outstanding. |
| Usable by a non-developer | Automatic discovery, technician-code import, saved site form, one-device or batch setup, progress, errors and retry. | [Mobile overview](assets/architecture/overall-200-sensors.mp4) and [pointer tutorials](assets/demos/README.md) demonstrate the implemented UI with simulated results. No independent facilities-team usability study has been run. |

## Submission checklist

| Deliverable | Where to start | Status |
| --- | --- | --- |
| Configurator source | [configurator/](../configurator/) | Shared React Native UI and provisioning logic, native iPhone and Tauri desktop adapters. |
| Device source | [device/](../device/), [protocol library](../src/) | Rust BLE service, NetworkManager integration, staging, authority tools and systemd installation. |
| Ubuntu setup and run instructions | [SETUP.md](SETUP.md) | Includes hardware, dependencies, both public authority keys, staging and expected results. A clean-machine reproduction has not been performed. |
| Channel choice and trade-offs | [Architecture](ARCHITECTURE.md#why-bluetooth-low-energy) | BLE rationale and alternatives documented. |
| Credential protection | [SECURITY.md](SECURITY.md) | Implemented protocol, storage differences, threats and accepted limits. |
| 200 devices with non-technical staff | [200-device design](ARCHITECTURE.md#200-devices-in-a-hospital-wing) | Queue, six session slots, progress and retries implemented. Room mapping, multiple-operator coordination and Smith integration remain design work. |
| Successful run evidence | [Real runs](../evidence/README.md#real-hardware) | Current macOS-to-Linux and earlier iPhone-to-Ubuntu results, with protocol scope labelled. |

## Platform and scale limits

- Device service: Ubuntu 22.04 tested; Ubuntu 24.04 not run.
- macOS configurator: real BLE and current-protocol Wi-Fi setup observed.
- iPhone: current Release installed; physical provisioning after the identity update not run. Earlier-protocol provisioning succeeded.
- Android and Windows/Linux desktop runtime: not run.
- Desktop storage: memory-only; persistent system-keychain integration is absent.
- 200 sensors: simulated app fleet and a real-BLE bench with simulated Wi-Fi outcomes. No 200-physical-device capacity claim. The earlier bench log is not in this repository and is not required to accept the checked-in evidence.
- Wrong password, absent network, rollback and reboot recovery: implementation tests exist; hardware validation remains incomplete.

## Reproduce the checks

Use the commands in [SETUP.md](SETUP.md#tests). Rust/TypeScript Noise vectors, certificate and token rejection, attempts and batch tests verify software behavior; they do not replace a radio or Wi-Fi run. Browser recordings use public fixtures, described in [the media notes](assets/demos/README.md).
