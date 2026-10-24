Provide. sets up Teton sensors' Wi-Fi over Bluetooth, from a phone or a computer, with no internet.

| File | Platform | Tested on hardware |
| --- | --- | --- |
| `Provide-*-android.apk` | Android 8 and later | No |
| `Provide-*-macos-arm64.dmg` | macOS on Apple silicon | Yes |
| `Provide-*-windows-x64-setup.exe` | Windows 10 and 11, x64 | No |
| `Provide-*-linux-x64.AppImage`, `.deb` | Ubuntu 22.04 and later, x64 (BlueZ) | No |

The iPhone app is not here: it installs from Xcode (see the README).

**These builds are unsigned.** Your system warns before the first launch:

- **macOS:** open the DMG, drag Provide. to Applications, then right-click it and choose Open.
- **Windows:** on the SmartScreen warning, choose More info, then Run anyway.
- **Linux:** make the AppImage executable (`chmod +x`) and run it, or install the deb with `sudo apt install ./Provide-*.deb`.
- **Android:** allow installs from your browser or file manager, then open the APK. On first launch, allow Nearby
  devices (Bluetooth).

**Which sensors it accepts.** The apps carry the public keys of the authority that built this release. They set up
sensors that authority certified, with a technician code it issued. To try Provide. with no sensor, tap the
`provide.` logo: the demo runs 200 simulated sensors.
