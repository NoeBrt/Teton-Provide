#!/bin/sh
# Lends noe-lab's Bluetooth chip to the simulated fleet (tools/sensor_sim.py, ~/noe-ws/lab-sensors), then gives it back
# to the real sensor, whatever happens.
#   ssh -t noe@noe-lab 'sudo sh ~/noe-ws/sim-lab.sh'      Ctrl-C stops the fleet; sensor-device restarts by itself.
# The log (sensor IDs, attempt IDs, the technician's name and outcomes; never a key or a password) is
# ~/noe-ws/sensor-sim/run.log. Use a throwaway site in the app (any 8-63 character password): the simulator never joins
# Wi-Fi, so no real password needs to reach this box.
set -u
SIM=/home/noe/noe-ws/sensor-sim
restore() {
  trap - EXIT INT TERM
  echo "giving hci0 back to sensor-device"
  systemctl start bluetooth sensor-device
  sleep 2
  systemctl is-active sensor-device
}
trap restore EXIT
trap 'exit 130' INT TERM
systemctl stop sensor-device bluetooth   # sensor-device requires bluetooth; the user channel needs bluetoothd gone
hciconfig hci0 down                     # and hci0 down, or the bind fails with EBUSY
"$SIM/.venv/bin/python" -I "$SIM/sensor_sim.py" /home/noe/noe-ws/lab-sensors 2>&1 | tee "$SIM/run.log"
