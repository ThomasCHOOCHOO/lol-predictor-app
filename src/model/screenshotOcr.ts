/**
 * On-device OCR for book-odds screenshots — WEB ONLY.
 *
 * Tesseract.js runs on WebAssembly, which React Native does not support
 * (its own docs state this). On native the UI therefore falls back to
 * pasting OCR text / adding rows by hand, and points the user at the web
 * version for screenshot reading. On web the image never leaves the
 * device: Tesseract loads its worker + English language data from its
 * CDN the first time, then reads the image locally.
 *
 * This module is loaded dynamically by the Odds tab so the OCR engine
 * (and its WASM payload) is never bundled into the native app or into
 * screens that don't use it.
 */
import { Platform } from 'react-native';

export async function ocrImageToText(imageDataUrl: string): Promise<string> {
  if (Platform.OS !== 'web') {
    throw new Error(
      'Screenshot OCR runs on the web version only (React Native has no WebAssembly for Tesseract). On the phone app, paste the odds text below instead.',
    );
  }
  let mod: any;
  try {
    mod = await import('tesseract.js');
  } catch {
    throw new Error('OCR engine could not be loaded — check your connection and try again.');
  }
  const recognize = mod.recognize ?? mod.default?.recognize;
  if (typeof recognize !== 'function') {
    throw new Error('OCR engine is unavailable in this build.');
  }
  const result = await recognize(imageDataUrl, 'eng');
  const text = result?.data?.text ?? '';
  if (!text.trim()) throw new Error('OCR read no text from this image — try a tighter crop of just the odds board.');
  return text;
}
