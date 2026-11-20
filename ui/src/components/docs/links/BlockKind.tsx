/**
 * The small marks of a heading or block kind that links, hover cards, search and Referenced by share
 * (RichDocsLinks C 17, D 21, E 27): a tile with the kind's colours and icon, and the kind's name in words.
 */

import type { CSSProperties } from 'react';

interface KindLook {
  bg: string;
  fg: string;
  /** SVG content in a 24×24 view box. */
  svg: string;
  /** The kind in words, as a link's place says it ("Limits · table"). */
  word: string;
}

const TABLE = '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M3 15h18M9 5v14"/>';
const IMAGE =
  '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M4 18l5-5 4 4 3-3 4 4"/>';
const CODE = '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 5l-4 14"/>';
const CALLOUT = '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>';
const HASH = '<path d="M5 9h14M4 15h14M10 4L8 20M16 4l-2 16"/>';
const BLOCK = '<rect x="4" y="5" width="16" height="14" rx="2.5"/><path d="M8 10h8M8 14h5"/>';

const LOOKS: Record<string, KindLook> = {
  heading: { bg: '#F1F6F2', fg: '#2E6F40', svg: HASH, word: 'heading' },
  table: { bg: '#E3EFFA', fg: '#2F6FB0', svg: TABLE, word: 'table' },
  image: { bg: '#F0E8FA', fg: '#6B3FA8', svg: IMAGE, word: 'image' },
  video: { bg: '#F0E8FA', fg: '#6B3FA8', svg: IMAGE, word: 'video' },
  code: { bg: '#1E2A22', fg: '#9FE0B2', svg: CODE, word: 'code' },
  callout: { bg: '#FDF3E3', fg: '#8A5A00', svg: CALLOUT, word: 'callout' },
  diagram: { bg: '#E3EFFA', fg: '#2F6FB0', svg: BLOCK, word: 'diagram' },
  sketch: { bg: '#E3EFFA', fg: '#2F6FB0', svg: BLOCK, word: 'sketch' },
  canvas: { bg: '#E3EFFA', fg: '#2F6FB0', svg: BLOCK, word: 'canvas' },
  embed: { bg: '#F1F6F2', fg: '#3A4A3E', svg: CODE, word: 'embed' },
  link: { bg: '#F1F6F2', fg: '#3A4A3E', svg: BLOCK, word: 'link' },
  file: { bg: '#F1F6F2', fg: '#3A4A3E', svg: BLOCK, word: 'file' },
  formula: { bg: '#F1F6F2', fg: '#3A4A3E', svg: BLOCK, word: 'formula' },
  quote: { bg: '#F1F6F2', fg: '#3A4A3E', svg: BLOCK, word: 'quote' },
  list: { bg: '#F1F6F2', fg: '#3A4A3E', svg: BLOCK, word: 'list' },
  text: { bg: '#F1F6F2', fg: '#3A4A3E', svg: BLOCK, word: 'text' },
};

/** How a kind looks (an unknown kind looks like a text block). */
export function kindLook(kind: string | null | undefined): KindLook {
  return LOOKS[kind ?? ''] ?? LOOKS.text;
}

/** The kind of a block in words ("table", "code"). */
export function kindWord(kind: string | null | undefined): string {
  return kindLook(kind).word;
}

/**
 * The kind's icon alone, in the current colour.
 * @param props.kind - The block kind (`table`, `image`, `code`, `callout`, `heading`…).
 * @param props.size - Icon size in px (11 in a chip, 15 in a card).
 */
export function KindGlyph({ kind, size = 11, style }: { kind: string; size?: number; style?: CSSProperties }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={kind === 'heading' ? 2 : 1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      dangerouslySetInnerHTML={{ __html: kindLook(kind).svg }}
    />
  );
}

/**
 * The kind's tile: a rounded square in the kind's colours with its icon.
 * @param props.kind - The block kind.
 * @param props.box - Tile size in px (22 in the `[[Page#` list, 30 in a hover card).
 * @param props.radius - Corner radius in px.
 * @param props.icon - Icon size in px.
 */
export function KindTile({
  kind,
  box = 22,
  radius = 6,
  icon = 11,
}: {
  kind: string;
  box?: number;
  radius?: number;
  icon?: number;
}) {
  const look = kindLook(kind);
  return (
    <span
      className="dk-kind-tile"
      data-kind={kind}
      style={{
        width: box,
        height: box,
        borderRadius: radius,
        background: look.bg,
        color: look.fg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
      }}
    >
      <KindGlyph kind={kind} size={icon} />
    </span>
  );
}
