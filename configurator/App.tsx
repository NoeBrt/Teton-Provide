import { useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { Onest_400Regular } from '@expo-google-fonts/onest/400Regular';
import { Onest_500Medium } from '@expo-google-fonts/onest/500Medium';
import { Onest_600SemiBold } from '@expo-google-fonts/onest/600SemiBold';
import { BleState, type Peripheral } from 'react-native-ble-manager/src/types';
import { probe, SERVICE_UUID, type ProbeResult, type Step } from './src/probe';
import { BleManager, bleStarted } from './src/ble';

// IoT palette (example.com) with text colours darkened for AA contrast.
const C = { bg: '#ffffff', card: '#f2f4f4', ink: '#1e1e1e', muted: '#646c74', tone: '#8d959d', line: '#e3e5e6', mint: '#bbf0bd', blue: '#2369c4', warn: '#a8301a', warnBg: '#ffe5dd' };
const STEPS: [Step, string][] = [['connect', 'Connexion'], ['services', 'Service IoT'], ['write', 'Écriture « hello »'], ['read', 'Lecture de la réponse']];
const SCAN_SECONDS = 5;

const BLE_HELP: Partial<Record<BleState, string>> = {
  [BleState.Off]: 'Le Bluetooth est désactivé. Activez-le dans le Centre de contrôle.',
  [BleState.TurningOff]: 'Le Bluetooth est désactivé. Activez-le dans le Centre de contrôle.',
  [BleState.Unauthorized]: 'L’app n’a pas accès au Bluetooth. Autorisez-le dans Réglages, puis revenez.',
  [BleState.Unsupported]: 'Ce téléphone ne prend pas en charge le Bluetooth Low Energy.',
};

function failureText(result: Extract<ProbeResult, { ok: false }>): string {
  if (result.step === 'connect') return 'Le capteur ne répond pas. Rapprochez-vous, puis réessayez.';
  if (result.step === 'services') return 'Ce capteur n’expose pas le service IoT.';
  if (result.step === 'write') return 'Le capteur a refusé la requête.';
  if (result.reason === 'unexpected-reply') return 'Réponse inattendue du capteur.';
  return 'La liaison Bluetooth a échoué. Réessayez.';
}

type Attempt = { key: number; at: string; name: string; result: ProbeResult };
const nameOf = (p: Peripheral) => p.advertising?.localName ?? p.name ?? 'Capteur sans nom';

export default function App() {
  const [fontsLoaded, fontError] = useFonts({ Onest_400Regular, Onest_500Medium, Onest_600SemiBold });
  const [ble, setBle] = useState<BleState>(BleState.Unknown);
  const [scanning, setScanning] = useState(false);
  const [searched, setSearched] = useState(false);
  const [sensors, setSensors] = useState<Record<string, Peripheral>>({});
  const [running, setRunning] = useState<{ id: string; step: Step } | null>(null);
  const [attempts, setAttempts] = useState<Attempt[]>([]);

  useEffect(() => {
    const ble = BleManager;
    if (!ble || !bleStarted) return;
    const subscriptions = [
      ble.onDidUpdateState(({ state }) => setBle(state)),
      ble.onDiscoverPeripheral(peripheral => setSensors(found => ({ ...found, [peripheral.id]: peripheral }))),
      ble.onStopScan(() => setScanning(false)),
    ];
    bleStarted.then(() => ble.checkState()).then(setBle).catch(() => setBle(BleState.Unsupported));
    return () => subscriptions.forEach(subscription => subscription.remove());
  }, []);

  const search = async () => {
    setSensors({});
    setSearched(true);
    setScanning(true);
    // Only devices advertising the IoT service UUID are listed.
    await BleManager?.scan({ serviceUUIDs: [SERVICE_UUID], seconds: SCAN_SECONDS, allowDuplicates: false }).catch(() => setScanning(false));
  };

  const test = async (sensor: Peripheral) => {
    if (!BleManager) return;
    setRunning({ id: sensor.id, step: 'connect' }); // before any await: blocks a second tap
    if (scanning) await BleManager.stopScan().catch(() => {});
    const result = await probe(BleManager, sensor.id, step => setRunning({ id: sensor.id, step }));
    setRunning(null);
    setAttempts(list => [{ key: Date.now(), at: new Date().toLocaleTimeString('fr-FR'), name: nameOf(sensor), result }, ...list].slice(0, 10));
    AccessibilityInfo.announceForAccessibility(result.ok ? `« world » reçu de ${nameOf(sensor)}.` : `Échec du test. ${failureText(result)}`);
  };

  if (!fontsLoaded && !fontError) return null;
  const ready = ble === BleState.On;
  const last = attempts[0];
  const successes = attempts.filter(attempt => attempt.result.ok).length;

  return (
    <SafeAreaProvider>
      <SafeAreaView style={s.screen}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={s.content}>
          <View style={s.header}>
            <Text style={s.wordmark}>iot.</Text>
            <Text style={s.chip}>SONDE BLE</Text>
          </View>

          <Text style={s.label}>ÉTAPE RADIO · SANS IDENTIFIANT</Text>
          <Text style={s.title}>Tester un capteur. <Text style={s.tone}>Il doit répondre « world » à « hello ».</Text></Text>

          {!BleManager && (
            <View style={[s.card, s.warnCard]} accessibilityRole="alert">
              <Text style={s.warnText}>Bluetooth indisponible dans Expo Go. Installez le build de développement (voir configurator/README.md) pour tester un capteur.</Text>
            </View>
          )}

          {BleManager && !ready && ble !== BleState.Unknown && (
            <View style={[s.card, s.warnCard]} accessibilityRole="alert">
              <Text style={s.warnText}>{BLE_HELP[ble] ?? 'Bluetooth indisponible pour le moment.'}</Text>
            </View>
          )}

          <Pressable style={[s.primary, (!ready || scanning || running) && s.disabled]} disabled={!ready || scanning || !!running} onPress={search} accessibilityRole="button">
            <Text style={s.primaryText}>{scanning ? 'Recherche en cours…' : 'Rechercher les capteurs'}</Text>
          </Pressable>

          {Object.values(sensors).map(sensor => {
            const active = running?.id === sensor.id;
            return (
              <View key={sensor.id} style={s.card}>
                <View style={s.row}>
                  <View style={s.grow}>
                    <Text style={s.sensorName}>{nameOf(sensor)}</Text>
                    {sensor.rssi !== 127 && <Text style={s.small}>Signal {sensor.rssi} dBm</Text>}
                  </View>
                  <Pressable style={[s.secondary, !!running && s.disabled]} disabled={!!running} onPress={() => test(sensor)} accessibilityRole="button" accessibilityLabel={`Tester ${nameOf(sensor)}`}>
                    <Text style={s.secondaryText}>{active ? 'Test…' : 'Tester'}</Text>
                  </Pressable>
                </View>
                {active && STEPS.map(([step, text], index) => {
                  const current = STEPS.findIndex(([key]) => key === running?.step);
                  const state = index < current ? '✓' : index === current ? '…' : String(index + 1);
                  return <Text key={step} style={[s.step, index === current && s.stepActive]}>{state}  {text}</Text>;
                })}
              </View>
            );
          })}
          {searched && !scanning && ready && Object.keys(sensors).length === 0 && (
            <Text style={s.small}>Aucun capteur trouvé. Approchez-vous du capteur et vérifiez qu’il est allumé.</Text>
          )}

          {last && !running && (
            <View style={[s.card, last.result.ok ? s.okCard : s.warnCard]} accessibilityRole="summary">
              <Text style={s.resultTitle}>{last.result.ok ? '« world » reçu' : 'Échec du test'}</Text>
              <Text style={last.result.ok ? s.okText : s.warnText}>
                {last.result.ok ? `${last.name} a répondu en ${last.result.ms} ms.` : failureText(last.result)}
              </Text>
            </View>
          )}

          {attempts.length > 0 && (
            <View style={s.log}>
              <Text style={s.label}>JOURNAL · {successes} RÉUSSITE{successes > 1 ? 'S' : ''} SUR {attempts.length}</Text>
              {attempts.map(attempt => (
                <Text key={attempt.key} style={s.logLine}>
                  {attempt.at}  {attempt.name}  {attempt.result.ok ? `✓ ${attempt.result.ms} ms` : `! ${attempt.result.step} · ${attempt.result.reason}`}
                </Text>
              ))}
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  content: { padding: 20, gap: 14 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: 14, borderBottomWidth: 1, borderColor: C.line },
  wordmark: { fontFamily: 'Onest_600SemiBold', fontSize: 26, letterSpacing: -1.2, color: C.ink },
  chip: { fontFamily: 'Onest_600SemiBold', fontSize: 11, letterSpacing: 0.6, color: C.ink, backgroundColor: C.mint, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, overflow: 'hidden' },
  label: { fontFamily: 'Onest_500Medium', fontSize: 12, letterSpacing: 0.7, color: C.blue, marginTop: 6 },
  title: { fontFamily: 'Onest_500Medium', fontSize: 30, lineHeight: 32, letterSpacing: -1, color: C.ink },
  tone: { color: C.tone },
  card: { backgroundColor: C.card, borderRadius: 10, padding: 16, gap: 6 },
  okCard: { backgroundColor: C.mint },
  warnCard: { backgroundColor: C.warnBg },
  warnText: { fontFamily: 'Onest_400Regular', fontSize: 15, lineHeight: 21, color: C.warn },
  okText: { fontFamily: 'Onest_400Regular', fontSize: 15, lineHeight: 21, color: C.ink },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  grow: { flex: 1 },
  sensorName: { fontFamily: 'Onest_600SemiBold', fontSize: 16, color: C.ink },
  small: { fontFamily: 'Onest_400Regular', fontSize: 14, lineHeight: 20, color: C.muted },
  primary: { backgroundColor: C.ink, borderRadius: 999, minHeight: 52, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 20 },
  primaryText: { fontFamily: 'Onest_500Medium', fontSize: 16, color: '#ffffff' },
  secondary: { backgroundColor: C.bg, borderRadius: 999, minHeight: 44, minWidth: 92, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, borderWidth: 1, borderColor: C.line },
  secondaryText: { fontFamily: 'Onest_500Medium', fontSize: 15, color: C.ink },
  disabled: { opacity: 0.45 },
  step: { fontFamily: 'Onest_400Regular', fontSize: 14, color: C.muted, paddingTop: 2 },
  stepActive: { fontFamily: 'Onest_600SemiBold', color: C.ink },
  resultTitle: { fontFamily: 'Onest_600SemiBold', fontSize: 18, color: C.ink },
  log: { gap: 4, paddingTop: 6 },
  logLine: { fontFamily: 'Onest_400Regular', fontSize: 13, color: C.ink, fontVariant: ['tabular-nums'] },
});
