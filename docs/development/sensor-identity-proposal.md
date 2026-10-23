# Sensor identity: resumed Claude investigation, 2026-10-23

Status: APPROVED for implementation and deployment by the user on 2026-10-23
(“je confirmee, deploie”). This reverses the earlier five-byte advertisement decision.
Implementation/deployment results are recorded separately in HANDOFF.

## Evidence and limits

Recovered nine completed Claude workflow results from run
`wf_d1068f0e-be1`; the wire-verification task failed at the Claude usage limit.
These reports are prior-session evidence, not fresh hardware measurements.

The current code independently confirms the failure path:

- `device/main.rs::advertisement` publishes only the state in manufacturer data;
  the identity is in `local_name`.
- `App.tsx` chooses `advertising.localName ?? sensor.name` both for setup and,
  with an unnamed fallback, for display and saved-site lookup.
- `setup.ts` compares that name with the certified identity before sending the
  technician token. A stale OS name therefore rejects a genuine sensor.
- `keepAdvertised` remembers a scan-response name only for the current process.
  Restarting the app loses that workaround.

Fresh deterministic replay on the actual `setup()` implementation, using the
existing Noise transcript: `FLWR-O-019` produces `not-genuine` with exactly one
write (handshake message 1); the transcript's certified ID succeeds. No radio
or system configuration was touched. This verifies the application failure path,
not the cause of missing over-the-air scan responses.

Apple explicitly says active scanning may not always occur in its
[Accessory Design Guidelines, §11.4](https://www.bluetooth.com/wp-content/uploads/attachments/BluetoothDesignGuidelines.pdf).
The installed btleplug 0.13.5 source confirms separate advertised and cached
names. The exact reason scan responses vanished on the Jetson/Mac pair remains
unproven; neither an Apple cache-refresh guarantee nor a particular kernel bug
should be presented as established.

## Proposed correction

Use the existing manufacturer record `0xFFFF`: `[state][five identity bytes]`,
where the five bytes are SHA-256(device public key)[0..5]. Render them as the
existing uppercase `TETON-` identity. Keep state at offset zero.

Use one shared parser for display, saved-site lookup and setup. Setup accepts
advertising data rather than a name string and derives the claimed identity
itself. No system-name or scan-response fallback identifies a sensor. Names can
remain available for diagnostics without being trusted by these paths.

The authority signature, Noise proven-key comparison, certified-ID comparison
and customer check remain mandatory before message 3. Advertisement data is
untrusted; moving it does not authenticate it. Missing/malformed identity fails
closed. Old one-byte firmware must get actionable update guidance rather than
an endless suggestion to wait for a name.

Legacy packet budget: flags 3 + service UUID 18 + manufacturer record
(length/type 2 + company 2 + state 1 + identity 5) = **31 bytes**. No spare byte.
Keep legacy advertising, existing default intervals and the UUID service filter.

## Scope

- Rust: identity-byte derivation in `src/authority.rs`; manufacturer payload and
  budget test in `src/protocol.rs` (runs without Linux BLE); firmware advertisement
  and its configuration tests in `device/main.rs`.
- Shared app: `probe.ts` parser/label/change detection/merge; `setup.ts` identity
  input; `App.tsx` callers, display and saved-site keys. Keep localName in types
  if fixtures/native inputs need it; the parser never reads it.
- Desktop: bridge mapping tests; remove name-based identity use. Avoid gratuitous
  transport/API changes unrelated to the correction.
- Fixtures: demo fleet and Python lab advertisements; probe, setup, demo and
  bridge tests. Saved certified-ID keys retain the same format, no migration.
- Docs: SECURITY, ARCHITECTURE, DECISIONS, SPEC, compliance and HANDOFF after
  approval, explicitly recording the shared iPhone/desktop protocol change.

No new dependency, second UI, weakened certificate check or Bluetooth-name
configuration workaround is needed. Preserve all existing uncommitted work.

## Acceptance before deployment

1. Red/green regression: stale/missing localName with a valid payload; no identity,
   truncated payload, wrong company, invalid bytes and mismatched certificate.
   Assert no token/credentials leave on rejection. Test display and stored keys
   through the same shared identity function.
2. Test the six-byte manufacturer payload and 31-byte total in default Rust
   tests. BLE-feature tests pin the advertisement options too, including absent
   secondary PHY and per-advertisement intervals. No claim that CI enforces
   these: the repository currently has no checked-in CI workflow.
3. JS tests, typecheck, lint; Rust tests, fmt, clippy; Linux BLE build and iOS
   Simulator check. Preserve the unrelated reconnect repair already in the tree.
4. Before modifying a sensor, measure manufacturer-record reception and time to
   first identity on Mac/iPhone with current firmware. Reports can initially
   lack manufacturer data, so do not promise identity on every callback.
5. With deployment authorization and a selected test sensor: btmon confirms a
   31-byte legacy primary advertisement, including after state changes; repeat
   cold launch, reconnect and real setup on Mac/iPhone. Record each evidence
   class separately; a transcript replay cannot establish ACTUAL_BLE/ACTUAL_WIFI.

Apps and test firmware must be updated together: an updated app intentionally
cannot provision firmware that publishes only the old state byte. The static ID
also becomes visible to passive listeners; address rotation alone cannot prevent
tracking while that static ID stays broadcast. `0xFFFF` remains test-only.

## Baseline checks before approval

- PASS: 82 JavaScript tests, typecheck, Expo lint.
- PASS: 4 desktop Rust tests, Rustfmt, Clippy with warnings denied.
- PASS: deterministic stale-name/certified-ID transcript comparison above.
- NOT_RUN: fresh radio capture, real Mac/iPhone setup, Linux firmware build,
  iOS Simulator and application packaging. No commit or deployment performed.
