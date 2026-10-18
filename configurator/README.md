# Configurator (Expo / React Native)

Phone app for the technician. This first version is the **BLE hello probe** only:
it finds devices advertising the Teton service UUID, connects, writes `hello`,
reads `world`, and logs each attempt. It sends no credentials.

Stack: Expo SDK 57, React Native 0.86 (New Architecture), TypeScript,
[`react-native-ble-manager`](https://github.com/innoveit/react-native-ble-manager)
12.5 for Bluetooth. It matches Teton's mobile stack (Expo + React Native).
Bluetooth needs native code, so **Expo Go cannot run it**: use a development build.

## Checks (Linux, no phone needed)

Node 22.18 or later (`nvm install 22`): the tests rely on Node's built-in
TypeScript type stripping.

```sh
npm ci
npm test            # probe logic against a fake BLE link
npm run typecheck
npm run lint
```

## Run on an iPhone

Needs an [Expo account](https://expo.dev/signup) and a **paid Apple Developer
account** (EAS signs an ad hoc build for registered devices). No Mac is required:
EAS builds in the cloud. On iOS 16+, enable Developer Mode on the iPhone.

```sh
npx eas-cli@latest login
npx eas-cli@latest device:create          # open the link on the iPhone, install the profile
npx eas-cli@latest build -p ios --profile development
```

Install the build from the QR code on the EAS build page, then:

```sh
npx expo start                            # phone and computer on the same network
```

Open the app, sign in to Expo, and pick the development server. Code changes
reload live.

For the offline demo, build a standalone app that bundles all JavaScript:
`npx eas-cli@latest build -p ios --profile preview`. It needs no development
server and no network.

## Test with the device

On the Ubuntu device: `./target/release/device` (see the root README). In the
app: **Rechercher les capteurs**, then **Tester** on `TETON-DEMO-001`. Expect
« world » reçu. Repeat, and toggle Bluetooth or walk away to check reconnects.
Screenshot the journal for `demo/phone-hello.txt`.

The bundle identifier `dev.tetonchallenge.configurator` in `app.json` can be
changed to one from your Apple account.

## Preview without Bluetooth (Expo Go)

Without a paid Apple account, the UI can still be viewed in Expo Go: `npx expo start
--go --tunnel` (tunnel mode avoids the firewall and needs no shared Wi-Fi), then scan
the QR code. Expo Go has no Bluetooth module, so the app shows « Bluetooth
indisponible dans Expo Go ». Use nRF Connect for the radio test.

## Install on an iPhone from a Mac (free Apple ID)

No paid Apple account is needed when the build is signed by Xcode on a Mac; the
app then expires after 7 days (reinstall with the same command).

Once: install Xcode (open it once), `xcode-select --install`, Node 22.18+, and
CocoaPods (`brew install cocoapods`); add your Apple ID in Xcode › Settings ›
Accounts. On the iPhone, enable Developer Mode.

```sh
git clone https://github.com/NoeBrt/teton-provisioning.git
cd teton-provisioning && git checkout feat/ble-device-and-configurator
cd configurator && npm ci
npx expo run:ios --device        # iPhone plugged in over USB
```

If signing fails, open `ios/*.xcworkspace`, select your Personal Team under
Signing & Capabilities, and change the bundle identifier if Xcode asks. On the
iPhone, trust the developer in Réglages › Général › VPN et gestion de l'appareil.
The app's Bluetooth then works; Metro runs on the Mac.
