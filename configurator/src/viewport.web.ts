// Window size, desktop: react-native-web reads the size on visualViewport's resize event, which the macOS app's WebKit
// view does not send when its window is resized (the layout then lags behind: phone layout at 1100 px, desktop at
// 600). The window's own resize event is passed on to it, on the next frame: during the window's event WebKit still
// reports the old visual viewport. Once more shortly after, for the last size of a drag.
if (typeof window !== 'undefined' && window.visualViewport) {
  const viewport = window.visualViewport;
  const send = () => viewport.dispatchEvent(new Event('resize'));
  let settle: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    requestAnimationFrame(send);
    clearTimeout(settle);
    settle = setTimeout(send, 150);
  });
}
export {};
