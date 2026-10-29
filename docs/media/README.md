# README demo media

The root README presents the original [mobile overview](overall-200-sensors.mp4) and [desktop overview](desktop-200-sensors.mp4), followed by five short pointer tutorials for each layout.

| Tutorial | Mobile | Desktop |
| --- | --- | --- |
| Technician code | [MP4](mobile-technician-code.mp4) | [MP4](desktop-technician-code.mp4) |
| Site Wi-Fi | [MP4](mobile-site-wifi.mp4) | [MP4](desktop-site-wifi.mp4) |
| Open and test a sensor | [MP4](mobile-sensor-test.mp4) | [MP4](desktop-sensor-test.mp4) |
| Individual setup | [MP4](mobile-sensor-setup.mp4) | [MP4](desktop-sensor-setup.mp4) |
| Configure all, errors and retry | [MP4](mobile-configure-all.mp4) | [MP4](desktop-configure-all.mp4) |

Tutorials retain the source resolution (390 × 844 mobile, 1280 × 800 desktop), 25 fps, full colour and a visible pointer with a blue click highlight. They are encoded as H.264 MP4, CRF 18, with fast-start metadata. No upscaling or generated intermediate frames are used. Only the middle of the batch tutorial is accelerated, at 4×.

The original mobile overview remains unchanged (600 × 1304, approximately 41 seconds). The desktop overview is approximately 25 seconds, 1440 × 900, accelerated 2×.

## What is real and what is simulated

The forms and provisioning UI are the application's existing components. Recordings run in isolated Chromium browser contexts, including the mobile layout; they do not exercise native iOS or Tauri Bluetooth.

For the technician-code setup scene, the browser intercepts its own local development bundle and replaces only the technician authority public key with the public interoperability-test authority from `configurator/src/noise-vectors.json`. The code from that same fixture passes the application's signature, holder and expiry checks. Validation is not bypassed. No product source, deployed authority or real credential is changed. The Wi-Fi values are fictitious.

After the setup scenes, the recording navigates into the app's existing demo mode. That remounts the app with its separate demo authority, code and in-memory site. The forms' saved state is not transferred to the demo. The 200 sensors use the real application Noise and certificate-checking code with simulated radio and Wi-Fi outcomes.

## Reproduce

With Metro running on `http://localhost:8081`, use an existing Playwright installation:

```sh
node tools/record-demos.mjs <PLAYWRIGHT_MODULE_PATH> [CHROMIUM_EXECUTABLE]
python3 tools/build-tutorials.py
```

The script asserts successful code import, site save, hello/world test, individual connection result, batch and retry completion, and absence of page errors and horizontal document overflow. Raw recordings and stage screenshots stay under `/private/tmp/sensor-gif-*`; capture timings and the local render report support visual review. Public test credentials are safe for documentation and are not valid for the deployed authority.

## Render verification

The current MP4 clips were decoded and checked for dimensions, frame rate, duration, file size and fast-start metadata. Opening frames and action/result frames were inspected in a browser video player. The README’s linked overview previews and tutorial links were checked at 390 px and 1440 px. See [render checks](../../evidence/tests/demos/render-check.json) and [video checks](../../evidence/tests/demos/video-check.json). This is a local preview, not a published GitHub rendering.

