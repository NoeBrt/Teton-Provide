// QR decoding, desktop: WebKit has no BarcodeDetector, so expo-camera falls back to barcode-detector, whose ZXing
// decoder fetches its wasm from jsdelivr on the first scan, which fails on a site without internet yet. The wasm is
// served by the app itself instead: `npm install` copies it from zxing-wasm into public/ (the postinstall script),
// and the web export puts public/ next to index.html. zxing.test.ts checks the copy is the one this decoder expects.
import { setZXingModuleOverrides } from 'barcode-detector';

setZXingModuleOverrides({ locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? `/${path}` : prefix + path) });
export {};
