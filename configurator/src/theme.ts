import { DynamicColorIOS, Platform, type ColorValue } from 'react-native';

// Palette from teton.ai with text colours darkened for AA contrast; the dark one keeps AA on the same pairs.
// `onInk`: text and spinners on an ink or warn fill.
const LIGHT = { bg: '#ffffff', card: '#f2f4f4', ink: '#1e1e1e', muted: '#646c74', tone: '#8d959d', line: '#e3e5e6', mint: '#bbf0bd', blue: '#2369c4', blueBg: '#e3edfa', warn: '#a8301a', warnBg: '#ffe5dd', onInk: '#ffffff' };
const DARK: typeof LIGHT = { bg: '#161819', card: '#222527', ink: '#eceeef', muted: '#a3aab0', tone: '#80888f', line: '#35393c', mint: '#1f4d2c', blue: '#7fb0f0', blueBg: '#1c2d44', warn: '#ff9e88', warnBg: '#4b2119', onInk: '#161819' };
type Name = keyof typeof LIGHT;
const names = Object.keys(LIGHT) as Name[];

// Each colour follows the system appearance with no re-render: iOS resolves DynamicColorIOS itself, the web (desktop
// window included) a CSS variable switched by prefers-color-scheme. Other platforms stay light.
const pick = (name: Name): ColorValue =>
  Platform.OS === 'ios' ? DynamicColorIOS({ light: LIGHT[name], dark: DARK[name] }) : Platform.OS === 'web' ? `var(--c-${name})` : LIGHT[name];
export const C = Object.fromEntries(names.map(name => [name, pick(name)])) as Record<Name, ColorValue>;

if (Platform.OS === 'web' && typeof document !== 'undefined') {
  const vars = (palette: typeof LIGHT) => names.map(name => `--c-${name}:${palette[name]};`).join('');
  const style = document.createElement('style');
  style.textContent = `:root{color-scheme:light dark;${vars(LIGHT)}}@media (prefers-color-scheme:dark){:root{${vars(DARK)}}}body{background:var(--c-bg)}`;
  document.head.appendChild(style);
}

export const F = { regular: 'Onest_400Regular', medium: 'Onest_500Medium', bold: 'Onest_600SemiBold' };
// Below this window width the desktop app uses the phone layout (App.tsx, Sheet.tsx).
export const DESKTOP_MIN_WIDTH = 900;
