import type { CSSProperties, ReactNode } from 'react';

/**
 * The line icons of the design (24 × 24 grid, stroke 1.7, round caps and joins, currentColor), for every place that
 * drew a glyph or an emoji instead (✦ ✕ 🔒 ⚠ ▾ ↻ ✎ 📄 …, design audit pattern "glyphs instead of icons").
 * Decorative by default (aria-hidden); give an icon-only button its own aria-label.
 */
const PATHS = {
  /** ✦ AI, Ask AI, AI features */
  sparkle: <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />,
  /** ✕ × close, dismiss, remove */
  close: <path d="M6 6l12 12M18 6L6 18" />,
  /** ✓ done, saved, chosen */
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l3 3 5-6" />
    </>
  ),
  /** 🔒 locked, read only, private */
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  /** Workspaces: stacked boards */
  layers: <path d="M12 3l9 5-9 5-9-5 9-5zM3 12.5l9 5 9-5M3 16.5l9 5 9-5" />,
  /** ⚠ warning */
  warning: <path d="M12 4l9 16H3L12 4zM12 10v4M12 17v.5" />,
  /** ⛔ blocked, not allowed */
  blocked: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8v.5" />
    </>
  ),
  /** ▾ ▼ ⌄ open a menu */
  chevronDown: <path d="M6 9l6 6 6-6" />,
  chevronUp: <path d="M6 15l6-6 6 6" />,
  /** ▸ ▷ (as a disclosure) */
  chevronRight: <path d="M9 6l6 6-6 6" />,
  chevronLeft: <path d="M15 6l-6 6 6 6" />,
  /** ▷ run, start */
  play: <path d="M8 5.5v13l10-6.5z" />,
  /** ⏸ pause */
  pause: <path d="M9 5v14M15 5v14" />,
  /** ■ stop */
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />,
  /** ↻ retry, refresh, again */
  refresh: <path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4" />,
  /** ↶ undo */
  undo: <path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  /** ↩ reply, send back */
  reply: <path d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" />,
  /** ✎ edit */
  edit: <path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />,
  /** 📄 🗋 a page, a document */
  page: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </>
  ),
  /** 📁 folder */
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  /** ☐ ◻ a to-do, a criterion */
  square: <rect x="4.5" y="4.5" width="15" height="15" rx="3" />,
  /** ▭ a frame, a board */
  frame: <rect x="3.5" y="5.5" width="17" height="13" rx="2" />,
  /** 🌳 a branch */
  branch: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 8.5v7M18 11.5c0 4-6 3-12 4.5" />
    </>
  ),
  /** ✋ a person stepped in, hand over */
  hand: (
    <path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10V5.5a1.5 1.5 0 0 1 3 0V13c0 4-2.5 7-6.5 7-3 0-4.5-1.5-6-4l-1.6-2.7a1.5 1.5 0 0 1 2.6-1.5L8 13" />
  ),
  /** 💬 chat, comment, a question */
  chat: <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />,
  /** 🛡 safety, permissions */
  shield: <path d="M12 3l8 3v6c0 4.5-3.3 8-8 9-4.7-1-8-4.5-8-9V6z" />,
  /** ↗ opens elsewhere */
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  /** ➤ send */
  send: <path d="M4 12l16-8-6 16-2.5-6.5z" />,
  /** ⚙ settings */
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </>
  ),
  /** 🕐 time, a schedule */
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  /** 💡 an idea, a tip */
  bulb: (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" />
    </>
  ),
  /** ⚡ quick, automatic */
  bolt: <path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" />,
  /** ⇅ sort */
  sort: <path d="M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4" />,
  download: <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />,
  upload: <path d="M12 16V5M7 9l5-5 5 5M5 20h14" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  more: (
    <>
      <circle cx="6" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="18" cy="12" r="1.2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  trash: <path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />,
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" />
    </>
  ),
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" />,
} satisfies Record<string, ReactNode>;

export type LineIconName = keyof typeof PATHS;

/**
 * One line icon of the design.
 * @param props.name - Which icon (see PATHS for the glyph each one replaces).
 * @param props.size - Width and height in px.
 * @param props.title - Announced label when the icon carries meaning on its own.
 */
export function LineIcon({
  name,
  size = 14,
  strokeWidth = 1.7,
  color,
  style,
  className,
  title,
}: {
  name: LineIconName;
  size?: number;
  strokeWidth?: number;
  /** Stroke colour; the text colour when left out. */
  color?: string;
  style?: CSSProperties;
  className?: string;
  /** For an icon that carries meaning on its own: it is then announced instead of hidden. */
  title?: string;
}) {
  const filled = name === 'play' || name === 'more';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? (color ?? 'currentColor') : 'none'}
      stroke={color ?? 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      className={className}
      style={{ flexShrink: 0, verticalAlign: '-0.15em', ...style }}
    >
      {PATHS[name]}
    </svg>
  );
}
