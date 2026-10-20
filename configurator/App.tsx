import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, AppState, Image, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { initialWindowMetrics, SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { Onest_400Regular } from '@expo-google-fonts/onest/400Regular';
import { Onest_500Medium } from '@expo-google-fonts/onest/500Medium';
import { Onest_600SemiBold } from '@expo-google-fonts/onest/600SemiBold';
import { BleState, type Peripheral } from 'react-native-ble-manager/src/types';
import { probe, SERVICE_UUID, type ProbeResult, type Step } from './src/probe';
import { BleManager, bleStarted } from './src/ble';
import * as Crypto from 'expo-crypto';
import { setup, type SetupResult, type SetupStep } from './src/setup';
import type { Label } from './src/noise';
import { SetupFlow, type Action } from './src/flow';
import { LabelScanner } from './src/LabelScanner';
import { loadSites, setActiveSite, SitesSheet, unlockPassword } from './src/SiteSheet';
import type { Site, SiteNetwork } from './src/sites';
import { C } from './src/theme';
import Animated, {
  cancelAnimation, Easing, FadeIn, interpolate, LinearTransition, scrollTo, useAnimatedReaction, useAnimatedRef, useAnimatedScrollHandler,
  useAnimatedStyle, useDerivedValue, useReducedMotion, useSharedValue, withDelay, withSpring, withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { Radar, RESIZE, SIZES } from './src/Radar';

const TEST_STEPS: [Step, string][] = [['connect', 'Connecting'], ['services', 'provide service'], ['write', 'Writing “hello”'], ['read', 'Reading the reply']];
const SETUP_STEPS: [SetupStep, string][] = [['connect', 'Connecting'], ['secure', 'Securing the channel'], ['send', 'Sending the network'], ['join', 'Joining the Wi‑Fi']];
const SCAN_SECONDS = 5;
const PAD = 20;
const COMPACT_H = 72; // panel height once folded: the 48 pt radar plus margins
const LARGE_GAP = 16; // space around the large radar
const CAPTION_H = 40;
const MIN_LARGE = 160;
const GAP = 14; // between cards (s.content gap)
// The list scrolls under the home indicator; a revealed card stops above it.
const BOTTOM_INSET = (initialWindowMetrics?.insets.bottom ?? 34) + 16;
const INTRO_TITLE = { duration: 450, easing: Easing.out(Easing.cubic) };
const INTRO_SPRING = { damping: 12, stiffness: 140, mass: 0.9 }; // a small overshoot as the dot appears
const AUTO_FOLD_AFTER = 4; // sensors shown under the large radar before it folds by itself
const FOLD = { duration: 1200, easing: Easing.inOut(Easing.cubic) }; // first-discovery fold
const LOCK_AFTER = 8; // pt into the list before compact mode holds
const MIN_PROGRESS_MS = 700; // an instant failure still shows progress briefly instead of flashing
// The radar's resize, its move into the row and the list's arrival share one curve, on the UI thread.
const layout = LinearTransition.duration(RESIZE.duration).easing(RESIZE.easing);
const appear = FadeIn.duration(RESIZE.duration).delay(RESIZE.duration / 2);

const BLE_HELP: Partial<Record<BleState, string>> = {
  [BleState.Off]: 'Bluetooth is off. Turn it on in Control Center.',
  [BleState.TurningOff]: 'Bluetooth is off. Turn it on in Control Center.',
  [BleState.Unauthorized]: 'The app has no Bluetooth access. Allow it in Settings, then come back.',
  [BleState.Unsupported]: 'This phone does not support Bluetooth Low Energy.',
};

function failureText(result: Extract<ProbeResult, { ok: false }>): string {
  if (result.step === 'connect') return 'The sensor is not responding. Move closer, then try again.';
  if (result.step === 'services') return 'This sensor does not expose the provide service.';
  if (result.step === 'write') return 'The sensor rejected the request.';
  if (result.reason === 'unexpected-reply') return 'Unexpected reply from the sensor.';
  return 'The Bluetooth link failed. Try again.';
}

function setupFailureText(result: Extract<SetupResult, { ok: false }>): string {
  switch (result.reason) {
    case 'WrongPsk': return 'The Wi‑Fi password was refused. Edit the site password, then try again.';
    case 'NotInRange': return 'The sensor cannot see this network. Check its name, or try closer to an access point.';
    case 'NmcliError': return 'The sensor could not apply the network settings. Try again.';
    case 'AlreadyProvisioned': return 'This sensor is already set up.';
    case 'Busy': return 'The sensor is busy with another phone. Wait a minute, then try again.';
    case 'not-authenticated': return 'This label does not match the sensor. Scan the label on this sensor.';
    case 'unknown': return 'The sensor restarted and lost the result. Try again.';
    case 'Timeout':
    case 'timeout': return result.step === 'join' ? 'The sensor did not join in time. Try again.' : 'The sensor is not responding. Move closer, then try again.';
    default: return 'The Bluetooth link failed. Try again.';
  }
}

type Kind = 'test' | 'setup';
type CardOutcome = { ok: boolean; title: string; text: string };
type Attempt = { key: number; at: string; name: string; ok: boolean; detail: string };
const nameOf = (p: Peripheral) => p.advertising?.localName ?? p.name ?? 'Unnamed sensor';

export default function App() {
  const [fontsLoaded, fontError] = useFonts({ Onest_400Regular, Onest_500Medium, Onest_600SemiBold });
  const [ble, setBle] = useState<BleState>(BleState.Unknown);
  const [sensors, setSensors] = useState<Record<string, Peripheral>>({});
  const [running, setRunning] = useState<{ id: string; kind: Kind; step: string } | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, CardOutcome>>({}); // latest result per sensor, shown in its card
  const [paused, setPaused] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [choosingSite, setChoosingSite] = useState(false);
  const [scanFor, setScanFor] = useState<Peripheral | null>(null);
  const flow = useRef(new SetupFlow(null)); // network → label → join; holds its own state (src/flow.ts)
  const busy = useRef(false); // synchronous guard: two taps in one frame never start two runs
  const measuredFirst = useRef(false);
  const focused = useRef<string | null>(null); // the card being tested or set up: kept fully on screen

  useEffect(() => { loadSites().then(saved => { setSites(saved.sites); setActiveId(saved.activeId); }); }, []);
  // A saved password is unlocked once per session and kept in memory only: leaving the app locks it again.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => { if (state === 'background') flow.current.network = null; });
    return () => subscription.remove();
  }, []);
  const activeSite = sites.find(site => site.id === activeId) ?? null;

  useEffect(() => {
    const ble = BleManager;
    if (!ble || !bleStarted) return;
    const subscriptions = [
      ble.onDidUpdateState(({ state }) => setBle(state)),
      ble.onDiscoverPeripheral(peripheral => setSensors(found => ({ ...found, [peripheral.id]: peripheral }))),
    ];
    bleStarted.then(() => ble.checkState()).then(setBle).catch(() => setBle(BleState.Unsupported));
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, []);

  const ready = ble === BleState.On;
  const scanning = ready && !running && !paused; // the radio scan pauses during a test; the radar keeps moving

  // Scan continuously while idle, in short rounds so iOS reports each sensor again (fresh signal).
  // Only devices advertising the IoT service UUID are listed.
  // ponytail: a sensor that stops advertising stays listed; prune by last-seen time if that confuses technicians.
  useEffect(() => {
    const ble = BleManager;
    if (!ble || !scanning) return;
    let live = true;
    const round = () => { if (live) ble.scan({ serviceUUIDs: [SERVICE_UUID], seconds: SCAN_SECONDS, allowDuplicates: false }).catch(() => {}); };
    const subscription = ble.onStopScan(round);
    round();
    return () => { live = false; subscription.remove(); ble.stopScan().catch(() => {}); };
  }, [scanning]);

  // Shared by the hello test and the Wi-Fi setup: progress in the card, then its result, log and announcement.
  const run = async (sensor: Peripheral, kind: Kind, work: (onStep: (step: string) => void) => Promise<{ outcome: CardOutcome; detail: string }>) => {
    if (busy.current) return;
    busy.current = true;
    focused.current = sensor.id;
    // Testing or setting up folds the radar: the card gets the room, far from the screen's rounded bottom edge.
    if (y.get() < travel - 1) fold(RESIZE);
    setRunning({ id: sensor.id, kind, step: 'connect' });
    try {
      await BleManager?.stopScan().catch(() => {}); // iOS connects more reliably without a concurrent scan
      const started = Date.now();
      const { outcome, detail } = await work(step => setRunning({ id: sensor.id, kind, step }));
      await new Promise(resolve => setTimeout(resolve, MIN_PROGRESS_MS - (Date.now() - started))); // UI only: durations stay real
      setOutcomes(map => ({ ...map, [sensor.id]: outcome }));
      setAttempts(list => [{ key: Date.now(), at: new Date().toLocaleTimeString('en-GB'), name: nameOf(sensor), ok: outcome.ok, detail }, ...list].slice(0, 10));
      AccessibilityInfo.announceForAccessibility(`${outcome.title}. ${outcome.text}`);
    } finally {
      busy.current = false;
      setRunning(null);
    }
  };

  const test = (sensor: Peripheral) => BleManager && run(sensor, 'test', async onStep => {
    const result = await probe(BleManager!, sensor.id, onStep);
    return result.ok
      ? { outcome: { ok: true, title: '“world” received', text: `Replied in ${result.ms} ms.` }, detail: `✓ hello ${result.ms} ms` }
      : { outcome: { ok: false, title: 'Test failed', text: failureText(result) }, detail: `! hello ${result.step} · ${result.reason}` };
  });

  const join = (sensor: Peripheral, label: Label, site: SiteNetwork, attempt: Uint8Array | undefined) => BleManager && run(sensor, 'setup', async onStep => {
    let result: SetupResult = { ok: false, step: 'connect', reason: 'rejected' };
    try {
      result = await setup(BleManager!, sensor.id, label, site.ssid, site.password, Crypto.getRandomBytes, onStep, { attempt });
    } finally {
      flow.current.finished(sensor.id, result);
    }
    return result.ok
      ? { outcome: { ok: true, title: 'Device connected', text: `Joined ${site.ssid} · ${result.ipv4}` }, detail: `✓ wi-fi ${result.ipv4}` }
      : { outcome: { ok: false, title: 'Wi‑Fi setup failed', text: setupFailureText(result) }, detail: `! wi-fi ${result.step} · ${result.reason}` };
  });

  // The flow decides (site Wi-Fi once, label once per sensor, join); this shows the matching screen or runs it.
  const act = (action: Action | null) => {
    if (action?.kind === 'ask-network') {
      if (activeSite) unlock(activeSite);
      else setChoosingSite(true);
    }
    if (action?.kind === 'scan-label') setScanFor(sensors[action.sensorId] ?? null);
    if (action?.kind === 'join') {
      setScanFor(null);
      const sensor = sensors[action.sensorId];
      if (sensor) join(sensor, action.label, action.site, action.attempt);
      else flow.current.finished(action.sensorId, { ok: false, step: 'connect', reason: 'rejected' });
    }
  };
  const setUp = (sensor: Peripheral) => { if (!busy.current) act(flow.current.request(sensor.id)); };
  const onLabel = (label: Label) => { if (scanFor) act(flow.current.labelScanned(scanFor.id, label)); };
  // Sites: Face ID unlocks the active site's password, then any sensor waiting for it carries on.
  const use = (site: Site, password: string) => {
    setActiveId(site.id);
    setActiveSite(site.id);
    act(flow.current.networkSaved({ ssid: site.ssid, password } satisfies SiteNetwork));
  };
  const unlock = async (site: Site) => {
    const password = await unlockPassword(site);
    if (password) use(site, password);
    else setChoosingSite(true); // cancelled, or Face ID changed since it was saved: pick or re-enter
  };
  const pick = (site: Site) => { setChoosingSite(false); unlock(site); };
  const saved = (next: Site[], site: Site, password: string) => { setSites(next); setChoosingSite(false); use(site, password); };
  const forgotten = (next: Site[], id: string) => {
    setSites(next);
    if (id !== activeId) return;
    setActiveId(null);
    setActiveSite(null);
    flow.current.network = null;
  };
  const closeSites = () => { flow.current.cancelNetwork(); setChoosingSite(false); };

  const togglePause = () => setPaused(value => !value);

  // Scroll-driven radar: its size, position, title and captions are pure functions of the scroll offset, computed on
  // the UI thread every frame. It follows the finger (including the iOS bounce) and never triggers an animation itself.
  const { width } = useWindowDimensions();
  const [bodyH, setBodyH] = useState(0);
  const [titleH, setTitleH] = useState(0);
  const [siteH, setSiteH] = useState(48); // measured; defaults until the first layout
  const [firstH, setFirstH] = useState(130); // first sensor card without its result drawer
  const [collapsed, setCollapsed] = useState(false);
  const [locked, setLocked] = useState(false); // compact mode holds: the list's top is the scroll edge
  const found = Object.keys(sensors).length;
  // The large radar shrinks on small screens or with large text, so the first sensor stays above the fold.
  // Room kept under the large radar: the Site Wi-Fi card and the whole first sensor card (buttons included).
  const peek = siteH + GAP + firstH + GAP;
  const room = bodyH - titleH - 2 * LARGE_GAP - CAPTION_H - (found > 0 ? peek : 0);
  const large = Math.round(Math.min(SIZES[1], Math.max(MIN_LARGE, room)));
  const largeH = titleH + LARGE_GAP + large + LARGE_GAP + CAPTION_H; // panel height in large mode
  const travel = Math.max(largeH - COMPACT_H, 1); // scroll distance from large to compact
  const panelW = width - 2 * PAD;
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const y = useSharedValue(0);
  const base = useSharedValue(0); // large panel height: the whole screen while nothing is found

  // Only a change in the sensor count animates the panel; layout measurements (safe area, title height)
  // apply instantly, so the radar never drifts on launch.
  const shownFor = useRef(found);
  useEffect(() => {
    const target = found === 0 ? bodyH : largeH;
    const countChanged = (shownFor.current === 0) !== (found === 0);
    shownFor.current = found;
    base.value = countChanged ? withTiming(target, RESIZE) : target;
  }, [found, bodyH, largeH, base]);
  const measured = bodyH > 0 && titleH > 0;

  // Launch: the title rises in, then the dot springs out and the waves start; skipped with Reduce Motion.
  const reduceMotion = useReducedMotion();
  const titleIn = useSharedValue(0);
  const radarIn = useSharedValue(0);
  const captionIn = useSharedValue(0);
  useEffect(() => {
    if (!measured) return;
    if (reduceMotion) { titleIn.value = 1; radarIn.value = 1; captionIn.value = 1; return; }
    titleIn.value = withTiming(1, INTRO_TITLE);
    radarIn.value = withDelay(150, withSpring(1, INTRO_SPRING));
    captionIn.value = withDelay(450, withTiming(1, INTRO_TITLE));
  }, [measured]); // eslint-disable-line react-hooks/exhaustive-deps -- once, on the first layout

  // A few sensors fit under the large radar, which stays put; only the finger folds it. Past AUTO_FOLD_AFTER the list
  // needs the room, so the radar folds once by scrolling the list up, slowly and on the UI thread (the native animated
  // scrollTo is ~0.3 s and not tunable). A touch during the fold hands control straight back to the finger.
  const crowded = found > AUTO_FOLD_AFTER;
  const autoY = useSharedValue(-1); // < 0: not driving the scroll
  useAnimatedReaction(() => autoY.value, value => { if (value >= 0) scrollTo(scrollRef, 0, value, false); });
  const fold = (timing: typeof FOLD) => {
    autoY.set(y.get());
    autoY.set(withTiming(travel, timing, finished => {
      autoY.value = -1;
      if (finished) setLock(true); // compact mode holds, as after a manual fold
    }));
  };
  useEffect(() => { if (crowded) fold(FOLD); }, [crowded]); // eslint-disable-line react-hooks/exhaustive-deps -- once, when the list gets crowded

  // Compact mode is sticky: scrolling back up the list stops at its top (native rubber band, radar unchanged).
  // Only a new drag started from that top unlocks it, so a second gesture brings the large radar back.
  const lock = useSharedValue(false);
  const setLock = (value: boolean) => {
    'worklet';
    if (lock.value === value) return;
    lock.value = value;
    scheduleOnRN(setLocked, value);
  };
  // When a card opens its drawer below the fold, scroll just enough to show it whole; the radar follows the scroll.
  const reveal = (bottom: number) => {
    const target = bottom + GAP + BOTTOM_INSET - bodyH; // clear of the home indicator and the rounded corners
    if (target > y.get() + 1) scrollRef.current?.scrollTo({ y: target, animated: true });
  };

  const onScroll = useAnimatedScrollHandler({
    onScroll: event => {
      y.value = event.contentOffset.y;
      const folded = event.contentOffset.y >= travel - 1;
      if (folded !== collapsed) scheduleOnRN(setCollapsed, folded);
      if (event.contentOffset.y > travel + LOCK_AFTER) setLock(true);
    },
    onBeginDrag: event => {
      cancelAnimation(autoY);
      autoY.value = -1;
      if (event.contentOffset.y <= travel + 2) setLock(false);
    },
    onEndDrag: event => { if (event.contentOffset.y >= travel - 1) setLock(true); },
    onMomentumEnd: event => { if (event.contentOffset.y >= travel - 1) setLock(true); },
  });

  const geometry = useDerivedValue(() => {
    const offset = lock.value ? Math.max(y.value, travel) : y.value; // the rubber band at a locked top moves nothing
    const progress = Math.min(Math.max(offset / travel, 0), 1); // 0 large, 1 compact
    const pull = Math.max(-offset, 0); // finger dragging past the top
    const top = base.value + pull; // the large panel stretches with the pull
    const size = interpolate(progress, [0, 1], [large * (1 + pull / 1500), SIZES[0]]);
    return {
      progress, pull, size,
      height: interpolate(progress, [0, 1], [top, COMPACT_H]),
      cx: interpolate(progress, [0, 1], [panelW / 2, SIZES[0] / 2]),
      cy: interpolate(progress, [0, 1], [titleH + (top - titleH - CAPTION_H) / 2, COMPACT_H / 2]),
    };
  });
  const radarSize = useDerivedValue(() => geometry.value.size);
  const panelStyle = useAnimatedStyle(() => ({ height: geometry.value.height }));
  const radarStyle = useAnimatedStyle(() => {
    const { cx, cy, size } = geometry.value;
    return {
      opacity: Math.min(radarIn.value * 2, 1),
      transform: [{ translateX: cx - size / 2 }, { translateY: cy - size / 2 }, { scale: 0.3 + 0.7 * radarIn.value }],
    };
  });
  const titleStyle = useAnimatedStyle(() => ({
    opacity: interpolate(geometry.value.progress, [0, 0.4], [1, 0], 'clamp') * titleIn.value,
    transform: [{ translateY: geometry.value.pull - geometry.value.progress * travel * 0.3 + (1 - titleIn.value) * 16 }],
  }));
  const largeCaption = useAnimatedStyle(() => ({
    opacity: interpolate(geometry.value.progress, [0, 0.3], [1, 0], 'clamp') * captionIn.value,
    transform: [{ translateY: geometry.value.cy + geometry.value.size / 2 + 12 + (1 - captionIn.value) * 8 }],
  }));
  const compactCaption = useAnimatedStyle(() => ({ opacity: interpolate(geometry.value.progress, [0.7, 1], [0, 1], 'clamp') }));

  if (!fontsLoaded && !fontError) return null;
  const successes = attempts.filter(attempt => attempt.ok).length;
  const caption = (
    !ready ? 'Search paused.'
      : running ? (running.kind === 'setup' ? 'Setting up…' : 'Testing…')
      : paused ? 'Search paused. Tap the dot to resume.'
      : found === 0 ? 'Looking for IoT sensors…'
      : `${found} sensor${found > 1 ? 's' : ''} nearby · still searching`
  );

  return (
    <SafeAreaProvider>
      {/* No bottom edge: the list scrolls under the home indicator instead of being cut by a white band. */}
      <SafeAreaView style={s.screen} edges={['top', 'left', 'right']}>
        <StatusBar style="dark" />
        <View style={[s.header, s.headerFixed]}>
          <View style={s.brand}>
            {/* IoT mark from example.com's site header (SVG rendered to a transparent PNG). */}
            <Image source={require('./assets/iot-mark.png')} style={s.mark} accessibilityLabel="IoT" />
            <Text style={s.wordmark} maxFontSizeMultiplier={1.2}>provide.</Text>
          </View>
          <Text style={s.chip} maxFontSizeMultiplier={1.2}>WI‑FI SETUP</Text>
        </View>

        <View style={s.body} onLayout={event => setBodyH(event.nativeEvent.layout.height)}>
          {/* The list scrolls under the panel; snapping settles the radar fully large or fully compact. */}
          <Animated.ScrollView ref={scrollRef} onScroll={onScroll} scrollEventThrottle={16} scrollEnabled={found > 0}
            snapToOffsets={[0, travel]} snapToEnd={false} contentInset={{ top: locked ? -travel : 0 }}
            contentContainerStyle={[s.content, { paddingTop: largeH, minHeight: found > 0 ? bodyH + travel : 0 }]}>
          {found > 0 && (
            // A compact requirement, not a card: the room goes to the sensors.
            <Pressable style={[s.requirement, !activeSite && s.requirementTodo]} onPress={() => setChoosingSite(true)} onLayout={event => setSiteH(event.nativeEvent.layout.height)}
              accessibilityRole="button" accessibilityLabel={activeSite ? `Site Wi-Fi: ${activeSite.name}. Change` : 'Site Wi-Fi required. Choose a site'}>
              <Text style={[s.check, activeSite ? s.checkDone : s.checkTodo]} maxFontSizeMultiplier={1.3}>{activeSite ? '✓' : '!'}</Text>
              <Text style={[s.requirementText, s.grow]} numberOfLines={1}>{activeSite ? activeSite.name : 'Site Wi‑Fi required'}</Text>
              <Text style={s.requirementAction}>{activeSite ? 'Change' : 'Choose'}</Text>
            </Pressable>
          )}
          {Object.values(sensors).map((sensor, index) => {
            const active = running?.id === sensor.id;
            const outcome = active ? undefined : outcomes[sensor.id];
            const STEPS: [string, string][] = running?.kind === 'setup' ? SETUP_STEPS : TEST_STEPS;
            const step = Math.max(0, STEPS.findIndex(([key]) => key === running?.step));
            return (
              <Animated.View key={sensor.id} entering={appear} layout={layout} style={[s.card, s.clip]}
                // Measured once, before any result drawer opens, so a result never resizes the radar.
                onLayout={event => {
                  const box = event.nativeEvent.layout;
                  if (index === 0 && !measuredFirst.current) { measuredFirst.current = true; setFirstH(box.height); }
                  if (sensor.id === focused.current) reveal(box.y + box.height);
                }}>
                <View style={s.row}>
                  <View style={s.grow}>
                    <Text style={s.sensorName}>{nameOf(sensor)}</Text>
                    {sensor.rssi !== 127 && <Text style={s.small}>Signal {sensor.rssi} dBm</Text>}
                  </View>
                </View>
                <View style={s.row}>
                  <Pressable style={[s.secondary, s.grow, !!running && !(active && running.kind === 'test') && s.disabled]} disabled={!!running} onPress={() => test(sensor)} accessibilityRole="button" accessibilityLabel={`Test ${nameOf(sensor)}`}>
                    {active && running.kind === 'test' ? <ActivityIndicator color={C.ink} accessibilityLabel="Testing" /> : <Text style={s.secondaryText}>Test</Text>}
                  </Pressable>
                  <Pressable style={[s.primary, s.grow, !!running && !(active && running.kind === 'setup') && s.disabled]} disabled={!!running} onPress={() => setUp(sensor)} accessibilityRole="button" accessibilityLabel={`Set up the Wi-Fi of ${nameOf(sensor)}`}>
                    {active && running.kind === 'setup' ? <ActivityIndicator color="#ffffff" accessibilityLabel="Setting up" /> : <Text style={s.primaryText}>Set up</Text>}
                  </Pressable>
                </View>
                {/* One drawer of steady height: it opens once, shows progress, then the result fades in place.
                    The result stays in the tested card, so it is visible wherever that card sits in a long list. */}
                {(active || outcome) && (
                  <View style={s.drawer}>
                    {active ? (
                      <Animated.View key="progress" entering={FadeIn.duration(200)} style={[s.drawerBody, s.progressCard]} accessibilityLiveRegion="polite">
                        <Text style={s.drawerTitle}>{STEPS[step][1]}…</Text>
                        <Text style={s.small}>Step {step + 1} of {STEPS.length}</Text>
                        <View style={s.bar}>{STEPS.map(([key], index) => <View key={key} style={[s.segment, index <= step && s.segmentOn]} />)}</View>
                      </Animated.View>
                    ) : outcome && (
                      <Animated.View key="result" entering={FadeIn.duration(300)} style={[s.drawerBody, outcome.ok ? s.okCard : s.warnCard]} accessibilityRole="summary">
                        <Text style={s.drawerTitle}>{outcome.title}</Text>
                        <Text style={outcome.ok ? s.okText : s.warnText}>{outcome.text}</Text>
                      </Animated.View>
                    )}
                  </View>
                )}
              </Animated.View>
            );
          })}

          {attempts.length > 0 && (
            <View style={s.log}>
              <Text style={s.label}>LOG · {successes} OF {attempts.length} SUCCEEDED</Text>
              {attempts.map(attempt => (
                <Text key={attempt.key} style={s.logLine}>
                  {attempt.at}  {attempt.name}  {attempt.detail}
                </Text>
              ))}
            </View>
          )}
          </Animated.ScrollView>

          {/* Touches pass through to the list except on the dot; once compact, the panel acts like a bar. */}
          <Animated.View style={[s.panel, panelStyle, !measured && s.hidden]} pointerEvents={collapsed ? 'auto' : 'box-none'}>
            <View style={s.panelInner} pointerEvents="box-none">
              <Animated.View style={[s.titleBlock, titleStyle]} pointerEvents="none" onLayout={event => setTitleH(event.nativeEvent.layout.height)}>
                <Text style={s.label} maxFontSizeMultiplier={1.3}>ENCRYPTED BLUETOOTH LINK</Text>
                <Text style={s.title} maxFontSizeMultiplier={1.3}>Set up a sensor. <Text style={s.tone}>Scan its label; it joins the site Wi‑Fi.</Text></Text>
                {!BleManager && (
                  <View style={[s.card, s.warnCard]} accessibilityRole="alert">
                    <Text style={s.warnText}>Bluetooth is unavailable in Expo Go. Install the development build (see configurator/README.md) to test a sensor.</Text>
                  </View>
                )}

                {BleManager && !ready && ble !== BleState.Unknown && (
                  <View style={[s.card, s.warnCard]} accessibilityRole="alert">
                    <Text style={s.warnText}>{BLE_HELP[ble] ?? 'Bluetooth is unavailable right now.'}</Text>
                  </View>
                )}
              </Animated.View>
              {BleManager && (
                <>
                  <Animated.View style={[s.floating, radarStyle]}>
                    <Radar active={ready && !paused} color={C.ink} size={radarSize} onPress={togglePause} label={paused ? 'Resume search' : 'Pause search'} />
                  </Animated.View>
                  <Animated.Text style={[s.small, s.center, s.largeCaption, largeCaption]} maxFontSizeMultiplier={1.3} numberOfLines={2} pointerEvents="none" accessibilityLiveRegion="polite">{caption}</Animated.Text>
                  <Animated.View style={[s.compactCaption, compactCaption]} pointerEvents="none">
                    <Text style={s.small} maxFontSizeMultiplier={1.3} numberOfLines={2} importantForAccessibility="no">{caption}</Text>
                  </Animated.View>
                </>
              )}
            </View>
          </Animated.View>
        </View>
        <SitesSheet key={choosingSite ? 'open' : 'closed'} visible={choosingSite} sites={sites} activeId={activeId} newId={Crypto.randomUUID}
          onClose={closeSites} onPick={pick} onSaved={saved} onForgotten={forgotten} />
        <LabelScanner sensorName={scanFor ? nameOf(scanFor) : null} onCancel={() => { flow.current.cancelScan(); setScanFor(null); }} onLabel={onLabel} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: { paddingHorizontal: PAD, paddingBottom: 48, gap: GAP },
  body: { flex: 1 },
  hidden: { opacity: 0 }, // until the first layout pass, so the radar appears in its final place
  panel: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: C.bg, overflow: 'hidden' },
  panelInner: { position: 'absolute', top: 0, bottom: 0, left: PAD, right: PAD },
  titleBlock: { position: 'absolute', top: 0, left: 0, right: 0, gap: 14, paddingTop: 6 },
  floating: { position: 'absolute', top: 0, left: 0 },
  largeCaption: { position: 'absolute', top: 0, left: 0, right: 0 },
  compactCaption: { position: 'absolute', left: 48 + 12, right: 0, top: 0, height: COMPACT_H, justifyContent: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 14, borderBottomWidth: 1, borderColor: C.line },
  headerFixed: { marginHorizontal: 20, marginTop: 8 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  mark: { width: 28, height: 28, tintColor: C.ink },
  wordmark: { fontFamily: 'Onest_600SemiBold', fontSize: 26, letterSpacing: -1.2, color: C.ink },
  chip: { fontFamily: 'Onest_600SemiBold', fontSize: 11, letterSpacing: 0.6, color: C.ink, backgroundColor: C.mint, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, overflow: 'hidden' },
  label: { fontFamily: 'Onest_500Medium', fontSize: 12, letterSpacing: 0.7, color: C.blue, marginTop: 6 },
  title: { fontFamily: 'Onest_500Medium', fontSize: 30, lineHeight: 32, letterSpacing: -1, color: C.ink },
  tone: { color: C.tone },
  card: { backgroundColor: C.card, borderRadius: 10, padding: 16, gap: 6 },
  okCard: { backgroundColor: C.mint },
  clip: { overflow: 'hidden' }, // the drawer is revealed by the card growing, never drawn over the next card
  drawer: { marginTop: 6, minHeight: 84 },
  drawerBody: { flex: 1, gap: 4, borderRadius: 8, padding: 12, justifyContent: 'center' },
  drawerTitle: { fontFamily: 'Onest_600SemiBold', fontSize: 16, color: C.ink },
  progressCard: { backgroundColor: C.bg },
  bar: { flexDirection: 'row', gap: 4, marginTop: 4 },
  segment: { flex: 1, height: 4, borderRadius: 2, backgroundColor: C.line },
  segmentOn: { backgroundColor: C.ink },
  warnCard: { backgroundColor: C.warnBg },
  warnText: { fontFamily: 'Onest_400Regular', fontSize: 15, lineHeight: 21, color: C.warn },
  okText: { fontFamily: 'Onest_400Regular', fontSize: 15, lineHeight: 21, color: C.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1 },
  sensorName: { fontFamily: 'Onest_600SemiBold', fontSize: 16, color: C.ink },
  small: { fontFamily: 'Onest_400Regular', fontSize: 14, lineHeight: 20, color: C.muted },
  center: { textAlign: 'center' },
  secondary: { backgroundColor: C.bg, borderRadius: 999, minHeight: 44, minWidth: 92, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderWidth: 1, borderColor: C.line },
  secondaryText: { fontFamily: 'Onest_500Medium', fontSize: 15, color: C.ink },
  requirement: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 48, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: C.card },
  requirementTodo: { backgroundColor: C.warnBg },
  check: { width: 22, height: 22, lineHeight: 22, borderRadius: 11, overflow: 'hidden', textAlign: 'center', fontFamily: 'Onest_600SemiBold', fontSize: 13 },
  checkDone: { backgroundColor: C.mint, color: C.ink },
  checkTodo: { backgroundColor: C.warn, color: '#ffffff' },
  requirementText: { fontFamily: 'Onest_500Medium', fontSize: 15, color: C.ink },
  requirementAction: { fontFamily: 'Onest_500Medium', fontSize: 15, color: C.blue },
  primary: { backgroundColor: C.ink, borderRadius: 999, minHeight: 44, minWidth: 92, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  primaryText: { fontFamily: 'Onest_500Medium', fontSize: 15, color: '#ffffff' },
  disabled: { opacity: 0.45 },
  log: { gap: 4, paddingTop: 6 },
  logLine: { fontFamily: 'Onest_400Regular', fontSize: 13, color: C.ink, fontVariant: ['tabular-nums'] },
});
