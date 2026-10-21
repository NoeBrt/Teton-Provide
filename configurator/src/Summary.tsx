// The overall of the sensors in range, in the card style: how many are set up, one bar for all of them, and the three
// groups, each a tab that filters the card list below (tap it again for all). Words and shapes, no symbols.
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Group } from './wing.ts';
import { C, F } from './theme.ts';

const GROUPS: [Group, string][] = [['done', 'Set up'], ['failed', 'Errors'], ['left', 'Not set up']];

type Props = {
  counts: Record<Group, number>;
  line: string | null; // what "not set up" is made of, or the batch's progress
  filter: Group | 'all';
  onFilter: (filter: Group | 'all') => void;
};

export function Summary({ counts, line, filter, onFilter }: Props) {
  const total = counts.done + counts.failed + counts.left;
  return (
    <View style={s.card}>
      <Text style={s.hero} maxFontSizeMultiplier={1.3}>
        {counts.done} set up <Text style={s.tone}>of {total} in range</Text>
      </Text>
      {line && <Text style={s.small} maxFontSizeMultiplier={1.3}>{line}</Text>}
      {/* Same order and colours as the groups below: set up in ink, as a progress bar fills, errors in red. */}
      <View style={s.bar} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <View style={[s.fill, { flex: counts.done }]} />
        <View style={[s.fill, s.fillWarn, { flex: counts.failed }]} />
        <View style={{ flex: counts.left }} />
      </View>
      <View style={s.groups} accessibilityRole="tablist">
        {GROUPS.map(([group, label]) => {
          const on = filter === group;
          const count = counts[group];
          const alert = group === 'failed' && count > 0 && !on;
          return (
            <Pressable key={group} style={[s.group, alert && s.groupWarn, on && s.groupOn, count === 0 && !on && s.disabled]} disabled={count === 0 && !on}
              onPress={() => onFilter(on ? 'all' : group)} accessibilityRole="tab" accessibilityState={{ selected: on, disabled: count === 0 && !on }}
              accessibilityLabel={`${label}, ${count}`} accessibilityHint={on ? 'Shows all sensors' : `Shows only these sensors`}>
              <View style={s.legend}>
                <Swatch group={group} on={on} />
                <Text style={[s.count, alert && s.warn, on && s.light]} maxFontSizeMultiplier={1.3}>{count}</Text>
              </View>
              <Text style={[s.label, alert && s.warn, on && s.light]} numberOfLines={2} maxFontSizeMultiplier={1.3}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** The group's shape, also in the compact sensor rows: filled ink, filled red, or hollow. On a selected (ink) tab, a
 * plain light fill: mint, pale red, grey. */
export function Swatch({ group, on = false }: { group: Group; on?: boolean }) {
  if (on) return <View style={[s.swatch, s.swatchOn, group === 'done' && s.swatchDoneOn, group === 'failed' && s.swatchWarnOn]} />;
  return <View style={[s.swatch, group === 'done' && s.swatchDone, group === 'failed' && s.swatchWarn]} />;
}

const s = StyleSheet.create({
  card: { backgroundColor: C.card, borderRadius: 10, padding: 16, gap: 10 },
  hero: { fontFamily: F.medium, fontSize: 26, lineHeight: 30, letterSpacing: -0.8, color: C.ink, fontVariant: ['tabular-nums'] },
  tone: { color: C.tone },
  small: { fontFamily: F.regular, fontSize: 14, lineHeight: 20, color: C.muted, marginTop: -6 },
  bar: { flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: C.bg },
  fill: { backgroundColor: C.ink },
  fillWarn: { backgroundColor: C.warn },
  groups: { flexDirection: 'row', gap: 8 },
  group: { flex: 1, minHeight: 64, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, gap: 2, backgroundColor: C.bg, justifyContent: 'center' },
  groupWarn: { backgroundColor: C.warnBg },
  groupOn: { backgroundColor: C.ink },
  count: { fontFamily: F.bold, fontSize: 20, color: C.ink, fontVariant: ['tabular-nums'] },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 8, height: 8, borderRadius: 2, borderWidth: 1, borderColor: C.tone },
  swatchDone: { backgroundColor: C.ink, borderColor: C.ink },
  swatchWarn: { backgroundColor: C.warn, borderColor: C.warn },
  swatchOn: { borderWidth: 0, backgroundColor: C.tone },
  swatchDoneOn: { backgroundColor: C.mint },
  swatchWarnOn: { backgroundColor: C.warnBg },
  label: { fontFamily: F.regular, fontSize: 14, lineHeight: 18, color: C.muted },
  warn: { color: C.warn },
  light: { color: '#ffffff' },
  disabled: { opacity: 0.45 },
});
