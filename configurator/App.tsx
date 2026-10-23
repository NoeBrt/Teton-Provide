import { memo, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, AppState, Image, Platform, Pressable, ScrollView, Settings, StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import { initialWindowMetrics, SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { Onest_400Regular } from '@expo-google-fonts/onest/400Regular';
import { Onest_500Medium } from '@expo-google-fonts/onest/500Medium';
import { Onest_600SemiBold } from '@expo-google-fonts/onest/600SemiBold';
import { BleState, type Peripheral } from 'react-native-ble-manager/src/types';
import { changed, keepAdvertised, probe, SERVICE_UUID, sensorState, type ProbeResult, type SensorState, type Step } from './src/probe';
import { BleManager, bleStarted } from './src/ble';
import { startDemo, type Demo } from './src/demo';
import { ask } from './src/ask';
import * as Crypto from 'expo-crypto';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Haptics from 'expo-haptics';
import { setup, type SetupFailure, type SetupResult, type SetupStep } from './src/setup';
import { expired, SetupFlow, type Action } from './src/flow';
import { runBatch, type BatchControl, type BatchEntry, type BatchSummary } from './src/batch';
import type { Token } from './src/authority';
import { expiryText, loadTokenInfo, TechnicianSheet, tokenProblem, unlockToken, type TokenInfo } from './src/TechnicianSheet';
import { loadSetups, loadSites, saveSetups, setActiveSite, SitesSheet, unlockPassword } from './src/SiteSheet';
import { stateText, type Setups, type Site, type SiteNetwork } from './src/sites';
import { C, DESKTOP_MIN_WIDTH } from './src/theme';
import Animated, {
  cancelAnimation, Easing, FadeIn, FadeOut, interpolate, LinearTransition, scrollTo, useAnimatedReaction, useAnimatedRef, useAnimatedScrollHandler,
  useAnimatedStyle, useDerivedValue, useReducedMotion, useSharedValue, withDelay, withSpring, withTiming, type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { Radar, RESIZE, SIZES } from './src/Radar';
import './src/feedback';
import './src/viewport';
import { Summary, Swatch } from './src/Summary';
import { groupOf, minutesLeft, type Group } from './src/wing';

const TEST_STEPS: [Step, string][] = [['connect', 'Connecting'], ['services', 'provide service'], ['write', 'Writing “hello”'], ['read', 'Reading the reply']];
const SETUP_STEPS: [SetupStep, string][] = [['connect', 'Connecting'], ['secure', 'Securing the channel'], ['send', 'Sending the network'], ['join', 'Joining the Wi‑Fi']];
const SCAN_SECONDS = 5;
// With 200 sensors the scan reports hundreds of advertisements a second; cards redraw at most this often.
const SCAN_FLUSH_MS = 500;
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
const FRESH_MS = 1000; // a row this new fades in; one shown again by a tab does not
const LOCK_AFTER = 8; // pt into the list before compact mode holds
const MIN_PROGRESS_MS = 700; // an instant failure still shows progress briefly instead of flashing
const SUCCESS_SHOWN_MS = 8000; // then the card folds back; its state line and the log keep the result
// The radar's resize, its move into the row and the list's arrival share one curve, on the UI thread.
// None on the web: Reanimated's web LinearTransition scales the view to its new box, which stretches the text and the
// buttons while a card opens (measured: Test 17 px high instead of 44 for 28 frames). SensorCard clips instead.
const layout = Platform.OS === 'web' ? undefined : LinearTransition.duration(RESIZE.duration).easing(RESIZE.easing);
// A card unfolding on desktop answers a click: short and decelerating, where iOS follows the finger's slower pace.
const UNFOLD = { duration: 220, easing: Easing.out(Easing.cubic) };
const SPIN = { duration: 550, easing: Easing.out(Easing.back(1.2)) }; // the refresh arrow's turn, a slight overshoot
const appear = FadeIn.duration(RESIZE.duration).delay(RESIZE.duration / 2);
// Launch order: the title and the dot, then the code and site Wi-Fi rows (they can be set before any sensor is found),
// then the sensors heard meanwhile.
const afterDot = FadeIn.duration(RESIZE.duration).delay(700);
const WEB = Platform.OS === 'web';
const INTRO_MS = 1400;
// A resize across the desktop width rebuilds the screen in the other layout: what is already there resizes and moves
// into place, it does not fade in again. Set by Provide when its layout changes (one screen per app).
let switchedAt = 0;
const unlessSwitched = <T,>(animation: T) => (Date.now() - switchedAt < 600 ? undefined : animation);
// A card opened or started by hand is scrolled into view while it grows, then let go: a later layout change elsewhere
// in the list never scrolls to it again.
const FOCUS_MS = 1500;
const LIST_LABELS = { all: 'SENSORS', done: 'SET UP', failed: 'ERRORS', left: 'NOT SET UP' } as const;
let logKey = 0; // log lines finished in the same millisecond still get distinct keys
const SHEET_GONE_MS = 600;
// Leaving the app this long locks the code and the site password again (Face ID); a shorter switch keeps a batch going.
const LOCK_AFTER_MS = 2 * 60_000;
const STALE_MS = 15_000; // Refresh drops the sensors not heard for this long

/** True once `shown` has been false for SHEET_GONE_MS. RN's Modal on iOS drops, and never retries, a sheet presented
 *  while another one is still sliding away. ponytail: a fixed delay; open from Modal onDismiss if it proves short. */
function useGone(shown: boolean) {
  const [gone, setGone] = useState(true);
  useEffect(() => {
    if (shown) { setGone(false); return; }
    const timer = setTimeout(() => setGone(true), SHEET_GONE_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  return gone && !shown;
}

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

function reasonText(reason: SetupFailure | undefined, step: SetupStep = 'connect'): string {
  switch (reason) {
    case 'WrongPsk': return 'The Wi‑Fi password was refused. Edit the site password, then try again.';
    case 'NotInRange': return 'The sensor cannot see this network. Check its name, or try closer to an access point.';
    case 'NmcliError': return 'The sensor could not apply the network settings. Try again.';
    case 'AlreadyProvisioned': return 'This sensor is already set up.';
    case 'Busy': return 'The sensor is busy with another phone. Wait a minute, then try again.';
    case 'unidentified': return 'This sensor has not announced its ID yet. Nothing was sent to it; try again in a moment.';
    case 'not-genuine': return 'This is not a genuine IoT sensor. Nothing was sent to it.';
    case 'other-customer': return 'This sensor belongs to a customer your technician code does not cover.';
    case 'token-invalid': return 'The sensor refused your technician code. Ask IoT for a new one.';
    case 'token-expired': return 'Your technician code has expired. Ask IoT for a new one.';
    case 'closed': return 'This sensor is not prepared for setup yet. Test still checks that it answers.';
    case 'unknown': return 'The sensor restarted and lost the result. Try again.';
    case 'locked': return 'The technician code or the site Wi‑Fi is no longer unlocked (the app was left for more than 2 minutes, or the site was changed). Tap Retry failed to unlock them.';
    case 'Timeout':
    case 'timeout': return step === 'join' ? 'The sensor did not join in time. Try again.' : 'The sensor is not responding. Move closer, then try again.';
    default: return 'The Bluetooth link failed. Try again.';
  }
}

type Kind = 'test' | 'setup';
type CardOutcome = { ok: boolean; title: string; text: string };
type Attempt = { key: number; at: string; name: string; ok: boolean; detail: string };
const nameOf = (p: Peripheral) => p.advertising?.localName ?? p.name ?? 'Unnamed sensor';

type CardActions = {
  test: (sensor: Peripheral) => void; setUp: (sensor: Peripheral) => void; toggle: (id: string) => void;
  placed: (id: string, first: boolean, bottom: number, height: number) => void;
};
type CardProps = {
  sensor: Peripheral; mine?: { kind: Kind; step: string }; entry?: BatchEntry; outcome?: CardOutcome;
  siteName: string | null; batching: boolean; first: boolean; actions: CardActions;
  compact?: boolean; open?: boolean; group?: Group;
  seen?: number; // when the sensor was first listed (Date.now)
  tight?: boolean; // a folded row after another one: rows sit closer than cards
};

// One sensor. Memoized: with 200 sensors, a scan update or one sensor's progress redraws only the cards it changed.
// Past a few sensors (`compact`) it is a one-line row, its group's shape, its state and its signal; a tap opens it in
// place into the full card (the same view grows, as the result drawer does), another tap folds it back.
const SensorCard = memo(function SensorCard({ sensor, mine, entry, outcome, siteName, batching, first, actions, compact = false, open = false, tight = false, group = 'left', seen = 0 }: CardProps) {
  const active = !!mine;
  const state = sensorState(sensor.advertising);
  const settable = state !== 'not-staged'; // a set-up sensor can be reconfigured with a technician code
  const STEPS: [string, string][] = mine?.kind === 'setup' ? SETUP_STEPS : TEST_STEPS;
  const step = Math.max(0, STEPS.findIndex(([key]) => key === mine?.step));
  const folded = compact && !open;
  // A sensor the batch stopped on before trying it (code locked or expired) has no result to say why.
  const failure = entry?.state === 'stopped' || (entry?.state === 'failed' && (folded || (!outcome && !active))) ? entry : null;
  const why = failure && `${failure.state === 'stopped' ? 'Not tried: ' : ''}${reasonText(failure.reason, failure.step ?? 'join')}`;
  // The row's line: what happens now, or the first sentence of why it failed (the card has the rest).
  const line = mine ? `${STEPS[step][1]}… ${step + 1}/${STEPS.length}`
    : entry?.state === 'queued' ? 'Waiting in the batch'
    : why ? why.split('.')[0]
    : entry?.state === 'ok' && state !== 'offline' ? `Joined the Wi‑Fi · ${entry.ipv4 ?? ''}`
    : state ? stateText(state, siteName) : 'State unknown';
  const head = folded ? (
    <View style={s.rowBody}>
      <Swatch group={group} />
      <View style={s.grow}>
        <Text style={s.rowName}>{nameOf(sensor)}</Text>
        <Text style={[s.rowLine, group === 'failed' && !mine && s.stateWarn, !!mine && s.stateOk]} numberOfLines={1}>{line}</Text>
      </View>
      {sensor.rssi !== 127 && <Text style={s.rowSignal} maxFontSizeMultiplier={1.3}>{sensor.rssi} dBm</Text>}
    </View>
  ) : (
    <View>
      <Text style={s.sensorName}>{nameOf(sensor)}</Text>
      {state && <Text style={[s.small, state === 'online' && s.stateOk, state === 'offline' && s.stateWarn]}>{stateText(state, siteName)}</Text>}
      {entry?.state === 'queued' && <Text style={s.small}>Waiting in the batch</Text>}
      {why && <Text style={s.stateWarnLine}>{why}</Text>}
      {sensor.rssi !== 127 && <Text style={s.small}>Signal {sensor.rssi} dBm</Text>}
    </View>
  );
  // On the web the frame grows and shrinks with its content in UNFOLD, by clipping: a layout transition there
  // scales the card, which stretches its text. The first measure sets the height without animating.
  const height = useSharedValue(0);
  const frame = useAnimatedStyle(() => (height.value ? { height: height.value } : {}));
  // Only a change of the card itself animates (open, fold, link, result): a resize of the window re-wraps the text,
  // and the frame follows that at once instead of trailing behind it.
  const shape = `${folded}|${active}|${!!outcome}`;
  const shapeWas = useRef({ shape, at: 0 });
  if (shapeWas.current.shape !== shape) shapeWas.current = { shape, at: Date.now() };
  const box = [folded ? s.sensorRow : s.card, folded && group === 'failed' && s.requirementTodo];
  const entering = unlessSwitched(!compact || Date.now() - seen < FRESH_MS ? appear : undefined);
  // Measured once, before any result drawer opens, so a result never resizes the radar.
  const placed = (event: LayoutChangeEvent) => { const at = event.nativeEvent.layout; actions.placed(sensor.id, first, at.y + at.height, at.height); };
  const body = (<>
      {/* The same pressable folded and open, so VoiceOver keeps its place. */}
      {compact ? (
        <Pressable onPress={() => actions.toggle(sensor.id)} accessibilityRole="button" accessibilityState={{ expanded: open }}
          accessibilityLabel={folded ? `${nameOf(sensor)}, ${line}${sensor.rssi !== 127 ? `, signal ${sensor.rssi} dBm` : ''}` : undefined}
          accessibilityHint={open ? 'Folds it back into the list' : 'Opens it to test or set it up'}>
          {head}
        </Pressable>
      ) : head}
      {!folded && (
        <>
            <View style={s.row}>
              <Pressable style={[s.secondary, s.grow, active && mine.kind !== 'test' && s.disabled]} disabled={active} onPress={() => actions.test(sensor)} accessibilityRole="button" accessibilityLabel={`Test ${nameOf(sensor)}`}>
                {mine?.kind === 'test' ? <ActivityIndicator color={C.ink} accessibilityLabel="Testing" /> : <Text style={s.secondaryText}>Test</Text>}
              </Pressable>
              <Pressable style={[s.primary, s.grow, ((active && mine.kind !== 'setup') || !settable || batching) && s.disabled]} disabled={active || !settable || batching} onPress={() => actions.setUp(sensor)} accessibilityRole="button"
                accessibilityLabel={`${state === 'online' || state === 'offline' ? 'Reconfigure' : 'Set up'} the Wi-Fi of ${nameOf(sensor)}`}>
                {mine?.kind === 'setup' ? <ActivityIndicator color="#ffffff" accessibilityLabel="Setting up" /> : <Text style={s.primaryText}>{state === 'online' || state === 'offline' ? 'Reconfigure' : 'Set up'}</Text>}
              </Pressable>
            </View>
            {/* One drawer of steady height: it opens once, shows progress, then the result fades in place.
                The result shows in the tested card, wherever it sits in a long list; a success folds away after
                SUCCESS_SHOWN_MS (the state line keeps it), a failure stays until the next action. */}
            {(active || outcome) && (
              <Animated.View style={s.drawer} exiting={FadeOut.duration(200)}>
                {active ? (
                  <Animated.View key="progress" entering={unlessSwitched(FadeIn.duration(200))} style={[s.drawerBody, s.progressCard]} accessibilityLiveRegion="polite">
                    <Text style={s.drawerTitle}>{STEPS[step][1]}…</Text>
                    <Text style={s.small}>Step {step + 1} of {STEPS.length}</Text>
                    <View style={s.bar}>{STEPS.map(([key], index) => <View key={key} style={[s.segment, index <= step && s.segmentOn]} />)}</View>
                  </Animated.View>
                ) : outcome && (
                  <Animated.View key="result" entering={unlessSwitched(FadeIn.duration(300))} exiting={FadeOut.duration(200)} style={[s.drawerBody, outcome.ok ? s.okCard : s.warnCard]} accessibilityRole="summary">
                    <Text style={s.drawerTitle}>{outcome.title}</Text>
                    <Text style={outcome.ok ? s.okText : s.warnText}>{outcome.text}</Text>
                  </Animated.View>
                )}
              </Animated.View>
            )}
        </>
      )}
  </>);
  return Platform.OS === 'web' ? (
    <Animated.View entering={entering} style={[s.frame, box[1], tight && s.tight, frame]} onLayout={placed}>
      <View style={box} onLayout={event => {
        const next = event.nativeEvent.layout.height;
        height.value = height.value && Date.now() - shapeWas.current.at < 400 ? withTiming(next, UNFOLD) : next;
      }}>{body}</View>
    </Animated.View>
  ) : (
    <Animated.View entering={entering} layout={layout} style={[...box, s.clip, tight && s.tight]} onLayout={placed}>{body}</Animated.View>
  );
});

// A clockwise arrow drawn with views (the app has no icon library): an open ring and its arrowhead. `spin` counts
// turns: each tap adds one, on the UI thread.
function RefreshIcon({ spin }: { spin: SharedValue<number> }) {
  const turning = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360}deg` }] }));
  return (
    <Animated.View style={[s.refreshIcon, turning]} importantForAccessibility="no-hide-descendants">
      <View style={s.refreshRing} />
      <View style={s.refreshHead} />
    </Animated.View>
  );
}

function SensorGrid({ desktop, children }: { desktop: boolean; children: React.ReactNode }) {
  return desktop ? <View style={s.grid}>{children}</View> : <>{children}</>;
}

// Desktop, before the first sensor: the list's place shows the search instead of an empty half window. The rows are
// placeholders, pulsing while the search runs (src/feedback.web.ts), replaced by the sensors as they are heard.
function Waiting({ text, searching }: { text: string; searching: boolean }) {
  return (
    // Arrives with the code and site rows, after the title and the dot (the launch order).
    <Animated.View entering={unlessSwitched(afterDot)} style={s.waiting}>
      <Text style={[s.label, s.listLabel]} maxFontSizeMultiplier={1.3}>SENSORS · 0</Text>
      <Text style={s.small} accessibilityLiveRegion="polite">{text}</Text>
      <View style={s.grid} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        {Array.from({ length: 6 }, (_, i) => (
          <View key={i} style={[s.sensorRow, s.placeholderRow]} {...{ dataSet: searching ? { pulse: String(i % 3) } : undefined }}>
            <View style={[s.placeholderBar, s.placeholderName]} />
            <View style={[s.placeholderBar, s.placeholderLine]} />
          </View>
        ))}
      </View>
    </Animated.View>
  );
}

type Mode = { demo: Demo | null; onDemo: (on: boolean) => void };

function Provide({ demo, onDemo }: Mode) {
  // The demo's simulated wing stands in for the radio; everything else is the same app.
  const radio = demo ? (demo.radio as unknown as NonNullable<typeof BleManager>) : BleManager;
  const radioStarted = demo ? Promise.resolve() : bleStarted;
  const [fontsLoaded, fontError] = useFonts({ Onest_400Regular, Onest_500Medium, Onest_600SemiBold });
  const [ble, setBle] = useState<BleState>(BleState.Unknown);
  const [sensors, setSensors] = useState<Record<string, Peripheral>>({});
  const [running, setRunning] = useState<Record<string, { kind: Kind; step: string }>>({}); // a batch runs several at once
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [outcomes, setOutcomes] = useState<Record<string, CardOutcome>>({}); // latest result per sensor, shown in its card
  const [paused, setPaused] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [choosingSite, setChoosingSite] = useState(false);
  const [setups, setSetups] = useState<Setups>({}); // sensor name → site this phone set it up on
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null); // who this phone's technician code is for
  // `asked`: the flow opened it for a waiting sensor or batch; `n` counts openings, so each one mounts a fresh sheet.
  const [tokenSheet, setTokenSheet] = useState({ open: false, asked: false, n: 0 });
  const [batch, setBatch] = useState<Record<string, BatchEntry>>({});
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [filter, setFilter] = useState<Group | 'all'>('all');
  const flow = useRef(new SetupFlow(null)); // token → site Wi-Fi → join; holds its own state (src/flow.ts)
  const busy = useRef(new Set<string>()); // synchronous guard: two taps in one frame never start two runs on a sensor
  const batchActive = useRef(false);
  const batchControl = useRef<BatchControl>({}); // adds sensors to the running batch
  const [batchStarted, setBatchStarted] = useState<{ ms: number; size: number } | null>(null); // for the time left
  const afterCredentials = useRef<(() => void) | null>(null); // a batch waiting for the token or the site Wi-Fi
  const sensorsRef = useRef(sensors);
  sensorsRef.current = sensors;
  const measuredFirst = useRef(false);
  const focused = useRef<{ id: string; until: number } | null>(null); // the card opened or started by hand, for FOCUS_MS
  const [openId, setOpenId] = useState<string | null>(null); // the compact row opened into its card, one at a time
  // What a tab has shown since it was tapped: those sensors stay listed, updated in place, until the next tap.
  const kept = useRef({ list: [] as string[], set: new Set<string>() });
  const stickyOpen = useRef<string | null>(null); // a row opened while in progress, kept in the block until closed
  const slotOf = useRef(new Map<string, number>()); // IN PROGRESS: sensor → its row
  const seenAt = useRef(new Map<string, number>()); // when each sensor was first listed
  const heardAt = useRef(new Map<string, number>()); // its last advertisement, for Refresh

  useEffect(() => {
    if (demo) { // the demo's code and site, in memory: nothing saved is read or written
      setTokenInfo({ name: demo.token.name, customers: demo.token.customers, expires: demo.token.expires });
      setSites([demo.site]);
      setActiveId(demo.site.id);
      act(flow.current.tokenReady(demo.token));
      act(flow.current.networkSaved({ ssid: demo.site.ssid, password: demo.password }));
      return;
    }
    loadSites().then(saved => { setSites(saved.sites); setActiveId(saved.activeId); });
    loadSetups().then(setSetups);
    loadTokenInfo().then(setTokenInfo);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- once per mode: switching remounts
  // The site password and the technician code are unlocked once per session and kept in memory only: leaving the
  // app for more than LOCK_AFTER_MS locks them again (the demo's cannot be re-entered, so they stay).
  const leftAt = useRef<number | null>(null);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (demo) return;
      if (state === 'background') leftAt.current = Date.now();
      if (state === 'active' && leftAt.current !== null) {
        if (Date.now() - leftAt.current > LOCK_AFTER_MS) { flow.current.network = null; flow.current.token = null; }
        leftAt.current = null;
      }
    });
    return () => subscription.remove();
  }, [demo]);
  const activeSite = sites.find(site => site.id === activeId) ?? null;
  const liveToken = tokenInfo && !expired(tokenInfo) ? tokenInfo : null; // an expired code counts as missing
  const activeRef = useRef(activeSite); // a setup finishes renders later: read the site in use then, not a stale one
  activeRef.current = activeSite;
  const remember = (sensorName: string) => {
    const siteId = activeRef.current?.id;
    if (!siteId) return;
    setSetups(current => {
      const next = { ...current, [sensorName]: siteId };
      if (!demo) saveSetups(next);
      return next;
    });
  };

  useEffect(() => {
    const ble = radio;
    if (!ble || !radioStarted) return;
    // The latest advertisement of each sensor waits here; one state update applies them all (docs/BENCHMARKS.md).
    const latest = new Map<string, Peripheral>();
    const flush = setInterval(() => {
      if (latest.size === 0) return;
      const heard = [...latest.values()];
      latest.clear();
      setSensors(found => {
        const updates = heard.map(peripheral => keepAdvertised(found[peripheral.id], peripheral)).filter(peripheral => changed(found[peripheral.id], peripheral));
        return updates.length ? { ...found, ...Object.fromEntries(updates.map(peripheral => [peripheral.id, peripheral])) } : found;
      });
    }, SCAN_FLUSH_MS);
    const subscriptions = [
      ble.onDidUpdateState(({ state }) => setBle(state)),
      ble.onDiscoverPeripheral(peripheral => { latest.set(peripheral.id, keepAdvertised(latest.get(peripheral.id), peripheral)); heardAt.current.set(peripheral.id, Date.now()); }),
    ];
    radioStarted.then(() => ble.checkState()).then(setBle).catch(() => setBle(BleState.Unsupported));
    return () => { clearInterval(flush); subscriptions.forEach(subscription => subscription.remove()); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- the radio is fixed for this mode

  const ready = ble === BleState.On;
  const anyRunning = Object.keys(running).length > 0;
  // The scan goes on during a batch and a test: sensors found meanwhile can join the running batch.
  const scanning = ready && !paused;

  // Scan continuously, during batches too, reporting every advertisement, so a card follows its sensor's state within a second
  // (without duplicates iOS skips sensors for whole rounds); `changed` keeps re-renders to real changes.
  // Only devices advertising the IoT service UUID are listed.
  // A sensor that stops advertising stays listed until Refresh (STALE_MS).
  useEffect(() => {
    const ble = radio;
    if (!ble || !scanning) return;
    let live = true;
    const round = () => { if (live) ble.scan({ serviceUUIDs: [SERVICE_UUID], seconds: SCAN_SECONDS, allowDuplicates: true }).catch(() => {}); };
    const subscription = ble.onStopScan(round);
    round();
    return () => { live = false; subscription.remove(); ble.stopScan().catch(() => {}); };
  }, [scanning]);

  // Shared by the hello test and the Wi-Fi setup: progress in the card, then its result, log and announcement.
  const run = async <R,>(sensor: Peripheral, kind: Kind, work: (onStep: (step: string) => void) => Promise<{ outcome: CardOutcome; detail: string; result: R }>): Promise<R | undefined> => {
    if (busy.current.has(sensor.id)) return undefined;
    busy.current.add(sensor.id);
    // Testing or setting up folds the radar: the card gets the room, far from the screen's rounded bottom edge. A batch
    // folds it once when it starts, and never scrolls to each card: the technician may be reading elsewhere.
    if (!batchActive.current) {
      focused.current = { id: sensor.id, until: Date.now() + FOCUS_MS };
      setOpenId(sensor.id); // stays open if the list turns compact during the run
      if (!desktop && y.get() < travel - 1) fold(RESIZE);
    }
    setRunning(map => ({ ...map, [sensor.id]: { kind, step: 'connect' } }));
    try {
      const started = Date.now();
      const { outcome, detail, result } = await work(step => setRunning(map => ({ ...map, [sensor.id]: { kind, step } })));
      await new Promise(resolve => setTimeout(resolve, MIN_PROGRESS_MS - (Date.now() - started))); // UI only: durations stay real
      setOutcomes(map => ({ ...map, [sensor.id]: outcome }));
      // A success folds away after a while; a failure stays, since it tells the technician what to do next.
      if (outcome.ok) {
        setTimeout(() => setOutcomes(map => {
          if (map[sensor.id] !== outcome) return map; // a newer result replaced it
          const { [sensor.id]: _shown, ...rest } = map;
          return rest;
        }), SUCCESS_SHOWN_MS);
      }
      const key = ++logKey;
      setAttempts(list => [{ key, at: new Date().toLocaleTimeString('en-GB'), name: nameOf(sensor), ok: outcome.ok, detail }, ...list].slice(0, 10));
      if (!batchActive.current) AccessibilityInfo.announceForAccessibility(`${outcome.title}. ${outcome.text}`);
      return result;
    } finally {
      busy.current.delete(sensor.id);
      setRunning(map => { const { [sensor.id]: _done, ...rest } = map; return rest; });
    }
  };

  const test = (sensor: Peripheral) => radio && run<ProbeResult>(sensor, 'test', async onStep => {
    const result = await probe(radio, sensor.id, onStep);
    return result.ok
      ? { outcome: { ok: true, title: '“world” received', text: `Replied in ${result.ms} ms.` }, detail: `✓ hello ${result.ms} ms`, result }
      : { outcome: { ok: false, title: 'Test failed', text: failureText(result) }, detail: `! hello ${result.step} · ${result.reason}`, result };
  });

  const join = async (sensor: Peripheral, site: SiteNetwork, attempt: Uint8Array | undefined): Promise<SetupResult> => {
    let result: SetupResult = { ok: false, step: 'connect', reason: 'rejected' };
    const token = flow.current.token;
    const single = !batchActive.current; // decided at the start: a batch may begin while this run lasts
    const done = radio && token && await run<SetupResult>(sensor, 'setup', async onStep => {
      try {
        result = await setup(radio, sensor.id, sensor.advertising?.localName ?? sensor.name, token, site.ssid, site.password, Crypto.getRandomBytes, onStep, { attempt, deviceAuthority: demo?.deviceAuthority });
      } finally {
        flow.current.finished(sensor.id, result);
      }
      if (result.ok) remember(nameOf(sensor));
      // A setup by hand is kept like a batch result: the overall counts it, a failure sorts first and Retry failed has it.
      const entry: BatchEntry = result.ok ? { state: 'ok', ipv4: result.ipv4 } : { state: 'failed', reason: result.reason, step: result.step };
      if (single) setBatch(map => ({ ...map, [sensor.id]: entry }));
      return result.ok
        ? { outcome: { ok: true, title: 'Device connected', text: `Joined ${site.ssid} · ${result.ipv4}` }, detail: `✓ wi-fi ${result.ipv4}`, result }
        : { outcome: { ok: false, title: 'Wi‑Fi setup failed', text: reasonText(result.reason, result.step) }, detail: `! wi-fi ${result.step} · ${result.reason}`, result };
    });
    if (!done) flow.current.finished(sensor.id, result); // never started: free the sensor in the flow
    return result;
  };

  // The flow decides (technician code once, site Wi-Fi once, join); this shows the matching screen or runs it.
  const act = (action: Action | null) => {
    if (action?.kind === 'ask-token') askToken();
    if (action?.kind === 'ask-network') askNetwork();
    if (action?.kind === 'join') {
      const sensor = sensorsRef.current[action.sensorId];
      if (sensor) join(sensor, action.site, action.attempt);
      else flow.current.finished(action.sensorId, { ok: false, step: 'connect', reason: 'rejected' });
    }
  };
  const setUp = (sensor: Peripheral) => { if (!busy.current.has(sensor.id)) act(flow.current.request(sensor.id)); };
  // Credentials for a batch: the code, then the site Wi-Fi, each asked once; the batch starts when both are there.
  const withCredentials = (next: () => void) => {
    afterCredentials.current = next;
    if (!flow.current.token || expired(flow.current.token)) return askToken();
    if (!flow.current.network) return askNetwork();
    afterCredentials.current = null;
    next();
  };
  const resumeCredentials = () => { const next = afterCredentials.current; if (next) withCredentials(next); };
  // The technician code: Face ID unlocks the saved one, unless it has expired; otherwise the code sheet asks for it.
  // The demo has its own code and site, in memory: it never opens the code or site sheets, which use the saved ones.
  const demoOnly = () => { flow.current.cancelWaiting(); afterCredentials.current = null; };
  const askToken = async () => {
    if (demo) return demoOnly();
    if (liveToken) {
      const token = await unlockToken();
      if (token && !tokenProblem(token)) return tokenReady(token);
    }
    setTokenSheet(sheet => ({ open: true, asked: true, n: sheet.n + 1 }));
  };
  const shutTokenSheet = () => setTokenSheet(sheet => ({ ...sheet, open: false }));
  const tokenReady = (token: Token) => {
    shutTokenSheet();
    act(flow.current.tokenReady(token));
    resumeCredentials();
  };
  const tokenSaved = (token: Token, info: TokenInfo) => { setTokenInfo(info); tokenReady(token); };
  // Closing cancels the waiting sensor or batch only if the flow asked for this code, not when the technician opened it.
  const closeToken = () => {
    if (tokenSheet.asked) { flow.current.cancelWaiting(); afterCredentials.current = null; }
    shutTokenSheet();
  };
  const askNetwork = () => {
    if (demo) return demoOnly();
    if (activeSite) unlock(activeSite); else setChoosingSite(true);
  };
  // Sites: Face ID unlocks the active site's password, then any sensor waiting for it carries on.
  const use = (site: Site, password: string) => {
    setActiveId(site.id);
    if (!demo) setActiveSite(site.id);
    act(flow.current.networkSaved({ ssid: site.ssid, password } satisfies SiteNetwork));
    resumeCredentials();
  };

  // One tap for every ready sensor in range: six at a time (src/batch.ts), each card showing its own progress.
  const startBatch = (ids: string[]) => withCredentials(async () => {
    if (batchActive.current || ids.length === 0) return;
    batchActive.current = true;
    if (!desktop && y.get() < travel - 1) fold(FOLD); // slowly, as at discovery: nothing waits on it
    setSummary(null);
    setBatchStarted({ ms: Date.now(), size: ids.length });
    try {
      // Auto-lock would leave the app, which locks the code and the site password: the screen stays on until the end.
      await activateKeepAwakeAsync('batch').catch(() => {});
      const result = await runBatch(ids, id => {
        const action = flow.current.batchRequest(id); // never asks: locked or expired credentials stop the batch
        if (action.kind === 'stop') return Promise.resolve<SetupResult>({ ok: false, step: 'connect', reason: action.reason });
        const sensor = sensorsRef.current[id];
        if (action.kind !== 'join' || !sensor) {
          if (action.kind === 'join') flow.current.finished(id, { ok: false, step: 'connect', reason: 'rejected' });
          return Promise.resolve<SetupResult>({ ok: false, step: 'connect', reason: 'rejected' });
        }
        return join(sensor, action.site, action.attempt);
      }, (id, entry) => setBatch(map => ({ ...map, [id]: entry })), undefined, batchControl.current);
      setSummary(result);
      AccessibilityInfo.announceForAccessibility(`${result.ok} set up, ${result.failed} failed${result.stopped ? `, ${result.stopped} not tried` : ''}.`);
    } finally {
      batchActive.current = false; // whatever happened, the buttons come back
      deactivateKeepAwake('batch').catch(() => {});
    }
  });
  // Sensors found while a batch runs join its queue; the time left counts them.
  const addToBatch = (ids: string[]) => {
    batchControl.current.add?.(ids);
    setBatchStarted(started => started && { ...started, size: started.size + ids.length });
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
  const closeSites = () => { flow.current.cancelWaiting(); afterCredentials.current = null; setChoosingSite(false); };

  const togglePause = () => setPaused(value => !value);
  // Refresh: sensors gone quiet leave the list (not one in a batch), and the search resumes.
  const refresh = () => {
    if (paused) { setPaused(false); return; } // nothing was heard while paused: resume before judging who is gone
    const now = Date.now();
    const gone = Object.keys(sensors).filter(id => !running[id] && !batch[id] && now - (heardAt.current.get(id) ?? 0) > STALE_MS);
    gone.forEach(id => seenAt.current.delete(id)); // back later, it fades in again
    if (gone.length) setSensors(found => Object.fromEntries(Object.entries(found).filter(([id]) => !gone.includes(id))));
    setPaused(false);
    AccessibilityInfo.announceForAccessibility(gone.length ? `${gone.length} sensors no longer heard were removed` : 'Search resumed');
  };
  // Not while a test or a batch runs: their sensors belong to the mode being left.
  const askDemo = () => {
    if (Object.keys(running).length > 0 || batchActive.current) return;
    if (demo) ask('Leave the demo?', 'Back to the sensors around you.', [{ text: 'Stay', style: 'cancel' }, { text: 'Leave', onPress: () => onDemo(false) }]);
    else ask('Demo with simulated sensors', '200 simulated sensors, with a demo technician code and site. Nothing goes over Bluetooth, and your saved code and sites are not used.',
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Start the demo', onPress: () => onDemo(true) }]);
  };
  // Cards get one unchanging actions object (so memo holds); it calls this render's functions.
  const placed = (id: string, first: boolean, bottom: number, height: number) => {
    if (first && !measuredFirst.current) { measuredFirst.current = true; setFirstH(height); }
    if (id === focused.current?.id && Date.now() < focused.current.until) reveal(bottom, height);
  };
  const toggle = (id: string) => {
    setOpenId(open => (open === id ? null : id));
    focused.current = { id, until: Date.now() + FOCUS_MS };
  };
  const current = useRef({ test, setUp, toggle, placed });
  current.current = { test, setUp, toggle, placed };
  const [cardActions] = useState<CardActions>(() => ({
    test: sensor => { current.current.test(sensor); },
    setUp: sensor => current.current.setUp(sensor),
    toggle: id => current.current.toggle(id),
    placed: (id, first, bottom, height) => current.current.placed(id, first, bottom, height),
  }));

  // Scroll-driven radar: its size, position, title and captions are pure functions of the scroll offset, computed on
  // the UI thread every frame. It follows the finger (including the iOS bounce) and never triggers an animation itself.
  const reported = useWindowDimensions();
  // Web: the screen's measured width, not the window's reported one, which the macOS app's WebKit updates late on a
  // resize (src/viewport.web.ts); the layout follows what the browser actually laid out.
  const [bodyW, setBodyW] = useState(0);
  const width = WEB && bodyW ? bodyW : reported.width;
  const desktop = WEB && width >= DESKTOP_MIN_WIDTH;
  const layoutWas = useRef(desktop);
  if (layoutWas.current !== desktop) { layoutWas.current = desktop; switchedAt = Date.now(); } // before the new tree mounts
  const [bodyH, setBodyH] = useState(0);
  const [titleH, setTitleH] = useState(0);
  const [siteH, setSiteH] = useState(48); // measured; defaults until the first layout
  const [firstH, setFirstH] = useState(130); // first sensor card without its result drawer
  const [collapsed, setCollapsed] = useState(false);
  const [locked, setLocked] = useState(false); // compact mode holds: the list's top is the scroll edge
  const [introDone, setIntroDone] = useState(false);
  const found = introDone ? Object.keys(sensors).length : 0; // sensors heard during the intro join after it
  // The large radar shrinks on small screens or with large text, so the first sensor stays above the fold.
  // Room kept under the large radar: the requirement rows from launch, then the whole first sensor card (buttons
  // included) once there is one.
  const peek = siteH + GAP + (found > 0 ? firstH + GAP : 0);
  const room = bodyH - titleH - 2 * LARGE_GAP - CAPTION_H - peek;
  const large = desktop ? 180 : Math.round(Math.min(SIZES[1], Math.max(MIN_LARGE, room)));
  const largeH = titleH + LARGE_GAP + large + LARGE_GAP + CAPTION_H; // panel height in large mode
  const travel = Math.max(largeH - COMPACT_H, 1); // scroll distance from large to compact
  const panelW = desktop ? 320 : width - 2 * PAD;
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const y = useSharedValue(0);
  const base = useSharedValue(0); // large panel height
  const largeV = useSharedValue(SIZES[1]); // large radar size
  // The first layout applies at once, so the radar never drifts on launch. Every later change (sensors found, a row
  // measured, large text) animates from where the panel is, on the curve of the list's layout transitions: nothing
  // jumps, even when a measurement lands in the middle of an animation.
  const panelTo = useRef<{ height: number; size: number } | null>(null);
  const measured = bodyH > 0 && titleH > 0;
  useEffect(() => {
    if (!measured) return;
    const was = panelTo.current;
    if (was?.height !== largeH) base.value = was ? withTiming(largeH, RESIZE) : largeH;
    if (was?.size !== large) largeV.value = was ? withTiming(large, RESIZE) : large;
    panelTo.current = { height: largeH, size: large };
  }, [measured, largeH, large, base, largeV]);

  // Launch: the title rises in, then the dot springs out and the waves start; skipped with Reduce Motion.
  const reduceMotion = useReducedMotion();
  const titleIn = useSharedValue(0);
  const radarIn = useSharedValue(0);
  const captionIn = useSharedValue(0);
  const refreshSpin = useSharedValue(0);
  useEffect(() => {
    if (!measured) return;
    const timer = setTimeout(() => setIntroDone(true), reduceMotion ? 0 : INTRO_MS);
    if (reduceMotion) { titleIn.value = 1; radarIn.value = 1; captionIn.value = 1; return () => clearTimeout(timer); }
    titleIn.value = withTiming(1, INTRO_TITLE);
    radarIn.value = withDelay(150, withSpring(1, INTRO_SPRING));
    captionIn.value = withDelay(450, withTiming(1, INTRO_TITLE));
    return () => clearTimeout(timer);
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
  // Crowded is also when the overall card and the compact rows appear: folding at once shows the card whole.
  // A window narrowed past the desktop width while crowded opens the phone layout already folded: animating it there
  // would first show the large radar, then shrink it.
  const wasDesktop = useRef(desktop);
  useEffect(() => {
    const resized = wasDesktop.current !== desktop;
    wasDesktop.current = desktop;
    if (desktop) return;
    if (!resized) { if (crowded) fold(FOLD); return; }
    // A new phone list mounts at its top: the radar starts from there, not from the old list's offset (which left it
    // compact above an unscrolled list). Folding it is the resize's job below.
    y.value = 0;
  }, [crowded, desktop]); // eslint-disable-line react-hooks/exhaustive-deps -- when the list gets crowded, or the layout changes

  // Web: after a window resize the phone layout shows the list, the circle compact above it (the default view after
  // a resize; a large circle pushed the sensors down). Through the list itself, once laid out: a new list mounted by
  // a layout switch is not yet the one the UI-thread scroll targets. Scrolling back up still brings the circle back.
  // A late re-measure (the title re-wraps at the new width) moves `travel` after that: a list resting at the compact
  // offset follows it.
  const sizeWas = useRef('');
  const travelWas = useRef(travel);
  const foldPending = useRef(false); // a resize's fold, kept until the list has really reached the compact offset
  useEffect(() => {
    const size = `${width}x${bodyH}`;
    if (sizeWas.current && sizeWas.current !== size && WEB && !desktop && found > 0) foldPending.current = true;
    const resting = Math.abs(y.get() - travelWas.current) <= 1;
    sizeWas.current = size;
    travelWas.current = travel;
    if (!WEB || desktop || found === 0 || !(foldPending.current || resting)) return;
    let frame = 0;
    let tries = 10; // a list just mounted by a layout switch may not be laid out yet: its scroll is then lost
    const settle = () => {
      const list = scrollRef.current?.getScrollableNode?.() as HTMLElement | undefined;
      if (!list) { if (--tries > 0) frame = requestAnimationFrame(settle); return; } // not mounted yet: the radar waits
      if (Math.abs(list.scrollTop - travel) > 1) scrollRef.current?.scrollTo({ y: travel, animated: false });
      if (Math.abs(list.scrollTop - travel) > 1 && --tries > 0) { frame = requestAnimationFrame(settle); return; }
      foldPending.current = false;
      y.value = list.scrollTop; // where the list really is: the radar never claims a fold that did not land
    };
    frame = requestAnimationFrame(settle);
    return () => cancelAnimationFrame(frame);
  }, [width, bodyH, desktop, travel]); // eslint-disable-line react-hooks/exhaustive-deps -- on a resize, or a moved compact offset

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
  // Up as well: a card opened while another one above it folds back can land under the folded radar.
  const reveal = (bottom: number, height: number) => {
    if (desktop) return; // the desktop list scrolls independently; no mobile radar offset
    const top = bottom - height - COMPACT_H - GAP; // its top, clear of the folded radar
    const target = bottom + GAP + BOTTOM_INSET - bodyH; // its bottom, clear of the home indicator and the rounded corners
    if (top < y.get() - 1) scrollRef.current?.scrollTo({ y: Math.max(top, travel), animated: true });
    else if (target > y.get() + 1) scrollRef.current?.scrollTo({ y: target, animated: true });
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
    // The rubber band at a locked top moves nothing. Not on the web: without contentInset the list scrolls past that
    // top, so the radar follows the scroll there and grows back as the list comes down (no gap above the list).
    const offset = desktop ? 0 : lock.value && !WEB ? Math.max(y.value, travel) : y.value;
    const progress = Math.min(Math.max(offset / travel, 0), 1); // 0 large, 1 compact
    const pull = Math.max(-offset, 0); // finger dragging past the top
    const top = base.value + pull; // the large panel stretches with the pull
    const size = interpolate(progress, [0, 1], [largeV.value * (1 + pull / 1500), SIZES[0]]);
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

  // The overall: every sensor in one of three groups (src/wing.ts); a tapped group filters the cards.
  const groups: Record<string, Group> = {};
  const counts: Record<Group, number> = { done: 0, failed: 0, left: 0 };
  for (const sensor of Object.values(sensors)) {
    const group = groupOf(sensorState(sensor.advertising), batch[sensor.id]);
    groups[sensor.id] = group;
    counts[group]++;
  }
  const overall = crowded; // a few sensors are all on screen: no overall, no tabs
  const shownGroup = overall ? filter : 'all';
  // Nothing moves or vanishes under the thumb: the list keeps the scan order, and a tab keeps every sensor it has shown
  // (a retry or a batch changes their state in place) until it is tapped again; sensors joining its group are added
  // at the end. The Errors tab starts grouped by cause, so the same fix reads once down the list.
  const cause = (id: string) => batch[id]?.reason ?? '';
  const pickFilter = (next: Group | 'all') => {
    const list = Object.keys(groups).filter(id => groups[id] === next);
    if (next === 'failed') list.sort((a, b) => cause(a).localeCompare(cause(b)));
    kept.current = { list, set: new Set(list) };
    setFilter(next);
    setOpenId(null);
  };
  if (shownGroup !== 'all') {
    for (const id of Object.keys(groups)) {
      if (groups[id] === shownGroup && !kept.current.set.has(id)) { kept.current.list.push(id); kept.current.set.add(id); }
    }
  }
  const listed = !introDone ? [] : shownGroup === 'all' ? Object.values(sensors) : kept.current.list.map(id => sensors[id]).filter(Boolean);
  // Not set up: the sensors being set up right now move to the IN PROGRESS block on top and leave the list below, which
  // is what is left to do; once done they belong to Set up or Errors. A row opened while in progress stays in the block
  // with its result until it is closed.
  if (running[openId ?? '']) stickyOpen.current = openId;
  else if (stickyOpen.current !== openId) stickyOpen.current = null; // closed, or another row opened
  const inBlock = (id: string) => (groups[id] === 'left' && !!running[id]) || id === stickyOpen.current;
  // Each sensor keeps its slot while it is in the block (a finished one does not shift the others under the thumb).
  const inProgress: Peripheral[] = [];
  if (shownGroup === 'left') {
    const slots = slotOf.current;
    for (const id of [...slots.keys()]) if (!inBlock(id) || !sensors[id]) slots.delete(id);
    for (const sensor of Object.values(sensors)) {
      if (!inBlock(sensor.id) || slots.has(sensor.id)) continue;
      let free = 0;
      while ([...slots.values()].includes(free)) free++;
      slots.set(sensor.id, free);
    }
    for (const [id, slot] of [...slots.entries()].sort((a, b) => a[1] - b[1])) inProgress[slot] = sensors[id];
  }
  const shown = shownGroup === 'left' ? Object.values(sensors).filter(sensor => groups[sensor.id] === 'left' && !inBlock(sensor.id)) : listed;
  const now = Date.now();
  for (const id of Object.keys(sensors)) if (!seenAt.current.has(id)) seenAt.current.set(id, now);
  const compact = crowded; // past a few sensors, one row each; a tap opens it in place
  // Sensors already tried this session, in a batch or by hand, are offered again through Retry failed, not here.
  const readyIds = Object.values(sensors).filter(sensor => sensorState(sensor.advertising) === 'ready' && !running[sensor.id] && !batch[sensor.id]).map(sensor => sensor.id);
  // Not a sensor that failed to prove it is genuine (retrying would only hand an impostor more time), nor one being set
  // up by hand right now.
  const failedIds = Object.entries(batch)
    .filter(([id, entry]) => !running[id] && ((entry.state === 'failed' && entry.reason !== 'not-genuine') || entry.state === 'stopped'))
    .map(([id]) => id);
  const batching = batchActive.current;
  // Under the overall: the batch's progress while it runs, otherwise what "not set up" is made of.
  const inBatch = Object.values(batch);
  const runningNow = inBatch.filter(entry => entry.state === 'running').length;
  const waiting = inBatch.filter(entry => entry.state === 'queued').length;
  // Only this batch: entries from earlier batches stay in `batch`, but none of them is running or waiting.
  const eta = batching && batchStarted ? minutesLeft(batchStarted.ms, Date.now(), batchStarted.size - runningNow - waiting, runningNow + waiting) : null;
  const untried = (state: SensorState | null) => Object.values(sensors).filter(sensor => !batch[sensor.id] && sensorState(sensor.advertising) === state).length;
  const notPrepared = untried('not-staged');
  const unknown = untried(null); // older firmware advertises no state
  const overallLine = (batching
    ? [`${runningNow} in progress`, waiting > 0 && `${waiting} waiting`, eta && `about ${eta} min left`]
    : [readyIds.length > 0 && `${readyIds.length} ready to set up`, notPrepared > 0 && `${notPrepared} not prepared`, unknown > 0 && `${unknown} state unknown`]
  ).filter(Boolean).join(' · ') || null;
  // One sheet at a time, the site sheet first: a sheet asked for while the other one is still sliding away waits for
  // it to leave.
  const siteGone = useGone(choosingSite);
  const codeShown = tokenSheet.open && siteGone;
  const codeGone = useGone(codeShown);
  const siteShown = choosingSite && codeGone;

  // Not on the web: expo-font's load detector hangs in the desktop window's WebKit (its user agent says no Safari) until
  // a 12 s timeout, a blank window all that time. The fonts are local there and in place before the intro ends.
  if (!fontsLoaded && !fontError && Platform.OS !== 'web') return null;
  const successes = attempts.filter(attempt => attempt.ok).length;
  const caption = (
    !ready ? 'Search paused.'
      : anyRunning ? (Object.values(running).some(r => r.kind === 'setup') ? 'Setting up…' : 'Testing…')
      : paused ? 'Search paused. Tap the dot to resume.'
      : found === 0 ? 'Looking for IoT sensors…'
      : `${found} sensor${found > 1 ? 's' : ''} nearby · still searching`
  );
  // The reward: a tap on the finger, the arrow turns once (to the nearest whole turn, so a second tap mid-turn carries
  // on without a jump; none with Reduce Motion), and a success tap once the list is refreshed. iOS only: on the desktop
  // the haptics find no vibration and do nothing.
  const tapRefresh = () => {
    refresh();
    if (!reduceMotion) refreshSpin.value = withTiming(Math.round(refreshSpin.value) + 1, SPIN);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}); // a build without the module stays silent
  };
  const refreshButton = found > 0 && ready && !anyRunning && (
    <Pressable onPressIn={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}); }} onPress={tapRefresh} hitSlop={13}
      accessibilityRole="button" accessibilityLabel="Refresh the list" accessibilityHint="Removes the sensors no longer heard and searches again">
      <RefreshIcon spin={refreshSpin} />
    </Pressable>
  );

  const requirements = (<>
    {measured && (
      // Compact requirements, not cards: the room goes to the sensors. Shown from launch, after the dot.
      <Animated.View entering={unlessSwitched(afterDot)} layout={layout} style={s.requirements} onLayout={event => setSiteH(event.nativeEvent.layout.height)}>
        <Pressable style={[s.requirement, !liveToken && s.requirementTodo]} disabled={!!demo} onPress={() => setTokenSheet(sheet => ({ open: true, asked: false, n: sheet.n + 1 }))}
          accessibilityRole="button" accessibilityLabel={liveToken ? `Technician code of ${liveToken.name}, valid until ${expiryText(liveToken.expires)}. Change`
            : tokenInfo ? `Technician code expired on ${expiryText(tokenInfo.expires)}. Change` : 'Technician code required. Add it'}>
          <Text style={[s.check, liveToken ? s.checkDone : s.checkTodo]} maxFontSizeMultiplier={1.3}>{liveToken ? '✓' : '!'}</Text>
          <Text style={[s.requirementText, s.grow]} numberOfLines={desktop ? undefined : 1}>
            {liveToken ? `${liveToken.name} · until ${expiryText(liveToken.expires)}` : tokenInfo ? 'Technician code expired' : 'Technician code required'}
          </Text>
          {!demo && <Text style={s.requirementAction}>{tokenInfo ? 'Change' : 'Add'}</Text>}
        </Pressable>
        <Pressable style={[s.requirement, !activeSite && s.requirementTodo]} disabled={!!demo} onPress={() => setChoosingSite(true)}
          accessibilityRole="button" accessibilityLabel={activeSite ? `Site Wi-Fi: ${activeSite.name}. Change` : 'Site Wi-Fi required. Choose a site'}>
          <Text style={[s.check, activeSite ? s.checkDone : s.checkTodo]} maxFontSizeMultiplier={1.3}>{activeSite ? '✓' : '!'}</Text>
          <Text style={[s.requirementText, s.grow]} numberOfLines={desktop ? undefined : 1}>{activeSite ? activeSite.name : 'Site Wi‑Fi required'}</Text>
          {!demo && <Text style={s.requirementAction}>{activeSite ? 'Change' : 'Choose'}</Text>}
        </Pressable>
      </Animated.View>
    )}
  </>);
  const overview = (<>
    {found > 0 && overall && (
      // Fades in once the cards have moved down for it, instead of appearing under them.
      <Animated.View entering={unlessSwitched(appear)} layout={layout}><Summary counts={counts} line={overallLine} filter={shownGroup} onFilter={pickFilter} /></Animated.View>
    )}
    {found > 0 && (readyIds.length > 0 || failedIds.length > 0 || summary?.stopReason) && (
      <Animated.View entering={unlessSwitched(appear)} layout={layout} style={[s.batch, desktop && s.desktopBatch]}>
        {readyIds.length > 0 && !summary?.stopReason && (!batching || batchControl.current.add) && (
          <Pressable style={s.primary} onPress={() => (batching ? addToBatch(readyIds) : startBatch(readyIds))} accessibilityRole="button">
            <Text style={s.primaryText}>{batching ? `Add ${readyIds.length} to the batch` : `Set up all ready (${readyIds.length})`}</Text>
          </Pressable>
        )}
        {summary?.stopReason && <Text style={s.warnText} accessibilityRole="alert">Stopped: {reasonText(summary.stopReason, 'join')}</Text>}
        {!batching && failedIds.length > 0 && (
          <Pressable style={s.secondary} onPress={() => startBatch(failedIds)} accessibilityRole="button">
            <Text style={s.secondaryText}>Retry failed ({failedIds.length})</Text>
          </Pressable>
        )}
      </Animated.View>
    )}
  </>);
  const sensorList = (<>
    {inProgress.length > 0 && <Text style={[s.label, s.listLabel]} maxFontSizeMultiplier={1.3}>IN PROGRESS · {inProgress.filter(Boolean).length}</Text>}
    <SensorGrid desktop={desktop}>
    {Array.from(inProgress, (sensor, index) => !sensor ? (
      // A slot between two sensors, freed until the next one starts: kept, so the rows below do not move.
      <View key={`slot-${index}`} style={[s.sensorRow, s.emptySlot, !desktop && index > 0 && s.tight]} />
    ) : (
      // Fixed slots, one per link: their content changes in place (a freshly mounted row shows blank for a moment).
      <SensorCard key={`slot-${index}`} sensor={sensor} mine={running[sensor.id]} entry={batch[sensor.id]} first={false}
        outcome={running[sensor.id] ? undefined : outcomes[sensor.id]} batching={batching} actions={cardActions}
        siteName={sites.find(site => site.id === setups[nameOf(sensor)])?.name ?? null} compact open={sensor.id === openId}
        group={groups[sensor.id]} tight={!desktop && index > 0 && sensor.id !== openId && inProgress[index - 1]?.id !== openId} />
    ))}
    </SensorGrid>
    {found > 0 && introDone && (
      <View style={s.listHead}>
        <Text style={[s.label, s.listLabel, s.grow]} maxFontSizeMultiplier={1.3}>{LIST_LABELS[shownGroup]} · {shown.length}</Text>
        {refreshButton}
      </View>
    )}
    <SensorGrid desktop={desktop}>
    {shown.map((sensor, index) => (
      <SensorCard key={sensor.id} sensor={sensor} mine={running[sensor.id]} entry={batch[sensor.id]} first={!compact && index === 0}
        outcome={running[sensor.id] ? undefined : outcomes[sensor.id]} batching={batching} actions={cardActions}
        siteName={sites.find(site => site.id === setups[nameOf(sensor)])?.name ?? null}
        compact={compact} open={sensor.id === openId} group={groups[sensor.id]} seen={seenAt.current.get(sensor.id)}
        tight={!desktop && compact && index > 0 && sensor.id !== openId && shown[index - 1].id !== openId} />
    ))}

    </SensorGrid>
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
  </>);
  const searchPanel = (<>
    {/* Touches pass through to the list except on the dot; once compact, the panel acts like a bar. */}
    <Animated.View style={[s.panel, panelStyle, desktop && s.desktopPanel, !measured && s.hidden]} pointerEvents={desktop || !collapsed ? 'box-none' : 'auto'}>
      <View style={[s.panelInner, desktop && { left: 0, right: 0 }]} pointerEvents="box-none">
        <Animated.View style={[s.titleBlock, titleStyle]} pointerEvents="none" onLayout={event => setTitleH(event.nativeEvent.layout.height)}>
          <Text style={s.label} maxFontSizeMultiplier={1.3}>ENCRYPTED BLUETOOTH LINK</Text>
          <Text style={s.title} maxFontSizeMultiplier={1.3}>Set up sensors. <Text style={s.tone}>Each proves it is a IoT sensor, then joins the site Wi‑Fi.</Text></Text>
          {!radio && (
            <View style={[s.card, s.warnCard]} accessibilityRole="alert">
              <Text style={s.warnText}>{Platform.OS === 'web' ? 'Open the Provide desktop app to use Bluetooth.' : 'Bluetooth is unavailable in Expo Go. Install the development build to test a sensor.'}</Text>
            </View>
          )}

          {radio && !ready && ble !== BleState.Unknown && (
            <View style={[s.card, s.warnCard]} accessibilityRole="alert">
              <Text style={s.warnText}>{BLE_HELP[ble] ?? 'Bluetooth is unavailable right now.'}</Text>
            </View>
          )}
        </Animated.View>
        {radio && (
          <>
            <Animated.View style={[s.floating, radarStyle]}>
              <Radar active={ready && !paused} color={C.ink} size={radarSize} onPress={togglePause} label={paused ? 'Resume search' : 'Pause search'} />
            </Animated.View>
            {/* Only the visible caption takes touches: the hidden one sits over the list. */}
            <Animated.Text style={[s.small, s.center, s.largeCaption, largeCaption]} maxFontSizeMultiplier={1.3} numberOfLines={2} pointerEvents="none" accessibilityLiveRegion="polite">{caption}</Animated.Text>
            <Animated.View style={[s.compactCaption, compactCaption]} pointerEvents="none">
              <Text style={s.small} maxFontSizeMultiplier={1.3} numberOfLines={2} importantForAccessibility="no">{caption}</Text>
            </Animated.View>
          </>
        )}
      </View>
    </Animated.View>
  </>);

  return (
    <SafeAreaProvider>
      {/* No bottom edge: the list scrolls under the home indicator instead of being cut by a white band. */}
      <SafeAreaView style={s.screen} edges={['top', 'left', 'right']}>
        <StatusBar style="dark" />
        <View style={[s.header, s.headerFixed]}>
          {/* A tap on the logo opens the demo with simulated sensors, or leaves it (each asks first). */}
          <Pressable style={s.brand} onPress={askDemo} hitSlop={8} accessibilityRole="button"
            accessibilityLabel={demo ? 'IoT provide. Leave the demo' : 'IoT provide.'} accessibilityHint={demo ? undefined : 'Opens a demo with simulated sensors'}>
            {/* IoT mark from example.com's site header (SVG rendered to a transparent PNG). */}
            <Image source={require('./assets/iot-mark.png')} style={s.mark} accessibilityIgnoresInvertColors />
            <Text style={s.wordmark} maxFontSizeMultiplier={1.2}>provide.</Text>
          </Pressable>
          {/* In the demo the chip says so, and a tap on it leaves too. */}
          {demo ? (
            <Pressable onPress={askDemo} hitSlop={8} accessibilityRole="button" accessibilityLabel="Demo with simulated sensors. Leave the demo">
              <Text style={[s.chip, s.chipDemo]} maxFontSizeMultiplier={1.2}>DEMO</Text>
            </Pressable>
          ) : <Text style={s.chip} maxFontSizeMultiplier={1.2}>WI‑FI SETUP</Text>}
        </View>

        <View style={[s.body, desktop && s.workspace]} onLayout={event => { setBodyH(event.nativeEvent.layout.height); if (WEB) setBodyW(event.nativeEvent.layout.width); }}>
          {desktop ? (
            <>
              {/* Scrolls only in a window too short for it, so the code and site rows stay reachable. */}
              <ScrollView style={s.sidebar} contentContainerStyle={s.sidebarContent}>
                {searchPanel}
                {requirements}
              </ScrollView>
              <View style={s.main}>
                {found === 0 && radio ? (
                  <Waiting searching={ready && !paused}
                    text={ready && !paused ? 'Sensors show here as soon as they are heard. Stay within a few metres of them.' : caption} />
                ) : (<>
                  <View style={s.overview}>{overview}</View>
                  <Animated.ScrollView ref={scrollRef} style={s.sensorScroll} contentContainerStyle={s.desktopList}>
                    {sensorList}
                  </Animated.ScrollView>
                </>)}
              </View>
            </>
          ) : (
            <>
              <Animated.ScrollView ref={scrollRef} onScroll={onScroll} scrollEventThrottle={16} scrollEnabled={found > 0}
                snapToOffsets={[0, travel]} snapToEnd={false} contentInset={{ top: locked ? -travel : 0 }}
                contentContainerStyle={[s.content, { paddingTop: largeH, minHeight: found > 0 ? bodyH + travel : 0 }]}>
                {requirements}
                {overview}
                {sensorList}
              </Animated.ScrollView>
              {searchPanel}
            </>
          )}

        </View>
        <SitesSheet key={choosingSite ? 'sites-open' : 'sites-closed'} visible={siteShown} sites={sites} activeId={activeId} newId={Crypto.randomUUID}
          onClose={closeSites} onPick={pick} onSaved={saved} onForgotten={forgotten} />
        <TechnicianSheet key={tokenSheet.open ? `code-open-${tokenSheet.n}` : 'code-closed'} visible={codeShown}
          info={tokenInfo} onClose={closeToken} onSaved={tokenSaved} />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: { paddingHorizontal: PAD, paddingBottom: 48, gap: GAP },
  body: { flex: 1 },
  workspace: { flexDirection: 'row', gap: 24, padding: 20, minHeight: 0 },
  sidebar: { width: 320, flexGrow: 0, flexShrink: 0 },
  sidebarContent: { gap: 20, paddingBottom: 4 },
  main: { flex: 1, minWidth: 0, minHeight: 0 },
  overview: { gap: 14, paddingBottom: 16 },
  desktopBatch: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  desktopPanel: { position: 'relative', left: 0, right: 0, flexShrink: 0 },
  sensorScroll: { flex: 1, minHeight: 0 },
  waiting: { gap: 12 },
  placeholderRow: { gap: 8 },
  placeholderBar: { backgroundColor: C.line },
  placeholderName: { width: 150, height: 12, borderRadius: 6 },
  placeholderLine: { width: 96, height: 10, borderRadius: 5 },
  desktopList: { gap: GAP, paddingBottom: 24 },
  // Desktop columns in CSS: the browser re-flows them on every frame of a window resize (a width computed here
  // trailed a frame behind and made the cards jump). react-native-web passes these styles through.
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 8, alignItems: 'start' } as unknown as ViewStyle,
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
  chipDemo: { backgroundColor: C.ink, color: '#ffffff' },
  chip: { fontFamily: 'Onest_600SemiBold', fontSize: 11, letterSpacing: 0.6, color: C.ink, backgroundColor: C.mint, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, overflow: 'hidden' },
  label: { fontFamily: 'Onest_500Medium', fontSize: 12, letterSpacing: 0.7, color: C.blue, marginTop: 6 },
  title: { fontFamily: 'Onest_500Medium', fontSize: 30, lineHeight: 32, letterSpacing: -1, color: C.ink },
  tone: { color: C.tone },
  card: { backgroundColor: C.card, borderRadius: 10, padding: 16, gap: 6 },
  okCard: { backgroundColor: C.mint },
  frame: { backgroundColor: C.card, borderRadius: 10, overflow: 'hidden' }, // the web card's clipping frame (SensorCard)
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
  emptySlot: { opacity: 0.5 },
  listHead: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 24 },
  listLabel: { marginTop: 0, marginBottom: -4 },
  refreshIcon: { width: 18, height: 18 },
  refreshRing: { position: 'absolute', left: 1, top: 1, width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: C.ink, borderTopColor: 'transparent', transform: [{ rotate: '45deg' }] },
  refreshHead: { position: 'absolute', right: 1, top: -1, width: 0, height: 0, borderLeftWidth: 4, borderRightWidth: 4, borderBottomWidth: 6, borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: C.ink, transform: [{ rotate: '90deg' }] },
  sensorRow: { minHeight: 56, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, backgroundColor: C.card, justifyContent: 'center' },
  rowBody: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tight: { marginTop: 6 - GAP }, // 6 pt between rows instead of the list's GAP
  rowName: { fontFamily: 'Onest_600SemiBold', fontSize: 15, color: C.ink },
  rowLine: { fontFamily: 'Onest_400Regular', fontSize: 13, lineHeight: 18, color: C.muted },
  rowSignal: { fontFamily: 'Onest_400Regular', fontSize: 13, color: C.muted, fontVariant: ['tabular-nums'] },
  stateOk: { fontFamily: 'Onest_500Medium', color: C.ink },
  stateWarn: { color: C.warn },
  small: { fontFamily: 'Onest_400Regular', fontSize: 14, lineHeight: 20, color: C.muted },
  center: { textAlign: 'center' },
  secondary: { backgroundColor: C.bg, borderRadius: 999, minHeight: 44, minWidth: 92, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderWidth: 1, borderColor: C.line },
  secondaryText: { fontFamily: 'Onest_500Medium', fontSize: 15, color: C.ink },
  requirements: { gap: 8 },
  batch: { gap: 10 },
  stateWarnLine: { fontFamily: 'Onest_400Regular', fontSize: 14, lineHeight: 20, color: C.warn },
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

// The app, or its demo: 200 simulated sensors instead of the radio (src/demo.ts). Switching remounts the screen, so no
// sensor, result, scan or credential crosses from one mode to the other. Launched with `-demo 1` (simctl) on iOS, or
// `?demo=1` on the web build, it opens in the demo.
export default function App() {
  const [demo, setDemo] = useState<Demo | null>(() => (launchedInDemo() ? startDemo(Crypto.getRandomBytes) : null));
  useEffect(() => () => demo?.stop(), [demo]);
  return <Provide key={demo ? 'demo' : 'real'} demo={demo} onDemo={on => setDemo(on ? startDemo(Crypto.getRandomBytes) : null)} />;
}

function launchedInDemo() {
  if (Platform.OS === 'ios') return String(Settings.get('demo')) === '1';
  if (Platform.OS === 'web') return new URLSearchParams(globalThis.location?.search).get('demo') === '1';
  return false;
}
