# Teton provisioning

A technician's phone gives headless Ubuntu devices their Wi-Fi credentials over Bluetooth Low Energy, with no
Internet and no shared network, one sensor or every ready sensor in range at once. In a Noise `XX` handshake each
sensor proves it is a genuine Teton sensor with a certificate Teton signed for its key, and the phone proves its
technician holds a code Teton issued; only then does the password travel, encrypted. The device joins the network
through NetworkManager and reports the IPv4 address it received for that attempt.

- **Why BLE, how credentials are protected, 200 devices:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), with
  diagrams, screens and a [55 s video](docs/architecture/demo-simulator.mp4) with 20 sensors.
- **Security design and tests:** [docs/SECURITY.md](docs/SECURITY.md).
- **Every decision and its alternatives:** [docs/DECISIONS.md](docs/DECISIONS.md).
- **Requirement-by-requirement status:** [tasks/compliance.md](tasks/compliance.md).

| Side | Code |
| --- | --- |
| Device service (Rust) | `device/main.rs` (BLE peripheral), `device/wifi.rs` (NetworkManager), `src/provision.rs` (Noise, protocol), `src/authority.rs` (certificates, technician codes), `device/stage.rs` (staging) |
| Teton's authority tool (Rust) | `device/authority.rs`: certifies sensors, issues technician codes |
| Configurator app **provide.** (Expo, React Native) | `configurator/` |

**Status.** With the first protocol (a QR label per sensor), an iPhone set up the Wi-Fi of the Ubuntu device end to
end on real hardware: encrypted BLE exchange, NetworkManager join, **Device connected** with the address
([demo/real-join.txt](demo/real-join.txt)); a `btmon` capture shows the credentials only inside an encrypted write.
The current protocol (certificates, technician codes, batch of 200) passes its tests on both sides and runs in the
iOS Simulator against 20 fake sensors; its real-hardware run is pending. Not run yet: wrong-password and
absent-network cases on hardware, a reboot test, Android. See [What is proven](docs/ARCHITECTURE.md#what-is-proven).

## Hardware and assumptions

| Role | Requirement | Tested with |
| --- | --- | --- |
| Device | Ubuntu 22.04 or 24.04, x86-64; one adapter with **BLE peripheral** support and one **Wi-Fi** interface managed by NetworkManager | Ubuntu 22.04.5, BlueZ 5.64, NetworkManager 1.36.6, MediaTek MT7921 (Wi-Fi + Bluetooth) |
| Device admin link | Ethernet or console if you administer over SSH: provisioning moves the Wi-Fi interface to the new network | Ethernet (`eno1`) |
| Target network | WPA2-Personal (SSID and passphrase, 8 to 63 characters). Enterprise Wi-Fi (EAP) is out of scope. | |
| Configurator | iPhone with the app installed beforehand; Android builds from the same code | iPhone 15 Pro, iOS 27.0; Android not run |

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

The script creates the system user `teton`, installs `teton-device` and `teton-stage` in `/usr/local/bin`, the
unit [`teton-device.service`](device/systemd/teton-device.service), and a polkit rule that lets `teton` manage its
own NetworkManager profile ([22.04](device/systemd/teton-device.pkla), [24.04](device/systemd/50-teton-device.rules)).

Teton's authorities, once, on a machine you keep offline (the demo used noe-lab, outside the repository). The private
keys are written 0600 and never leave that directory:

```sh
target/release/authority init ~/teton-authority      # prints both public keys
```

The device authority's public key goes into the app (`DEVICE_AUTHORITY` in `configurator/src/authority.ts`); the
technician authority's goes onto each sensor below.

Stage each sensor once. `stage init` creates its key and prints its public key; the workshop certifies that key for
one customer; `stage install` stores the certificate and the technician authority's public key:

```sh
sudo -u teton teton-stage init /var/lib/teton-device             # "TETON-XXXXXXXXXX keyed …", then the public key
target/release/authority certify ~/teton-authority <public key> DEMO     # prints the certificate (hex)
target/release/authority public ~/teton-authority                        # the technician authority's key
sudo -u teton teton-stage install /var/lib/teton-device <certificate> <technician authority key>
sudo systemctl restart teton-device
journalctl -u teton-device -f      # "TETON-XXXXXXXXXX advertising on hci0; accepts hello and encrypted provisioning"
```

Nothing on these command lines is secret. A key is never regenerated; `stage install` refuses a certificate for
another key.

Issue a technician code (valid 30 days by default, for one or more customers) and send its link to the technician
over a channel you trust; it is a credential:

```sh
target/release/authority issue ~/teton-authority "Noé" DEMO 30      # prints a QR code and provide://technician/<hex>
```

## Set up the configurator (phone)

Install the app before the visit; it needs no network afterwards. Build and install steps for an iPhone, with a
free Apple ID from a Mac or with EAS, are in [configurator/README.md](configurator/README.md). Android uses the same
code through `npx expo run:android`; we have not run it on a device.

## Run the demo

1. On the phone, open the technician code link (or scan its QR code from **Technician code › Add**). The app checks
   it and keeps it behind Face ID.
2. Turn off Wi-Fi and mobile data on the phone if you want to show that no network is involved.
3. Open **provide.**. It scans by itself and lists each sensor by ID with its state (ready, online…).
4. Tap **Set up all ready (N)**, or **Set up** on one card. The first time, enter the site: a name, the Wi-Fi
   network and its password, typed or read from the network's standard Wi-Fi QR code (`WIFI:T:WPA;S:…;P:…;;`, as
   Android shares it). The password stays in the Keychain behind Face ID.
5. Each card shows the steps: connecting, securing the channel, sending the network, joining the Wi-Fi. Expect
   **Device connected** with the network name and the sensor's new IPv4 address; the counters and filters show
   what is done, what failed and why.

On the device, check the result:

```sh
nmcli -f NAME,UUID,DEVICE connection show --active    # teton-provisioned, one of the two fixed profile UUIDs
journalctl -u teton-device                            # "attempt <id> connected": no SSID, password or address
```

A wrong password, an absent network or a timeout shows an actionable message in the app; the device deletes the
failed profile and goes back to its previous network, if it had one. A set-up sensor shows **Reconfigure**: any
phone with a valid code can give it a new network. To return the machine to **ready**, remove the record of its
working profile; at startup the service deletes the old profile:

```sh
sudo systemctl stop teton-device
sudo rm /var/lib/teton-device/provisioned
sudo systemctl start teton-device
```

Each sensor card also has **Test**, which writes `hello` and expects `world`: a radio check that carries no
credentials.

## Tests

```sh
cargo test --all-targets --locked                         # protocol and simulation, no Bluetooth: 40 tests
cargo test --features ble,stage --all-targets --locked    # adds the device, NetworkManager, Noise and authority tests: 80 tests
cargo clippy --features ble,stage --all-targets --locked -- -D warnings
cd configurator && npm ci && npm test && npm run typecheck && npm run lint   # 48 tests
```

The Noise tests replay a transcript produced by the device's `snow` implementation against the phone's
JavaScript one, byte for byte, with the certificate and the technician code (`tests/noise_vectors.rs`,
`configurator/src/noise.test.ts`). The phone tests also check that a sensor failing the certificate checks never
receives the code or the password (`configurator/src/setup.test.ts`), and run 200 fake sensors through the batch
(`configurator/src/batch.test.ts`).

Development tools, kept from the first milestone: a dependency-free simulation
(`cargo run --example simulation --locked`), benchmarks ([docs/BENCHMARKS.md](docs/BENCHMARKS.md)), and a
read-only host preflight (`cargo run --bin audit-host --locked`) that checks BlueZ, the adapter and
NetworkManager without changing anything.

## Evidence

| What | Where | Class |
| --- | --- | --- |
| iPhone to Ubuntu over real BLE: discovery, six exchanges, reconnect after a service restart | [demo/phone-hello.txt](demo/phone-hello.txt) | `ACTUAL_BLE` |
| Encrypted protocol, test-first trace | [demo/tdd-provision.txt](demo/tdd-provision.txt) | `COMMAND_FIXTURE` |
| Technician flow with 20 sensors, real app code against fake Noise responders, fake radio | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#the-technicians-flow) | `SIMULATION` |
| Real setup from the iPhone (first protocol): encrypted exchange, Wi-Fi join, Device connected; capture without the SSID | [demo/real-join.txt](demo/real-join.txt) | `ACTUAL` |
| Offline hello against the systemd service | [demo/service-offline-hello.txt](demo/service-offline-hello.txt) | `ACTUAL_BLE` |
| Current protocol on hardware; wrong password, absent network and rollback on hardware; reboot; Android | | `NOT_RUN` |

Earlier material: [solution report (PDF, French)](docs/rapport-solution.pdf) and the
[first interactive mockup](docs/architecture-demo.html); the step-by-step engineering log is in
[tasks/HANDOFF.md](tasks/HANDOFF.md).
