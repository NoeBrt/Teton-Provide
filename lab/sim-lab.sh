#!/bin/sh
# Lends noe-lab's Bluetooth chip to the simulated fleet (lab/teton_sim.py, ~/noe-ws/lab-sensors), then gives it back
# to the real sensor, whatever happens.
#   ssh -t noe@noe-lab 'sudo sh ~/noe-ws/sim-lab.sh'      Ctrl-C stops the fleet; teton-device restarts by itself.
# The log (sensor IDs, attempt IDs, the technician's name and outcomes; never a key or a password) is
# ~/noe-ws/teton-sim/run.log. Use a throwaway site in the app (any 8-63 character password): the simulator never joins
# Wi-Fi, so no real password needs to reach this box.
set -u
SIM=/home/noe/noe-ws/teton-sim
restore() {
  trap - EXIT INT TERM
  echo "giving hci0 back to teton-device"
  systemctl start bluetooth teton-device
  sleep 2
  systemctl is-active teton-device
}
trap restore EXIT
trap 'exit 130' INT TERM
systemctl stop teton-device bluetooth   # teton-device requires bluetooth; the user channel needs bluetoothd gone
hciconfig hci0 down                     # and hci0 down, or the bind fails with EBUSY
"$SIM/.venv/bin/python" -I "$SIM/teton_sim.py" /home/noe/noe-ws/lab-sensors 2>&1 | tee "$SIM/run.log"
