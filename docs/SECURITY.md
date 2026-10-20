# Credential Protection: Bootstrap Review

Status: **design review, not implemented.** No credential byte may cross BLE
until checkpoint H passes and the tests at the end of this file pass. This
closes the task 4 review item; it does not select the mobile framework.
An independent security review (2026-10-18) shaped the policies below.

## Constraints

- The device is headless: no screen, keyboard, or button for a pairing PIN.
- Android and iPhone must both work with the same technician flow, offline.
- The only trusted out-of-band channel is the physical label on the device.
  Labels sit in patient rooms: assume anyone can photograph or cover one.
- The technician is not a developer; no PIN typing, no OS pairing dialogs.

## Options reviewed

| Option | Verdict | Reason |
| --- | --- | --- |
| BLE "Just Works" pairing | Rejected | Encrypts the link but authenticates nobody; an active man-in-the-middle wins. |
| Static passkey printed on the label | Rejected | A reused passkey leaks to an active attacker in at most ~19 reconnects ([Insinuator](https://insinuator.net/2021/10/change-your-ble-passkey-like-you-change-your-underwear/), [CVE-2020-26558](https://nvd.nist.gov/vuln/detail/CVE-2020-26558)). |
| LE Secure Connections OOB (key from QR) | Rejected | Not available to iOS apps ([Apple DTS](https://developer.apple.com/forums/thread/758122)); on Android `createBondOutOfBand` is a `@SystemApi`, absent from the public SDK ([AOSP](https://android.googlesource.com/platform/packages/modules/Bluetooth/+/refs/heads/main/framework/java/android/bluetooth/BluetoothDevice.java)). |
| Application channel, Noise `NKpsk2`, key and secret in QR | **Recommended** | Works over plain GATT on both platforms; the device proves its key, the phone proves it read the label; no OS pairing UI. |
| SRP6a with a label secret (ESP-IDF Security 2 model) | Alternative | Proven BLE provisioning precedent ([ESP-IDF](https://docs.espressif.com/projects/esp-idf/en/latest/api-reference/provisioning/provisioning.html)); needs a long label secret and a less common SRP stack on the device. |

Further alternatives (short code with a PAKE, a Smith manifest, IoT device attestation) and their conclusions are
recorded in decision 24 of `docs/DECISIONS.md`; the MVP keeps the QR label.

## Recommended design

1. **Staging, not BLE.** A local staging command generates the device's static
   X25519 key and a 256-bit label secret atomically in the service's
   `StateDirectory` (mode 0600; the unit gains `StateDirectory=` then), and prints
   the label: device ID, public key, secret. Staging rejects duplicate keys, so a
   golden image booted once cannot clone a key across the fleet, and checks each
   printed label with a real handshake. At runtime the key is never regenerated:
   no key means no advertising.
2. **Discovery.** The phone scans the QR, then connects to the advertisement
   whose name matches the ID. The name is a hint only; the keys decide.
   A QR without key and secret, or a typed ID, never leads to sending.
3. **Handshake.** `Noise_NKpsk2_25519_ChaChaPoly_SHA256`. NK authenticates the
   device to the phone; the `psk2` label secret authenticates the phone, so the
   public key can leak through inventories without granting access. The prologue
   binds the protocol version and device ID. Device side: `snow` 0.10 (Rust ≥ 1.85,
   [not formally audited](https://github.com/mcginty/snow)). Phone side: the same
   `snow` core through UniFFI, or a platform library, chosen with the framework.
4. **Credentials.** Sent only as Noise transport messages after the handshake.
   The payload carries SSID, password, and a random 128-bit attempt ID. AEAD gives
   confidentiality and integrity; per-message nonces reject reordering and replay.
5. **Activation.** The device records the attempt as *pending* with
   hash(SSID‖password), then calls NetworkManager over D-Bus. The password never
   appears in argv, logs, or BLE plaintext.
6. **Result.** Inside the channel, the device reports the attempt ID, the state of
   that exact connection profile, and the IP observed after activation. Only that
   answer may show **Device connected**.

## Site credentials versus device secrets

- **Label secret and key:** unique per device; they only open the BLE channel.
- **Site profile:** SSID and password, entered once per intervention (or loaded as a
  profile signed by Smith) and kept in the phone's Keychain or Keystore until the
  technician taps *Finish*. Each device receives it inside its own Noise session.
- **Shared password risk:** with WPA2-Personal all sensors hold the same password,
  so one extracted sensor exposes the network and revocation means rotating it
  everywhere. Prefer per-device credentials in production: EAP-TLS certificates or
  per-device PSKs (PPSK/iPSK), issued by Smith and bound to the scanned device ID.
  The demo uses WPA2-Personal.

## Policies

- **Authorization.** Holding the label secret authorizes the *first* provisioning.
  For a 200-device rollout the phone also checks the scanned key against a fleet
  manifest signed by Smith and preloaded, which defeats a QR stuck over the label.
- **Single use.** Success is terminal: the device unregisters the provisioning
  GATT service and disconnects every peer. A provisioned device never reopens
  provisioning after a restart, crash, or power cut; software cannot tell those
  apart. Re-provisioning needs a re-provision token signed by Smith, or a
  workshop reset that issues a new label secret.
- **Concurrency.** Noise state is kept per connection; one attempt is in flight at
  a time and a second client is refused, not queued. (Decision 21's single
  response slot is for the hello probe only.)
- **Replay and retries.** Fresh device ephemerals give a replayed session new keys.
  A repeated attempt ID with the same payload hash returns its stored result; the
  same ID with a different hash is rejected, so a corrected password needs a new ID.
- **Interrupted result.** The phone reconnects, runs a new handshake, and asks for
  the attempt ID. Results live in memory; after a reboot the app shows *unknown*.
- **Timeouts.** Handshake and idle timeouts drop peers that hold the link open.
- **No downgrade.** The hello characteristic stays hello-only; there is no plaintext
  credential path and no build flag that enables one.
- **Logs.** Outcomes and attempt IDs only; never SSID, password, keys, or addresses.
- **Framing.** Noise messages can exceed the ATT MTU; a length-prefixed chunk layer
  over acknowledged writes and reads is required and must be fuzzed.

## Accepted risks for the demo

- No signed fleet manifest: a substituted QR label is not detected. Mitigate with
  tamper-evident labels; the manifest is part of the 200-device design.
- NetworkManager stores the PSK in a root-only system connection file.
- Polkit rules letting a `DynamicUser` service create NetworkManager profiles are
  not yet verified.

## Tests required before enabling secrets

- A handshake against a wrong device key or without the label secret fails before
  any credential is sent.
- Tampered, truncated, reordered, and replayed frames are rejected.
- A BLE capture (`btmon` on the device) contains no SSID or password bytes.
- After success, a second phone holding the label can neither connect to the
  provisioning service nor reopen it by restarting the service or the machine.
- Wrong password, unreachable network, and existing or fallback connections never
  report success; interrupted results recover by attempt ID or stay unknown.
- The chunk parser survives fuzzing with no panic and bounded memory.
