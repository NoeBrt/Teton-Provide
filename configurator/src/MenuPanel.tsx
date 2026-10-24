import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { C } from './theme';
import { menuBarApi, type MenuAction, type MenuSnapshot } from './menuBar';

if (typeof document !== 'undefined' && new URLSearchParams(globalThis.location?.search).get('menubar') === '1') {
  const style = document.createElement('style');
  style.textContent = `html,body,#root{background:transparent!important}
    :root{--menu-control:rgba(0,0,0,.055);--menu-border:rgba(0,0,0,.09);--menu-accent:#007aff}
    @media(prefers-color-scheme:dark){:root{--menu-control:rgba(255,255,255,.085);--menu-border:rgba(255,255,255,.11);--menu-accent:#0a84ff}}
    [role=button]:focus-visible{outline:2px solid var(--menu-accent);outline-offset:2px}`;
  document.head.appendChild(style);
}

export function MenuPanel() {
  const [state, setState] = useState<MenuSnapshot | null>(null);
  const [error, setError] = useState(false);
  const panelRows = state ? Math.min(state.sensors.length, 5) : null;
  useEffect(() => {
    if (panelRows !== null) menuBarApi?.core.invoke('resize_menu_bar', { sensorCount: panelRows }).catch(() => setError(true));
  }, [panelRows]);
  const fail = () => setError(true);
  const open = () => { menuBarApi?.core.invoke('open_main').catch(fail); };
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => { if (!disposed) setError(true); }, 5000);
    menuBarApi?.event.listen<MenuSnapshot>('provide-menu-state', event => {
      if (disposed) return;
      clearTimeout(timer);
      setError(false);
      setState(event.payload);
    }).then(off => {
      if (disposed) { off(); return; }
      stop = off;
      return menuBarApi?.event.emitTo('main', 'provide-menu-ready', null);
    }).catch(fail);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') menuBarApi?.core.invoke('hide_menu_bar').catch(fail);
    };
    document.addEventListener('keydown', key);
    return () => { disposed = true; clearTimeout(timer); stop?.(); document.removeEventListener('keydown', key); };
  }, []);
  const action = (payload: MenuAction) => { menuBarApi?.event.emitTo('main', 'provide-menu-action', payload).catch(fail); };
  const busy = state?.sensors.some(sensor => sensor.busy);
  const done = state?.sensors.filter(sensor => sensor.group === 'done').length ?? 0;
  const failed = state?.sensors.filter(sensor => sensor.group === 'failed').length ?? 0;
  return (
    <View style={s.panel}>
      <View style={s.header}>
        <Text style={s.brand} accessibilityRole="header">provide.</Text>
        <Text style={[s.chip, state && !state.demo && state.bluetooth !== 'Bluetooth on' && state.bluetooth !== 'Checking Bluetooth' && s.chipWarn]}>{state?.demo ? 'DEMO' : state?.bluetooth ?? 'Connecting…'}</Text>
      </View>
      <View style={s.heading}>
        <View style={s.grow}>
          <Text style={s.title}>{state ? `${state.sensors.length} sensors nearby` : 'Your sensors'}</Text>
          <Text style={s.caption} numberOfLines={1}>{state?.site ?? 'Choose a site in Provide.'}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={state?.refresh === 'refreshing' ? 'Cancel refresh' : 'Refresh the list'}
          disabled={!state?.canRefresh} onPress={() => action({ kind: 'refresh' })} style={[s.button, !state?.canRefresh && s.disabled]}>
          {state?.refresh === 'refreshing' && <ActivityIndicator size="small" color={C.ink} />}
          <Text style={s.buttonText}>{state?.refresh === 'refreshing' ? 'Cancel' : 'Refresh'}</Text>
        </Pressable>
      </View>
      {error && <Text style={s.error} accessibilityRole="alert">Cannot reach Provide. Open the app to reconnect.</Text>}
      <Text style={s.feedback} accessibilityLiveRegion="polite">
        {!state ? 'Connecting to Provide.…' : state.refresh === 'refreshing' ? 'Refreshing the list…' : busy ? 'Operation in progress…'
          : state.refresh === 'failed' ? 'Search failed. Try Refresh again.' : state.refresh === 'cancelled' ? 'Refresh cancelled'
            : state.refresh === 'updated' ? 'List updated' : `${done} set up · ${failed} errors · ${state.sensors.length - done - failed} not set up`}
      </Text>
      <ScrollView style={s.list} contentContainerStyle={s.listContent}>
        {state?.sensors.length === 0 && <Text style={s.empty}>{state.bluetooth === 'Bluetooth on' ? 'Looking for IoT sensors…\nKeep them within a few metres.' : state.bluetooth}</Text>}
        {state?.sensors.map(sensor => (
          <View key={sensor.id} style={s.sensor}>
            <Pressable style={s.grow} accessibilityRole="button" accessibilityLabel={`Open ${sensor.name}`} onPress={() => action({ kind: 'open', id: sensor.id })}>
              <Text style={s.name} numberOfLines={1}>{sensor.name}</Text>
              <Text numberOfLines={2} style={[s.status, sensor.group === 'failed' && s.error]}>{sensor.status}</Text>
            </Pressable>
            {sensor.busy ? <ActivityIndicator size="small" color={C.ink} accessibilityLabel={`Working on ${sensor.name}`} /> : <>
              <Pressable accessibilityRole="button" accessibilityLabel={`Test ${sensor.name}`} disabled={!state.canRefresh} style={[s.smallButton, !state.canRefresh && s.disabled]} onPress={() => action({ kind: 'test', id: sensor.id })}>
                <Text style={s.buttonText}>Test</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`Set up ${sensor.name}`} disabled={busy || !sensor.canSetUp} style={[s.smallButton, (busy || !sensor.canSetUp) && s.disabled]} onPress={() => action({ kind: 'set-up', id: sensor.id })}>
                <Text style={s.buttonText}>Set up</Text>
              </Pressable>
            </>}
          </View>
        ))}
      </ScrollView>
      <View style={s.footer}>
        <Pressable accessibilityRole="button" onPress={open} style={s.button}><Text style={s.buttonText}>Open Provide. ↗</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={() => action({ kind: 'set-up-all' })} disabled={!state?.canSetUpAll} style={[s.primary, !state?.canSetUpAll && s.disabled]}>
          <Text style={s.primaryText}>Set up all ready</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  panel: { flex: 1, backgroundColor: 'transparent', borderRadius: 26, overflow: 'hidden', padding: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10 },
  brand: { fontFamily: 'system-ui', fontWeight: '600', fontSize: 18, letterSpacing: -0.5, color: C.ink },
  chip: { fontFamily: 'system-ui', fontSize: 11, color: C.muted },
  chipWarn: { color: C.warn },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 8 },
  grow: { flex: 1, minWidth: 0 },
  title: { fontFamily: 'system-ui', fontWeight: '600', fontSize: 17, color: C.ink },
  caption: { fontFamily: 'system-ui', fontSize: 12, color: C.muted, marginTop: 4 },
  feedback: { fontFamily: 'system-ui', fontSize: 11, color: C.muted, paddingHorizontal: 12, paddingBottom: 12 },
  list: { flex: 1, borderTopWidth: 1, borderColor: 'var(--menu-border)' },
  listContent: { paddingHorizontal: 12 },
  sensor: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 64, paddingVertical: 10, borderBottomWidth: 1, borderColor: 'var(--menu-border)' },
  name: { fontFamily: 'system-ui', fontWeight: '500', fontSize: 12, color: C.ink },
  status: { fontFamily: 'system-ui', fontSize: 11, color: C.muted, marginTop: 4 },
  button: { minHeight: 32, paddingHorizontal: 12, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: 'var(--menu-control)' },
  smallButton: { minHeight: 32, minWidth: 40, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: 'var(--menu-control)' },
  buttonText: { fontFamily: 'system-ui', fontWeight: '500', fontSize: 12, color: C.ink },
  primary: { minHeight: 32, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: 18, backgroundColor: 'var(--menu-accent)' },
  primaryText: { fontFamily: 'system-ui', fontWeight: '500', fontSize: 12, color: '#fff' },
  footer: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, paddingHorizontal: 8, paddingTop: 12, paddingBottom: 6, borderTopWidth: 1, borderColor: 'var(--menu-border)' },
  disabled: { opacity: 0.4 },
  empty: { fontFamily: 'system-ui', fontSize: 13, color: C.muted, lineHeight: 21, paddingVertical: 36, textAlign: 'center' },
  error: { color: C.warn, fontFamily: 'system-ui', fontSize: 12 },
});
