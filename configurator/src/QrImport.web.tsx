// Desktop: the code is often already on the screen or in a file, so besides the webcam it can be pasted (a
// screenshot or a copied image), dropped onto the window, or chosen as a file. Decoded here with the same decoder as the
// webcam (src/zxing.web.ts); the image is never stored.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { PASTE_KEY } from './pasteKey.ts';
import { C, F } from './theme.ts';

type Props = { onData?: (data: string) => void };
type Detector = { detect(source: ImageBitmapSource): Promise<{ rawValue: string }[]> };

async function decode(blob: Blob): Promise<string | null> {
  const Barcode = (globalThis as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
  if (!Barcode) return null;
  const image = await createImageBitmap(blob);
  try {
    return (await new Barcode({ formats: ['qr_code'] }).detect(image))[0]?.rawValue ?? null;
  } finally {
    image.close();
  }
}

export function QrImport({ onData }: Props) {
  const [note, setNote] = useState<string | null>(null);
  const read = async (blob: Blob | null | undefined) => {
    if (!blob || !blob.type.startsWith('image/')) return;
    setNote('Reading the image…');
    const data = await decode(blob).catch(() => null);
    setNote(data ? null : 'No QR code found in this image. Try a sharper or larger picture of the code.');
    if (data) onData?.(data);
  };
  // While the sheet is open: an image pasted anywhere, or dropped anywhere on the window.
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const item = [...(event.clipboardData?.items ?? [])].find(i => i.type.startsWith('image/'));
      if (!item) return; // text is for the paste field
      event.preventDefault();
      read(item.getAsFile());
    };
    const over = (event: DragEvent) => event.preventDefault();
    const drop = (event: DragEvent) => { event.preventDefault(); read(event.dataTransfer?.files[0]); };
    document.addEventListener('paste', paste);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => { document.removeEventListener('paste', paste); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); };
  }); // re-bound each render, with the current onData
  const choose = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => read(input.files?.[0]);
    input.click();
  };
  return (
    <View style={s.box}>
      <Text style={s.text}>Or paste a screenshot of the code ({PASTE_KEY}), drop its image here, or choose the image.</Text>
      <Pressable style={s.button} onPress={choose} accessibilityRole="button">
        <Text style={s.buttonText}>Choose an image…</Text>
      </Pressable>
      {note && <Text style={s.note} accessibilityLiveRegion="polite">{note}</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  box: { gap: 10, padding: 14, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', borderColor: C.line, alignItems: 'center' },
  text: { fontFamily: F.regular, fontSize: 14, lineHeight: 20, color: C.muted, textAlign: 'center' },
  button: { borderRadius: 999, minHeight: 40, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line },
  buttonText: { fontFamily: F.medium, fontSize: 15, color: C.ink },
  note: { fontFamily: F.regular, fontSize: 14, color: C.muted, textAlign: 'center' },
});
