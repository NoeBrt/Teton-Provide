# Provide desktop: UX and animation audit (2026-10-22)

Evidence: shared React app in Chromium, the packaged WKWebView/Tauri window on the MacBook, iPhone 16 Pro Simulator.
Demo data only in captures; this audit does not validate Bluetooth, keychain persistence, QR recognition or real Wi-Fi.

| Finding | Evidence and consequence | Status |
| --- | --- | --- |
| Mobile stretched over the desktop; radar folding leaves a large blank area | T3 native screenshot; prerequisites/summary/sensors fall below the window | T7: two zones, stable radar, independent sensor scroll implemented |
| Batch buttons span the entire desktop width | Native baseline | T7: content-sized actions implemented |
| Sensor rows span the window, signal too far from the name | Native baseline | T7: phone-width columns, stable order, same SensorCard |
| Full-screen web forms | Empty form captures | T7: centered 560 px modal, Escape/Tab/Enter and focus-return checks PASS |
| Open/close stretches the text and buttons | Frames at 80/240/540 ms: Reanimated web LinearTransition scales the whole card; Test height 23.18 px instead of 44 px at 80 ms | FIXED: no layout transition on the web (iOS keeps it); Playwright: open in 12–19 ms, Test 44 px from the first frame, 0 scaled frames (was 17.2 px, 28 scaled frames, 530–645 ms) |
| New width style object invalidates memoized cards | T7 passes a fresh object to each of 200 SensorCards on every parent update | FIXED: `cell` memoized per width |
| Expanded and selected states absent from web accessibility | Live DOM: row aria-expanded and tab aria-selected are null; RN web ignores these accessibilityState fields | CONFIRMED; add explicit ARIA and regression |
| Desktop row opened at the bottom can hide its actions | Desktop reveal currently returns without scrolling; scroll region clips the expanded card | CONFIRMED in code; visual lower-row regression planned |
| Action area changes height as Add appears/disappears | Conditional toolbar mounts/unmounts during a batch | CONFIRMED layout cause; reserve its desktop height |
| Tab changes keep the old list scroll offset | pickFilter does not reset desktop ScrollView | CONFIRMED in code; inspect after scrolling a long tab |
| Dialog stretches to the available height | Site form at 1280×800 ends around 600 px but the panel continues to 768 px | CONFIRMED visually; fix flex sizing |
| Sidebar can overflow in a short desktop window | Fixed radar/title/prerequisites have no sidebar scrolling | Code risk; verify at 900×600 and large text |
| Hidden radar caption is read twice | Tauri accessibility tree exposes the large and compact captions together | CONFIRMED; hide the inactive caption from assistive technology |
| Site Save has no in-flight guard or saving feedback | TechnicianSheet has a guard; SitesSheet.save does not, which matters with an asynchronous native keychain | Code finding; storage-failure/double-save fixture at T5 |
| Forget can report success after a storage error | SitesSheet.forget catches any deletion error and removes the site in UI | Code finding; correct with T5, never claim a failed deletion succeeded |
| Mobile wording remains in desktop credential errors | “on this phone”, “Face ID” in platform-shared forms | Code finding; desktop wording needs the actual keychain behavior at T5 |
| Runtime icon has a system-added glass surround | macOS registered running icon differs from raw ICNS; Dock AX timed out | Source PNG/ICNS fixed; OS rendering limitation recorded in handoff |
| Real desktop capabilities absent | ble.web is unavailable, secureStore.web is volatile; no dedicated webcam decoder | T4–T6 not complete; no hardware claim |

Passing checks so far: Test → world, batch with six slots, Add while running, Retry, Errors/Set up/Not set up tabs,
Refresh, no duplicate sensors or horizontal document overflow at widths 320/400/768/899/900/1280/1920/2560,
independent list scrolling, keyboard form validation, Escape/focus return, Tab trap and Enter field navigation.
Native demo batch ended with 188 set up, 8 errors, 4 not prepared. iPhone demo layout compared visually with the
existing mobile evidence; native rebuild in progress.

New skills installed from official publishers (user requested):
- [Anthropic frontend-design](https://www.skills.sh/anthropics/skills/frontend-design), about 1.0M installs.
- [Vercel React best practices](https://www.skills.sh/vercel-labs/agent-skills/vercel-react-best-practices), about 828K.
- [Vercel React Native skills](https://www.skills.sh/vercel-labs/agent-skills/vercel-react-native-skills), about 251K.

Source SKILL.md files and relevant rules were read before use. All three directory entries show three passing audits;
this is a provenance signal, not a guarantee. Existing IoT palette, Onest, protocol, app and iPhone layout take
precedence over generic design advice. No UI framework, animation package or deployment service was added.
