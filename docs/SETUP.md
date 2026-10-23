# Setup and evaluation guide

**Send Wi-Fi credentials from a technician’s phone or laptop to a headless Linux device over Bluetooth, then confirm that the device joined the network.** No internet, cloud relay or shared network is needed during provisioning.

The repository contains both sides: the **provide. configurator** (React Native / Expo, with a Tauri desktop shell) and the **Linux device service** (Rust, BlueZ and NetworkManager).

```text
Technician → provide. → BLE + authenticated Noise XX → Linux device → Wi-Fi network
                           encrypted credentials       NetworkManager
                     ← result for this attempt + IP ←
```

**Validation status, 23 October 2026.** The current protocol has completed a real Wi-Fi setup from the macOS configurator to a Linux device. An earlier protocol also completed an iPhone-to-Ubuntu setup. The current iPhone build is installed; its hardware provisioning run after the identity update remains unverified. The 200-device UI runs against simulated sensors. This is not a validation of 200 physical devices.

## Start here

| Goal | Path |
| --- | --- |
| See the technician experience | [42-second demo video](assets/architecture/overall-200-sensors.mp4) — simulated sensors, no real Wi-Fi joins |
| Explore the UI on Ubuntu without hardware | [Local preview](#preview-without-hardware) |
| Reproduce a real Wi-Fi join | [Hardware and assumptions](#hardware-and-assumptions), then [Ubuntu setup](#prepare-the-ubuntu-device) |
| Check the four challenge constraints | [Evidence and limits](#evidence-and-limits) |
| Review channel choice, security and 200-device deployment | [Architecture](ARCHITECTURE.md#why-bluetooth-low-energy), [security](SECURITY.md), [200-device design](ARCHITECTURE.md#200-devices-in-a-hospital-wing) |

## Preview without hardware

Requires Node.js 22.18 or later. From a fresh checkout:

```sh
git clone https://github.com/NoeBrt/iot-provisioning.git
cd iot-provisioning/configurator
npm ci
npm run web
```

Open the local URL printed by Expo and append `?demo=1`, or tap the **provide.** logo to enter demo mode. Try **Set up all ready**, the error filter and **Retry failed**.

Demo mode uses 200 fake sensors with the real application handshake and certificate checks, under a separate demo authority. It sends nothing over Bluetooth and never joins Wi-Fi. A plain browser supports this preview only; real Bluetooth provisioning requires the native phone or desktop app.

## Hardware and assumptions

| Role | Requirements and validation |
| --- | --- |
| Linux device | Ubuntu, BlueZ, NetworkManager, a Bluetooth adapter supporting **BLE peripheral mode**, and a NetworkManager-managed Wi-Fi interface. Ubuntu 22.04.5 has been tested; Ubuntu 24.04 has not. |
| Configurator | An iPhone with a standalone native build installed before the visit, or a Mac with the Tauri app. Android and desktop Windows/Linux hardware runs are unverified. |
| Target Wi-Fi | WPA2-Personal, SSID and an 8–63 character passphrase. Enterprise/EAP Wi-Fi is outside the demo’s scope. |
| Administration | Ethernet or a local console is recommended: provisioning changes the device’s Wi-Fi connection and can disconnect an SSH session using it. |

Dependencies, authorities and apps are prepared before the visit. Those preparation steps can require internet. The provisioning exchange itself does not.

## Prepare the Ubuntu device

Run these commands from the repository root on a dedicated test device. The installer adds a system user, installs a service and NetworkManager permissions, restarts Bluetooth, and disables BlueZ’s battery plugin to avoid unwanted phone pairing requests.

### 1. Build and install

Install Rust 1.88.0 with rustup if it is not already available. The repository pins that toolchain in `rust-toolchain.toml`.

```sh
sudo apt update
sudo apt install build-essential pkg-config libdbus-1-dev bluez network-manager curl rfkill
curl --proto '=https' -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.88.0 --profile minimal
. "$HOME/.cargo/env"
cargo build --release --features ble,stage --locked
nmcli device status
rfkill list bluetooth
```

If Bluetooth is soft-blocked, run `sudo rfkill unblock bluetooth`. Replace `wlo1` below with the Wi-Fi interface reported by `nmcli`:

```sh
sudo device/systemd/install.sh wlo1
```

The service runs as `iot`. Its private state lives in `/var/lib/iot-device`, mode `0700`. It cannot accept provisioning until staged below.

### 2. Create your evaluation authorities

For a self-contained evaluation, generate new authorities in a private directory outside the checkout. In production these would be kept at the workshop, separate from deployed devices.

```sh
target/release/authority init ~/iot-evaluation-authority
target/release/authority public ~/iot-evaluation-authority
```

The output names two **public** keys. In `configurator/src/authority.ts`, replace both `DEVICE_AUTHORITY` and `TECHNICIAN_AUTHORITY` with these values **before building the configurator**. The first verifies devices; the second verifies imported technician codes. The checked-in public keys belong to the existing test deployment; its private keys are not included.

Never copy authority private keys into the app, the repository or evidence files.

### 3. Stage the device

```sh
sudo -u iot iot-stage init /var/lib/iot-device
```

Copy the device public key printed by this command, then run:

```sh
target/release/authority certify ~/iot-evaluation-authority <DEVICE_PUBLIC_KEY_HEX> DEMO
```

Copy the certificate hex and the technician authority public key from step 2:

```sh
sudo -u iot iot-stage install /var/lib/iot-device <CERTIFICATE_HEX> <TECHNICIAN_AUTHORITY_PUBLIC_KEY_HEX>
sudo systemctl restart iot-device
journalctl -u iot-device -n 20 --no-pager
```

Expected: a `IOT-XXXXXXXXXX` identifier and an advertising message. The identity is derived from the device key; app and device firmware must use the current manufacturer-data format. The app rejects older state-only advertisements with firmware-update guidance.

### 4. Issue a technician code

```sh
target/release/authority issue ~/iot-evaluation-authority "Evaluator" DEMO 1
```

This prints a QR code and a text code valid for one day, authorized for customer `DEMO`. The code contains a private holder key: treat it as a credential. Import it directly inside provide.; do not include it in screenshots or logs.

## Prepare the configurator

Build after setting both authority public keys above.

- **iPhone:** follow [Install on an iPhone from a Mac](../configurator/README.md#install-on-an-iphone-from-a-mac-free-apple-id). Use a **Release standalone build** with bundled JavaScript, so Metro and a shared network are unnecessary during the demo. Expo Go cannot run native Bluetooth provisioning.
- **macOS:** with Xcode command-line tools, Rust and Node installed, run the commands below. Grant Bluetooth access when prompted. The packaged application is under `configurator/desktop/src-tauri/target/release/bundle/`.

```sh
cd configurator
npm ci
npm run desktop:build
```

The device instructions target Ubuntu. The desktop configurator’s Linux and Windows builds have not been validated on hardware; use the iPhone or macOS path for the demonstrated real exchange.

On iPhone, the technician code and site credentials use native secure storage with authentication. The desktop implementation currently keeps them **in memory only**: closing the app loses them. Persistent desktop keychain storage is not implemented.

## Run a real provisioning session

1. Open provide. in normal mode; there must be no **DEMO** indicator. Keep Bluetooth enabled. To demonstrate independence from networking, turn off the configurator’s Wi-Fi and mobile data, and ensure the device is not already on the target network.
2. Add the technician code by scanning or pasting it inside the app.
3. Wait for the device’s `IOT-XXXXXXXXXX` identifier. **Test** exchanges `hello` / `world`; this checks Bluetooth only.
4. Tap **Set up**, enter the facility name, target SSID and password, and confirm.
5. Expect connecting → securing the channel → sending the network → joining Wi-Fi, then **Device connected** with the target SSID and the device’s new IPv4 address.

Check independently on the Linux device:

```sh
nmcli -f NAME,UUID,DEVICE connection show --active
journalctl -u iot-device -n 40 --no-pager
```

Expected: the `iot-provisioned` profile is active and the journal reports the provisioning attempt as connected. The service does not log Wi-Fi credentials. For a headless deployment, the systemd service starts automatically at boot.

A configured device offers **Reconfigure**. The implementation rolls back to the previous profile if a new network fails; the wrong-password, absent-network and rollback scenarios still need hardware validation.

## Evidence and limits

| Challenge constraint | Implementation and evidence | What this proves |
| --- | --- | --- |
| No internet or shared initial network | Local BLE GATT; [offline service check](../evidence/real/service-offline-hello.txt) | A phone with networking disabled exchanged hello over BLE. A complete offline encrypted provisioning run is still to be recorded. |
| Real Wi-Fi connection using received credentials | NetworkManager activation; [current protocol hardware run](../evidence/real/identity-advertisement.txt) | macOS app result and device journal report a connected attempt on real hardware. [Earlier iPhone run](../evidence/real/real-join.txt) used the previous protocol. |
| No plaintext credentials over the air | Noise XX; [security design and test locations](SECURITY.md); [earlier BLE capture summary](../evidence/real/real-join.txt) | Protocol checks cover encryption and authentication. The earlier capture checked SSID absence; it is not a fresh full capture of the current protocol checking both SSID and password. |
| Usable by a non-developer | Automatic discovery, one-device or batch setup, progress and actionable errors; [UI video](assets/architecture/overall-200-sensors.mp4) | Demonstrates the implemented technician flow with simulated devices. No independent facilities-team usability study has been run. |

Other unverified areas: 200 physical sensors, a new 200-sensor radio batch after the identity change, Android, desktop Windows/Linux runtime, and reboot recovery on hardware. Historical documents may describe older milestones; the dated evidence above states which protocol was exercised.

## Architecture and the 200-device case

BLE works before either side joins a network and is available on phones without adding a device access point. Its costs are radio range, discovery delays, MTU limits and a small number of concurrent links.

Each sensor proves a certified key during **Noise XX**. The configurator checks that key, the advertised identity and the customer before sending the technician token. The sensor verifies the token and holder key; only then are the SSID and password sent as encrypted transport messages. NetworkManager receives them through D-Bus. The app reports success from the result of that exact attempt.

For 200 sensors, the app queues work with up to six concurrent sessions, shows per-device progress and groups errors for retry. Device certificates remove the need to scan 200 individual labels. The demo and BLE simulator exercise this design; they do not establish real deployment capacity. A hospital rollout still needs measured controller limits and RF coverage, room-to-device mapping, multiple-operator coordination, revocation and per-device network credentials. Smith integration is outside this implementation.

Read the [channel trade-offs](ARCHITECTURE.md#why-bluetooth-low-energy), [credential protection](SECURITY.md) and [200-device discussion](ARCHITECTURE.md#200-devices-in-a-hospital-wing).

## Tests

Run the full device suite on Ubuntu; BlueZ/D-Bus dependencies and Linux host-audit fixtures are platform-specific:

```sh
cargo test --features ble,stage --all-targets --locked
cargo clippy --features ble,stage --all-targets --locked -- -D warnings
```

Run configurator checks with Node.js 22.18 or later:

```sh
cd configurator
npm ci
npm test
npm run typecheck
npm run lint
```

Tests cover Rust/TypeScript Noise interoperability, certificate and technician-token rejection, malformed messages, attempt handling and the simulated batch queue. They complement the hardware evidence; they do not replace it.

## Code map

| Path | Responsibility |
| --- | --- |
| `configurator/` | Technician UI, Noise initiator, authorization, batch queue; native and desktop platform adapters |
| `device/` | Linux BLE service, NetworkManager integration, staging and authority CLIs, systemd installation |
| `src/` | Rust protocol, Noise responder, certificates and simulation library |
| `tests/` | Rust integration tests and interoperability vectors |
| `lab/` | Real-BLE bench with simulated sensors and simulated Wi-Fi outcomes |
| `docs/` | Architecture, security, decisions, benchmarks and demonstration media |
| `evidence/` | Execution evidence and verification scripts, including historical runs |
| `docs/development/` | Development history and plans; optional background reading |
