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
 * Upscaling is load-bearing, not cosmetic: on a real Pinnacle board
 * (714 px wide) Tesseract at native resolution returned gibberish, and
 * at 2x it returned the board almost verbatim (team names, (Match) /
 * (Map 1) labels, and both moneyline odds per match). So images
 * narrower than 1200 px are drawn to a 2x canvas before recognition.
 *
 * This module is loaded dynamically by the Odds tab so the OCR engine
 * (and its WASM payload) is never bundled into the native app or into
 * screens that don't use it.
 */
import { Platform } from 'react-native';

async function upscaleIfSmall(imageDataUrl: string): Promise<string> {
  if (typeof document === 'undefined') return imageDataUrl;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Could not load image for OCR.'));
    el.src = imageDataUrl;
  });
  if (img.naturalWidth >= 1200) return imageDataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth * 2;
  canvas.height = img.naturalHeight * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return imageDataUrl;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

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
  let input = imageDataUrl;
  try {
    input = await upscaleIfSmall(imageDataUrl);
  } catch {
    // Upscaling failed — try the original image rather than giving up.
    input = imageDataUrl;
  }
  const result = await recognize(input, 'eng');
  const text = result?.data?.text ?? '';
  if (!text.trim()) throw new Error('OCR read no text from this image — try a tighter crop of just the odds board.');
  return text;
}
