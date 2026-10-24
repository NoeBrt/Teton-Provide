import { useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as SecureStore from './secureStore';
import { parseTokenText, toHex, type Token } from './authority.ts';
import { QrCamera } from './QrCamera';
import { Sheet } from './Sheet';
import { PASTE_KEY } from './pasteKey.ts';
import { expiryText, pastedCode, tokenProblem, validity } from './technicianCode.ts';

import { C, F } from './theme.ts';

export { expiryText, tokenProblem }; // App.tsx reads them from here

// The technician code (token and holder private key) is a credential: its own Keychain entry behind
// Face ID, on this device only (like site passwords). Its name, customers and expiry are not secret and sit beside
// it, so the app can show them.
const TOKEN = 'technician-token';
const INFO = 'technician-code-info'; // version 2 codes only: an earlier code's info no longer counts
const OLD_INFO = 'technician-info'; // a version 1 code's info, deleted when a new code is saved
const STORED = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export type TokenInfo = { name: string; customers: string[]; expires: number };
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
    <Sheet visible={visible} onClose={onClose} label="Technician code">
      <Text style={s.title} maxFontSizeMultiplier={1.3}>Technician code</Text>
      <Text style={s.text}>
        {replacing && info
          ? `New code: ${codeText(infoOf(replacing))}. It replaces the code of ${codeText(info)}.`
          : info
            ? `${codeText(info)}. Scan or paste a new code to replace it.`
            : 'Sensors only accept a phone with a code from Teton. Scan the code Teton sent you, or paste it.'}
      </Text>
      {replacing && info ? (
        <Pressable style={s.primary} onPress={() => save(replacing)} accessibilityRole="button"
          accessibilityLabel={`Replace the code of ${codeText(info)} with the code of ${codeText(infoOf(replacing))}`}>
          <Text style={s.primaryText}>Replace</Text>
        </Pressable>
      ) : scanning ? (
        <QrCamera hint="The camera reads the technician QR code. Nothing is recorded." onData={scanned} style={s.camera} />
      ) : (
        <CodeField text={text} onChangeText={setText} />
      )}
      {error && <Text style={s.warn} accessibilityRole="alert">{error}</Text>}
      {!scanning && !replacing && pastedCode(text).kind !== 'problem' && ( // the card already says why
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
    </Sheet>
  );
}

// The code is long (about 300 characters: Teton's signature and the holder's key), so it is pasted whole, like a
// recovery key, never typed or shown. Empty: a paste area (a transparent field over it takes the paste, or a long press and
// Paste). Pasted: what the code is for (name, customers and expiry are not secret), or why it cannot be used.
function CodeField({ text, onChangeText }: { text: string; onChangeText: (text: string) => void }) {
  const [focused, setFocused] = useState(false);
  const card = pastedCode(text);
  if (card.kind !== 'empty') {
    return (
      <View style={[s.codeCard, card.kind === 'ok' ? s.codeCardOk : s.codeCardWarn]} accessibilityLiveRegion="polite">
        <View style={s.grow}>
          {card.kind === 'ok' ? (<>
            <Text style={s.codeName}>✓ {card.name}</Text>
            <Text style={s.codeLine}>{card.line}</Text>
          </>) : <Text style={s.codeWarn}>{card.message}</Text>}
          <Text style={s.codeMeta}>{card.length} characters, hidden</Text>
        </View>
        <Pressable onPress={() => onChangeText('')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Clear the pasted code">
          <Text style={s.codeClear}>Clear</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={[s.pasteArea, focused && s.pasteAreaFocused]}>
      <Text style={s.pasteTitle}>Paste your technician code</Text>
      <Text style={s.pasteHow}>{Platform.OS === 'web' ? `Click here, then ${PASTE_KEY}` : 'Press and hold here, then Paste'}</Text>
      <TextInput style={s.pasteInput} value={text} onChangeText={onChangeText} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        caretHidden autoComplete="off" textContentType="none" autoCapitalize="none" autoCorrect={false} spellCheck={false}
        accessibilityLabel="Technician code" accessibilityHint="Paste the code Teton sent you; it stays hidden" />
    </View>
  );
}

const s = StyleSheet.create({
  title: { fontFamily: F.bold, fontSize: 24, letterSpacing: -0.6, color: C.ink, marginTop: 8 },
  text: { fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: C.muted },
  camera: { height: 280 },
  grow: { flex: 1 },
  pasteArea: { minHeight: 96, borderRadius: 10, borderWidth: 1.5, borderStyle: 'dashed', borderColor: C.tone, backgroundColor: C.card,
    alignItems: 'center', justifyContent: 'center', gap: 4, padding: 16 },
  pasteAreaFocused: { borderStyle: 'solid', borderColor: C.blue, backgroundColor: C.bg },
  pasteTitle: { fontFamily: F.medium, fontSize: 16, color: C.ink },
  pasteHow: { fontFamily: F.regular, fontSize: 14, color: C.muted },
  // Over the area, invisible but focusable: it receives the paste.
  pasteInput: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.02, color: 'transparent', fontSize: 16 },
  codeCard: { minHeight: 96, borderRadius: 10, padding: 16, flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  codeCardOk: { backgroundColor: C.mint },
  codeCardWarn: { backgroundColor: C.warnBg },
  codeName: { fontFamily: F.bold, fontSize: 17, color: C.ink },
  codeLine: { fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: C.ink, marginTop: 2 },
  codeWarn: { fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: C.warn },
  codeMeta: { fontFamily: F.regular, fontSize: 13, color: C.muted, marginTop: 6 },
  codeClear: { fontFamily: F.medium, fontSize: 15, color: C.blue },
  warn: { fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: C.warn, backgroundColor: C.warnBg, borderRadius: 10, padding: 12, overflow: 'hidden' },
  primary: { backgroundColor: C.ink, borderRadius: 999, minHeight: 48, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  primaryText: { fontFamily: F.medium, fontSize: 16, color: C.onInk },
  secondary: { borderRadius: 999, minHeight: 48, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line },
  secondaryText: { fontFamily: F.medium, fontSize: 16, color: C.ink },
});
