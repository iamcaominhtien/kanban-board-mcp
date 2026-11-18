/**
 * The line icons of the embed blocks, drawn from the "Embeds and attachments" board (24-unit view box, round caps).
 */

import type { ReactNode } from 'react';

/** The paths of each icon. */
const PATHS: Record<string, ReactNode> = {
  html: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M9 13.5l-2 1.5 2 1.5M15 13.5l2 1.5-2 1.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  size: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  more: (
    <g fill="currentColor" stroke="none">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </g>
  ),
  shield: (
    <>
      <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
      <path d="M9 12l2.2 2.2L15 10" />
    </>
  ),
  check: <path d="M5 12.5L10 17.5L19 7" />,
  x: <path d="M6 6L18 18M18 6L6 18" />,
  warn: <path d="M12 3.5L22 20H2ZM12 10V14M12 17.2V17.3" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  code: <path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  offline: (
    <path d="M3 3l18 18M5 12a10 10 0 0 1 4-2.3M2 8.8A15 15 0 0 1 8 5.6M19 12a10 10 0 0 0-4-2.3M22 8.8a15 15 0 0 0-6-3.2M9 16a5 5 0 0 1 6 0M12 20h.01" />
  ),
  back: <path d="M15 6l-6 6 6 6" />,
  download: <path d="M12 4v12M7 11l5 5 5-5M4 20h16" />,
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 20h16" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  film: (
    <path d="M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4" />
  ),
  pen: (
    <>
      <path d="M4 20c3 0 4-1 4-3l9-9-3-3-9 9c-2 0-3 1-3 3z" />
      <path d="M15 6l3 3 2-2a1.4 1.4 0 0 0 0-2l-1-1a1.4 1.4 0 0 0-2 0z" />
    </>
  ),
  swap: <path d="M4 8h14l-3-3M20 16H6l3 3" />,
  chevron: <path d="M6 9L12 15L18 9" />,
  video: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M10 9.5v5l4.5-2.5z" />
    </>
  ),
  card: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8" cy="12" r="1.2" />
      <path d="M12 10h6M12 14h4" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.01" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
    </>
  ),
  open: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  folder: <path d="M3 6h6l2 2h10v11H3z" />,
  page: <path d="M6 3h8l4 4v14H6zM14 3v5h5" />,
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M12 4v16" />
    </>
  ),
  ticket: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M9 6v12" strokeDasharray="2 2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4-4" />
    </>
  ),
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
};

/** The name of an embed icon. */
export type EmbIconName = keyof typeof PATHS;

/**
 * Renders one embed icon.
 * @param props.size - Width and height in px.
 * @param props.sw - Stroke width in view-box units (the board uses 2 to 2.6).
 */
export function EmbIcon({ name, size = 14, sw = 2 }: { name: EmbIconName; size?: number; sw?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      {PATHS[name]}
    </svg>
  );
}
