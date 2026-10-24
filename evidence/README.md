# Evidence

Use the [requirements map](../README.md#requirements-map) for the current requirement status. Evidence files retain their original contents and dates, including historical command paths. A test fixture or simulated Wi-Fi response is not a hardware connection.

## Real hardware

| File | Scope |
| --- | --- |
| [identity-advertisement.txt](real/identity-advertisement.txt) | 23 October 2026: current identity format, real macOS discovery and observed real Wi-Fi setup; app result and device journal agree. |
| [real-join.txt](real/real-join.txt) | Earlier iPhone-to-Ubuntu protocol: encrypted exchange, real join and SSID capture check. |
| [real-reconfigure.txt](real/real-reconfigure.txt) | Historical reconfiguration trace; read the recorded protocol context. |
| [phone-hello.txt](real/phone-hello.txt) | Real BLE hello/world and reconnection observations. |
| [service-offline-hello.txt](real/service-offline-hello.txt) | Offline phone-to-systemd hello; no full encrypted offline join claim. |
| Other files in [real/](real/) | Host environment and preflight observations, including blocked outcomes. |

## Simulation and software checks

- [simulation/](simulation/): simulation, controlled benchmarks and soak traces. They do not measure 200 physical sensors.
- [checks/](tests/): test-first traces, fixture results and verification reports. [Desktop playtest](tests/desktop/playtest.json) and [video checks](tests/demos/video-check.json) describe their environments.
- [tools/](../tools/): capture checks, benchmark harnesses, browser recording and media export tools. Run instructions for the recordings are in [the media notes](../docs/media/README.md).

The [videos and images](../docs/media/) live with documentation. Real credentials, authority private keys, device state and raw sensitive captures are excluded from Git; public interoperability fixtures are explicitly marked in source.
