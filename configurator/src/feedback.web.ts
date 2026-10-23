// Press feedback, desktop: every button, tab and sensor row answers the pointer at once (hover, then press), with short
// CSS transitions the browser runs off the JavaScript thread. Rows only dim: a whole card scaling reads as a jump.
// Placeholder rows (`data-pulse`, App.tsx Waiting) pulse while the search runs, one after the other.
// The desktop's camera faces the user, so expo-camera mirrors its preview; a QR code held to it then moves the wrong way.
// Shown as the camera sees it (decoding reads the frames, unmirrored either way).
const css = `
video { transform: none !important; }
[role="button"], [role="tab"] { cursor: pointer; }
[aria-disabled="true"] { cursor: default; }
@keyframes provide-pulse { from { opacity: 1; } to { opacity: 0.4; } }
@keyframes provide-refresh-spin { to { transform: rotate(360deg); } }
@keyframes provide-refresh-bounce { 0%, 100% { transform: translateY(0); } 35% { transform: translateY(-4px); } 65% { transform: translateY(1px); } }
@keyframes provide-refresh-done { from { opacity: 0.55; transform: translateY(6px); } 65% { opacity: 1; transform: translateY(-2px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: no-preference) {
  [data-refresh-spin] { animation: provide-refresh-spin 800ms linear infinite; }
  [data-refresh-bounce] { animation: provide-refresh-bounce 380ms ease-out; }
  [data-refresh-done] { animation: provide-refresh-done 420ms ease-out; }
  [data-pulse] { animation: provide-pulse 900ms ease-in-out infinite alternate; }
  [data-pulse="1"] { animation-delay: 150ms; }
  [data-pulse="2"] { animation-delay: 300ms; }
  [role="button"], [role="tab"] { transition: opacity 120ms ease-out, transform 120ms ease-out; }
}
[role="button"]:not([aria-disabled="true"]):hover, [role="tab"]:not([aria-disabled="true"]):hover { opacity: 0.86; }
[role="button"]:not([aria-disabled="true"]):active, [role="tab"]:not([aria-disabled="true"]):active { opacity: 0.72; }
[role="button"]:not([aria-disabled="true"]):not([aria-expanded]):active, [role="tab"]:not([aria-disabled="true"]):active { transform: scale(0.97); }
`;
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}
export {};
