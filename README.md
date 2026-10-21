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
The current protocol (certificates, technician codes, batch of 200) passes its tests on both sides. The app runs it
in its own demo mode (200 simulated sensors, no radio) and over real Bluetooth against a test bench on noe-lab that
shows 200 simulated sensors; its run with real sensors is pending. Not run yet: wrong-password and
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

Issue a technician code (valid 30 days by default and at most, for one or more customers) and give it to the
technician only, printed or over a channel you trust; it is a credential:

```sh
target/release/authority issue ~/teton-authority "Noé" DEMO 30      # prints a QR code and the code <token hex>.<holder key hex>
```

The code has no link: the technician scans it, or pastes it, inside the app.

## Set up the configurator (phone)

Install the app before the visit; it needs no network afterwards. Build and install steps for an iPhone, with a
free Apple ID from a Mac or with EAS, are in [configurator/README.md](configurator/README.md). Android uses the same
code through `npx expo run:android`; we have not run it on a device.

## Run the demo

1. Open **provide.**, tap **Technician code › Add** (or **Set up**, which asks for the code first) and scan the QR
   code `authority issue` printed with the app's camera, or paste the code. The app checks it and keeps it behind
   Face ID.
2. Turn off Wi-Fi and mobile data on the phone if you want to show that no network is involved.
3. **provide.** scans by itself and lists each sensor by ID with its state (ready, online…).
4. Tap **Set up all ready (N)**, or **Set up** on one card. The first time, enter the site: a name, the Wi-Fi
   network and its password, typed or read from the network's standard Wi-Fi QR code (`WIFI:T:WPA;S:…;P:…;;`, as
   Android shares it). The password stays in the Keychain behind Face ID. Once unlocked, the code and the password
   stay in memory; back in the app after more than 2 minutes away, Face ID asks again.
5. Each card shows the steps: connecting, securing the channel, sending the network, joining the Wi-Fi. Expect
   **Device connected** with the network name and the sensor's new IPv4 address; a failed card says why.
6. With more than four sensors in range, each sensor becomes a one-line row (its group's shape, one status line,
   its signal); a tap opens it in place into the full card, a second tap folds it. A card above the list reads
   "N set up of M in range", with the batch's progress and the time left. Its tabs **Set up**, **Errors** and
   **Not set up** show only that group; tap the tab again for all. **Not set up** puts the sensors being set up in
   an **IN PROGRESS** block on top; **Errors** groups the failures by cause. Sensors found during a batch join it
   with **Add N to the batch**; **Retry failed** sets up the failed ones again. The refresh icon beside the list
   header drops the sensors not heard for 15 s.

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

### Demo mode, without sensors

Tap the **provide.** logo and confirm: the app swaps the radio for 200 simulated sensors and the chip reads **DEMO**.
Each one runs the sensor side of Noise `XX` with a certificate from a demo authority, so the app runs its real
handshake, checks and encryption. Among them: sensors set up before, not prepared, out of Wi-Fi range, impostors and
another customer's. The demo uses its own code and site, in memory; it reads and writes nothing saved and sends
nothing over Bluetooth. Tap the logo or the chip to leave. In the iOS Simulator,
`xcrun simctl launch booted dev.tetonchallenge.configurator -demo 1` opens the app in demo mode.

### Test bench: 200 simulated sensors over real Bluetooth

`lab/` holds a bench for noe-lab, kept out of the app. `teton_sim.py` (Bumble, Python) takes `hci0` through the HCI
user channel and advertises 200 sensors in turn over the advertising sets the controller enables at once, keeping 6
free for the phone's links (the MT7921 reports 20 sets and enabled 16). Each sensor answers GATT and Noise like the
device service, byte for byte, and simulates its Wi-Fi join: most join in 5.5 s; some are slow, out of range, busy,
time out, are online or offline, or are clones (a copied certificate without its key). The password
`wrong-password` makes every join fail with a refused password.

```sh
sh lab/mint-lab.sh           # on noe-lab, as noe: 200 identities, keys 0600, customer LAB (194-196: OTHER)
sudo sh ~/noe-ws/sim-lab.sh  # copy of lab/sim-lab.sh: stops teton-device and bluetooth, gives hci0 back on exit
.venv/bin/python teton_sim.py --selftest noise-vectors.json  # in ~/noe-ws/teton-sim, a copy of the phone's vectors
```

`mint-lab.sh` uses the `stage` and `authority` binaries in `~/noe-ws/teton-dev/target/release` and the authorities in
`~/noe-ws/teton-authority`; `sim-lab.sh` expects `teton_sim.py` and a virtual environment with Bumble in
`~/noe-ws/teton-sim`. The identities are certified by the real device authority, so the phone needs a technician code
that covers `LAB`. Use a throwaway site: the bench never joins Wi-Fi, but it receives the password.

## Tests

```sh
cargo test --all-targets --locked                         # protocol and simulation, no Bluetooth: 40 tests
cargo test --features ble,stage --all-targets --locked    # adds the device, NetworkManager, Noise and authority tests: 88 tests
cargo clippy --features ble,stage --all-targets --locked -- -D warnings
cd configurator && npm ci && npm test && npm run typecheck && npm run lint   # 68 tests
```

The Noise tests replay a transcript produced by the device's `snow` implementation against the phone's
JavaScript one, byte for byte, with the certificate and the technician code (`tests/noise_vectors.rs`,
`configurator/src/noise.test.ts`). The phone tests also check that a sensor failing the certificate checks never
receives the code or the password (`configurator/src/setup.test.ts`), run 200 fake sensors through the batch
(`configurator/src/batch.test.ts`), and check that demo sensors are refused under the real device authority
(`configurator/src/demo.test.ts`).

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
| 200 sensors in demo mode: overall card, compact rows, batch with sensors added, tabs | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#the-technicians-flow), [42 s video](docs/architecture/overall-200-sensors.mp4) | `SIMULATION` |
| iPhone to 200 simulated sensors over real BLE (test bench): 84 provisioning sessions and 79 simulated joins in one run | `lab/`; run log on noe-lab, not in the repository | `ACTUAL_BLE` |
| Real setup from the iPhone (first protocol): encrypted exchange, Wi-Fi join, Device connected; capture without the SSID | [demo/real-join.txt](demo/real-join.txt) | `ACTUAL` |
| Offline hello against the systemd service | [demo/service-offline-hello.txt](demo/service-offline-hello.txt) | `ACTUAL_BLE` |
| Current protocol on hardware; wrong password, absent network and rollback on hardware; the overall, six links and scanning during runs with many real sensors; reboot; Android | | `NOT_RUN` |

Earlier material: [solution report (PDF, French)](docs/rapport-solution.pdf) and the
[first interactive mockup](docs/architecture-demo.html); the step-by-step engineering log is in
[tasks/HANDOFF.md](tasks/HANDOFF.md).
