import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { C, F } from './theme.ts';
import './zxing';
import { QrImport } from './QrImport';

// Focus: continuous autofocus by default; a tap runs one focus pass now (expo-camera's `autofocus="on"` focuses once
// at the centre, where the frame asks for the code), then hands back to continuous focus. expo-camera exposes no lens
// position or focus point, so this is as manual as it gets without native code.
const REFOCUS_MS = 1500;

type Props = { hint: string; onData?: (data: string) => void; style?: StyleProp<ViewStyle> };

/** The camera reading QR codes (the technician code, site Wi-Fi codes), or what it takes to get camera access first. */
export function QrCamera({ hint, onData, style }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const [taps, setTaps] = useState(0); // each tap restarts a focus pass
  const [focusing, setFocusing] = useState(false);
  const pulse = useSharedValue(1);
  const frame = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }));
  useEffect(() => {
    if (!taps) return;
    const done = setTimeout(() => setFocusing(false), REFOCUS_MS);
    return () => clearTimeout(done);
  }, [taps]);
  // Desktop: expo-camera asks the webcam for no resolution, so it opens at its default (often 640×480), too coarse for a
  // dense code like the technician's unless it fills the picture. Once the stream runs, ask for full HD.
  useEffect(() => {
    if (Platform.OS !== 'web' || !permission?.granted) return;
    const wait = setInterval(() => {
      const track = (document.querySelector('video')?.srcObject as MediaStream | null | undefined)?.getVideoTracks()[0];
      if (!track) return;
      clearInterval(wait);
      track.applyConstraints({ width: { ideal: 1920 }, height: { ideal: 1080 } }).catch(() => {}); // a camera below that keeps its best
    }, 200);
    return () => clearInterval(wait);
  }, [permission?.granted]);
  const refocus = () => {
    setFocusing(false); // off then on: a tap during a focus pass starts a new one
    requestAnimationFrame(() => setFocusing(true));
    setTaps(n => n + 1);
    pulse.set(withSequence(withTiming(0.88, { duration: 120 }), withTiming(1, { duration: 260 })));
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  };
  if (permission?.granted) {
    return (<>
      <CameraView style={[s.box, style]} facing="back" autofocus={focusing ? 'on' : 'off'} barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={onData && (({ data }) => onData(data))}>
        <Pressable style={s.overlay} onPress={refocus} accessibilityRole="button" accessibilityLabel="Focus the camera"
          accessibilityHint="Focuses on the code in the frame">
          <Animated.View style={[s.frame, frame]} pointerEvents="none" />
          <Text style={s.guide} pointerEvents="none">Center the code · tap to focus</Text>
        </Pressable>
      </CameraView>
      <QrImport onData={onData} />
    </>);
  }
  const blocked = permission?.canAskAgain === false; // refused before: iOS no longer asks, only Settings can allow it
  return (<>
    <View style={[s.box, s.placeholder, style]}>
      <Text style={s.text}>
        {blocked
          ? 'Camera access is off for this app. Turn it on in Settings.'
          : permission?.status === 'denied' // the desktop app: macOS refused, asking again only works once it is allowed there
            ? 'Camera access is off for this app. Turn it on in System Settings, Privacy & Security, Camera, then try again.'
            : hint}
      </Text>
      <Pressable style={s.primary} onPress={blocked ? () => Linking.openSettings() : () => requestPermission()} accessibilityRole="button">
        <Text style={s.primaryText}>{blocked ? 'Open Settings' : 'Allow the camera'}</Text>
      </Pressable>
    </View>
    <QrImport onData={onData} />
  </>);
}

const s = StyleSheet.create({
  // The defaults on iOS; on the web they undo the camera's own flex: 1, which squashed it to no height.
  box: { flexGrow: 0, flexShrink: 0, flexBasis: 'auto', borderRadius: 16, overflow: 'hidden', backgroundColor: C.card },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  // The code's place: centered, where the focus pass looks.
  frame: { width: '62%', aspectRatio: 1, maxHeight: '78%', borderRadius: 14, borderWidth: 2, borderColor: 'rgba(255,255,255,0.9)',
    shadowColor: '#000000', shadowOpacity: 0.55, shadowRadius: 3, shadowOffset: { width: 0, height: 0 } }, // readable on a white code too
  guide: { position: 'absolute', bottom: 10, fontFamily: F.medium, fontSize: 13, color: '#ffffff', textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
  placeholder: { alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  text: { fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: C.muted, textAlign: 'center' },
  primary: { backgroundColor: C.ink, borderRadius: 999, minHeight: 48, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  primaryText: { fontFamily: F.medium, fontSize: 16, color: C.onInk },
});
