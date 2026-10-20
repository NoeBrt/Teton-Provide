# Compliance matrix

Re-checked after every step against the challenge PDF (`Technical_Interview_Challenge_Platform.pdf`) and the
technician user stories (README, "Technician experience"). **PASS** is backed by evidence, **NOT_RUN** is built
but unproven on hardware, **GAP** is missing. Evidence classes stay distinct (`tasks/HANDOFF.md`).

Last check: 2026-10-20, after the device review fixes (findings 5-8, `COMMAND_FIXTURE`); real Wi-Fi still waits for the Ethernet cable.

## PDF constraints (all four required)

| # | Constraint | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | **No internet**: local channel, no cloud relay, no shared local network at the start | PASS (design), NOT_RUN (offline run) | BLE only, no IP between phone and device; the app is a bundled Release build, crypto is pure JS (`@noble`). Missing: a run with Internet off and no shared LAN. |
| 2 | **Real network connection** with the received credentials | NOT_RUN | `device/wifi.rs` creates and activates a NetworkManager profile over D-Bus and checks that exact profile holds an IPv4. Waiting for the Ethernet cable so `wlo1` can be provisioned without cutting SSH. |
| 3 | **No plaintext credentials over the air** | PASS (code, `COMMAND_FIXTURE`), NOT_RUN (capture) | Noise `NKpsk2`, keys from the label; credentials only after the handshake (`demo/tdd-provision.txt`, `setup.test.ts`: a device failing the handshake never receives them). Missing: `btmon` capture with no SSID/password bytes. |
| 4 | **Usable by a non-developer** | PASS (app flow, `SIMULATION`), GAP (device start) | Site Wi-Fi once, **Set up**, scan the label, plain-language progress and errors, retry. GAP: the device service is still started over SSH; the systemd unit must start it at boot. |

## Submission list

| Item | Status | Notes |
|---|---|---|
| Working code, configurator and device | PASS | `configurator/` (Expo, iPhone), `device/` + `src/` (Rust, BlueZ, NetworkManager). |
| README reproducible on a standard Ubuntu machine, hardware assumptions | GAP | Must add: `stage`, `--features ble,stage`, `libdbus-1-dev`, NetworkManager permission (polkit or root), BLE + Wi-Fi adapter, Ethernet for management. |
| Architecture: channel choice and trade-offs | PARTIAL | `docs/DECISIONS.md` 1, 15, 18 and `docs/ARCHITECTURE.md`. Add: SoftAP creates a local network, DPP needs Android, camera QR fallback, BLE assumption on IoT hardware. |
| Architecture: credentials in transit | PARTIAL | `docs/SECURITY.md` still says "design review, not implemented"; update to the implemented protocol and its deviations. |
| Architecture: 200 devices, non-technical team | PARTIAL | Decision 22 (site profile once, room batches) and SECURITY policies; needs a consolidated section. |
| Evidence: credentials transmitted and connection established | NOT_RUN | `demo/phone-hello.txt` covers the hello probe only. |

## Technician user stories

| Story | Status | Notes |
|---|---|---|
| Open the prepared app and identify the device by its physical label | PASS (code) | QR label scan; a label for another sensor is refused. Camera not testable in the Simulator. |
| Enter the Wi-Fi name and password in a simple form | PASS (code) | Saved **sites** (a technician serves several facilities): name, network, password; pick one per visit. Shown as a one-line requirement above the sensors. |
| Tap one button and follow plain-language progress | PASS (`SIMULATION`) | **Set up**: Connecting → Securing the channel → Sending the network → Joining the Wi-Fi. |
| See **Device connected** with the IP, or an actionable error with retry | PASS (code), NOT_RUN (real) | Success only from the device's report for this attempt. A retry after a lost result reuses the attempt, so the device answers with its stored result. |
| Device needs no screen, keyboard or SSH during provisioning | GAP | systemd unit not yet updated (`StateDirectory`, NetworkManager permission). |
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
| `btmon` capture without credential bytes; wrong password, unreachable and fallback networks never report success | NOT_RUN |

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
