// The paste shortcut to name in hints: ⌘V on a Mac, Ctrl+V elsewhere (the desktop app also builds for Windows and Linux).
export const PASTE_KEY = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘V' : 'Ctrl+V';
