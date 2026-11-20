/**
 * The 12 shared-highlight colours (design board "Rich Docs — reading", K 76): each has a tint (the palette's
 * highlight colour, through the page's `--rd-hl-<name>` variable so it follows the reading theme), an ink for its
 * dotted line and marker, and a shape, so colour is never the only sign.
 */

import type { HighlightColor } from '../../../api/docsHighlights';
import { cssColor } from '../editor/ribbon/palette';

/** All 12, in the palette's order. */
export const HL_COLORS: readonly HighlightColor[] = [
  'yellow',
  'lime',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
  'red',
  'orange',
  'sand',
  'grey',
  'slate',
];

/** The six the bubble shows first (⋯ opens all 12). */
export const HL_FIRST_SIX: readonly HighlightColor[] = ['yellow', 'green', 'blue', 'pink', 'orange', 'violet'];

/** The ink of each colour: its dotted line, its marker and its swatch border. */
export const HL_INK: Record<HighlightColor, string> = {
  yellow: '#8A5A00',
  lime: '#5C6B1E',
  green: '#2E6F40',
  teal: '#0F766E',
  blue: '#1F5A8E',
  violet: '#5B4BB5',
  pink: '#B02A6B',
  red: '#C4432A',
  orange: '#B4571F',
  sand: '#6B4A2E',
  grey: '#5B6B60',
  slate: '#5B6B60',
};

/** The tint of each colour in each reading theme (highlightTints.css), for the 4.5 : 1 check of K 77. */
export const HL_TINTS: Record<'white' | 'sepia' | 'night', Record<HighlightColor, string>> = {
  white: {
    yellow: '#FFE9A8',
    lime: '#E6EFB8',
    green: '#CFE8D6',
    teal: '#C8EAE5',
    blue: '#CFE3F5',
    violet: '#E1DAF6',
    pink: '#F8D5E6',
    red: '#F8D3CB',
    orange: '#FADDBF',
    sand: '#EFE3CC',
    grey: '#E3E8E5',
    slate: '#C9D3CC',
  },
  sepia: {
    yellow: '#F7E0A0',
    lime: '#DFE6A8',
    green: '#C6DFC9',
    teal: '#BCE0D6',
    blue: '#C3D9EB',
    violet: '#D8D0EC',
    pink: '#F2CCDC',
    red: '#F2C9BC',
    orange: '#F5D3A8',
    sand: '#E8D9B8',
    grey: '#DDD7C6',
    slate: '#CCC7B5',
  },
  night: {
    yellow: '#5C4A12',
    lime: '#3E4A14',
    green: '#1F4A2E',
    teal: '#14463F',
    blue: '#1F3F5E',
    violet: '#3A3162',
    pink: '#5A2442',
    red: '#5A2A20',
    orange: '#5A3516',
    sand: '#4A3F2A',
    grey: '#2E3A32',
    slate: '#3B4A40',
  },
};

function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** "rgb(196, 67, 42)" or "#C4432A" → "#c4432a"; null for anything else (transparent, a keyword). */
export function hexOf(css: string): string | null {
  const s = css.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (!m) return null;
  if (m[4] !== undefined && parseFloat(m[4]) < 1 && !m[4].endsWith('%')) return null;
  return `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The WCAG contrast ratio of two colours (1 to 21), or null when one is not a plain colour.
 * @param a - A CSS colour (hex or rgb()).
 * @param b - Another.
 */
export function contrast(a: string, b: string): number | null {
  const ha = hexOf(a);
  const hb = hexOf(b);
  const la = ha ? luminance(ha) : null;
  const lb = hb ? luminance(hb) : null;
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** "yellow" → "Yellow". */
export function colorName(c: string): string {
  return c.charAt(0).toUpperCase() + c.slice(1);
}

/**
 * The tint of a colour on the page (its CSS value, following the page background).
 * @param c - A colour name.
 */
export function tintOf(c: HighlightColor): string {
  return cssColor('highlight', c) ?? '#FFE9A8';
}

/** Whether a string is one of the 12 names. */
export function isHlColor(c: unknown): c is HighlightColor {
  return typeof c === 'string' && (HL_COLORS as readonly string[]).includes(c);
}

/** The inside of each colour's shape (10×10 view box, filled with its ink unless it says otherwise). */
const SHAPES: Record<HighlightColor, string> = {
  yellow: '<circle cx="5" cy="5" r="4.2"/>',
  lime: '<path d="M5 .3C5 .3 8.8 4.1 8.8 6.3A3.8 3.8 0 0 1 1.2 6.3C1.2 4.1 5 .3 5 .3z"/>',
  green: '<rect x="1" y="1" width="8" height="8" rx="1"/>',
  teal: '<path d="M5 .4L9.2 2.7V7.3L5 9.6L.8 7.3V2.7z"/>',
  blue: '<path d="M5 .6L9.7 9H.3z"/>',
  violet: '<path d="M5 .2L6.4 3.6L10 3.8L7.2 6.1L8.1 9.7L5 7.7L1.9 9.7L2.8 6.1L0 3.8L3.6 3.6z"/>',
  pink: '<path d="M5 9.4L1.1 5.5A2.5 2.5 0 0 1 5 2.4A2.5 2.5 0 0 1 8.9 5.5z"/>',
  red: '<path d="M3.7 .4h2.6v3.3h3.3v2.6H6.3v3.3H3.7V6.3H.4V3.7h3.3z"/>',
  orange: '<path d="M5 .1L9.9 5L5 9.9L.1 5z"/>',
  sand: '<circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" stroke-width="1.9"/>',
  grey: '<rect x=".3" y="3.1" width="9.4" height="3.8" rx="1.2"/>',
  slate: '<path d="M7.6 .7A4.6 4.6 0 1 0 9.3 7.6A3.7 3.7 0 0 1 7.6 .7z"/>',
};

/**
 * The colour's shape as SVG markup (for the markers placed straight into the page's DOM).
 * @param color - The colour.
 * @param size - Width and height in CSS pixels.
 */
export function shapeSvg(color: HighlightColor, size = 10): string {
  const ink = HL_INK[color];
  return `<svg width="${size}" height="${size}" viewBox="0 0 10 10" fill="${ink}" color="${ink}" aria-hidden="true" style="flex:none;display:inline-block">${SHAPES[color]}</svg>`;
}

/**
 * The colour's shape, 10×10 view box, filled with its ink (board K 76: twelve shapes, so colour is never the only
 * sign).
 * @param props.color - The colour.
 * @param props.size - Width and height in CSS pixels.
 */
export function HlShape({ color, size = 12 }: { color: HighlightColor; size?: number }) {
  const ink = HL_INK[color];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      fill={ink}
      color={ink}
      aria-hidden="true"
      style={{ flex: 'none', display: 'inline-block' }}
      // the shapes are fixed markup of this file, never page or user text
      dangerouslySetInnerHTML={{ __html: SHAPES[color] }}
    />
  );
}
