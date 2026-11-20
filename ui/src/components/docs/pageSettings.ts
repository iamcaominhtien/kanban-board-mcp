/**
 * Page settings of a Docs page (server/contract/richdoc/page-settings.json): what each key may hold, its default,
 * and how the reader and the editor draw a page with them (its column width, fonts, text size, page colours and
 * the named palette of server/contract/richdoc/palette.json, the cover and the header).
 */

import type { CSSProperties } from 'react';
import type { DocsLayout } from '../../hooks/useDocsLayout';

export type PageWidth = 'narrow' | 'normal' | 'wide' | 'full';
export type PageBackground = 'white' | 'paper' | 'mist' | 'sepia' | 'night';
export type PageFont =
  'jakarta' | 'lora' | 'source-serif' | 'merriweather' | 'playfair' | 'inter' | 'jetbrains-mono' | 'caveat';
export type TextSize = 's' | 'm' | 'l';
export type TitleStyle = 'plain' | 'serif' | 'display' | 'eyebrow';
export type TitleAlign = 'left' | 'center' | 'right';
export type TitleSize = 'standard' | 'large' | 'huge';
export type CoverHeight = 's' | 'm' | 'l' | 'full';
export type CoverFit = 'fill' | 'fit';
/** Three steps of room, for the margins and the space between blocks. */
export type Room = 'tight' | 'normal' | 'roomy';
export type PageView = 'continuous' | 'paged';
export type Paragraphs = 'space' | 'indent';
export type TextAlign = 'left' | 'center' | 'right' | 'justify';

/** The `cover` setting: a picture (or a plain colour) above the title. */
export interface PageCover {
  /** `/uploads/...` (an upload of this board) or an `https:` link; empty for a colour cover. */
  src: string;
  /** A colour cover (`#rrggbb`) instead of a picture; null for a picture. */
  color: string | null;
  /** Horizontal position of the picture in the frame, 0 (left) to 100 (right). */
  positionX: number;
  /** Vertical position of the picture in the frame, 0 (top) to 100 (bottom). */
  positionY: number;
  height: CoverHeight;
  /** `fill` crops the picture to the frame, `fit` shows all of it. */
  fit: CoverFit;
  /** Per cent of black laid over the picture, 0 to 80. */
  dim: number;
  /** The title (and its eyebrow) sits on the picture. */
  titleOnCover: boolean;
}

/** The settings that change how a page looks, each one valid and filled in with its default. */
export interface PageLook {
  width: PageWidth;
  background: PageBackground;
  bodyFont: PageFont;
  /** `null`: the body font. */
  headingFont: PageFont | null;
  textSize: TextSize;
  /** The body text size in CSS px: `baseSize` when the page set one, else its `textSize` step. */
  sizePx: number;
  /** The page chose a size in px (`baseSize`). */
  baseSizeSet: boolean;
  lineHeight: number;
  /** The page chose a line height (a page without one keeps the reader's own, 1.7). */
  lineHeightSet: boolean;
  showOutline: boolean;
  /** The deepest heading level in "On this page" (2 or 3). */
  outlineDepth: 2 | 3;
  /** The headings beside the page in the editor. */
  editorOutline: boolean;
  margins: Room;
  blockSpacing: Room;
  view: PageView;
  paragraphs: Paragraphs;
  textAlign: TextAlign;
  dropCap: boolean;
  cover: PageCover | null;
  titleStyle: TitleStyle;
  titleSize: TitleSize;
  titleAlign: TitleAlign;
  eyebrow: string | null;
  showTitle: boolean;
  showByline: boolean;
  showReadingTime: boolean;
  showEditedBy: boolean;
}

/** A change sent to the server: a key with its new value, or `null` to go back to the default. */
export type SettingsPatch = Partial<Record<LookKey, unknown>>;

/** The keys the Page settings panel changes (Reset sets each back to its default). */
export const LOOK_KEYS = [
  'width',
  'background',
  'bodyFont',
  'headingFont',
  'textSize',
  'baseSize',
  'lineHeight',
  'showOutline',
  'outlineDepth',
  'editorOutline',
  'margins',
  'blockSpacing',
  'view',
  'paragraphs',
  'textAlign',
  'dropCap',
  'cover',
  'titleStyle',
  'titleSize',
  'titleAlign',
  'eyebrow',
  'showTitle',
  'showByline',
  'showReadingTime',
  'showEditedBy',
] as const;
export type LookKey = (typeof LOOK_KEYS)[number];

export const WIDTHS: readonly PageWidth[] = ['narrow', 'normal', 'wide', 'full'];
/** Column width of each page width in CSS pixels (on a desktop its least: see WIDTH_GROWTH); `full` fills the pane. */
export const WIDTH_PX: Record<PageWidth, number | null> = { narrow: 560, normal: 680, wide: 880, full: null };

/**
 * How a column grows on a large desktop screen: share of the window width and the most it takes, in px. WIDTH_PX
 * stays its least, so the column is never narrower than the setting says; a wide window fills with text instead of
 * two empty margins, as the page did before 5.1.0 (`clamp(640px, 62vw, 1120px)`).
 */
const WIDTH_GROWTH: Record<Exclude<PageWidth, 'full'>, { vw: number; maxPx: number }> = {
  narrow: { vw: 50, maxPx: 880 },
  normal: { vw: 62, maxPx: 1120 },
  wide: { vw: 78, maxPx: 1440 },
};
export const WIDTH_LABEL: Record<PageWidth, string> = {
  narrow: 'Narrow',
  normal: 'Normal',
  wide: 'Wide',
  full: 'Full',
};

export const BACKGROUNDS: readonly PageBackground[] = ['white', 'paper', 'sepia', 'mist', 'night'];
export const BACKGROUND_LABEL: Record<PageBackground, string> = {
  white: 'White',
  paper: 'Paper',
  mist: 'Mist',
  sepia: 'Sepia',
  night: 'Night',
};

export const FONTS: readonly PageFont[] = [
  'jakarta',
  'inter',
  'lora',
  'source-serif',
  'merriweather',
  'playfair',
  'jetbrains-mono',
  'caveat',
];
/** The CSS family of each font key (the files are bundled: docFonts.css; Plus Jakarta Sans is the app font). */
export const FONT_FAMILY: Record<PageFont, string> = {
  jakarta: "'Plus Jakarta Sans', system-ui, sans-serif",
  lora: "'Lora', Georgia, serif",
  'source-serif': "'Source Serif 4', Georgia, serif",
  merriweather: "'Merriweather', Georgia, serif",
  playfair: "'Playfair Display', Georgia, serif",
  inter: "'Inter', system-ui, sans-serif",
  'jetbrains-mono': "'JetBrains Mono', ui-monospace, monospace",
  caveat: "'Caveat', cursive",
};
export const FONT_LABEL: Record<PageFont, string> = {
  jakarta: 'Plus Jakarta Sans',
  lora: 'Lora',
  'source-serif': 'Source Serif 4',
  merriweather: 'Merriweather',
  playfair: 'Playfair Display',
  inter: 'Inter',
  'jetbrains-mono': 'JetBrains Mono',
  caveat: 'Caveat',
};

/** Font pairings, first in the Text tab: a heading font (null = the body font) and a body font. */
export const FONT_PAIRINGS: readonly {
  id: string;
  label: string;
  note: string;
  bodyFont: PageFont;
  headingFont: PageFont | null;
}[] = [
  { id: 'sans', label: 'Sans', note: 'For specs and notes', bodyFont: 'jakarta', headingFont: null },
  { id: 'serif', label: 'Serif', note: 'For stories and books', bodyFont: 'source-serif', headingFont: null },
  {
    id: 'editorial',
    label: 'Editorial',
    note: 'Serif titles, sans text',
    bodyFont: 'jakarta',
    headingFont: 'source-serif',
  },
  { id: 'mono', label: 'Mono', note: 'For code-first pages', bodyFont: 'jetbrains-mono', headingFont: null },
];

export const TEXT_SIZES: readonly TextSize[] = ['s', 'm', 'l'];
/** Body text size of each step in CSS pixels; `m` is the reader's own 14.5. */
export const TEXT_SIZE_PX: Record<TextSize, number> = { s: 13.5, m: 14.5, l: 16.5 };

/** The base size slider: 12 to 22 px in half pixels. */
export const BASE_SIZE_MIN = 12;
export const BASE_SIZE_MAX = 22;

export const ROOMS: readonly { value: Room; label: string }[] = [
  { value: 'tight', label: 'Tight' },
  { value: 'normal', label: 'Normal' },
  { value: 'roomy', label: 'Roomy' },
];

/** The room each Margins step adds to (or takes from) the text column, in CSS px; Full pages change their gutter. */
const MARGIN_COL_PX: Record<Room, number> = { tight: 64, normal: 0, roomy: -96 };
const MARGIN_GUTTER_PX: Record<Room, number> = { tight: 24, normal: 48, roomy: 160 };
/** The space after a paragraph or a block, in em of the text, for each Spacing step. */
const BLOCK_SPACE_EM: Record<Room, number> = { tight: 0.45, normal: 0.85, roomy: 1.4 };

/** The size of the title against the text for each Title size step. */
export const TITLE_SIZES: readonly { value: TitleSize; label: string; scale: number }[] = [
  { value: 'standard', label: 'Standard', scale: 1 },
  { value: 'large', label: 'Large', scale: 1.2 },
  { value: 'huge', label: 'Huge', scale: 1.45 },
];

export const LINE_HEIGHTS: readonly { value: number; label: string }[] = [
  { value: 1.4, label: 'Tight' },
  { value: 1.6, label: 'Normal' },
  { value: 1.8, label: 'Relaxed' },
  { value: 2.0, label: 'Loose' },
];

export const TITLE_STYLES: readonly { value: TitleStyle; label: string }[] = [
  { value: 'plain', label: 'Plain' },
  { value: 'serif', label: 'Serif' },
  { value: 'display', label: 'Display' },
  { value: 'eyebrow', label: 'With eyebrow' },
];

/** Cover height of each step in CSS pixels. */
export const COVER_PX: Record<CoverHeight, number> = { s: 160, m: 240, l: 320, full: 480 };
export const COVER_LABEL: Record<CoverHeight, string> = { s: 'Short', m: 'Medium', l: 'Tall', full: 'Full' };

export const TEXT_COLOR_NAMES = [
  'ink',
  'slate',
  'green',
  'olive',
  'teal',
  'blue',
  'violet',
  'pink',
  'red',
  'orange',
  'amber',
  'brown',
] as const;
export const HIGHLIGHT_NAMES = [
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
] as const;

type Colors<K extends string> = Record<K, string>;
/** One background of palette.json: the page, its ink and the 12 + 12 named colours. */
export interface PaletteEntry {
  page: string;
  ink: string;
  text: Colors<(typeof TEXT_COLOR_NAMES)[number]>;
  highlight: Colors<(typeof HIGHLIGHT_NAMES)[number]>;
}

const LIGHT_TEXT: PaletteEntry['text'] = {
  ink: '#1E2A22',
  slate: '#5B6B60',
  green: '#2E6F40',
  olive: '#5C6B1E',
  teal: '#0F766E',
  blue: '#1F5A8E',
  violet: '#5B4BB5',
  pink: '#B02A6B',
  red: '#C4432A',
  orange: '#B4571F',
  amber: '#8A5A00',
  brown: '#6B4A2E',
};
const LIGHT_HIGHLIGHT: PaletteEntry['highlight'] = {
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
};

/** server/contract/richdoc/palette.json (a test keeps the two the same). */
export const PALETTE: Record<PageBackground, PaletteEntry> = {
  white: { page: '#FFFFFF', ink: '#1E2A22', text: LIGHT_TEXT, highlight: LIGHT_HIGHLIGHT },
  paper: { page: '#FBF8F1', ink: '#1E2A22', text: LIGHT_TEXT, highlight: LIGHT_HIGHLIGHT },
  mist: { page: '#EAF1EC', ink: '#1E2A22', text: LIGHT_TEXT, highlight: LIGHT_HIGHLIGHT },
  sepia: {
    page: '#F4ECD8',
    ink: '#2B2418',
    text: {
      ink: '#2B2418',
      slate: '#5E5444',
      green: '#2A6A3C',
      olive: '#56611C',
      teal: '#0E6F67',
      blue: '#1D5688',
      violet: '#55459F',
      pink: '#A5266A',
      red: '#B73F28',
      orange: '#A5501C',
      amber: '#7F5300',
      brown: '#5F4128',
    },
    highlight: {
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
  },
  night: {
    page: '#17211A',
    ink: '#E6EEE8',
    text: {
      ink: '#E6EEE8',
      slate: '#A9B8AE',
      green: '#7FCB95',
      olive: '#C3D36B',
      teal: '#5EC9BC',
      blue: '#7DB5E8',
      violet: '#B3A6F0',
      pink: '#F08DBB',
      red: '#F4907A',
      orange: '#F2A56B',
      amber: '#E8B93A',
      brown: '#D1A77E',
    },
    highlight: {
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
  },
};

/** The page colours around the palette: body text, muted text, rules and the tint of cards and code. */
const SURFACE: Record<PageBackground, { text: string; muted: string; rule: string; surface: string }> = {
  white: { text: '#3A4A3E', muted: '#5B6B60', rule: '#E3E8E5', surface: '#F6FAF7' },
  paper: { text: '#3A4A3E', muted: '#5B6B60', rule: '#E6DFCF', surface: '#F3EEE2' },
  mist: { text: '#33433A', muted: '#5B6B60', rule: '#CFDCD3', surface: '#DFE9E2' },
  sepia: { text: '#3D3426', muted: '#5E5444', rule: '#DDD0B2', surface: '#EBE0C6' },
  night: { text: '#C9D6CD', muted: '#A9B8AE', rule: '#2E3A32', surface: '#1F2C23' },
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const pick = <T>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

/**
 * Reads a page's stored settings, every look key valid and filled in with its default.
 * @param settings - `page.settings` as the server sent it (missing keys are their defaults, unknown values are
 *   ignored).
 */
export function readPageLook(settings?: Record<string, unknown> | null): PageLook {
  const s = settings ?? {};
  const lh = s.lineHeight;
  const lineHeightSet = typeof lh === 'number' && LINE_HEIGHTS.some((l) => l.value === lh);
  const c = s.cover as Partial<PageCover> | null | undefined;
  const pos = (v: unknown) => (typeof v === 'number' ? Math.min(100, Math.max(0, v)) : 50);
  const colour = c && typeof c === 'object' && typeof c.color === 'string' && HEX.test(c.color) ? c.color : null;
  const cover: PageCover | null =
    c && typeof c === 'object' && ((typeof c.src === 'string' && c.src) || colour)
      ? {
          src: typeof c.src === 'string' ? c.src : '',
          color: colour,
          positionX: pos(c.positionX),
          positionY: pos(c.positionY),
          height: pick(c.height, ['s', 'm', 'l', 'full'] as const, 'm'),
          fit: pick(c.fit, ['fill', 'fit'] as const, 'fill'),
          dim: typeof c.dim === 'number' ? Math.min(80, Math.max(0, c.dim)) : 0,
          titleOnCover: bool(c.titleOnCover, false),
        }
      : null;
  const textSize = pick(s.textSize, TEXT_SIZES, 'm');
  const bs = s.baseSize;
  const baseSizeSet = typeof bs === 'number' && bs >= BASE_SIZE_MIN && bs <= BASE_SIZE_MAX;
  const rooms = ['tight', 'normal', 'roomy'] as const;
  return {
    width: pick(s.width, WIDTHS, 'normal'),
    background: pick(s.background, BACKGROUNDS, 'white'),
    bodyFont: pick(s.bodyFont, FONTS, 'jakarta'),
    headingFont: s.headingFont == null ? null : pick(s.headingFont, FONTS, null as PageFont | null),
    textSize,
    sizePx: baseSizeSet ? (bs as number) : TEXT_SIZE_PX[textSize],
    baseSizeSet,
    lineHeight: lineHeightSet ? (lh as number) : 1.6,
    lineHeightSet,
    showOutline: bool(s.showOutline, true),
    outlineDepth: s.outlineDepth === 2 ? 2 : 3,
    editorOutline: bool(s.editorOutline, true),
    margins: pick(s.margins, rooms, 'normal'),
    blockSpacing: pick(s.blockSpacing, rooms, 'normal'),
    view: pick(s.view, ['continuous', 'paged'] as const, 'continuous'),
    paragraphs: pick(s.paragraphs, ['space', 'indent'] as const, 'space'),
    textAlign: pick(s.textAlign, ['left', 'center', 'right', 'justify'] as const, 'left'),
    dropCap: bool(s.dropCap, false),
    cover,
    titleStyle: pick(s.titleStyle, ['plain', 'serif', 'display', 'eyebrow'] as const, 'plain'),
    titleSize: pick(s.titleSize, ['standard', 'large', 'huge'] as const, 'standard'),
    titleAlign: pick(s.titleAlign, ['left', 'center', 'right'] as const, 'left'),
    eyebrow: typeof s.eyebrow === 'string' && s.eyebrow.trim() ? s.eyebrow : null,
    showTitle: bool(s.showTitle, true),
    showByline: bool(s.showByline, true),
    showReadingTime: bool(s.showReadingTime, true),
    showEditedBy: bool(s.showEditedBy, true),
  };
}

/**
 * Applies a patch to stored settings as the server merges it: a `null` value removes the key.
 * @param settings - The stored settings.
 * @param patch - Keys to change; `null` goes back to the default.
 */
export function mergeSettings(
  settings: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(settings ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

/**
 * The column width of a page: the screen on a phone or for Full, the set width on a tablet, and on a desktop the set
 * width growing with the window up to its most (WIDTH_GROWTH), less or more by the page's margins.
 */
function columnWidth(look: PageLook, px: number | null, layout: DocsLayout): string {
  if (layout === 'phone' || px === null || look.width === 'full') return '100%';
  const margin = MARGIN_COL_PX[look.margins];
  if (layout === 'tablet') return `${px + margin}px`;
  const grow = WIDTH_GROWTH[look.width];
  const growing = margin === 0 ? `${grow.vw}vw` : `calc(${grow.vw}vw ${margin < 0 ? '-' : '+'} ${Math.abs(margin)}px)`;
  return `clamp(${px + margin}px, ${growing}, ${grow.maxPx + margin}px)`;
}

/** The page's width folds the tree to its rail and "On this page" to a button (Wide and Full). */
export function isWidePage(look: PageLook): boolean {
  return look.width === 'wide' || look.width === 'full';
}

/**
 * The CSS custom properties that draw a page with its settings: the column width (`--dp-col`) and the room left
 * beside it (`--dp-gutter`, both sides together), the page colours
 * (`--dp-page`, `--dp-ink`, `--dp-text`, `--dp-muted`, `--dp-rule`, `--dp-surface`, `--dp-link`), the fonts and
 * sizes (`--dp-body-font`, `--dp-heading-font`, `--dp-size`, `--dp-lh`) and the named palette for the background
 * (`--rd-c-<name>`, `--rd-hl-<name>`, which RichDocView and the editor read).
 * @param look - The page's settings.
 * @param layout - On a phone the column is always the screen width (minus the pane's 16 px gutters).
 */
export function lookVars(look: PageLook, layout: DocsLayout = 'desktop'): CSSProperties {
  const pal = PALETTE[look.background];
  const sur = SURFACE[look.background];
  const px = WIDTH_PX[look.width];
  const vars: Record<string, string> = {
    '--dp-col': columnWidth(look, px, layout),
    // a tablet keeps 60 px each side (Reader 2, Shell 22 at 820): room for the 44 px block handles beside the text
    '--dp-gutter': layout === 'phone' ? '32px' : layout === 'tablet' ? '120px' : `${MARGIN_GUTTER_PX[look.margins]}px`,
    '--dp-page': pal.page,
    '--dp-ink': pal.ink,
    '--dp-text': sur.text,
    '--dp-muted': sur.muted,
    '--dp-rule': sur.rule,
    '--dp-surface': sur.surface,
    '--dp-link': pal.text.green,
    '--dp-body-font': FONT_FAMILY[look.bodyFont],
    '--dp-heading-font': FONT_FAMILY[look.headingFont ?? look.bodyFont],
    '--dp-size': `${look.sizePx}px`,
    '--dp-lh': String(look.lineHeightSet ? look.lineHeight : 1.7),
    '--dp-block-space': `${BLOCK_SPACE_EM[look.blockSpacing]}em`,
    '--dp-title-scale': String(TITLE_SIZES.find((t) => t.value === look.titleSize)?.scale ?? 1),
  };
  for (const n of TEXT_COLOR_NAMES) vars[`--rd-c-${n}`] = pal.text[n];
  for (const n of HIGHLIGHT_NAMES) vars[`--rd-hl-${n}`] = pal.highlight[n];
  return vars as CSSProperties;
}

/**
 * The class names of a page drawn with its settings (docs.css): `dk-paged`, its background and its title style.
 * @param look - The page's settings.
 */
export function lookClass(look: PageLook): string {
  const extra = [
    look.bodyFont !== 'jakarta' || look.headingFont ? 'dk-fonted' : '',
    look.blockSpacing !== 'normal' ? `dk-sp-${look.blockSpacing}` : '',
    look.paragraphs === 'indent' ? 'dk-para-indent' : '',
    look.textAlign !== 'left' ? `dk-ta-${look.textAlign}` : '',
    look.dropCap ? 'dk-page-dropcap' : '',
  ].filter(Boolean);
  return `dk-paged dk-bg-${look.background}${extra.length ? ' ' + extra.join(' ') : ''}`;
}

/**
 * The CSS of a cover frame: its picture (or colour), where the picture sits, how it fits and how dim it is.
 * @param cover - The page's cover.
 * @param origin - The server's origin (resolveOrigin()).
 */
export function coverStyle(cover: PageCover, origin: string): CSSProperties {
  if (cover.color && !cover.src) return { backgroundColor: cover.color };
  const shade =
    cover.dim > 0 ? `linear-gradient(rgba(0,0,0,${cover.dim / 100}), rgba(0,0,0,${cover.dim / 100})), ` : '';
  return {
    backgroundImage: `${shade}url("${coverUrl(cover.src, origin)}")`,
    backgroundPosition: `${cover.positionX}% ${cover.positionY}%`,
    backgroundSize: cover.fit === 'fit' ? 'contain' : 'cover',
    backgroundRepeat: 'no-repeat',
    backgroundColor: cover.fit === 'fit' ? '#1e2a22' : undefined,
  };
}

/** Relative luminance of a `#rrggbb` colour (WCAG 2). */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/**
 * The WCAG contrast ratio of two `#rrggbb` colours, 1 to 21.
 * @param a - One colour.
 * @param b - The other.
 */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/**
 * Minutes it takes to read a text at 230 words a minute, at least 1.
 * @param text - The page as plain text or Markdown.
 */
export function readingMinutes(text: string): number {
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return Math.max(1, Math.ceil(words / 230));
}

/**
 * The src to load for a cover: an upload of this board gets the server's origin.
 * @param src - The stored `cover.src`.
 * @param origin - The server's origin (resolveOrigin()).
 */
export function coverUrl(src: string, origin: string): string {
  return src.startsWith('/uploads/') ? `${origin}${src}` : src;
}

/**
 * The breadcrumb with its middle folded: the first and the last `keepEnd` items stay, the rest become one "…".
 * @param items - The path from the space root to the parent of the page.
 * @param max - Most items shown before folding (at least 2).
 * @returns The items to show, with `null` where the folded ones were.
 */
export function foldCrumbs<T>(items: readonly T[], max: number): (T | null)[] {
  const m = Math.max(2, max);
  if (items.length <= m) return [...items];
  return [items[0], null, ...items.slice(items.length - (m - 1))];
}
