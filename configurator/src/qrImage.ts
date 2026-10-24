// Reading a QR code from an image on the desktop (QrImport.web.tsx): which pasted or dropped item is the image, and
// decoding it locally with the shipped decoder (src/zxing.web.ts). Pure, the browser parts injected, so it is tested
// without a browser.
type Item = Blob | { type: string; getAsFile(): Blob | null };
type Bitmap = { close(): void };
export type QrDecoder = { toBitmap(image: Blob): Promise<Bitmap>; detect(bitmap: Bitmap): Promise<{ rawValue: string }[]> };

/** The first image among clipboard items or dropped files; text is left to the paste field. */
export function firstImage(items: ArrayLike<Item>): Blob | null {
  const item = Array.from(items).find(i => i.type.startsWith('image/'));
  return !item ? null : item instanceof Blob ? item : item.getAsFile();
}

/** The text of the first QR code in the image, or null (no code in it, or no decoder). The bitmap is always released. */
export async function decodeImage(image: Blob, decoder: QrDecoder | null): Promise<string | null> {
  if (!decoder) return null;
  const bitmap = await decoder.toBitmap(image);
  try {
    return (await decoder.detect(bitmap))[0]?.rawValue ?? null;
  } finally {
    bitmap.close();
  }
}

/** The page's decoder: BarcodeDetector (native, or the polyfill src/zxing.web.ts installs) over createImageBitmap. */
export function browserDecoder(): QrDecoder | null {
  type Detector = { detect(source: unknown): Promise<{ rawValue: string }[]> };
  const Barcode = (globalThis as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
  if (!Barcode || typeof createImageBitmap === 'undefined') return null;
  const detector = new Barcode({ formats: ['qr_code'] });
  return { toBitmap: image => createImageBitmap(image), detect: bitmap => detector.detect(bitmap) };
}
