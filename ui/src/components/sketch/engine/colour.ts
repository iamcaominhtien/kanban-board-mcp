/** The colours offered as swatches (the design's palette). */
export const SWATCHES = [
  '#2b2b2b',
  '#6b6b6b',
  '#ffffff',
  '#e8441a',
  '#f29b2e',
  '#f5c518',
  '#a4c82a',
  '#2c6e3f',
  '#17b8a6',
  '#5bb4f0',
  '#2f6fb0',
  '#8b5cf6',
  '#f472b6',
  '#7a4a24',
] as const;

/** How many recent colours are kept. */
export const MAX_RECENT = 8;

/**
 * Read `#rgb` or `#rrggbb` into a normalised `#rrggbb` (lower case), or null when it is not a colour.
 * @param text - What was typed; the `#` is optional.
 */
export function normaliseHex(text: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.replace(/./g, (c) => c + c);
  return `#${h}`;
}

/**
 * Split a `#rrggbb` colour into channels.
 * @param hex - A colour as `normaliseHex` returns it.
 */
export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Join channels into `#rrggbb`.
 * @param r - Red, 0 to 255.
 * @param g - Green.
 * @param b - Blue.
 */
export function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((c) =>
      Math.max(0, Math.min(255, Math.round(c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * Put a colour first in the recent list, once, keeping at most `MAX_RECENT`.
 * @param recent - The list now, newest first.
 * @param colour - The colour just used.
 */
export function pushRecent(recent: readonly string[], colour: string): string[] {
  return [colour, ...recent.filter((c) => c !== colour)].slice(0, MAX_RECENT);
}
