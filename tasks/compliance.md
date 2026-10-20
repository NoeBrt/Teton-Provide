# Compliance matrix

Re-checked after every step against the challenge PDF (`Technical_Interview_Challenge_Platform.pdf`) and the
technician user stories (README, "Technician experience"). **PASS** is backed by evidence, **NOT_RUN** is built
but unproven on hardware, **GAP** is missing. Evidence classes stay distinct (`tasks/HANDOFF.md`).

Last check: 2026-10-20, after the first real setups from the iPhone (`demo/real-join.txt`).

## PDF constraints (all four required)

| # | Constraint | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | **No internet**: local channel, no cloud relay, no shared local network at the start | PASS (design), PASS (offline hello, `ACTUAL_BLE`) | BLE only, no IP between phone and device; the app is a bundled Release build, crypto is pure JS (`@noble`). Phone network off, hello against the systemd service: `demo/service-offline-hello.txt`. Missing: the offline encrypted setup itself. |
| 2 | **Real network connection** with the received credentials | PASS (`ACTUAL`) | iPhone to noe-lab over BLE; NetworkManager joined the site network with the received credentials in the service's own profile (`teton-provisioned` on wlo1, DHCP address), and the app showed **Device connected** (`demo/real-join.txt`, run 2). |
| 3 | **No plaintext credentials over the air** | PASS (code), PASS (capture, SSID) | Noise `NKpsk2`, keys from the label; credentials only after the handshake (`demo/tdd-provision.txt`, `setup.test.ts`). `btmon` captures of two real setups: the credentials travel in one encrypted 68-byte write; the SSID bytes appear nowhere (`demo/real-join.txt`). Pending: the password-bytes check (`demo/check_capture.py`, user-run). Known leak: message sizes reveal SSID and password lengths. |
| 4 | **Usable by a non-developer** | PASS (app flow, `SIMULATION`), PASS (device start, `ACTUAL_HOST`) | Site Wi-Fi once (typed or Wi-Fi QR), **Set up**, scan the label, plain-language progress and errors, retry. Device start: installed with `device/systemd/install.sh`; runs as `teton` from systemd, no SSH (`demo/service-offline-hello.txt`). Pending: restart and reboot. |

## Submission list

| Item | Status | Notes |
|---|---|---|
| Working code, configurator and device | PASS | `configurator/` (Expo, iPhone), `device/` + `src/` (Rust, BlueZ, NetworkManager). |
| README reproducible on a standard Ubuntu machine, hardware assumptions | PARTIAL | Hardware table, Ubuntu packages, build, install script, staging, demo, reset, tests, evidence. `install.sh` ran on noe-lab (Ubuntu 22.04). NOT_RUN: a clean machine, Ubuntu 24.04. GAP: the configurator build needs a Mac for iPhone; no Android build has been produced or run. |
| Architecture: channel choice and trade-offs | PASS | `docs/ARCHITECTURE.md` "Why Bluetooth Low Energy": decision tree, alternatives table (SoftAP, DPP, Web Bluetooth, camera QR, USB), costs of BLE, Teton hardware assumption. |
| Architecture: credentials in transit | PASS | `docs/ARCHITECTURE.md` "How credentials are protected"; `docs/SECURITY.md` now states the implemented protocol and its deviations (no chunk layer, peers not disconnected). |
| Architecture: 200 devices, non-technical team | PASS (design) | `docs/ARCHITECTURE.md` "200 devices in a hospital wing": Smith work order, per-device credentials, room batches, stop on first wrong password, staggered joins, result sync. Not implemented. |
| Evidence: credentials transmitted and connection established | PASS (`ACTUAL`) | `demo/real-join.txt`: device and NetworkManager journals, over-the-air timeline, app result; `demo/service-offline-hello.txt`; Simulator screens and video (`SIMULATION`). |

## Technician user stories

| Story | Status | Notes |
|---|---|---|
| Open the prepared app and identify the device by its physical label | PASS (`ACTUAL`) | The printed QR label scanned on the iPhone 15 Pro (`demo/real-join.txt`); a label for another sensor is refused. |
| Enter the Wi-Fi name and password in a simple form | PASS (code, iPhone) | Saved **sites** (a technician serves several facilities): name, network, password; pick one per visit. Network and password can also come from the standard Wi-Fi QR code (`WIFI:T:WPA;…`): scanned from the user's real network on the iPhone 15 Pro (2026-10-20). |
| Tap one button and follow plain-language progress | PASS (`ACTUAL`) | **Set up**: Connecting → Securing the channel → Sending the network → Joining the Wi-Fi. |
| See **Device connected** with the IP, or an actionable error with retry | PASS (`ACTUAL`) | Device connected with the IP on the iPhone (run 2). Run 1 showed the actionable timeout; its cause (BlueZ battery plugin) is fixed, and the provisioning service now stays 2 min after success so a retry recovers a lost result. Wrong password and absent network: NOT_RUN on hardware. |
| Device needs no screen, keyboard or SSH during provisioning | PASS (start), NOT_RUN (reboot) | Installed on noe-lab; the systemd service answered the iPhone offline. Restart and reboot pending (reboot waits for the user's jobs). |
| Several sensors per room without re-entering credentials | PASS (code) | Site Wi-Fi reused for every sensor; labels kept in memory for retries. |
| Readable on small screens and with large text (non-developer, hospital hallway) | PASS (`SIMULATION`) | iPhone SE: the large radar shrinks so the first sensor stays visible; accessibility-large: header, title and captions capped at ×1.2–1.3, body text and buttons scale; network name on 2 lines; no hyphen breaks in Wi‑Fi or sensor IDs; password Show/Hide; keyboard never hides Save. |
| Android | NOT_RUN | Same code; no Android device available (user decision, 2026-10-18). |

## Security design (`docs/SECURITY.md`) versus code

| Policy | Status |
|---|---|
| Staging creates key and secret, never at runtime; no key, no provisioning | PASS (`stage`; the hello probe still advertises without a key: deliberate deviation) |
| Handshake binds version and device ID; credentials only after it | PASS |
| Attempt ID, payload hash, stored result on repeat, conflict on change | PASS |
| One phone at a time, idle sessions dropped | PASS (60 s) |
| Single use: provisioned state persisted, provisioning closed | PASS (code); peers are not actively disconnected |
| Logs: outcomes and attempt IDs only | PASS |
| Site passwords on the phone | PASS (code), NOT_RUN (Face ID on device) | Keychain, this device only; each password behind Face ID (`biometryCurrentSet`), unlocked once per session, dropped when the app leaves the foreground; refused if Face ID is off. Decision 22 said "one intervention only": superseded by saved sites at the user's request (2026-10-20); Smith-issued expiring profiles remain the production answer. |
| Chunk layer for messages above the ATT MTU | DEVIATION: one Noise message per GATT write (≤ 512 B, longest is 131 B); `maxByteSize` stops the library from splitting it |
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
