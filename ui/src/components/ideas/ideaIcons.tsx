import type { CSSProperties, ReactNode } from 'react';
import type { IdeaStage } from '../../types/idea';
import { LineIcon, type LineIconName } from '../ui/LineIcon';

/**
 * The Idea Space's own line icons that the shared set does not have (flask, flag, rocket, inbox tray, merge, archive
 * box…), drawn like LineIcon: 24 × 24 grid, round caps and joins, currentColor. Paths come from the design source
 * (design/source/Idea*.dc.html). Any LineIcon name works too.
 */
const IDEA_PATHS = {
  flask: (
    <>
      <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" />
      <path d="M7.5 15h9" />
    </>
  ),
  flag: <path d="M5 21V4M5 4h11l-2 4 2 4H5" />,
  bars: (
    <>
      <rect x="7" y="5" width="3.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
    </>
  ),
  shipped: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  thumb: <path d="M7 11v9H4v-9zM7 11l4-7c1.5 0 2.5 1 2.5 2.5V10H19a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 18 20H7" />,
  rocket: (
    <>
      <path d="M12 3c4 2 6 6 5 11l-3 3h-4l-3-3c-1-5 1-9 5-11zM9 17l-3 4M15 17l3 4" />
      <circle cx="12" cy="10" r="1.6" />
    </>
  ),
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  columns: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15M14.5 4.5v15" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.2" />
    </>
  ),
  inbox: <path d="M3 13l3-8h12l3 8v6H3zM3 13h5l1 3h6l1-3h5" />,
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1" />
    </>
  ),
  merge: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="12" r="2.5" />
      <path d="M6 8.5v7M8.5 6c5 0 7.5 3 7.5 6" />
    </>
  ),
  archive: (
    <>
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <path d="M5 9v10h14V9M10 13h4" />
    </>
  ),
  arrowLeft: <path d="M19 12H5M11 6l-6 6 6 6" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  arrowUpRight: <path d="M7 17L17 7M9 7h8v8" />,
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4 18l5-5 4 4 3-3 4 4" />
    </>
  ),
  brush: <path d="M20 4c-5 1-9 5-10 9l2 2c4-1 8-5 8-11zM10 13c-3 0-5 2-5 5 0 1.5-1 2-2 2 3 2 9 1 9-4" />,
  book: <path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10" />,
  doc: (
    <>
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5" />
    </>
  ),
  clipboard: (
    <>
      <rect x="6" y="5" width="12" height="16" rx="2" />
      <path d="M9 5V4h6v1M9 11h6M9 15h4" />
    </>
  ),
  log: <path d="M6 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6zM6 3v18M10 8h5M10 12h5" />,
  history: <path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4M12 8v4l3 2" />,
  tag: (
    <>
      <path d="M3 12V4h8l10 10-8 8z" />
      <circle cx="7.5" cy="8.5" r="1.2" />
    </>
  ),
  filter: <path d="M4 5h16l-6 7.5V19l-4-2v-4.5L4 5z" />,
  pin: <path d="M9 3h6l-1 6 3 3H7l3-3zM12 12v9" />,
  attach: <path d="M20 11l-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" />,
  bold: <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />,
  italic: <path d="M10 5h8M6 19h8M14 5l-4 14" />,
  code: <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />,
  people: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20c0-3.5 3-6 6-6s6 2.5 6 6M16 5a3.5 3.5 0 0 1 0 7M18 14c2 .8 3 2.6 3 5" />
    </>
  ),
  comment: <path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />,
  keyboard: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
    </>
  ),
  expand: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  circleCheck: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l3 3 5-6" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IdeaIconName = keyof typeof IDEA_PATHS | LineIconName;

/** One line icon: the Idea Space's own, or any shared LineIcon. Decorative unless given a title. */
export function IdeaIcon({
  name,
  size = 14,
  strokeWidth = 1.7,
  color,
  style,
  className,
  title,
}: {
  name: IdeaIconName;
  size?: number;
  strokeWidth?: number;
  color?: string;
  style?: CSSProperties;
  className?: string;
  title?: string;
}) {
  if (!(name in IDEA_PATHS)) {
    return (
      <LineIcon
        name={name as LineIconName}
        size={size}
        strokeWidth={strokeWidth}
        color={color}
        style={style}
        className={className}
        title={title}
      />
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
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
      {IDEA_PATHS[name as keyof typeof IDEA_PATHS]}
    </svg>
  );
}

/** The icon of each stage, as the design draws it on the stage chips. */
export const STAGE_ICONS: Record<IdeaStage, IdeaIconName> = {
  inbox: 'inbox',
  exploring: 'flask',
  ready: 'flag',
  building: 'bolt',
  parked: 'bars',
  shipped: 'shipped',
  archived: 'archive',
};
