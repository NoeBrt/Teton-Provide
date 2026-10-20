import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { checkToken, parseTokenText, toHex, type Token } from './authority.ts';
import { QrCamera } from './QrCamera';
import { C, F } from './theme.ts';

// The technician code (token and holder private key) is a credential: its own Keychain entry behind
// Face ID, on this device only (like site passwords). Its name, customers and expiry are not secret and sit beside
// it, so the app can show them.
const TOKEN = 'technician-token';
const INFO = 'technician-code-info'; // version 2 codes only: an earlier code's info no longer counts
const OLD_INFO = 'technician-info'; // a version 1 code's info, deleted when a new code is saved
const STORED = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export type TokenInfo = { name: string; customers: string[]; expires: number };
const now = () => Math.floor(Date.now() / 1000);

export const expiryText = (expires: number) =>
  new Date(expires * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const validity = (expires: number) => `${expires <= now() ? 'expired on' : 'valid until'} ${expiryText(expires)}`;
const codeText = (code: TokenInfo) => `${code.name} · ${code.customers.join(', ')} · ${validity(code.expires)}`;
const infoOf = (token: Token): TokenInfo => ({ name: token.name, customers: token.customers, expires: token.expires });

export async function loadTokenInfo(): Promise<TokenInfo | null> {
  try {
    const info = JSON.parse((await SecureStore.getItemAsync(INFO, STORED)) ?? 'null');
    return info && typeof info.name === 'string' && Array.isArray(info.customers) && typeof info.expires === 'number' ? info : null;
  } catch {
    return null;
  }
}

/** Asks Face ID, then returns the stored token; null if cancelled, missing or no longer readable (a version 1 code). */
export async function unlockToken(): Promise<Token | null> {
  const stored = await SecureStore.getItemAsync(TOKEN, { ...STORED, requireAuthentication: true, authenticationPrompt: 'Use your technician code' })
    .catch(() => null);
  return stored ? parseTokenText(stored) : null;
}

async function saveToken(token: Token) {
  // Replace instead of update: iOS asks Face ID to update an entry, never to create one.
  await SecureStore.deleteItemAsync(TOKEN, STORED);
  await SecureStore.setItemAsync(TOKEN, `${toHex(token.bytes)}.${toHex(token.holderPrivate)}`, { ...STORED, requireAuthentication: true });
  await SecureStore.setItemAsync(INFO, JSON.stringify(infoOf(token)), STORED);
  await SecureStore.deleteItemAsync(OLD_INFO, STORED).catch(() => {}); // not secret: a leftover is no reason to fail
}

/** Why a scanned or pasted code cannot be used, or null if it can. */
export function tokenProblem(token: Token | null): string | null {
  if (!token) return 'This is not a technician code. Scan the code IoT sent you, or paste it.';
  const check = checkToken(token, now());
  if (check === 'invalid') return 'This code was not issued by IoT.';
  if (check === 'expired') return `This code expired on ${expiryText(token.expires)}. Ask IoT for a new one.`;
  return null;
}

type Props = {
  visible: boolean;
  info: TokenInfo | null;
  onClose: () => void;
  /** A checked token was saved behind Face ID; the caller may use it right away. */
  onSaved: (token: Token, info: TokenInfo) => void;
};

// Mount with a key that changes on opening, so each opening starts clean.
export function TechnicianSheet({ visible, info, onClose, onSaved }: Props) {
  const [text, setText] = useState(''); // only what the technician pasted or typed: a scanned code is never shown
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const [replacing, setReplacing] = useState<Token | null>(null); // a checked code that waits for Replace
  const saving = useRef(false); // one save at a time
  const lastScan = useRef<string | null>(null); // the camera reports the same code many times a second: read it once

  const save = async (token: Token) => {
    if (saving.current) return; // a double tap on Replace saves once
    saving.current = true;
    try {
      await saveToken(token);
      setText('');
      onSaved(token, infoOf(token));
    } catch {
      lastScan.current = null; // Try again: the camera may read the same code
      setError('The code could not be saved on this phone. Try again.');
    } finally {
      saving.current = false;
    }
  };

  // Parsed once per scanned or pasted code; its name and customers show only once it is checked.
  const accept = (input: string) => {
    if (saving.current || replacing) return;
    const token = parseTokenText(input);
    const problem = tokenProblem(token);
    if (problem) return setError(problem);
    if (!SecureStore.canUseBiometricAuthentication()) return setError('Turn on Face ID in Settings: your technician code is protected by it.');
    setError(null);
    // Another code is stored: replacing it waits for the technician to see both.
    if (info && codeText(info) !== codeText(infoOf(token!))) return setReplacing(token);
    save(token!);
  };
  const scanned = (data: string) => {
    if (data === lastScan.current) return;
    lastScan.current = data;
    accept(data);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.fill} behavior="padding">
        <ScrollView contentContainerStyle={s.sheet} keyboardShouldPersistTaps="handled">
          <Text style={s.title} maxFontSizeMultiplier={1.3}>Technician code</Text>
          <Text style={s.text}>
            {replacing && info
              ? `New code: ${codeText(infoOf(replacing))}. It replaces the code of ${codeText(info)}.`
              : info
                ? `${codeText(info)}. Scan or paste a new code to replace it.`
                : 'Sensors only accept a phone with a code from IoT. Scan the code IoT sent you, or paste it.'}
          </Text>
          {replacing && info ? (
            <Pressable style={s.primary} onPress={() => save(replacing)} accessibilityRole="button"
              accessibilityLabel={`Replace the code of ${codeText(info)} with the code of ${codeText(infoOf(replacing))}`}>
              <Text style={s.primaryText}>Replace</Text>
            </Pressable>
          ) : scanning ? (
            <QrCamera hint="The camera reads the technician QR code. Nothing is recorded." onData={scanned} style={s.camera} />
          ) : (
            <TextInput style={s.input} value={text} onChangeText={setText} placeholder="Paste the code here" autoCapitalize="none"
              autoCorrect={false} multiline accessibilityLabel="Technician code" />
          )}
          {error && <Text style={s.warn} accessibilityRole="alert">{error}</Text>}
          {!scanning && !replacing && (
            <Pressable style={s.primary} onPress={() => accept(text)} accessibilityRole="button">
              <Text style={s.primaryText}>Save</Text>
            </Pressable>
          )}
          {!replacing && (
            <Pressable style={s.secondary} onPress={() => { setError(null); lastScan.current = null; setScanning(value => !value); }} accessibilityRole="button">
              <Text style={s.secondaryText}>{scanning ? 'Paste the code instead' : 'Scan the QR code instead'}</Text>
            </Pressable>
          )}
          <Pressable style={s.secondary} onPress={onClose} accessibilityRole="button">
            <Text style={s.secondaryText}>Close</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg },
  sheet: { padding: 20, gap: 12 },
  title: { fontFamily: F.bold, fontSize: 24, letterSpacing: -0.6, color: C.ink, marginTop: 8 },
  text: { fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: C.muted },
  camera: { height: 280 },
  input: { fontFamily: F.regular, fontSize: 15, color: C.ink, backgroundColor: C.card, borderRadius: 10, padding: 14, minHeight: 96, textAlignVertical: 'top' },
  warn: { fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: C.warn, backgroundColor: C.warnBg, borderRadius: 10, padding: 12, overflow: 'hidden' },
  primary: { backgroundColor: C.ink, borderRadius: 999, minHeight: 48, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  primaryText: { fontFamily: F.medium, fontSize: 16, color: '#ffffff' },
  secondary: { borderRadius: 999, minHeight: 48, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line },
  secondaryText: { fontFamily: F.medium, fontSize: 16, color: C.ink },
});
