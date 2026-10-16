# Task Checklist

Status: planning complete; no application implementation started. Commands
below are planned acceptance commands until their task is implemented.

## 1. Shared hello contract

**Description:** Define the one byte-level handler reused by simulated and real devices.

**Acceptance criteria:**
- [ ] `hello` produces `world`; all other input is rejected without echo/logging.
- [ ] Tests cover empty, malformed, oversized, and credential-like input.

**Verification:** `python3 -m pytest tests/test_protocol.py -q`.
**Dependencies:** None.
**Files:** `protocol.py`, `tests/test_protocol.py`, `pyproject.toml`, `requirements-dev.txt`.
**Scope:** Medium, four files. Runtime uses the standard library; lock pytest for development.

## 2. Local simulated round trip

**Description:** Run distinct device/configurator flows through bounded queues,
with synthetic discovery and the actual shared handler.

**Acceptance criteria:**
- [ ] `python3 -m simulation` shows discovery, connection, request, response, and close.
- [ ] Output says `SIMULATION`; no sockets, root, Docker, BLE, or Internet required.
- [ ] A focused test checks the returned response and finite wait deadlines.

**Verification:** `python3 -m simulation`; `python3 -m pytest tests/test_simulation.py -q`.
**Dependencies:** 1.
**Files:** `simulation.py`, `tests/test_simulation.py`, `README.md`.
**Scope:** Medium, three files. Keep transport wiring separate from message handling.

## 3. Simulated failures and recovery

**Description:** Exercise a dropped response and a closed session, then retry
through a fresh connection; simulate replacing the device instance.

**Acceptance criteria:**
- [ ] Timeout and disconnect give bounded, explicit failures; no hanging tasks.
- [ ] Retry/new connection succeeds and receives no stale response from the old session.
- [ ] Simulated restart clears transient state and allows synthetic rediscovery.

**Verification:** `python3 -m pytest tests/test_simulation.py -q`; repeat the demo 20
times through a bounded test, without real-time sleeps or flaky timing assertions.
**Dependencies:** 2.
**Files:** `simulation.py`, `tests/test_simulation.py`, `demo/simulation.txt`, `README.md`.
**Scope:** Medium, four files. Evidence records actual output and environment.

## Checkpoint S: software demonstration

- [ ] Tasks 1-3 pass with `python3 -m pytest -q` and `git diff --check`.
- [ ] Evidence labels discovery, disconnect, and restart as simulated.
- [ ] No claim of working BLE, secure provisioning, or Wi-Fi connection.

## 4. Audit available hardware and lock BLE dependencies

**Description:** Inspect the eventual device and configurator using the README
commands; confirm adapter capabilities and Python/BlueZ compatibility.

**Acceptance criteria:**
- [ ] Identify device, OS, BlueZ, radios, NetworkManager ownership, and usable D-Bus APIs.
- [ ] Resolve/import Bleak and `dbus-fast` in reproducible virtual environments;
  lock tested versions and document any ARM64 differences.
- [ ] Required host access is available; otherwise record the exact unpassed gate.

**Verification:** README hardware audit; dependency installation/import checks
on both machines. These commands will be recorded when versions are selected.
**Dependencies:** Hardware availability and host access; follows checkpoint S.
**Files:** `docs/DECISIONS.md`, `README.md`, `requirements-device.txt`, `requirements-configurator.txt`.
**Scope:** Medium, four files. No shared LAN is required for the later BLE exchange.

## 5. Real device BLE hello endpoint

**Description:** Register a BlueZ service and advertisement, invoking the shared
handler through a read/write GATT characteristic.

**Acceptance criteria:**
- [ ] `IOT-DEMO-001` advertises a fixed service UUID discoverable by another machine.
- [ ] The endpoint accepts only `hello`; malformed writes fail without raw payload logging.
- [ ] Startup failure and normal shutdown cleanly report/release registrations.

**Verification:** Unit checks for handler wiring; live advertisement discovery
from the configurator, with commands and sanitized evidence recorded.
**Dependencies:** 1, 4.
**Files:** `device/main.py`, `device/ble.py`, `device/tests/test_ble.py`, `protocol.py`.
**Scope:** Medium, four files. No pairing/security or Wi-Fi implementation yet.

## 6. Real configurator BLE round trip

**Description:** Discover by service UUID using Bleak, select the demo endpoint,
connect, write `hello` with acknowledgement, and read `world`.

**Acceptance criteria:**
- [ ] Real two-machine GATT exchange succeeds without Internet or a shared LAN.
- [ ] No device, ambiguous selection, disconnect, and timeout produce clear errors.
- [ ] Disconnect/reconnect works without resetting Bluetooth manually.

**Verification:** Configurator command documented in README; repeated live
exchanges and failure cases. Capture sanitized output, not nearby-device inventories.
**Dependencies:** 5.
**Files:** `configurator/main.py`, `configurator/ble.py`, `configurator/tests/test_ble.py`, `README.md`.
**Scope:** Medium, four files.

## 7. Host service lifecycle and radio evidence

**Description:** Install the real device service with appropriate host permissions;
validate restart/reboot and collect honest hardware evidence.

**Acceptance criteria:**
- [ ] Service restart and device reboot restore discovery and successful hello exchange.
- [ ] Repeated reconnects pass, with Internet disabled and no shared LAN.
- [ ] Journal and demo evidence contain no secrets or arbitrary payloads.

**Verification:** `systemctl status iot-provisioning --no-pager`;
`journalctl -u iot-provisioning`; repeat the documented real round trip.
**Dependencies:** 6; reboot access must be available without losing the only recovery path.
**Files:** `device/systemd/iot-provisioning.service`, `README.md`,
`demo/ble-hello.txt`, `docs/DECISIONS.md`.
**Scope:** Medium, four files. Verify service permissions rather than assuming root is necessary.

## Checkpoint H: real transport milestone

- [ ] Tasks 4-7 pass on actual machines; hardware and simulation evidence remain distinct.
- [ ] Dependency/setup instructions reproduce the radio flow on supported Ubuntu.
- [ ] Stop here before adding credentials, security implementation, or technician UI.

## Later scope, not implementation tasks yet

After checkpoint H, write a focused plan for authenticated credential transfer,
real NetworkManager activation/IP verification, and failure-safe retries.
Then deliver technician UX, scaling/security documentation, and final evidence.
Preserve the original challenge's real-network requirement throughout.
