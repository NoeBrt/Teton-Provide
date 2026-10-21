# Compliance matrix

Re-checked after every step against the challenge PDF (`Technical_Interview_Challenge_Platform.pdf`) and the
technician user stories (README, "Technician experience"). **PASS** is backed by evidence, **NOT_RUN** is built
but unproven on hardware, **GAP** is missing. Evidence classes stay distinct (`tasks/HANDOFF.md`).

Last check: 2026-10-21, after step 19 in `tasks/HANDOFF.md` (batch at the pace of a wing, demo mode, test bench), on
top of the overall (step 18) and the holder-bound codes (step 17). Their run with real sensors is pending; the `ACTUAL`
rows below come from the first protocol (QR label). Step 19 touches security in three places, checked below: the code
and the site password now stay in memory until the app comes back after more than 2 minutes away (`LOCK_AFTER_MS`),
the app holds a second, public demo authority confined to its fake radio, and a lab process on noe-lab receives the
site password. The four constraints keep their status: demo mode uses no radio and no network, the bench uses BLE
only and never joins Wi-Fi, and no credential travels outside the Noise channel.

## PDF constraints (all four required)

| # | Constraint | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | **No internet**: local channel, no cloud relay, no shared local network at the start | PASS (design), PASS (offline hello, `ACTUAL_BLE`) | BLE only, no IP between phone and device; the app is a bundled Release build, crypto is pure JS (`@noble`). Phone network off, hello against the systemd service: `demo/service-offline-hello.txt`. Missing: the offline encrypted setup itself. |
| 2 | **Real network connection** with the received credentials | PASS (`ACTUAL`) | iPhone to noe-lab over BLE; NetworkManager joined the site network with the received credentials in the service's own profile (`iot-provisioned` on wlo1, DHCP address), and the app showed **Device connected** (`demo/real-join.txt`, run 2). |
| 3 | **No plaintext credentials over the air** | PASS (code), PASS (capture, SSID, first protocol) | Noise `XX`; the phone checks the sensor's certificate before sending its code, and the credentials go only after the sensor accepts the code (`src/provision.rs`, `setup.test.ts`). `btmon` captures of two real setups: the credentials travel in one encrypted 68-byte write; the SSID bytes appear nowhere (`demo/real-join.txt`). Pending: the password-bytes check (`demo/check_capture.py`, user-run). Known leak: message sizes reveal SSID and password lengths. |
| 4 | **Usable by a non-developer** | PASS (app flow, `SIMULATION`), PASS (device start, `ACTUAL_HOST`) | Technician code once (QR scanned in the app, or pasted), site Wi-Fi once (typed or Wi-Fi QR), **Set up all ready (N)** or **Set up** per sensor, plain-language progress and errors, an overall card whose tabs **Set up**, **Errors** and **Not set up** filter the list, compact rows past four sensors, an IN PROGRESS block, **Retry failed** (20-sensor Simulator video; 200 sensors in demo mode in screens 8 to 11 and `overall-200-sensors.mp4`). NOT_RUN: the overall with many real sensors. Device start: installed with `device/systemd/install.sh`; runs as `iot` from systemd, no SSH (`demo/service-offline-hello.txt`). Pending: restart and reboot. |

## Submission list

| Item | Status | Notes |
|---|---|---|
| Working code, configurator and device | PASS | `configurator/` (Expo, iPhone), `device/` + `src/` (Rust, BlueZ, NetworkManager). |
| README reproducible on a standard Ubuntu machine, hardware assumptions | PARTIAL | Hardware table, Ubuntu packages, build, install script, staging, demo, reset, tests, evidence. `install.sh` ran on noe-lab (Ubuntu 22.04). NOT_RUN: a clean machine, Ubuntu 24.04. GAP: the configurator build needs a Mac for iPhone; no Android build has been produced or run. |
| Architecture: channel choice and trade-offs | PASS | `docs/ARCHITECTURE.md` "Why Bluetooth Low Energy": decision tree, alternatives table (SoftAP, DPP, Web Bluetooth, camera QR, USB), costs of BLE, IoT hardware assumption. |
| Architecture: credentials in transit | PASS | `docs/ARCHITECTURE.md` "How credentials are protected"; `docs/SECURITY.md` now states the implemented protocol and its deviations (no chunk layer, peers not disconnected). |
| Architecture: 200 devices, non-technical team | PASS (built, `COMMAND_FIXTURE` + `SIMULATION`, bench `ACTUAL_BLE`) | `docs/ARCHITECTURE.md` "200 devices in a hospital wing": certified sensors, technician codes, batch of every ready sensor (six at a time, link failures retried twice, sensors added during a run), stop on site-wide errors, and the overall of the sensors in range (set up, errors, not set up, as tabs over the list) are built; `batch.test.ts` runs 200 fake sensors, `wing.test.ts` the group of each sensor, `demo.test.ts` the demo wing; Simulator video with 20, and with 200 in demo mode for the overall. Test bench: the iPhone over real BLE against 200 simulated sensors, 84 provisioning sessions and 79 joins in one run (log on noe-lab). Room mapping (Smith), per-device credentials and staggered joins: design only. NOT_RUN: more than one real sensor; six links and scanning during runs with real sensors. |
| Evidence: credentials transmitted and connection established | PASS (`ACTUAL`) | `demo/real-join.txt`: device and NetworkManager journals, over-the-air timeline, app result; `demo/service-offline-hello.txt`; Simulator screens and video (`SIMULATION`). |

## Technician user stories

| Story | Status | Notes |
|---|---|---|
| Open the prepared app and identify the device by its physical label | PASS (changed, `SIMULATION`) | Each card shows the sensor's ID (`IOT-` + 10 hex digits of its key), which the sensor proves with its certificate; staging prints it, so a sticker can carry it with no secret on it. The QR label scan of the first protocol ran on the iPhone 15 Pro (`demo/real-join.txt`). Room mapping: later, in Smith. |
| Enter the Wi-Fi name and password in a simple form | PASS (code, iPhone) | Saved **sites** (a technician serves several facilities): name, network, password; pick one per visit. Network and password can also come from the standard Wi-Fi QR code (`WIFI:T:WPA;…`): scanned from the user's real network on the iPhone 15 Pro (2026-10-20). |
| Tap one button and follow plain-language progress | PASS (`ACTUAL`), PASS (many sensors, `SIMULATION`) | **Set up**: Connecting → Securing the channel → Sending the network → Joining the Wi-Fi. For a batch, the overall card above the list: "15 set up of 108 in range", "6 in progress · 83 waiting · about 1 min left"; each sensor's row shows its step ("Securing the channel… 2/4"), and the Not set up tab puts the running sensors in an IN PROGRESS block; after the batch, the Errors tab and **Retry failed** (200 simulated sensors in demo mode, screens 8 to 11 and `overall-200-sensors.mp4` in `docs/architecture/`; `wing.test.ts`). NOT_RUN: many real sensors. |
| See **Device connected** with the IP, or an actionable error with retry | PASS (`ACTUAL`) | Device connected with the IP on the iPhone (run 2). Run 1 showed the actionable timeout; its cause (BlueZ battery plugin) is fixed, and the provisioning service now stays 2 min after success so a retry recovers a lost result. Wrong password and absent network: NOT_RUN on hardware. |
| Device needs no screen, keyboard or SSH during provisioning | PASS (start), NOT_RUN (reboot) | Installed on noe-lab; the systemd service answered the iPhone offline. Restart and reboot pending (reboot waits for the user's jobs). |
| Several sensors per room without re-entering credentials | PASS (code, `SIMULATION`) | One code and one site Wi-Fi for every sensor, unlocked once and kept in memory until the app comes back after more than 2 minutes away, so a short switch keeps a batch going; **Set up all ready** runs them six at a time, and **Add N to the batch** adds the sensors found meanwhile (20 in the Simulator video, 200 in `batch.test.ts` and in demo mode). With 200 in demo mode (`SIMULATION`), the overall card counts them; past four sensors each sensor is a compact row that opens into its card; the tabs show the set-up, failed or not-set-up sensors only; the Errors tab lists only the refused sensors, grouped by cause, each with its reason (`10-overall-errors.png`). |
| Readable on small screens and with large text (non-developer, hospital hallway) | PASS (`SIMULATION`) | iPhone SE: the large radar shrinks so the first sensor stays visible; accessibility-large: header, title and captions capped at ×1.2–1.3, body text and buttons scale; network name on 2 lines; no hyphen breaks in Wi‑Fi or sensor IDs; password Show/Hide; keyboard never hides Save. Overall on the iPhone SE with accessibility-large text: text capped at ×1.3, the title, the progress line and "Not set up" wrap, and the whole card stays on the first screen (`docs/architecture/11-overall-se-large-text.png`). |
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
| Site passwords on the phone | PASS (code), NOT_RUN (Face ID on device) | Keychain, this device only; each password behind Face ID (`biometryCurrentSet`), unlocked once per session, kept in memory and locked again when the app comes back after more than 2 minutes away (`LOCK_AFTER_MS`, no test); refused if Face ID is off. Decision 22 said "one intervention only": superseded by saved sites at the user's request (2026-10-20); Smith-issued expiring profiles remain the production answer. |
| Demo authority (public seeds) trusted only for the demo's simulated sensors on its fake radio; real sensors always checked against `DEVICE_AUTHORITY`; demo reads and writes nothing saved | PASS (code audit; `demo.test.ts`: demo sensors refused under the real authority) |
| Lab bench identities certified by the real device authority, keys 0600 on noe-lab; the root simulator receives the site password in memory and never logs it | ACCEPTED RISK (`docs/SECURITY.md`): use a throwaway site; the bench never joins Wi-Fi |
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
