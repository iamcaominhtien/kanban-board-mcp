/**
 * The icons of the "AI teams on rich pages" boards, drawn from their code: the filled team spark, the stroked marks
 * of the suggestion buttons and labels (each with the board's own stroke width), and a pick by change and block kind.
 */

import type { ReactNode } from 'react';

/** The filled four-point spark of a team (chip, bar, block header). */
export const SPARK_PATH = 'M12 3C12 8 14 10 19 12C14 14 12 16 12 21C12 16 10 14 5 12C10 10 12 8 12 3Z';

/**
 * The team's filled spark.
 * @param props.size - Width and height in px.
 * @param props.color - Fill (default the current colour).
 */
export function Spark({ size = 12, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill={color} style={{ flexShrink: 0 }}>
      <path d={SPARK_PATH} />
    </svg>
  );
}

const P: Record<string, ReactNode> = {
  check: <path d="M5 12.5L10 17.5L19 7" />,
  close: <path d="M6 6L18 18M18 6L6 18" />,
  chevRight: <path d="M9 6L15 12L9 18" />,
  chevLeft: <path d="M15 6L9 12L15 18" />,
  chevDown: <path d="M6 9L12 15L18 9" />,
  chevUp: <path d="M6 15L12 9L18 15" />,
  arrowDown: <path d="M12 5v14M6 13l6 6 6-6" />,
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  warning: <path d="M12 3.5L22 20H2ZM12 10V14M12 17.2V17.3" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.01" />
    </>
  ),
  pause: <path d="M9 6V18M15 6V18" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  spark: <path d="M12 3C12 8 14 10 19 12C14 14 12 16 12 21C12 16 10 14 5 12C10 10 12 8 12 3Z" />,
  agent: <path d="M12 3V21M3 12H21M5.6 5.6L18.4 18.4M18.4 5.6L5.6 18.4" />,
  colour: <path d="M6 16L12 4l6 12M8.5 12h7M5 21h14" />,
  highlight: (
    <path d="M5 12l7-7 7 7-6 6a2 2 0 0 1-3 0zM20 15c1 1.5 1.5 2.5 1.5 3.3a1.5 1.5 0 0 1-3 0c0-.8.5-1.8 1.5-3.3z" />
  ),
  align: <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />,
  float: (
    <>
      <rect x="13" y="5" width="7" height="7" rx="1" />
      <path d="M4 6h6M4 10h6M4 15h16M4 19h12" />
    </>
  ),
  quote: <path d="M9 7c-3 1-4 3-4 6v4h5v-5H7c0-2 1-3 2-3zM19 7c-3 1-4 3-4 6v4h5v-5h-3c0-2 1-3 2-3z" />,
  numbered: <path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v4M4 11h2.5l-2.5 3h2.7M4 17h2.5v1.5H5v1.5h1.5V21H4" />,
  width: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  alt: <path d="M3 18l4-12 4 12M4.5 14h5M14 8h7M14 12h7M14 16h4" />,
  caption: (
    <>
      <rect x="4" y="4" width="16" height="11" rx="1.5" />
      <path d="M8 19h8" />
    </>
  ),
  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M3 17l5-4 4 3 3-2 6 4" />
    </>
  ),
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M3 15h18M9 4v16M15 4v16" />
    </>
  ),
  wand: <path d="M5 19L17 7M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 12l.6 1.2L21 14l-1.4.8L19 16l-.6-1.2L17 14l1.4-.8z" />,
  shorten: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <path d="M8 7.5L20 18M8 16.5L20 6" />
    </>
  ),
  tone: <path d="M3 12h3l3-7 4 14 3-7h5" />,
  translate: <path d="M4 6h9M8.5 4v2M6 6c0 4 3 7 6 8M11 6c-1 3-3 6-6.5 8M13 20l4-9 4 9M14.5 17h5" />,
  palette: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18c1.2 0 2-.8 2-1.8 0-1.4-1.2-1.7-1.2-2.8 0-1 .8-1.7 1.9-1.7H17a4 4 0 0 0 4-4C21 6.5 17 3 12 3z" />
      <circle cx="7.5" cy="11" r="1" />
      <circle cx="10" cy="7.5" r="1" />
      <circle cx="15" cy="7.5" r="1" />
    </>
  ),
  send: <path d="M3 11L21 3L13 21L11 13Z" />,
  heading: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  callout: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8" cy="12" r="1.2" />
      <path d="M12 10h6M12 14h4" />
    </>
  ),
  bullets: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" />
      <circle cx="4.5" cy="12" r="1" />
      <circle cx="4.5" cy="18" r="1" />
    </>
  ),
  tasks: (
    <>
      <rect x="3.5" y="4" width="5" height="5" rx="1" />
      <path d="M4.5 6.5l1.2 1.2 2-2.4M12 6h8M12 12h8M12 18h8" />
      <rect x="3.5" y="10" width="5" height="5" rx="1" />
      <rect x="3.5" y="16" width="5" height="5" rx="1" />
    </>
  ),
  columns: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </>
  ),
};

/** A name of {@link SgIcon}. */
export type SgIconName = keyof typeof P;

/**
 * One stroked board icon.
 * @param props.name - Which icon.
 * @param props.size - Width and height in px.
 * @param props.sw - Stroke width on the 24-unit grid (the boards use 2, 2.2, 2.4 or 2.6).
 * @param props.color - Stroke (default the current colour).
 */
export function SgIcon({
  name,
  size = 13,
  sw = 2,
  color = 'currentColor',
}: {
  name: SgIconName;
  size?: number;
  sw?: number;
  color?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      {P[name]}
    </svg>
  );
}

const CHANGE_ICON: Record<string, SgIconName> = {
  Colour: 'colour',
  Highlight: 'highlight',
  Alignment: 'align',
  Image: 'float',
  Style: 'quote',
  List: 'numbered',
  Marker: 'numbered',
  Width: 'width',
  'Alt text': 'alt',
  Caption: 'caption',
};

/** The icon of one named formatting change ("Colour", "Alignment", "Image" …). */
export const changeIcon = (what: string): SgIconName => CHANGE_ICON[what] ?? 'align';

const BLOCK_ICON: Record<string, SgIconName> = {
  image: 'image',
  blockquote: 'quote',
  pullQuote: 'quote',
  table: 'table',
  bulletList: 'bullets',
  orderedList: 'numbered',
  taskList: 'tasks',
  columns: 'columns',
  callout: 'callout',
};

/** The icon of a row in a list of suggestions: by its first change, else by the kind of block. */
export function rowIcon(firstChange: string | null, blockType: string | null | undefined): SgIconName {
  if (firstChange && firstChange !== 'Colour' && firstChange !== 'Highlight') return changeIcon(firstChange);
  return BLOCK_ICON[blockType ?? ''] ?? 'text';
}
