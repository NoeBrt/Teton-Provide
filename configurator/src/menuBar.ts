import type { Tauri } from './ble.web';
import type { Group } from './wing';

export type MenuAction = { kind: 'refresh' | 'set-up-all' } | { kind: 'test' | 'set-up' | 'open'; id: string };
export type MenuSnapshot = {
  demo: boolean;
  bluetooth: string;
  site: string | null;
  canRefresh: boolean;
  refresh: 'idle' | 'refreshing' | 'updated' | 'failed' | 'cancelled';
  canSetUpAll: boolean;
  sensors: { id: string; name: string; status: string; group: Group; busy: boolean; canSetUp: boolean; setUpLabel: string }[];
};
export type MenuBarApi = Tauri & {
  event: Tauri['event'] & { emitTo(target: string, event: string, payload: unknown): Promise<void> };
};
export const menuBarApi = (globalThis as { __TAURI__?: MenuBarApi }).__TAURI__;

// Only the main window owns the radio and credentials. The panel receives this display-only snapshot.
export function connectMenuBar(api: MenuBarApi, snapshot: () => MenuSnapshot, action: (action: MenuAction) => void) {
  let disposed = false;
  const stops: (() => void)[] = [];
  const publish = () => disposed ? Promise.resolve() : api.event.emitTo('menubar', 'provide-menu-state', snapshot());
  const ready = Promise.all([
    api.event.listen('provide-menu-ready', () => { if (!disposed) void publish().catch(console.error); }),
    api.event.listen<MenuAction>('provide-menu-action', event => { if (!disposed) action(event.payload); }),
  ].map(promise => promise.then(stop => { if (disposed) stop(); else stops.push(stop); })));
  return { ready, publish, dispose() { disposed = true; stops.splice(0).forEach(stop => stop()); } };
}
