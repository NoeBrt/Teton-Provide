// Keep the app's Keychain identity stable across local updates. No certificate or private key leaves the Keychain.
import { execFileSync } from 'node:child_process';

const app = process.argv[2];
if (!app) throw new Error('Usage: node desktop/sign.mjs <Provide.app>');
let identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
if (!identity) {
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  identity = identities.match(/\b([A-Fa-f0-9]{40})\s+"(?:Apple Development:|Developer ID Application:)[^"]+"/)?.[1] ?? '-';
}
if (identity === '-') console.warn('Ad-hoc signing: Keychain access may be requested again after updates. Install an Apple signing certificate for a stable identity.');
execFileSync('codesign', ['--force', '--sign', identity, '--identifier', 'dev.tetonchallenge.provide', app], { stdio: 'inherit' });
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
