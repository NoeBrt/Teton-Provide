# Real: Provide. menu-bar panel on macOS

Observed on 24 October 2026, macOS 26.6.2, Apple Silicon, locally built Provide. with Tauri 2.12.5.

- **Window → Nearby Sensors** opened the native panel. The panel showed the same two Bluetooth sensors as the main
  window: `SENSOR-6B1E844588` and `SENSOR-4FF546816F`.
- The installed panel displayed **“world” received** for both sensors after interactive hello tests. These were real
  Bluetooth exchanges, not simulated sensors. No Wi-Fi setup was run as part of this verification.
- Refresh completed with **List updated** in the panel.
- Native Liquid Glass and rounded corners were visible in the installed app. The panel grew from 380 × 290 logical
  points while empty to 380 × 338 for two sensors; the captured two-sensor window was 760 × 676 pixels at 2×.

The 200-sensor browser check in `configurator/desktop/menu-bar-check.mjs` is a separate **simulation**. The popover
fallback on macOS 14–25 was not checked on hardware.
