// Radar, desktop: the same radar, its waves as CSS animations. macOS stops the page's animation frames while a window
// is being resized, which froze the frame-driven waves (Radar.tsx); CSS animations of transform and opacity keep
// running in the system compositor. The size still follows the scroll through Reanimated, as on iOS.
import { Pressable, StyleSheet, View, type ColorValue } from 'react-native';
import Animated, { interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { DOTS, HOLD, HOLD_SCALE, RELEASE, RESIZE, SIZES } from './Radar.tsx';

export { RESIZE, SIZES };

const STROKE = 3;

// Each ring is the radar's full size, scaled from the dot outwards: four rings on a 4 s cycle, one leaving every second,
// each reaching the edge and fading out within 1.2 s, like Radar.tsx's waves; the dot swells as each one leaves it.
const css = `
@keyframes provide-wave { 0% { transform: scale(0.14); opacity: 0; } 2% { opacity: 0.9; } 20% { opacity: 0.9; }
  30% { transform: scale(1); opacity: 0; } 100% { transform: scale(1); opacity: 0; } }
@keyframes provide-emit { 0% { transform: scale(1); } 6% { transform: scale(1.06); } 12%, 100% { transform: scale(1); } }
[data-wave] { animation: provide-wave 4000ms cubic-bezier(0.33, 1, 0.68, 1) infinite; opacity: 0; will-change: transform, opacity; }
[data-wave="1"] { animation-delay: 1000ms; }
[data-wave="2"] { animation-delay: 2000ms; }
[data-wave="3"] { animation-delay: 3000ms; }
[data-emit] { animation: provide-emit 1000ms ease-out infinite; }
@media (prefers-reduced-motion: reduce) { [data-wave] { display: none; } [data-emit] { animation: none; } }
`;
if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

type Props = { active: boolean; color: ColorValue; size: SharedValue<number>; label: string; onPress: () => void };

export function Radar({ active, color, size, label, onPress }: Props) {
  const reduceMotion = useReducedMotion();
  const press = useSharedValue(0);
  const boxStyle = useAnimatedStyle(() => ({ width: size.value, height: size.value }));
  const dotStyle = useAnimatedStyle(() => {
    const d = interpolate(size.value, SIZES, DOTS, 'clamp');
    return { width: d, height: d, borderRadius: d / 2, transform: [{ scale: 1 + HOLD_SCALE * press.value }] };
  });
  const waving = active && !reduceMotion;
  return (
    <Animated.View style={[s.box, boxStyle]}>
      {waving && [0, 1, 2, 3].map(i => (
        <View key={i} pointerEvents="none" style={[s.ring, { borderColor: color }]} {...{ dataSet: { wave: String(i) } }} />
      ))}
      <Pressable onPress={onPress} hitSlop={(44 - DOTS[0]) / 2} accessibilityRole="button" accessibilityLabel={label}
        onPressIn={() => { press.value = withTiming(1, HOLD); }}
        onPressOut={() => { press.value = withSpring(0, RELEASE); }}>
        <Animated.View style={dotStyle}>
          <View style={[s.fill, { backgroundColor: color }]} {...{ dataSet: waving ? { emit: 'true' } : undefined }} />
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

const s = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: 9999, borderWidth: STROKE },
  fill: { flex: 1, borderRadius: 9999 },
});
