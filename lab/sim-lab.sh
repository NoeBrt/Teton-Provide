#!/bin/sh
# Lends noe-lab's Bluetooth chip to the simulated fleet (lab/iot_sim.py, ~/noe-ws/lab-sensors), then gives it back
# to the real sensor, whatever happens.
#   ssh -t noe@noe-lab 'sudo sh ~/noe-ws/sim-lab.sh'      Ctrl-C stops the fleet; iot-device restarts by itself.
# The log (sensor IDs, attempt IDs, the technician's name and outcomes; never a key or a password) is
# ~/noe-ws/iot-sim/run.log. Use a throwaway site in the app (any 8-63 character password): the simulator never joins
# Wi-Fi, so no real password needs to reach this box.
set -u
SIM=/home/noe/noe-ws/iot-sim
restore() {
  trap - EXIT INT TERM
  echo "giving hci0 back to iot-device"
  systemctl start bluetooth iot-device
  sleep 2
  systemctl is-active iot-device
}
trap restore EXIT
trap 'exit 130' INT TERM
systemctl stop iot-device bluetooth   # iot-device requires bluetooth; the user channel needs bluetoothd gone
hciconfig hci0 down                     # and hci0 down, or the bind fails with EBUSY
"$SIM/.venv/bin/python" -I "$SIM/iot_sim.py" /home/noe/noe-ws/lab-sensors 2>&1 | tee "$SIM/run.log"
