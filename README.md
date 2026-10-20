# IoT provisioning

A technician's phone gives a headless Ubuntu device its Wi-Fi credentials over Bluetooth Low Energy, with no
Internet and no shared network. The phone scans the QR label on the device, both sides run an authenticated
Noise handshake keyed by that label, and only then does the password travel, encrypted. The device joins the
network through NetworkManager and reports the IPv4 address it received for that attempt.

- **Why BLE, how credentials are protected, 200 devices:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), with
  diagrams, screens and a [33 s video](docs/architecture/demo-simulator.mp4).
- **Security design and tests:** [docs/SECURITY.md](docs/SECURITY.md).
- **Every decision and its alternatives:** [docs/DECISIONS.md](docs/DECISIONS.md).
- **Requirement-by-requirement status:** [tasks/compliance.md](tasks/compliance.md).

| Side | Code |
| --- | --- |
| Device service (Rust) | `device/main.rs` (BLE peripheral), `device/wifi.rs` (NetworkManager), `src/provision.rs` (Noise, protocol), `device/stage.rs` (label) |
| Configurator app **provide.** (Expo, React Native) | `configurator/` |

**Status.** The phone and the device exchange messages over real BLE, and the encrypted protocol passes its tests
on both sides. The full flow runs in the iOS Simulator against the device's own Noise transcript. A real Wi-Fi join
from the phone has **not** run yet: the test machine has no second network link, and joining its Wi-Fi would cut
the SSH session the test runs over. See [What is proven](docs/ARCHITECTURE.md#what-is-proven).

## Hardware and assumptions

| Role | Requirement | Tested with |
| --- | --- | --- |
| Device | Ubuntu 22.04 or 24.04, x86-64; one adapter with **BLE peripheral** support and one **Wi-Fi** interface managed by NetworkManager | Ubuntu 22.04.5, BlueZ 5.64, NetworkManager 1.36.6, MediaTek MT7921 (Wi-Fi + Bluetooth) |
| Device admin link | Ethernet or console if you administer over SSH: provisioning moves the Wi-Fi interface to the new network | none yet (see Status) |
| Target network | WPA2-Personal (SSID and passphrase, 8 to 63 characters). Enterprise Wi-Fi (EAP) is out of scope. | |
| Configurator | iPhone with the app installed beforehand; Android builds from the same code | iPhone 15 Pro, iOS 27.0; Android not run |
| Label | A way to print the device's QR label (any printer, or a screen) | 48 mm thermal sticker printer |

Ubuntu 24.04 is expected to work (the polkit rule for it is included) but has not been run.

## Set up the device (Ubuntu)

Prepare once, with Internet:

```sh
sudo apt install build-essential pkg-config libdbus-1-dev bluez network-manager curl
curl --proto '=https' -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.88.0 --profile minimal
. ~/.cargo/env
cargo build --release --features ble,stage --locked
```

Install the service, which starts at boot and needs no screen, keyboard or SSH afterwards:

```sh
rfkill list bluetooth                        # if "Soft blocked: yes": sudo rfkill unblock bluetooth
sudo device/systemd/install.sh wlo1          # your Wi-Fi interface (nmcli device); omit to use the first one
```

The script creates the system user `iot`, installs `iot-device` and `iot-stage` in `/usr/local/bin`, the
unit [`iot-device.service`](device/systemd/iot-device.service), and a polkit rule that lets `iot` manage its
own NetworkManager profile ([22.04](device/systemd/iot-device.pkla), [24.04](device/systemd/50-iot-device.rules)).

Stage the device once. This creates its key and label secret, checks them with a real handshake, and prints the
QR label:

```sh
sudo -u iot iot-stage /var/lib/iot-device
sudo systemctl restart iot-device
journalctl -u iot-device -f                # "IOT-DEMO-001 advertising on hci0; accepts hello and encrypted provisioning"
```

The label holds the device's secret. Print `/var/lib/iot-device/label.svg` (readable only by `iot` and root), stick it on
the device, and do not share a photo of it. Staging refuses to run twice, so a key is never replaced by accident.

## Set up the configurator (phone)

Install the app before the visit; it needs no network afterwards. Build and install steps for an iPhone, with a
free Apple ID from a Mac or with EAS, are in [configurator/README.md](configurator/README.md). Android uses the same
code through `npx expo run:android`; we have not run it on a device.

## Run the demo

1. Turn off Wi-Fi and mobile data on the phone if you want to show that no network is involved.
2. Open **provide.**. It scans by itself and lists `IOT-DEMO-001`.
3. Tap **Set up**. The first time, enter the site: a name, the Wi-Fi network and its password, typed or read
   from the network's standard Wi-Fi QR code (`WIFI:T:WPA;S:…;P:…;;`, as Android shares it). The password stays
   in the Keychain behind Face ID.
4. Scan the device's QR label. The card shows the steps: connecting, securing the channel, sending the network,
   joining the Wi-Fi.
5. Expect **Device connected** with the network name and the device's new IPv4 address.

On the device, check the result:

```sh
nmcli -f NAME,UUID,DEVICE connection show --active    # iot-provisioned, 4a7db77c-6fda-47aa-95ca-d186c5096b32
journalctl -u iot-device                            # "attempt <id> connected": no SSID, password or address
```

A wrong password, an absent network or a timeout shows an actionable message in the app, and the device deletes
the failed profile. After a success the device closes provisioning for good. To repeat the demo on the same
machine, remove the provisioned marker; at startup the service deletes its old profile:

```sh
sudo systemctl stop iot-device
sudo rm /var/lib/iot-device/provisioned
sudo systemctl start iot-device
```

Each sensor card also has **Test**, which writes `hello` and expects `world`: a radio check that carries no
credentials.

## Tests

```sh
cargo test --all-targets --locked                         # protocol and simulation, no Bluetooth: 40 tests
cargo test --features ble,stage --all-targets --locked    # adds the device, NetworkManager and Noise tests: 70 tests
cargo clippy --features ble,stage --all-targets --locked -- -D warnings
cd configurator && npm ci && npm test && npm run typecheck && npm run lint   # 29 tests
```

The Noise tests replay a transcript produced by the device's `snow` implementation against the phone's
JavaScript one, byte for byte (`tests/noise_vectors.rs`, `configurator/src/noise.test.ts`). The phone tests also
check that a device failing the handshake never receives the password (`configurator/src/setup.test.ts`).

Development tools, kept from the first milestone: a dependency-free simulation
(`cargo run --example simulation --locked`), benchmarks ([docs/BENCHMARKS.md](docs/BENCHMARKS.md)), and a
read-only host preflight (`cargo run --bin audit-host --locked`) that checks BlueZ, the adapter and
NetworkManager without changing anything.

## Evidence

| What | Where | Class |
| --- | --- | --- |
| iPhone to Ubuntu over real BLE: discovery, six exchanges, reconnect after a service restart | [demo/phone-hello.txt](demo/phone-hello.txt) | `ACTUAL_BLE` |
| Encrypted protocol, test-first trace | [demo/tdd-provision.txt](demo/tdd-provision.txt) | `COMMAND_FIXTURE` |
| Full technician flow, real app code, recorded device transcript, fake radio | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#the-technicians-flow) | `SIMULATION` |
| Real Wi-Fi join, BLE capture without credential bytes, Android | | `NOT_RUN` |

Earlier material: [solution report (PDF, French)](docs/rapport-solution.pdf) and the
[first interactive mockup](docs/architecture-demo.html); the step-by-step engineering log is in
[tasks/HANDOFF.md](tasks/HANDOFF.md).
