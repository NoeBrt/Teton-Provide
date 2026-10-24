import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { C, DESKTOP_MIN_WIDTH } from './theme';

/** Same forms on phone and desktop; RN Modal owns Escape, focus trapping and focus return on web. */
export function Sheet({ visible, onClose, label, children }: { visible: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const { width } = useWindowDimensions();
  const desktop = Platform.OS === 'web' && width >= DESKTOP_MIN_WIDTH;
  return (
    <Modal visible={visible} transparent={desktop} animationType={desktop ? 'fade' : 'slide'} presentationStyle="pageSheet"
      onRequestClose={onClose} accessibilityLabel={label}>
      <View style={desktop ? s.backdrop : s.fill}>
        <KeyboardAvoidingView style={[s.fill, desktop && s.dialog]} behavior={desktop ? undefined : 'padding'}>
          <ScrollView contentContainerStyle={s.sheet} keyboardShouldPersistTaps="handled">{children}</ScrollView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  backdrop: { flex: 1, padding: 32, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(30,30,30,0.3)' },
  dialog: { flex: undefined, width: '100%', maxWidth: 560, maxHeight: '100%', borderRadius: 16, overflow: 'hidden' },
  sheet: { padding: 20, gap: 12 },
});
