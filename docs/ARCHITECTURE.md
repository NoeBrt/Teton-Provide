# Architecture and Selected Stack

Status: design only. No Jetson is currently available. Simulated acceptance
and hardware acceptance are distinct; the original challenge requires the latter.

## Stack

| Responsibility | Choice | Rationale / validation status |
| --- | --- | --- |
| Baseline | Ubuntu 22.04, Python 3.10 | Matches the inspected workstation; ARM64/device checks pending |
| Application runtime | stdlib `asyncio`, `argparse`, `logging` | One async model, CLI first, no web server yet |
| Simulation | In-process async queues, synthetic discovery | No radio, sockets, root privileges, or new runtime dependency |
| Tests | pytest | 8.3.3 available locally; use `asyncio.run` without another async test plugin |
| Real device BLE | BlueZ GATT/advertising via `dbus-fast` | Explicit Linux D-Bus integration, hardware validation pending |
| Real configurator BLE | Bleak | Discovery and GATT client; not a peripheral implementation |
| Later Wi-Fi control | NetworkManager D-Bus via `dbus-fast` | Typed activation status; avoids passwords in subprocess arguments |
| Real device lifecycle | systemd + virtual environment | Host BlueZ/NetworkManager access; policy and restart tests pending |
| Packaging | `pyproject.toml`, pip, locked requirements | Create with executable code; lock only resolved/tested versions |
| State | Memory for the transport milestone | A fresh instance starts available; no persistent provisioning state yet |

The hardware choices follow [Bleak's supported platforms](https://bleak.readthedocs.io/en/latest/)
and the [dbus-fast service/client APIs](https://dbus-fast.readthedocs.io/en/latest/).
Use the installed BlueZ version's APIs; upstream documentation is not proof
of support on an uninspected Jetson.

## Responsibility boundaries

```mermaid
flowchart LR
    C[Configurator hello flow] --> T[Selected transport]
    T --> P[Shared message handler]
    P --> D[Device response]
    D --> T
    T --> C
```

In simulation, the transport supplies fake device metadata and two bounded
queues. On hardware, Bleak and BlueZ perform the discovery, connection, and
GATT exchange. The shared handler receives bytes and returns bytes; it imports
neither BLE nor NetworkManager. Keep simulation wiring out of the real service.

Create `device/` and `configurator/` code when their flows exist. Put the shared
message contract in one root `protocol.py`, and the local demo in `simulation.py`.
Do not create security/network modules until those responsibilities are implemented.

## First message contract

- Demo identity: `TETON-DEMO-001`; its name is only a discovery hint.
- Request: exactly the five bytes `hello`; response: exactly `world`.
- Reject other input without echoing or logging it. This endpoint accepts no credentials.
- One request at a time; finite connection/response timeouts and explicit errors.
- Each new simulated connection gets fresh queues; discard pending data on close.

The eventual BLE adapter advertises a project-specific service UUID and exposes
one characteristic with write and read properties. The configurator performs
an acknowledged write, then reads the response. Both messages are small; no
fragmentation or notification protocol is needed for this probe. The UUID will
be generated once and stored in the shared contract when the BLE adapter is built.
The secure provisioning protocol may need a different framing scheme later.

## What simulation proves

| Check | Software simulation | Required later |
| --- | --- | --- |
| Discover expected demo ID | Synthetic registry only | Actual advertisements and scan |
| `hello` response | Actual shared handler through queues | GATT write/read over BLE |
| Timeout, disconnect, retry | Deterministic fault injection | Driver/radio disconnect behavior |
| Restart | Replace simulated device instance | systemd restart and machine reboot |
| Offline operation | No external services by construction | Radio demo without Internet or shared LAN |
| Wi-Fi success | Not simulated in milestone one | NetworkManager activation plus assigned IP |

Do not label software logs as successful BLE provisioning. Future fake network
results must also be labeled simulations; they cannot satisfy the real-Wi-Fi requirement.

## Docker and alternatives

Docker is optional packaging for the same software tests. If added, use an
unprivileged runner with networking disabled and dependencies already in the
image. Do not add a Compose network: it would introduce a shared LAN the actual
challenge does not assume. Docker's host Bluetooth/D-Bus passthrough would still
exercise host hardware and require host access.

A BlueZ `btvirt`/VHCI integration lab could later test actual GATT registration
without physical radios, but requires host kernel/device access. It is outside
the first simulation; see the [BlueZ emulator source](https://kernel.googlesource.com/pub/scm/bluetooth/bluez.git/+/master/emulator/vhci.c).
If real BLE proves unsuitable, audit SoftAP support and adapt the transport.
QR provisioning remains a documented alternative, not another implementation.

## Boundaries for later phases

Before any wireless credential transfer, select an established authenticated
channel and physical device-identity bootstrap. Evaluate BLE authenticated
pairing against a library-based application channel; decide based on actual
I/O capabilities and platform support. A BLE name, RSSI, or raw Diffie-Hellman
exchange is insufficient. Record sender authorization, replay policy, and
post-success exposure in `docs/SECURITY.md` before enabling secrets.

Then implement NetworkManager activation with an IP-based success criterion,
technician-friendly errors, and a small local UI if needed. The demo targets
personal WPA Wi-Fi; hospital EAP/certificate requirements are a separate scope.
Discuss site profiles, authenticated manifests, bounded queues, multiple operators,
and staging versus corridor setup for 200 devices; do not implement orchestration now.
