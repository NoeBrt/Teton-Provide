# Credential Protection

Status: **implemented** (commit `52644b3`, holder-bound codes and review fixes since), with the deviations marked
below. It replaces the QR-label protocol of
the first milestone (`Noise_NKpsk2`, decision 24), which cannot scale to 200 sensors; decision 27 of
`docs/DECISIONS.md` records why and what was chosen. `docs/ARCHITECTURE.md` explains it for readers, and
`tasks/compliance.md` tracks which of the tests at the end of this file have run.

## Constraints

- The device is headless: no screen, keyboard, or button for a pairing PIN.
- Android and iPhone must both work with the same technician flow, offline.
- 200 sensors per wing: no per-sensor label, scan or secret for the technician to handle.
- Threat: a rogue device in radio range that advertises like a Teton sensor, to collect the site password or to
  make the technician believe a sensor is set up. Also: someone with the app but no right to use it.
- The technician is not a developer; no PIN typing, no OS pairing dialogs.

## Options reviewed

| Option | Verdict | Reason |
| --- | --- | --- |
| BLE "Just Works" pairing | Rejected | Encrypts the link but authenticates nobody; an active man-in-the-middle wins. |
| Static passkey printed on the label | Rejected | A reused passkey leaks to an active attacker in at most ~19 reconnects ([Insinuator](https://insinuator.net/2021/10/change-your-ble-passkey-like-you-change-your-underwear/), [CVE-2020-26558](https://nvd.nist.gov/vuln/detail/CVE-2020-26558)). |
| LE Secure Connections OOB (key from QR) | Rejected | Not available to iOS apps ([Apple DTS](https://developer.apple.com/forums/thread/758122)); on Android `createBondOutOfBand` is a `@SystemApi`, absent from the public SDK ([AOSP](https://android.googlesource.com/platform/packages/modules/Bluetooth/+/refs/heads/main/framework/java/android/bluetooth/BluetoothDevice.java)). |
| Noise `NKpsk2`, key and secret in a QR label (first milestone) | Replaced | Sound, but one label scan per sensor and a secret printed in every patient room. |
| **Noise `XX`, device certificate from a Teton authority, technician token** | **Implemented** | Matter's model (device attestation) without a secure element: the sensor proves a key that Teton certified; the phone proves a code that Teton issued. Plain GATT on both platforms, no OS pairing UI, nothing to scan per sensor. |
| Sensor list from Smith before the visit | Later | Adds room mapping and revocation; needs the phone to sync before the visit. Out of scope for the demo. |

## Design

1. **Two authorities, at Teton.** `authority init` creates two Ed25519 keys (0600, kept offline): the **device
   authority** certifies sensors, the **technician authority** issues technician codes. The app embeds the device
   authority's public key; each sensor stores the technician authority's.
2. **Staging, not BLE.** On the sensor, `stage init` creates its static X25519 key (0600, never regenerated) and
   prints the public key. At the workshop, `authority certify` signs `[version][public key][customer]` with the
   domain `teton-device-cert/1`; `stage install` stores that certificate and the technician authority's key. A
   sensor without a certificate advertises **not staged** and offers no provisioning. A sensor staged by the first
   protocol kept its unused label secret after the key pair in `identity`; `stage install` rewrites the file without
   it (0600 temporary file, synced, renamed over it, directory synced) before storing the certificate.
3. **Identity.** The sensor advertises `TETON-` and 10 hex digits of SHA-256 of its public key (40 bits), and one
   state byte (not staged, ready, online, offline). The name is a hint only; the handshake decides.
4. **Handshake.** `Noise_XX_25519_ChaChaPoly_SHA256`, prologue `teton-provision/2`. Message 2 carries the sensor's
   static key and its certificate, encrypted. The phone checks, before message 3: the device authority's signature
   (`verify_strict` semantics, `zip215: false`), that the certified key is the key the sensor just proved, that the
   certified ID is the advertised name, and that the token covers the certified customer. Any failure ends the
   session with **not a genuine Teton sensor** or **another customer's sensor**; the phone has sent nothing but an
   ephemeral key.
5. **Technician code.** Message 3 carries the phone's token: `[2][expiry][holder X25519 public key][name][customers]`
   signed with the domain `teton-technician-token/2`. `authority issue` generates the holder key pair with each code,
   and the phone uses the holder's private key as its Noise static key. The sensor checks the signature, that its own
   customer is listed, that its clock (see Clock below) is before the expiry, and that the static key the phone just
   proved is the holder key, then answers inside the channel: accepted, or refused with a reason (invalid, other
   customer, expired). A refused session closes.
6. **Credentials.** Sent only as Noise transport messages after the token is accepted: SSID, password, and a random
   128-bit attempt ID. AEAD gives confidentiality and integrity; per-message nonces reject reordering and replay.
7. **Activation.** The device records the attempt as *pending* with hash(SSID‖password), then calls NetworkManager
   over D-Bus with the profile it is not using (two fixed UUIDs alternate). The password never appears in argv,
   logs, or BLE plaintext.
8. **Result.** Inside the channel, the device reports the attempt ID, the state of that exact profile, and the IP
   observed after activation. Only that answer may show **Device connected**.

## Site credentials versus device secrets

- **Device key:** unique per sensor, never leaves its state directory. The certificate is public.
- **Technician code:** `<token hex>.<holder private key hex>`, which `authority issue` prints as text and as a QR
  code, is a credential that works on any phone. A sensor receives only the token, which names the holder's public
  key, so a sensor that records it cannot present it. The app keeps the code in its own Keychain entry behind Face ID
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
- **Code import.** Only inside **provide.**: its code sheet reads the QR code with the app's own camera, or takes the
  pasted text. A scanned code is never shown in the text field, and a new code's name, customers and expiry appear
  only once the app has checked its signature and expiry. The app registers no `provide` scheme and reads no incoming
  URL (only Expo's default bundle-ID and dev-client schemes remain), so no link can carry the code: the first build
  opened `provide://technician/` links, but on iOS the app that opens a custom scheme claimed by two apps is
  undefined, and on Android any app can declare it, so a link could hand the whole code to another app (pre-ship
  security review). A pasted code that still starts with `provide://technician/` is accepted.
- **Reconfiguration.** A provisioned sensor keeps its provisioning service and accepts a new network from a phone with
  a valid code. If the new network fails, the device reactivates the previous profile; the new one is recorded only
  after it is active with an address. This replaces the first milestone's single-use rule.
- **Concurrency.** Noise state is kept per connection. The one-phone claim starts only when a token is accepted, so
  a replayed or unauthenticated session cannot lock the sensor; a second authorized phone gets "busy".
- **Replay and retries.** Fresh ephemerals on both sides give a replayed session new keys. A repeated attempt ID with
  the same payload hash returns its stored result; the same ID with a different hash is rejected.
- **Interrupted result.** The phone reconnects, runs a new handshake, and asks for the attempt ID. Results live in
  memory; after a reboot the app shows *unknown*.
- **Clock.** Sensors may boot offline with a wrong clock. Expiry is checked against the later of the clock and a
  floor. At startup the floor is the later of the firmware build date and the `clock-floor` file; every 30 s the
  sensor records its clock there once it is an hour past the floor, so a code that expired before the floor is
  always refused, even after the clock is stepped back. The floor rises no faster than the time elapsed since
  startup: at most to the startup floor plus the uptime plus one hour. A clock stepped far ahead (one spoofed NTP
  answer) therefore cannot carry the floor past real time and lock codes out. DEVIATION: a sensor whose clock runs
  late accepts a code past its expiry, by up to that lag. After a long power-off the floor trails real time by the
  downtime, so a clock set back by up to that downtime goes through; with a clock held ahead, each restart can put
  the floor one more hour ahead of real time.
- **Timeouts.** Idle sessions are dropped after 60 s.
- **No downgrade.** The hello characteristic stays hello-only; there is no plaintext credential path and no build flag
  that enables one.
- **Logs.** Outcomes, attempt IDs, the name on an accepted code, why a code was refused (a replayed token shows
  as presented without its holder key) and the negotiated BLE MTU when a session starts; never SSID, password,
  tokens, keys, or addresses.
- **Framing.** DEVIATION: no chunk layer. Each Noise message travels in one acknowledged GATT write of at most 512
  bytes (the largest token, 8 customers and a 64-byte name, fits), and the phone forbids the BLE library from
  splitting it. A longer message is rejected, not reassembled.

## Accepted risks for the demo

- Device keys sit in a file, not a secure element. A key extracted from one sensor impersonates that sensor; there
  is no revocation list yet.
- A leaked technician code works for its customers on any phone until it expires (30 days at most): it is not bound
  to one phone. A token recorded by a sensor, without the code's holder key, is refused.
- The code reaches the technician outside the app (a printed QR code, or text over a channel Teton trusts). After a
  paste, the app does not clear the clipboard, so the code stays there (and in Universal Clipboard) until something
  else is copied.
- No signed time source (Roughtime, NTS): the clock floor bounds a wrong clock but does not correct it (see Clock).
- The demo authorities live on noe-lab (0600, outside the repository), not on an offline machine.
- NetworkManager stores the PSK in a root-only system connection file.

## Tests required before enabling secrets

- A sensor that copies a genuine certificate, presents another authority's certificate, or advertises another ID never
  receives the token or the credentials. (`src/provision.rs`, `configurator/src/setup.test.ts`)
- Tokens for another customer, expired, forged or presented without their holder key are refused and close the
  session. (`src/provision.rs`, `src/authority.rs`)
- The code `authority issue` prints is the code the app reads. (`tests/noise_vectors.rs`,
  `configurator/src/authority.test.ts`)
- The clock floor never starts before the firmware date and rises no faster than the uptime. (`device/main.rs`)
- Tampered, truncated, reordered, and replayed frames are rejected. (`configurator/src/noise.test.ts`,
  `src/provision.rs`)
- A BLE capture (`btmon` on the device) contains no SSID or password bytes. (`demo/real-join.txt`, first protocol)
- Wrong password, unreachable network, and existing or fallback connections never report success; a failed
  reconfiguration returns to the previous network. (NOT_RUN on hardware)
- Oversized and malformed frames are rejected without panic (unit tests; no fuzzing yet).
