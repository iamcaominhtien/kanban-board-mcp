/**
 * The line icons of the Docs states boards (RichDocsStates 1-4), copied from their frames: 24-unit view box, round caps.
 */

import type { ReactNode } from 'react';

const PATHS = {
  warn: <path d="M12 3.5L22 20H2ZM12 10V14M12 17.2V17.3" />,
  check: <path d="M5 12.5L10 17.5L19 7" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7V12L15.5 14" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-4 3-6 7-6s7 2 7 6" />
    </>
  ),
  x: <path d="M6 6L18 18M18 6L6 18" />,
  offline: (
    <path d="M3 3l18 18M2 8.8A15 15 0 0 1 8 5.4M22 8.8A15 15 0 0 0 14.5 5M5 12a10 10 0 0 1 3.5-2M19 12a10 10 0 0 0-3.5-2.3M8.5 15.5a5 5 0 0 1 4-1.4M12 19h.01" />
  ),
  online: <path d="M2 8.8a15 15 0 0 1 20 0M5 12a10 10 0 0 1 14 0M8.5 15.5a5 5 0 0 1 7 0M12 19h.01" />,
  retry: <path d="M4 12a8 8 0 0 1 14-5l2 2M20 4v5h-5M20 12a8 8 0 0 1-14 5l-2-2M4 20v-5h5" />,
  download: <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  text: <path d="M4 6h16M4 10h16M4 14h10M4 18h12" />,
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M3 15h18M10 4v16" />
    </>
  ),
  picture: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="M4 18l5-5 4 4 3-3 4 4" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="5" width="14" height="14" rx="2" />
      <path d="M17 10l4-2.5v9L17 14" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h5" />
    </>
  ),
  send: <path d="M3 11L21 3L13 21L11 13Z" />,
  storage: (
    <>
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M5 14l2-9h10l2 9M7 17h.01" />
    </>
  ),
  list: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" />
      <circle cx="4.5" cy="12" r="1" />
      <circle cx="4.5" cy="18" r="1" />
    </>
  ),
  merge: <path d="M6 3v6a6 6 0 0 0 6 6h6M15 12l3 3-3 3M6 21v-6" />,
  history: <path d="M4 12a8 8 0 1 0 2.5-5.8L4 8.5M4 4v4.5h4.5M12 8v4l3 2" />,
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  undo: <path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  browser: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
    </>
  ),
} satisfies Record<string, ReactNode>;

/** The name of a states icon. */
export type StIconName = keyof typeof PATHS;

/**
 * A states-board line icon.
 * @param props.name - Which icon.
 * @param props.size - Width and height in px.
 * @param props.sw - Stroke width in view-box units.
 */
export function StIcon({ name, size = 14, sw = 2 }: { name: StIconName; size?: number; sw?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      {PATHS[name]}
    </svg>
  );
}
