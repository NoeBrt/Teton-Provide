# Compliance matrix

Re-checked after every step against the challenge PDF (`Technical_Interview_Challenge_Platform.pdf`) and the
technician user stories (README, "Technician experience"). **PASS** is backed by evidence, **NOT_RUN** is built
but unproven on hardware, **GAP** is missing. Evidence classes stay distinct (`tasks/HANDOFF.md`).

Last check: 2026-10-20, after the review fixes, holder-bound technician codes and in-app-only code import (step 17
in `tasks/HANDOFF.md`). Their real-hardware run is pending; the `ACTUAL` rows below come from the first protocol
(QR label).

## PDF constraints (all four required)

| # | Constraint | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | **No internet**: local channel, no cloud relay, no shared local network at the start | PASS (design), PASS (offline hello, `ACTUAL_BLE`) | BLE only, no IP between phone and device; the app is a bundled Release build, crypto is pure JS (`@noble`). Phone network off, hello against the systemd service: `demo/service-offline-hello.txt`. Missing: the offline encrypted setup itself. |
| 2 | **Real network connection** with the received credentials | PASS (`ACTUAL`) | iPhone to noe-lab over BLE; NetworkManager joined the site network with the received credentials in the service's own profile (`teton-provisioned` on wlo1, DHCP address), and the app showed **Device connected** (`demo/real-join.txt`, run 2). |
| 3 | **No plaintext credentials over the air** | PASS (code), PASS (capture, SSID, first protocol) | Noise `XX`; the phone checks the sensor's certificate before sending its code, and the credentials go only after the sensor accepts the code (`src/provision.rs`, `setup.test.ts`). `btmon` captures of two real setups: the credentials travel in one encrypted 68-byte write; the SSID bytes appear nowhere (`demo/real-join.txt`). Pending: the password-bytes check (`demo/check_capture.py`, user-run). Known leak: message sizes reveal SSID and password lengths. |
| 4 | **Usable by a non-developer** | PASS (app flow, `SIMULATION`), PASS (device start, `ACTUAL_HOST`) | Technician code once (QR scanned in the app, or pasted), site Wi-Fi once (typed or Wi-Fi QR), **Set up all ready (N)** or **Set up** per sensor, plain-language progress and errors, counters, failures first, **Retry failed** (20-sensor Simulator video). Device start: installed with `device/systemd/install.sh`; runs as `teton` from systemd, no SSH (`demo/service-offline-hello.txt`). Pending: restart and reboot. |

## Submission list

| Item | Status | Notes |
|---|---|---|
| Working code, configurator and device | PASS | `configurator/` (Expo, iPhone), `device/` + `src/` (Rust, BlueZ, NetworkManager). |
| README reproducible on a standard Ubuntu machine, hardware assumptions | PARTIAL | Hardware table, Ubuntu packages, build, install script, staging, demo, reset, tests, evidence. `install.sh` ran on noe-lab (Ubuntu 22.04). NOT_RUN: a clean machine, Ubuntu 24.04. GAP: the configurator build needs a Mac for iPhone; no Android build has been produced or run. |
| Architecture: channel choice and trade-offs | PASS | `docs/ARCHITECTURE.md` "Why Bluetooth Low Energy": decision tree, alternatives table (SoftAP, DPP, Web Bluetooth, camera QR, USB), costs of BLE, Teton hardware assumption. |
| Architecture: credentials in transit | PASS | `docs/ARCHITECTURE.md` "How credentials are protected"; `docs/SECURITY.md` now states the implemented protocol and its deviations (no chunk layer, peers not disconnected). |
| Architecture: 200 devices, non-technical team | PASS (built, `COMMAND_FIXTURE` + `SIMULATION`) | `docs/ARCHITECTURE.md` "200 devices in a hospital wing": certified sensors, technician codes, batch of every ready sensor (three at a time), stop on site-wide errors, counters and filters are built; `batch.test.ts` runs 200 fake sensors; Simulator video with 20. Room mapping (Smith), per-device credentials and staggered joins: design only. NOT_RUN: more than one real sensor. |
| Evidence: credentials transmitted and connection established | PASS (`ACTUAL`) | `demo/real-join.txt`: device and NetworkManager journals, over-the-air timeline, app result; `demo/service-offline-hello.txt`; Simulator screens and video (`SIMULATION`). |

## Technician user stories

| Story | Status | Notes |
|---|---|---|
| Open the prepared app and identify the device by its physical label | PASS (changed, `SIMULATION`) | Each card shows the sensor's ID (`TETON-` + 10 hex digits of its key), which the sensor proves with its certificate; staging prints it, so a sticker can carry it with no secret on it. The QR label scan of the first protocol ran on the iPhone 15 Pro (`demo/real-join.txt`). Room mapping: later, in Smith. |
| Enter the Wi-Fi name and password in a simple form | PASS (code, iPhone) | Saved **sites** (a technician serves several facilities): name, network, password; pick one per visit. Network and password can also come from the standard Wi-Fi QR code (`WIFI:T:WPA;…`): scanned from the user's real network on the iPhone 15 Pro (2026-10-20). |
| Tap one button and follow plain-language progress | PASS (`ACTUAL`) | **Set up**: Connecting → Securing the channel → Sending the network → Joining the Wi-Fi. |
| See **Device connected** with the IP, or an actionable error with retry | PASS (`ACTUAL`) | Device connected with the IP on the iPhone (run 2). Run 1 showed the actionable timeout; its cause (BlueZ battery plugin) is fixed, and the provisioning service now stays 2 min after success so a retry recovers a lost result. Wrong password and absent network: NOT_RUN on hardware. |
| Device needs no screen, keyboard or SSH during provisioning | PASS (start), NOT_RUN (reboot) | Installed on noe-lab; the systemd service answered the iPhone offline. Restart and reboot pending (reboot waits for the user's jobs). |
| Several sensors per room without re-entering credentials | PASS (code, `SIMULATION`) | One code and one site Wi-Fi for every sensor; **Set up all ready** runs them three at a time (20 in the Simulator video, 200 in `batch.test.ts`). |
| Readable on small screens and with large text (non-developer, hospital hallway) | PASS (`SIMULATION`) | iPhone SE: the large radar shrinks so the first sensor stays visible; accessibility-large: header, title and captions capped at ×1.2–1.3, body text and buttons scale; network name on 2 lines; no hyphen breaks in Wi‑Fi or sensor IDs; password Show/Hide; keyboard never hides Save. |
| Android | NOT_RUN | Same code; no Android device available (user decision, 2026-10-18). |

## Security design (`docs/SECURITY.md`) versus code

| Policy | Status |
|---|---|
| Staging creates the key, never at runtime; no certificate, no provisioning | PASS (`stage init`/`install`; the hello probe still advertises without a key: deliberate deviation) |
| Phone checks the certificate (authority, proven key, advertised ID, customer) before sending the code | PASS (`setup.test.ts`, `src/provision.rs`) |
| Sensor checks the code (signature, customer, expiry against a clock floor: firmware date or recorded time, rising no faster than the uptime) before any request | PASS (`src/provision.rs`, `src/authority.rs`, `device/main.rs`) |
| Holder-bound codes: the phone proves the code's holder key; a token recorded by a sensor is refused | PASS (code: `src/provision.rs`, `setup.test.ts`, snow vectors); NOT_RUN on hardware until the real run |
| Code imported only inside the app (camera scan or paste): no `provide` scheme and no incoming URL read (only Expo's default bundle-ID and dev-client schemes remain), so no link can carry the code; the printed code is the one the app reads | PASS (code: `app.json`, `authority.test.ts` against the `code` vector; `ios/provide/Info.plist` in the local native project, gitignored); NOT_RUN on hardware until the real run |
| Handshake binds the protocol version; credentials only after the code is accepted | PASS |
| Attempt ID, payload hash, stored result on repeat, conflict on change | PASS |
| One phone at a time (claim after the code is accepted), idle sessions dropped | PASS (60 s) |
| Reconfiguration with a code; working profile persisted; rollback to the previous network on failure | PASS (code); NOT_RUN on hardware. Replaces the first protocol's single use (decision 27) |
| Logs: outcomes, attempt IDs, the accepted technician's name, refusal reasons and the BLE MTU; never secrets | PASS |
| Site passwords on the phone | PASS (code), NOT_RUN (Face ID on device) | Keychain, this device only; each password behind Face ID (`biometryCurrentSet`), unlocked once per session, dropped when the app leaves the foreground; refused if Face ID is off. Decision 22 said "one intervention only": superseded by saved sites at the user's request (2026-10-20); Smith-issued expiring profiles remain the production answer. |
| Chunk layer for messages above the ATT MTU | DEVIATION: one Noise message per GATT write (≤ 512 B, the largest message 3 is 499 B); `maxByteSize` stops the library from splitting it |
| `btmon` capture without credential bytes; wrong password, unreachable and fallback networks never report success | PARTIAL: capture without SSID bytes (password check pending); failure networks NOT_RUN |

## Review findings (2026-10-20, two independent reviewers)

| # | Finding | Status |
|---|---|---|
| 1 | First setup asked for the site Wi-Fi twice (stale closure) | FIXED: `src/flow.ts`, test reproduces it |
| 2 | A QR read twice started two setups on one sensor | FIXED: flow ignores repeated scans; `run()` guard |
| 3 | A label that failed the handshake stayed cached | FIXED: forgotten on `not-authenticated`, test |
| 4 | "Change" opened the site Wi-Fi form with an empty name | FIXED: form remounted on opening |
| 5 | A replayed handshake message 1 holds the one-phone lock (DoS, no label needed) | FIXED: the claim starts when the phone's first transport message decrypts; unproven sessions are dropped then (2 tests) |
| 6 | Single use fails open if the marker write fails or the process dies mid-activation | FIXED (code): marker and directory fsynced before success is reported; if that fails the profile is deleted and the phone gets an error. A crash before the marker leaves a profile that startup deletes (finding 7). NOT_RUN on hardware |
| 7 | Failed or orphaned NetworkManager profile keeps autoconnect | FIXED (code): one fixed profile UUID, created with autoconnect off, enabled only after success; deleted before each attempt, on failure and at startup while unprovisioned. NOT_RUN on hardware |
| 8 | Wrong password may surface as a generic error (100 ms poll can miss FAILED) | FIXED (code): the device `StateChanged` signal records every FAILED reason. NOT_RUN: wrong-password run; on a desktop Ubuntu a secret agent may also prompt for the password |
| 9 | App flow untested; missing setup cases | PARTIAL: flow tested (7 tests), handshake refusal tested; device `Failed`/`Unknown` replies need extra snow vectors |
| — | systemd unit, `label.svg` kept on device, QR printed to the terminal, log flooding, zeroization, unspecific busy/closed messages | OPEN (suggestions) |
