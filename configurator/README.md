# Configurator (Expo / React Native)

Phone app for the technician. This first version is the **BLE hello probe** only:
it finds devices advertising the IoT service UUID, connects, writes `hello`,
reads `world`, and logs each attempt. It sends no credentials.

Stack: Expo SDK 57, React Native 0.86 (New Architecture), TypeScript,
[`react-native-ble-manager`](https://github.com/innoveit/react-native-ble-manager)
12.5 for Bluetooth. It matches the mobile stack (Expo + React Native).
Bluetooth needs native code, so **Expo Go cannot run it**: use a development build.

## Checks (Linux, no phone needed)

Node 22.18 or later (`nvm install 22`): the tests rely on Node's built-in
TypeScript type stripping.

```sh
npm ci
npm test            # Noise, certificates, codes, setup and the 200-sensor batch against fakes
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
app (“provide.”): the search runs by itself (tap the centre dot to pause/resume), then **Test** on a sensor (`IOT-` and its ID). Expect
“world” received. Repeat, and toggle Bluetooth or walk away to check reconnects.
Screenshot the log for `demo/phone-hello.txt`.

The bundle identifier `dev.iotchallenge.configurator` in `app.json` can be
changed to one from your Apple account.

## Preview without Bluetooth (Expo Go)

Without a paid Apple account, the UI can still be viewed in Expo Go: `npx expo start
--go --tunnel` (tunnel mode avoids the firewall and needs no shared Wi-Fi), then scan
the QR code. Expo Go has no Bluetooth module, so the app shows “Bluetooth
is unavailable in Expo Go”. Use nRF Connect for the radio test.

## Install on an iPhone from a Mac (free Apple ID)

No paid Apple account is needed when the build is signed by Xcode on a Mac; the
app then expires after 7 days (reinstall with the same command).

Once: install Xcode and open it, point the tools at it
(`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`), Node 22.18+, and CocoaPods
(`brew install cocoapods`); add your Apple ID in Xcode › Settings › Accounts. On the iPhone, trust
the Mac and enable Developer Mode (Settings › Privacy & Security).

Standalone build (JavaScript bundled, no Metro, works offline). Verified on 2026-10-19 with
Xcode 27.1 and an iPhone 15 Pro, iOS 27.0 (`demo/phone-hello.txt`):

```sh
cd configurator && npm ci
npx expo prebuild -p ios                       # generates ios/ (gitignored) and installs pods
open ios/provide.xcworkspace                   # once: Signing & Capabilities › Team › your Personal Team
xcrun devicectl list devices                   # note the iPhone identifier
cd ios && xcodebuild -workspace provide.xcworkspace -scheme provide -configuration Release \
  -destination 'id=<IPHONE_ID>' -derivedDataPath build/dd -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<TEAM_ID> CODE_SIGN_STYLE=Automatic build
xcrun devicectl device install app --device <IPHONE_ID> build/dd/Build/Products/Release-iphoneos/provide.app
```

`<TEAM_ID>` is shown under Signing in Xcode. If Xcode cannot register the bundle identifier, change
`ios.bundleIdentifier` in `app.json` (not in `ios/`) and prebuild again. On the iPhone, trust the
developer in Settings › General › VPN & Device Management, then allow Bluetooth.

For live reload while developing, `npx expo run:ios --device` builds a debug app that loads
JavaScript from Metro on the Mac instead.
