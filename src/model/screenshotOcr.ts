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
 * Resizing is load-bearing, not cosmetic: on a real Pinnacle board
 * (714 px wide) Tesseract at native resolution returned gibberish, and
 * at 2x it returned the board almost verbatim (team names, (Match) /
 * (Map 1) labels, and both moneyline odds per match). Small images are
 * upscaled 2x; large phone photos are downscaled to 2000 px wide so
 * mobile Safari doesn't run out of memory inside the OCR worker.
 *
 * This module is loaded dynamically by the Odds tab so the OCR engine
 * (and its WASM payload) is never bundled into the native app or into
 * screens that don't use it.
 */
import { Platform } from 'react-native';

/**
 * Resize the image into the range Tesseract actually reads well, in the
 * browser, before recognition. This is the phone-web path:
 * - Small desktop screenshots (< 900 px wide, e.g. the 714 px Pinnacle
 *   board) are upscaled 2x — at native resolution Tesseract returned
 *   gibberish, at 2x it returned the board almost verbatim.
 * - Large phone screenshots (> 2000 px wide) are downscaled to 2000 px.
 *   A full-res phone photo is slow and can blow up mobile Safari's
 *   memory inside the OCR worker; 2000 px wide still leaves board text
 *   well above Tesseract's readable size.
 * - Total pixels are capped (~6M) so a tall full-board phone shot
 *   (e.g. 1170 x 2532) isn't also doubled into a huge canvas.
 * Input may be a data URL (base64 picker) or a blob URL (web picker);
 * both load into an <img> the same way, and the blob URL avoids a
 * second giant base64 copy of a phone photo.
 */
async function prepareImageForOcr(input: string): Promise<string> {
  if (typeof document === 'undefined') return input;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('Could not load image for OCR.'));
    el.src = input;
  });
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return input;
  let scale = w < 900 ? 2 : w > 2000 ? 2000 / w : 1;
  const pixels = w * scale * (h * scale);
  if (pixels > 6_000_000) scale *= Math.sqrt(6_000_000 / pixels);
  if (scale === 1) return input;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return input;
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
    input = await prepareImageForOcr(imageDataUrl);
  } catch {
    // Resizing failed — try the original image rather than giving up.
    input = imageDataUrl;
  }
  const result = await recognize(input, 'eng');
  const text = result?.data?.text ?? '';
  if (!text.trim()) throw new Error('OCR read no text from this image — try a tighter crop of just the odds board.');
  return text;
}
