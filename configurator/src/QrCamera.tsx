import { Linking, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { C, F } from './theme.ts';

type Props = { hint: string; onData?: (data: string) => void; style?: StyleProp<ViewStyle> };

/** The camera reading QR codes (sensor labels, Wi-Fi codes), or what it takes to get camera access first. */
export function QrCamera({ hint, onData, style }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  if (permission?.granted) {
    return <CameraView style={[s.box, style]} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onData && (({ data }) => onData(data))} />;
  }
  const blocked = permission?.canAskAgain === false; // refused before: iOS no longer asks, only Settings can allow it
  return (
    <View style={[s.box, s.placeholder, style]}>
      <Text style={s.text}>{blocked ? 'Camera access is off for this app. Turn it on in Settings.' : hint}</Text>
      <Pressable style={s.primary} onPress={blocked ? () => Linking.openSettings() : () => requestPermission()} accessibilityRole="button">
        <Text style={s.primaryText}>{blocked ? 'Open Settings' : 'Allow the camera'}</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  box: { borderRadius: 16, overflow: 'hidden', backgroundColor: C.card },
  placeholder: { alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  text: { fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: C.muted, textAlign: 'center' },
  primary: { backgroundColor: C.ink, borderRadius: 999, minHeight: 48, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  primaryText: { fontFamily: F.medium, fontSize: 16, color: '#ffffff' },
});
