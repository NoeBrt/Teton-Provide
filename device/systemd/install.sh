#!/bin/sh
# Installs the device service on Ubuntu. From the repository root, after
#   cargo build --release --features ble,stage --locked
# run: sudo device/systemd/install.sh [wifi-interface]
set -eu
cd "$(dirname "$0")/../.."
for binary in device stage; do
  [ -x "target/release/$binary" ] || { echo "target/release/$binary missing: build it first" >&2; exit 1; }
done

id teton >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin teton
install -m 755 target/release/device /usr/local/bin/teton-device
install -m 755 target/release/stage /usr/local/bin/teton-stage
install -m 644 device/systemd/teton-device.service /etc/systemd/system/
# Only one of these is read, depending on the polkit version.
install -d /etc/polkit-1/localauthority/50-local.d /etc/polkit-1/rules.d
install -m 644 device/systemd/teton-device.pkla /etc/polkit-1/localauthority/50-local.d/
install -m 644 device/systemd/50-teton-device.rules /etc/polkit-1/rules.d/
if [ -n "${1:-}" ]; then echo "TETON_WIFI_INTERFACE=$1" > /etc/default/teton-device; fi
install -d -o teton -g teton -m 700 /var/lib/teton-device

systemctl daemon-reload
systemctl enable --now teton-device
systemctl --no-pager --lines=5 status teton-device
