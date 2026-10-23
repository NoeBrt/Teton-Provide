#!/bin/sh
# Installs the device service on Ubuntu. From device/, after
#   cargo build --release --features ble,stage --locked
# run: sudo systemd/install.sh [wifi-interface]
set -eu
cd "$(dirname "$0")/.."
for binary in device stage; do
  [ -x "target/release/$binary" ] || { echo "target/release/$binary missing: build it first" >&2; exit 1; }
done

id iot >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin iot
install -m 755 target/release/device /usr/local/bin/iot-device
install -m 755 target/release/stage /usr/local/bin/iot-stage
install -m 644 systemd/iot-device.service /etc/systemd/system/
# Only one of these is read, depending on the polkit version.
install -d /etc/polkit-1/localauthority/50-local.d /etc/polkit-1/rules.d
install -m 644 systemd/iot-device.pkla /etc/polkit-1/localauthority/50-local.d/
install -m 644 systemd/50-iot-device.rules /etc/polkit-1/rules.d/
if [ -n "${1:-}" ]; then echo "IOT_WIFI_INTERFACE=$1" > /etc/default/iot-device; fi
# A IoT device is a BLE peripheral only. BlueZ's battery plugin reads the battery level of each connected phone;
# iOS requires an encrypted link for it, so BlueZ asks the phone to pair, pairing fails, and BlueZ stops answering
# the phone's reads until it disconnects (seen in a btmon capture of a real setup). Run bluetoothd without it.
bluetoothd=$(ls /usr/libexec/bluetooth/bluetoothd /usr/lib/bluetooth/bluetoothd 2>/dev/null | head -n 1)
install -d /etc/systemd/system/bluetooth.service.d
printf '[Service]\nExecStart=\nExecStart=%s --noplugin=battery\n' "$bluetoothd" > /etc/systemd/system/bluetooth.service.d/iot-device.conf
install -d -o iot -g iot -m 700 /var/lib/iot-device

systemctl daemon-reload
systemctl restart bluetooth
systemctl enable iot-device
systemctl restart iot-device   # also picks up a new binary on reinstall
systemctl --no-pager --lines=5 status iot-device
