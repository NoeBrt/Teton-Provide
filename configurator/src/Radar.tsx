import { useEffect } from 'react';
import { Pressable, StyleSheet, type ColorValue } from 'react-native';
import Animated, {
  Easing, interpolate, useAnimatedStyle, useFrameCallback, useReducedMotion, useSharedValue, withSpring, withTiming, type SharedValue,
} from 'react-native-reanimated';

const PERIOD_MS = 2000;
const COMPACT_PERIOD_MS = 2600; // calmer pace when the radar sits beside the list
const WAVES = [0, 0.5]; // start delay of each circle (in cycles): the next leaves the dot half a cycle later
const GROW = 0.6; // share of the cycle a circle lives: spreads to the edge (1.2 s in the large view)
const FADE_FROM = 0.4; // it starts fading while still moving, so it never stalls at the edge
const THIN = 0.4; // the stroke loses 40% as it spreads, like a wave losing energy
const EMIT = 0.12; // the dot swells briefly (6%) as each circle leaves it
// Press feedback: the dot grows while held, then springs back with a little overshoot on release.
export const HOLD = { duration: 600, easing: Easing.out(Easing.cubic) };
export const HOLD_SCALE = 0.4;
export const RELEASE = { damping: 7, stiffness: 220, mass: 0.8 };
// Stroke and dot are tuned at both radar sizes (compact 48 pt, large 320 pt) and interpolated in between,
// so the resize stays continuous. The dot keeps a 44 pt touch target through hitSlop.
export const SIZES = [48, 320];
const STROKES = [2.5, 5];
export const DOTS = [14, 40];
const dotFor = (size: number) => { 'worklet'; return interpolate(size, SIZES, DOTS, 'clamp'); };
export const RESIZE = { duration: 450, easing: Easing.inOut(Easing.cubic) }; // shared with the layout transition in App

// `size` is driven by the caller (the scroll position), so the radar follows the finger instead of animating on its own.
type Props = { active: boolean; color: ColorValue; size: SharedValue<number>; label: string; onPress: () => void };

// Waves while the phone listens for sensors; the centre dot is the pause/resume button.
// Everything runs on the UI thread, so discovery re-renders never stutter the waves or the resize.
export function Radar({ active, color, size, label, onPress }: Props) {
  const reduceMotion = useReducedMotion();
  const t = useSharedValue(0);
  const box = size;
  const press = useSharedValue(0);

  // The wave clock advances every frame and is never restarted; its pace follows the size (calmer when compact).
  const clock = useFrameCallback(({ timeSincePreviousFrame: dt }) => {
    const period = interpolate(box.value, SIZES, [COMPACT_PERIOD_MS, PERIOD_MS], 'clamp');
    t.value += (dt ?? 0) / period; // cycles since the search (re)started; every circle is born at the dot
  }, false);
  useEffect(() => {
    const running = active && !reduceMotion;
    clock.setActive(running);
    if (!running) t.set(0); // a paused dot rests at its normal size
  }, [active, reduceMotion, clock, t]);

  const boxStyle = useAnimatedStyle(() => ({ width: box.value, height: box.value }));
  const dotStyle = useAnimatedStyle(() => {
    const d = dotFor(box.value);
    const k = (t.value * WAVES.length) % 1; // 0 when a circle leaves the dot
    const swell = k < EMIT ? 0.06 * Math.sin((Math.PI * k) / EMIT) : 0;
    return { width: d, height: d, borderRadius: d / 2, transform: [{ scale: 1 + swell + HOLD_SCALE * press.value }] };
  });

  return (
    <Animated.View style={[s.box, boxStyle]}>
      {active && !reduceMotion && WAVES.map(delay => <Ring key={delay} t={t} box={box} delay={delay} color={color} />)}
      <Pressable onPress={onPress} hitSlop={(44 - DOTS[0]) / 2} accessibilityRole="button" accessibilityLabel={label}
        onPressIn={() => { press.value = withTiming(1, HOLD); }}
        onPressOut={() => { press.value = withSpring(0, RELEASE); }}>
        <Animated.View style={[{ backgroundColor: color }, dotStyle]} />
      </Pressable>
    </Animated.View>
  );
}

// Each ring is laid out at the radar's size and grown with a scale: its diameter then moves continuously, where a
// growing width moved in pixel steps on the 48 pt compact radar and looked jerky. The stroke is set to the original
// stroke divided by the scale, so once scaled it matches it exactly: the drawn ring is the same as before.
function Ring({ t, box, delay, color }: { t: SharedValue<number>; box: SharedValue<number>; delay: number; color: ColorValue }) {
  const style = useAnimatedStyle(() => {
    const age = t.value - delay;
    if (age < 0) return { opacity: 0 }; // not born yet: on (re)start no circle appears half-way
    const phase = age % 1;
    const start = dotFor(box.value);
    const grow = 1 - (1 - Math.min(phase / GROW, 1)) ** 2; // gentle ease-out
    const d = start + (box.value - start) * grow;
    const scale = d / box.value;
    return {
      width: box.value, height: box.value, borderRadius: box.value / 2,
      borderWidth: (interpolate(box.value, SIZES, STROKES, 'clamp') * (1 - THIN * grow)) / scale,
      transform: [{ scale }],
      opacity: interpolate(phase, [0, 0.04, FADE_FROM, GROW], [0, 0.9, 0.9, 0], 'clamp'),
    };
  });
  return <Animated.View pointerEvents="none" style={[s.ring, { borderColor: color }, style]} />;
}

const s = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute' },
});
