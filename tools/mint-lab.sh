#!/bin/sh
# Mints the lab fleet on noe-lab, as noe (no sudo): 200 sensor identities in ~/noe-ws/lab-sensors/NNN, certified by
# the real device authority for the lab customer LAB (194-196 for OTHER, to show "another customer"). Re-runnable: a
# key is never regenerated. Private keys stay in 0600 files; argv carries public keys and certificates only.
set -eu
umask 077
BIN=$HOME/noe-ws/iot-dev/target/release
AUTHORITY=$HOME/noe-ws/iot-authority
OUT=$HOME/noe-ws/lab-sensors
mkdir -p "$OUT"
technician=$("$BIN/iot-workshop" public "$AUTHORITY" | sed -n 's/^technician authority.*: //p')
[ -n "$technician" ]
for i in $(seq -w 1 200); do
  d=$OUT/$i
  [ -f "$d/certificate" ] && continue
  [ -f "$d/identity" ] || "$BIN/stage" init "$d" >/dev/null
  case $i in 194|195|196) customer=OTHER ;; *) customer=LAB ;; esac
  pub=$(head -c 64 "$d/identity" | tail -c 32 | od -An -v -tx1 | tr -d ' \n')  # 64- or legacy 96-byte file
  cert=$("$BIN/iot-workshop" certify "$AUTHORITY" "$pub" "$customer" | tail -1)
  [ -n "$cert" ]
  "$BIN/stage" install "$d" "$cert" "$technician" >/dev/null
done
