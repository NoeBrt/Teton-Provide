import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { parseLabel } from './setup.ts';
import type { Label } from './noise.ts';
import { C, F } from './theme.ts';

// Sensor IDs like IOT-DEMO-004 must not wrap at their hyphens.
const unbroken = (text: string | null) => text?.replace(/-/g, '\u2011') ?? '';

type Props = { sensorName: string | null; onCancel: () => void; onLabel: (label: Label) => void };

// Reads the QR label of the sensor being set up. A label for another sensor, or any other QR code, is refused.
export function LabelScanner({ sensorName, onCancel, onLabel }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [message, setMessage] = useState<string | null>(null);
  const visible = sensorName !== null;

  const onScanned = ({ data }: BarcodeScanningResult) => {
    const label = parseLabel(data);
    if (!label) return setMessage('This is not a IoT sensor label.');
    if (label.deviceId !== sensorName) return setMessage(`This label belongs to ${unbroken(label.deviceId)}. Scan the label on ${unbroken(sensorName)}.`);
    setMessage(null);
    onLabel(label);
  };
  const close = () => { setMessage(null); onCancel(); };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={s.sheet}>
        <Text style={s.title} maxFontSizeMultiplier={1.3}>Scan the sensor label</Text>
        <Text style={s.text}>Point the camera at the QR code on {unbroken(sensorName)}.</Text>
        {permission?.granted ? (
          <CameraView style={s.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={visible ? onScanned : undefined} />
        ) : (
          <View style={[s.camera, s.placeholder]}>
            <Text style={[s.text, s.center]}>The camera reads the QR label on each sensor. Nothing is recorded.</Text>
            <Pressable style={s.primary} onPress={requestPermission} accessibilityRole="button">
              <Text style={s.primaryText}>Allow the camera</Text>
            </Pressable>
          </View>
        )}
        {message && <Text style={s.warn} accessibilityRole="alert">{message}</Text>}
        <Pressable style={s.secondary} onPress={close} accessibilityRole="button">
          <Text style={s.secondaryText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: C.bg, padding: 20, gap: 14 },
  title: { fontFamily: F.bold, fontSize: 24, letterSpacing: -0.6, color: C.ink, marginTop: 8 },
  text: { fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: C.muted },
  center: { textAlign: 'center' },
  camera: { flex: 1, borderRadius: 16, overflow: 'hidden', backgroundColor: C.card },
  placeholder: { alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  warn: { fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: C.warn, backgroundColor: C.warnBg, borderRadius: 10, padding: 12, overflow: 'hidden' },
  primary: { backgroundColor: C.ink, borderRadius: 999, minHeight: 48, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  primaryText: { fontFamily: F.medium, fontSize: 16, color: '#ffffff' },
  secondary: { borderRadius: 999, minHeight: 48, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line },
  secondaryText: { fontFamily: F.medium, fontSize: 16, color: C.ink },
});
