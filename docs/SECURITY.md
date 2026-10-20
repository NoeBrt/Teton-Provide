# Credential Protection

Status: **implemented** (commit `52644b3`), with the deviations marked below. It replaces the QR-label protocol of
the first milestone (`Noise_NKpsk2`, decision 24), which cannot scale to 200 sensors; decision 27 of
`docs/DECISIONS.md` records why and what was chosen. `docs/ARCHITECTURE.md` explains it for readers, and
`tasks/compliance.md` tracks which of the tests at the end of this file have run.

## Constraints

- The device is headless: no screen, keyboard, or button for a pairing PIN.
- Android and iPhone must both work with the same technician flow, offline.
- 200 sensors per wing: no per-sensor label, scan or secret for the technician to handle.
- Threat: a rogue device in radio range that advertises like a IoT sensor, to collect the site password or to
  make the technician believe a sensor is set up. Also: someone with the app but no right to use it.
- The technician is not a developer; no PIN typing, no OS pairing dialogs.

## Options reviewed

| Option | Verdict | Reason |
| --- | --- | --- |
| BLE "Just Works" pairing | Rejected | Encrypts the link but authenticates nobody; an active man-in-the-middle wins. |
| Static passkey printed on the label | Rejected | A reused passkey leaks to an active attacker in at most ~19 reconnects ([Insinuator](https://insinuator.net/2021/10/change-your-ble-passkey-like-you-change-your-underwear/), [CVE-2020-26558](https://nvd.nist.gov/vuln/detail/CVE-2020-26558)). |
| LE Secure Connections OOB (key from QR) | Rejected | Not available to iOS apps ([Apple DTS](https://developer.apple.com/forums/thread/758122)); on Android `createBondOutOfBand` is a `@SystemApi`, absent from the public SDK ([AOSP](https://android.googlesource.com/platform/packages/modules/Bluetooth/+/refs/heads/main/framework/java/android/bluetooth/BluetoothDevice.java)). |
| Noise `NKpsk2`, key and secret in a QR label (first milestone) | Replaced | Sound, but one label scan per sensor and a secret printed in every patient room. |
| **Noise `XX`, device certificate from a IoT authority, technician token** | **Implemented** | Matter's model (device attestation) without a secure element: the sensor proves a key that IoT certified; the phone proves a code that IoT issued. Plain GATT on both platforms, no OS pairing UI, nothing to scan per sensor. |
| Sensor list from Smith before the visit | Later | Adds room mapping and revocation; needs the phone to sync before the visit. Out of scope for the demo. |

## Design

1. **Two authorities, at IoT.** `authority init` creates two Ed25519 keys (0600, kept offline): the **device
   authority** certifies sensors, the **technician authority** issues technician codes. The app embeds the device
   authority's public key; each sensor stores the technician authority's.
2. **Staging, not BLE.** On the sensor, `stage init` creates its static X25519 key (0600, never regenerated) and
   prints the public key. At the workshop, `authority certify` signs `[version][public key][customer]` with the
   domain `iot-device-cert/1`; `stage install` stores that certificate and the technician authority's key. A
   sensor without a certificate advertises **not staged** and offers no provisioning.
3. **Identity.** The sensor advertises `IOT-` and 10 hex digits of SHA-256 of its public key (40 bits), and one
   state byte (not staged, ready, online, offline). The name is a hint only; the handshake decides.
4. **Handshake.** `Noise_XX_25519_ChaChaPoly_SHA256`, prologue `iot-provision/2`. Message 2 carries the sensor's
   static key and its certificate, encrypted. The phone checks, before message 3: the device authority's signature
   (`verify_strict` semantics, `zip215: false`), that the certified key is the key the sensor just proved, that the
   certified ID is the advertised name, and that the token covers the certified customer. Any failure ends the
   session with **not a genuine IoT sensor** or **another customer's sensor**; the phone has sent nothing but an
   ephemeral key.
5. **Technician code.** Message 3 carries the phone's token: `[version][expiry][name][customers]` signed with the
   domain `iot-technician-token/1`. The sensor checks the signature, that its own customer is listed, and that
   `max(clock, firmware build date)` is before the expiry, then answers inside the channel: accepted, or refused
   with a reason (invalid, other customer, expired). A refused session closes.
6. **Credentials.** Sent only as Noise transport messages after the token is accepted: SSID, password, and a random
   128-bit attempt ID. AEAD gives confidentiality and integrity; per-message nonces reject reordering and replay.
7. **Activation.** The device records the attempt as *pending* with hash(SSID‖password), then calls NetworkManager
   over D-Bus with the profile it is not using (two fixed UUIDs alternate). The password never appears in argv,
   logs, or BLE plaintext.
8. **Result.** Inside the channel, the device reports the attempt ID, the state of that exact profile, and the IP
   observed after activation. Only that answer may show **Device connected**.

## Site credentials versus device secrets

- **Device key:** unique per sensor, never leaves its state directory. The certificate is public.
- **Technician code:** a bearer credential. The app keeps it in its own Keychain entry behind Face ID
  (`requireAuthentication`, this device only); its name, customers and expiry sit beside it, unprotected, so the app
  can show them.
- **Site profile:** SSID and password, saved per facility in the Keychain behind Face ID, unlocked once per session.
  Each sensor receives it inside its own Noise session.
- **Shared password risk:** with WPA2-Personal all sensors hold the same password, so one extracted sensor exposes
  the network and revocation means rotating it everywhere. Prefer per-device credentials in production: EAP-TLS
  certificates or per-device PSKs (PPSK/iPSK), issued by Smith. The demo uses WPA2-Personal.

## Policies

- **Authorization.** A valid technician code for the sensor's customer authorizes setup and reconfiguration.
  Without one, a phone gets no further than the handshake.
- **Reconfiguration.** A provisioned sensor keeps its provisioning service and accepts a new network from a phone with
  a valid code. If the new network fails, the device reactivates the previous profile; the new one is recorded only
  after it is active with an address. This replaces the first milestone's single-use rule.
- **Concurrency.** Noise state is kept per connection. The one-phone claim starts only when a token is accepted, so
  a replayed or unauthenticated session cannot lock the sensor; a second authorized phone gets "busy".
- **Replay and retries.** Fresh ephemerals on both sides give a replayed session new keys. A repeated attempt ID with
  the same payload hash returns its stored result; the same ID with a different hash is rejected.
- **Interrupted result.** The phone reconnects, runs a new handshake, and asks for the attempt ID. Results live in
  memory; after a reboot the app shows *unknown*.
- **Clock.** Sensors may boot offline with a wrong clock. The firmware build date is the floor, so a code that expired
  before the firmware was built is always refused. DEVIATION: a sensor whose clock runs late accepts a code past its
  expiry, by up to that lag.
- **Timeouts.** Idle sessions are dropped after 60 s.
- **No downgrade.** The hello characteristic stays hello-only; there is no plaintext credential path and no build flag
  that enables one.
- **Logs.** Outcomes and attempt IDs only; never SSID, password, tokens, keys, or addresses.
- **Framing.** DEVIATION: no chunk layer. Each Noise message travels in one acknowledged GATT write of at most 512
  bytes (the largest token, 8 customers and a 64-byte name, fits), and the phone forbids the BLE library from
  splitting it. A longer message is rejected, not reassembled.

## Accepted risks for the demo

- Device keys sit in a file, not a secure element. A key extracted from one sensor impersonates that sensor; there
  is no revocation list yet.
- A leaked technician code works for its customers until it expires (30 days). It is not bound to one phone.
- The demo authorities live on noe-lab (0600, outside the repository), not on an offline machine.
- NetworkManager stores the PSK in a root-only system connection file.

## Tests required before enabling secrets

- A sensor that copies a genuine certificate, presents another authority's certificate, or advertises another ID never
  receives the token or the credentials. (`src/provision.rs`, `configurator/src/setup.test.ts`)
- Tokens for another customer, expired or forged are refused and close the session. (`src/provision.rs`,
  `src/authority.rs`)
- Tampered, truncated, reordered, and replayed frames are rejected. (`configurator/src/noise.test.ts`,
  `src/provision.rs`)
- A BLE capture (`btmon` on the device) contains no SSID or password bytes. (`demo/real-join.txt`, first protocol)
- Wrong password, unreachable network, and existing or fallback connections never report success; a failed
  reconfiguration returns to the previous network. (NOT_RUN on hardware)
- Oversized and malformed frames are rejected without panic (unit tests; no fuzzing yet).
