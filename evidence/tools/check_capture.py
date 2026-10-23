"""Checks a btmon capture of a real setup for plaintext credentials (constraint 3).

Usage, on the device after `sudo btmon -w /tmp/provision.snoop` ran during a Set up:
    python3 evidence/tools/check_capture.py /tmp/provision.snoop

Asks for the SSID and password without echo (never in argv or shell history), then reports:
- how many ATT write requests the capture holds, so an empty capture cannot pass for a clean one;
- whether the SSID or the password bytes appear anywhere in the raw capture.
Prints no secret.
"""
import getpass
import re
import subprocess
import sys

path = sys.argv[1]
raw = open(path, "rb").read()
decoded = subprocess.run(["btmon", "-r", path], capture_output=True, text=True, errors="replace").stdout
writes = [int(n) for n in re.findall(r"ATT: Write Request \(0x12\) len (\d+)", decoded)]

ssid = input("SSID sent during the setup: ").encode()
password = getpass.getpass("Wi-Fi password (not shown): ").encode()

print(f"capture: {len(raw)} bytes, {len(writes)} ATT write requests, largest {max(writes, default=0)} bytes")
print(f"SSID bytes in capture:     {'FOUND' if ssid and ssid in raw else 'not found'}")
print(f"password bytes in capture: {'FOUND' if password and password in raw else 'not found'}")
sys.exit(1 if (ssid and ssid in raw) or (password and password in raw) or not writes else 0)
