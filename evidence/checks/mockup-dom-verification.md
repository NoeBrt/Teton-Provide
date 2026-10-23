# Interactive architecture mockup — DOM verification

Date: 2026-10-17. Target: `docs/development/archive/architecture-demo.html`.

SHA-256 of the tested file:
`b8a0276825c5b0fc9bd2718cebc80f0fd482766780ce30ea9e5abbbb6011e801`.

## Method

Node 20.18.0 and jsdom 24.1.3 executed the file's actual inline JavaScript against
its parsed DOM. jsdom and 62 transitive packages were extracted from existing npm
cache tarballs into `/tmp/teton-jsdom-review/`; no repository dependencies or source
files were changed. No install scripts were run during extraction.

Harness command:

```sh
node /tmp/teton-jsdom-review/full-check.cjs
```

The harness uses native DOM `.click()` and dispatched input/change events.
Timers are controlled deterministically so every progress callback and cancellation
can be checked. A custom resource loader and blocked fetch/XHR record attempted
external requests. All entered credentials are fixed fictitious test values.

## Results

All 12 scenario groups passed:

- Success, incorrect password, missing network, disconnect, and rejected identity.
- Retry after each recoverable error; replacement selection after identity failure.
- Reset, scenario change, and cancel during progress remove pending timers.
- SSID containing an HTML image/event-handler string remains literal text.
- Password is empty immediately after submission and remains empty on retry.
- Show/hide password and phone/desktop preview controls update their DOM states.
- Whitespace-only SSID validation no longer persists after reset.

The last check first reproduced a defect: `Hotspot-Demo` remained invalid after
reset because custom validity was retained. After `reset()` cleared custom
validity, the same scenario passed.

Observed DOM errors: **0**. Attempted external resource/fetch/XHR requests: **0**.
Pending timers at the end: **0**.

## Limits

This verifies the mockup's DOM behavior, not browser rendering. Chrome could not
start in the restricted runtime; Firefox's snap runtime was also unavailable.
Layout, small-screen overflow, screenshots, actual browser constraint-validation
UX, CSP enforcement, and assistive-technology behavior remain unverified.
jsdom timers were controlled; the visual 800 ms pacing was not timed.

This page has no BLE or network implementation. These results provide no evidence
of device authentication, encrypted transport, provisioning, or real Wi-Fi access.
