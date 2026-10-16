# Teton Provisioning Challenge

Current phase: hardware feasibility audit. **No transport or Wi-Fi provisioning
flow has been implemented or demonstrated.**

The first milestone is a harmless local round trip: the device advertises,
the Ubuntu configurator discovers and connects, sends `hello`, and receives
a response. Reconnect, service restart, and reboot must then be verified.
Do not send credentials during this milestone.

## Observed environment

The development session exposes Ubuntu 22.04.5 LTS, Python 3.10.12,
BlueZ 5.64, and nmcli 1.36.6. Bluetooth `hci0` and Wi-Fi `wlo1` are visible
through sysfs. Access to host D-Bus and network sockets is restricted.
Jetson model, software versions, radio capabilities, and connectivity remain
unverified. See [the counter-review](docs/DECISIONS.md).

## Hardware audit

Run these read-only commands from a host terminal on **each machine**, labeling
which output belongs to the configurator and which belongs to the device:

```sh
uname -a
cat /etc/os-release
cat /etc/nv_tegra_release 2>/dev/null || true
cat /proc/device-tree/model 2>/dev/null || true
bluetoothd --version
bluetoothctl list
bluetoothctl show
rfkill list
systemctl status bluetooth --no-pager
nmcli general status
nmcli device status
ip link
busctl --system tree org.bluez
busctl --system tree org.freedesktop.NetworkManager
```

Using the adapter path returned above (often `/org/bluez/hci0`), inspect:

```sh
busctl --system introspect org.bluez /org/bluez/hci0 org.bluez.LEAdvertisingManager1
busctl --system introspect org.bluez /org/bluez/hci0 org.bluez.GattManager1
```

These checks identify APIs; they do not prove working advertising or GATT.
Next verify an actual device advertisement and a configurator BLE scan,
then implement the harmless round trip against the observed stack. Record
adapter paths, setup steps, failures, and repeated successes. Avoid capturing
nearby patients' or staff members' device identifiers in submission evidence.

## Milestone acceptance

- Device advertises a recognizable demo identity and service UUID.
- Configurator discovers, connects, sends `hello`, and receives a response.
- Disconnect/reconnect works without a manual Bluetooth reset.
- Device service restart and reboot restore the endpoint.
- Operation works with Internet disconnected and no shared LAN.
- Journal evidence shows outcomes without secrets or arbitrary payload logging.

The tested offline setup must include dependencies installed beforehand;
provisioning itself must not download packages or contact external services.
There are currently no application run commands or test suite.

## Next phases

After the first milestone passes, select authenticated credential protection,
integrate NetworkManager, test real Wi-Fi joining and failure paths, then add
technician UX and the scaling discussion. The full challenge is not complete.
