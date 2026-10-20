import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { checkToken, decodeToken, parseTokenText, type Token } from './authority.ts';
import { QrCamera } from './QrCamera';
import { C, F } from './theme.ts';

// The technician token is a credential: its own Keychain entry behind Face ID, on this device only (like site
// passwords). Its holder, customers and expiry are not secret and sit beside it, so the app can show them.
const TOKEN = 'technician-token';
const INFO = 'technician-info';
const STORED = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export type TokenInfo = { name: string; customers: string[]; expires: number };
const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const now = () => Math.floor(Date.now() / 1000);

export const expiryText = (expires: number) =>
  new Date(expires * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export async function loadTokenInfo(): Promise<TokenInfo | null> {
  try {
    const info = JSON.parse((await SecureStore.getItemAsync(INFO, STORED)) ?? 'null');
    return info && typeof info.name === 'string' && Array.isArray(info.customers) && typeof info.expires === 'number' ? info : null;
  } catch {
    return null;
  }
}

/** Asks Face ID, then returns the stored token; null if cancelled, missing or no longer readable. */
export async function unlockToken(): Promise<Token | null> {
  const stored = await SecureStore.getItemAsync(TOKEN, { ...STORED, requireAuthentication: true, authenticationPrompt: 'Use your technician code' })
    .catch(() => null);
  const bytes = stored && /^([0-9a-f]{2})+$/.test(stored) ? Uint8Array.from(stored.match(/../g)!, b => parseInt(b, 16)) : null;
  return bytes && decodeToken(bytes);
}

async function saveToken(token: Token) {
  // Replace instead of update: iOS asks Face ID to update an entry, never to create one.
  await SecureStore.deleteItemAsync(TOKEN, STORED);
  await SecureStore.setItemAsync(TOKEN, toHex(token.bytes), { ...STORED, requireAuthentication: true });
  await SecureStore.setItemAsync(INFO, JSON.stringify({ name: token.name, customers: token.customers, expires: token.expires } satisfies TokenInfo), STORED);
}

/** Why a scanned or pasted code cannot be used, or null if it can. */
export function tokenProblem(token: Token | null): string | null {
  if (!token) return 'This is not a technician code. Scan the QR code IoT sent you, or paste its link.';
  const check = checkToken(token, now());
  if (check === 'invalid') return 'This code was not issued by IoT.';
  if (check === 'expired') return `This code expired on ${expiryText(token.expires)}. Ask IoT for a new one.`;
  return null;
}

type Props = {
  visible: boolean;
  /** A link the app was opened with, already filled in. */
  initial: string | null;
  info: TokenInfo | null;
  onClose: () => void;
  /** A checked token was saved behind Face ID; the caller may use it right away. */
  onSaved: (token: Token, info: TokenInfo) => void;
};

// Mount with a key that changes on opening, so each opening starts clean.
export function TechnicianSheet({ visible, initial, info, onClose, onSaved }: Props) {
  const [text, setText] = useState(initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(!initial);
  const saving = useRef(false); // the camera reports the same code many times a second

  const use = async (input: string) => {
    if (saving.current) return;
    const token = parseTokenText(input);
    const problem = tokenProblem(token);
    if (problem) return setError(problem);
    if (!SecureStore.canUseBiometricAuthentication()) return setError('Turn on Face ID in Settings: your technician code is protected by it.');
    saving.current = true;
    try {
      await saveToken(token!);
      onSaved(token!, { name: token!.name, customers: token!.customers, expires: token!.expires });
    } catch {
      setError('The code could not be saved on this phone. Try again.');
    } finally {
      saving.current = false;
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.fill} behavior="padding">
        <ScrollView contentContainerStyle={s.sheet} keyboardShouldPersistTaps="handled">
          <Text style={s.title} maxFontSizeMultiplier={1.3}>Technician code</Text>
          <Text style={s.text}>
            {info
              ? `${info.name} · ${info.customers.join(', ')} · valid until ${expiryText(info.expires)}. Scan or paste a new code to replace it.`
              : 'Sensors only accept a phone with a code from IoT. Scan the QR code IoT sent you, or open its link on this phone.'}
          </Text>
          {scanning ? (
            <QrCamera hint="The camera reads the technician QR code. Nothing is recorded." onData={use} style={s.camera} />
          ) : (
            <TextInput style={s.input} value={text} onChangeText={setText} placeholder="provide://technician/…" autoCapitalize="none"
              autoCorrect={false} multiline accessibilityLabel="Technician code" />
          )}
          {error && <Text style={s.warn} accessibilityRole="alert">{error}</Text>}
          {!scanning && (
            <Pressable style={s.primary} onPress={() => use(text)} accessibilityRole="button">
              <Text style={s.primaryText}>Save</Text>
            </Pressable>
          )}
          <Pressable style={s.secondary} onPress={() => { setError(null); setScanning(value => !value); }} accessibilityRole="button">
            <Text style={s.secondaryText}>{scanning ? 'Paste the link instead' : 'Scan the QR code instead'}</Text>
          </Pressable>
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
