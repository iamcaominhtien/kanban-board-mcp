/** Longest side of a drawing, in px. The server enforces the same limits. */
export const MAX_SIDE = 4096;
/** Largest file (the PNG and the editable source each), in bytes. */
export const MAX_BYTES = 10 * 1024 * 1024;
/** Most layers in one drawing, the background and a picture included. */
export const MAX_LAYERS = 10;
/** Warn once a file passes this share of the limit. */
export const WARN_SHARE = 0.8;

/** What is wrong with a drawing that cannot be saved as it is. */
export interface Problem {
  code: 'canvas' | 'layers' | 'png' | 'source';
  message: string;
}

/**
 * Format a byte count for people: "8.4 MB", "312 KB".
 * @param bytes - Size in bytes.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Check a drawing against the limits; what comes back is shown before saving is tried.
 * @param d - The canvas size, layer count and, once known, the sizes of the two files.
 * @returns Every problem found; empty when the drawing can be saved.
 */
export function checkLimits(d: {
  width: number;
  height: number;
  layers: number;
  pngBytes?: number;
  sourceBytes?: number;
}): Problem[] {
  const out: Problem[] = [];
  if (d.width > MAX_SIDE || d.height > MAX_SIDE) {
    out.push({
      code: 'canvas',
      message: `The canvas is ${d.width} × ${d.height} px. The limit is ${MAX_SIDE} × ${MAX_SIDE} px. Crop it or shrink the canvas.`,
    });
  }
  if (d.layers > MAX_LAYERS) {
    out.push({
      code: 'layers',
      message: `A drawing can have ${MAX_LAYERS} layers (this one has ${d.layers}). Merge some layers.`,
    });
  }
  if ((d.pngBytes ?? 0) > MAX_BYTES) {
    out.push({
      code: 'png',
      message: `The picture is ${formatBytes(d.pngBytes as number)}. The limit is ${formatBytes(MAX_BYTES)}. Crop it or shrink the canvas.`,
    });
  }
  if ((d.sourceBytes ?? 0) > MAX_BYTES) {
    out.push({
      code: 'source',
      message: `The editable file is ${formatBytes(d.sourceBytes as number)}. The limit is ${formatBytes(MAX_BYTES)}. Crop it, shrink the canvas or merge layers.`,
    });
  }
  return out;
}

/**
 * Whether the files are close to the size limit, to warn before saving fails.
 * @param pngBytes - Size of the picture.
 * @param sourceBytes - Size of the editable source.
 */
export function nearLimit(pngBytes: number, sourceBytes: number): boolean {
  return Math.max(pngBytes, sourceBytes) > MAX_BYTES * WARN_SHARE;
}

/**
 * Scale a size down, keeping its shape, until both sides fit in `max`; a size that fits is unchanged.
 * @param width - Width in px.
 * @param height - Height in px.
 * @param max - Longest side allowed.
 */
export function fitWithin(width: number, height: number, max = MAX_SIDE): { w: number; h: number; scaled: boolean } {
  const k = Math.min(1, max / width, max / height);
  if (k >= 1) return { w: width, h: height, scaled: false };
  return { w: Math.max(1, Math.round(width * k)), h: Math.max(1, Math.round(height * k)), scaled: true };
}

/**
 * Clamp a canvas side to 1..MAX_SIDE; anything that is not a number becomes the fallback.
 * @param value - Typed value.
 * @param fallback - Value to use for junk.
 */
export function clampSide(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(MAX_SIDE, Math.round(value)));
}
