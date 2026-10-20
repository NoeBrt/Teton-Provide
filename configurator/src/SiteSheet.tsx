import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { credentialError } from './provision.ts';
import { removeSite, upsertSite, type Site } from './sites.ts';
import { C, F } from './theme.ts';

// Saved sites live in the Keychain on this phone only. Each password sits in its own entry behind Face ID
// (iOS biometryCurrentSet): reading it asks Face ID, and re-enrolling Face ID makes it unreadable.
const LIST = 'sites';
const ACTIVE = 'active-site';
const LEGACY = 'site-network'; // single-site version: a password without Face ID, removed on start
const passwordKey = (id: string) => `site-password-${id}`;
const STORED = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
const NB = 'Wi‑Fi';

const isSite = (value: unknown): value is Site =>
  ['id', 'name', 'ssid'].every(key => typeof (value as Record<string, unknown> | null)?.[key] === 'string');

export async function loadSites(): Promise<{ sites: Site[]; activeId: string | null }> {
  await SecureStore.deleteItemAsync(LEGACY).catch(() => {});
  let sites: Site[] = [];
  try {
    const parsed = JSON.parse((await SecureStore.getItemAsync(LIST, STORED)) ?? '[]');
    if (Array.isArray(parsed)) sites = parsed.filter(isSite);
  } catch {
    sites = [];
  }
  const activeId = await SecureStore.getItemAsync(ACTIVE, STORED).catch(() => null);
  return { sites, activeId: sites.some(site => site.id === activeId) ? activeId : null };
}

export const setActiveSite = (id: string | null) =>
  (id ? SecureStore.setItemAsync(ACTIVE, id, STORED) : SecureStore.deleteItemAsync(ACTIVE, STORED)).catch(() => {});

/** Asks Face ID, then returns the site's password; null if cancelled or no longer readable. */
export const unlockPassword = (site: Site) =>
  SecureStore.getItemAsync(passwordKey(site.id), { ...STORED, requireAuthentication: true, authenticationPrompt: `Use the ${NB} password of ${site.name}` })
    .catch(() => null);

async function saveSite(sites: Site[], site: Site, password: string): Promise<Site[]> {
  // Replace instead of update: iOS asks Face ID to update an entry, never to create one.
  await SecureStore.deleteItemAsync(passwordKey(site.id), STORED);
  await SecureStore.setItemAsync(passwordKey(site.id), password, { ...STORED, requireAuthentication: true });
  const next = upsertSite(sites, site);
  await SecureStore.setItemAsync(LIST, JSON.stringify(next), STORED);
  return next;
}

async function forgetSite(sites: Site[], id: string): Promise<Site[]> {
  await SecureStore.deleteItemAsync(passwordKey(id), STORED);
  const next = removeSite(sites, id);
  await SecureStore.setItemAsync(LIST, JSON.stringify(next), STORED);
  return next;
}

type Props = {
  visible: boolean;
  sites: Site[];
  activeId: string | null;
  newId: () => string;
  onClose: () => void;
  /** A saved site was picked: the caller unlocks its password. */
  onPick: (site: Site) => void;
  /** A site was saved: its password is already known, no Face ID needed. */
  onSaved: (sites: Site[], site: Site, password: string) => void;
  onForgotten: (sites: Site[], id: string) => void;
};

// One sheet, two views: the saved sites, or the form to add or edit one. Mount with a key that changes on opening.
export function SitesSheet({ visible, sites, activeId, newId, onClose, onPick, onSaved, onForgotten }: Props) {
  const [editing, setEditing] = useState<Site | 'new' | null>(sites.length === 0 ? 'new' : null);
  const [name, setName] = useState('');
  const [ssid, setSsid] = useState('');
  const [password, setPassword] = useState('');
  const [shown, setShown] = useState(false); // a mistyped password is the most likely failure: let the technician check it
  const [error, setError] = useState<string | null>(null);
  const ssidField = useRef<TextInput>(null);
  const passwordField = useRef<TextInput>(null);

  const edit = (site: Site | 'new') => {
    setEditing(site);
    setName(site === 'new' ? '' : site.name);
    setSsid(site === 'new' ? '' : site.ssid);
    setPassword('');
    setError(null);
  };
  const back = () => (sites.length === 0 ? onClose() : setEditing(null));

  const save = async () => {
    if (!name.trim()) return setError('Give the site a name, for example the building.');
    const problem = credentialError(ssid, password);
    if (problem) return setError(problem);
    if (!SecureStore.canUseBiometricAuthentication()) return setError('Turn on Face ID in Settings: saved site passwords are protected by it.');
    const site = { id: editing === 'new' || !editing ? newId() : editing.id, name: name.trim(), ssid };
    try {
      onSaved(await saveSite(sites, site, password), site, password);
    } catch {
      setError('The password could not be saved on this phone. Try again.');
    }
  };

  const forget = async (site: Site) => {
    const next = await forgetSite(sites, site.id).catch(() => removeSite(sites, site.id));
    onForgotten(next, site.id);
    edit('new');
    if (next.length > 0) setEditing(null);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={s.fill} behavior="padding">
        <ScrollView contentContainerStyle={s.sheet} keyboardShouldPersistTaps="handled">
          {editing === null ? (
            <>
              <Text style={s.title} maxFontSizeMultiplier={1.3}>Site {NB}</Text>
              <Text style={s.text}>Pick the facility you are in. Face ID unlocks its password once for this session.</Text>
              {sites.map(site => (
                <View key={site.id} style={[s.siteRow, site.id === activeId && s.siteActive]}>
                  <Pressable style={s.grow} onPress={() => onPick(site)} accessibilityRole="button" accessibilityLabel={`Use ${site.name}`}>
                    <Text style={s.siteName} numberOfLines={2}>{site.name}</Text>
                    <Text style={s.text} numberOfLines={1}>{site.ssid}</Text>
                  </Pressable>
                  <Pressable style={s.small} onPress={() => edit(site)} accessibilityRole="button" accessibilityLabel={`Edit ${site.name}`}>
                    <Text style={s.secondaryText}>Edit</Text>
                  </Pressable>
                </View>
              ))}
              <Pressable style={s.primary} onPress={() => edit('new')} accessibilityRole="button">
                <Text style={s.primaryText}>Add a site</Text>
              </Pressable>
              <Pressable style={s.secondary} onPress={onClose} accessibilityRole="button">
                <Text style={s.secondaryText}>Close</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={s.title} maxFontSizeMultiplier={1.3}>{editing === 'new' ? 'New site' : 'Edit site'}</Text>
              <Text style={s.text}>Every sensor you set up here joins this network.</Text>
              <Text style={s.label}>SITE NAME</Text>
              <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Hôpital Nord – Bât. B" returnKeyType="next"
                onSubmitEditing={() => ssidField.current?.focus()} submitBehavior="submit" accessibilityLabel="Site name" />
              <Text style={s.label}>NETWORK NAME</Text>
              <TextInput ref={ssidField} style={s.input} value={ssid} onChangeText={setSsid} autoCapitalize="none" autoCorrect={false} placeholder="Ward-3"
                returnKeyType="next" onSubmitEditing={() => passwordField.current?.focus()} submitBehavior="submit" accessibilityLabel="Network name" />
              <Text style={s.label}>PASSWORD</Text>
              <View style={s.row}>
                <TextInput ref={passwordField} style={[s.input, s.grow]} value={password} onChangeText={setPassword} secureTextEntry={!shown}
                  autoCapitalize="none" autoCorrect={false} textContentType="password" returnKeyType="done" onSubmitEditing={save}
                  placeholder={editing === 'new' ? undefined : 'Enter it again to change it'} accessibilityLabel="Password" />
                <Pressable style={s.toggle} onPress={() => setShown(value => !value)} accessibilityRole="button" accessibilityLabel={shown ? 'Hide the password' : 'Show the password'}>
                  <Text style={s.secondaryText}>{shown ? 'Hide' : 'Show'}</Text>
                </Pressable>
              </View>
              {error && <Text style={s.warn} accessibilityRole="alert">{error}</Text>}
              <Pressable style={s.primary} onPress={save} accessibilityRole="button">
                <Text style={s.primaryText}>Save</Text>
              </Pressable>
              <Pressable style={s.secondary} onPress={back} accessibilityRole="button">
                <Text style={s.secondaryText}>{sites.length === 0 ? 'Cancel' : 'Back'}</Text>
              </Pressable>
              {editing !== 'new' && (
                <Pressable style={s.link} onPress={() => forget(editing)} accessibilityRole="button" accessibilityLabel={`Forget ${editing.name} on this phone`}>
                  <Text style={s.linkText}>Forget this site on this phone</Text>
                </Pressable>
              )}
            </>
          )}
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
  label: { fontFamily: F.medium, fontSize: 12, letterSpacing: 0.7, color: C.blue, marginTop: 8 },
  input: { fontFamily: F.regular, fontSize: 17, color: C.ink, backgroundColor: C.card, borderRadius: 10, paddingHorizontal: 14, minHeight: 48 },
  row: { flexDirection: 'row', gap: 8 },
  grow: { flex: 1 },
  siteRow: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: C.card, borderRadius: 10, padding: 14, borderWidth: 2, borderColor: C.card },
  siteActive: { borderColor: C.ink },
  siteName: { fontFamily: F.bold, fontSize: 16, color: C.ink },
  small: { minHeight: 44, minWidth: 64, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: C.line, backgroundColor: C.bg },
  toggle: { minWidth: 72, minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: C.line },
  warn: { fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: C.warn, backgroundColor: C.warnBg, borderRadius: 10, padding: 12, overflow: 'hidden' },
  primary: { backgroundColor: C.ink, borderRadius: 999, minHeight: 48, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  primaryText: { fontFamily: F.medium, fontSize: 16, color: '#ffffff' },
  secondary: { borderRadius: 999, minHeight: 48, paddingVertical: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line },
  secondaryText: { fontFamily: F.medium, fontSize: 16, color: C.ink },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  linkText: { fontFamily: F.medium, fontSize: 15, color: C.warn },
});
