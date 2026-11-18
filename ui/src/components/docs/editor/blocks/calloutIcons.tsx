/**
 * The callout icons (Blocks board, H 42): twelve line icons a callout can carry instead of its kind's own, stored by
 * name in the callout's `icon` attribute. Older pages may hold an emoji there; it is drawn as it is.
 */

import type { ReactNode } from 'react';

/** The icons in the order of the picker, by stored name. */
export const CALLOUT_ICON_PATHS: Record<string, ReactNode> = {
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5v.01" />
    </>
  ),
  warning: <path d="M12 3.5L22 20H2ZM12 10V14M12 17.2V17.3" />,
  check: <path d="M5 12.5L10 17.5L19 7" />,
  bulb: <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.3 1 2.1h5c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3z" />,
  flag: <path d="M5 21V4M5 4h12l-2 4 2 4H5" />,
  heart: <path d="M12 20s-8-5-8-11a4.5 4.5 0 0 1 8-2.5A4.5 4.5 0 0 1 20 9c0 6-8 11-8 11z" />,
  book: <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5" />,
  bell: <path d="M6 17V11a6 6 0 0 1 12 0v6l2 2H4zM10 21h4" />,
  lock: (
    <>
      <rect height="9" rx="2" width="14" x="5" y="11" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  pin: <path d="M9 3h6l-1 6 3 3H7l3-3zM12 12v9" />,
  sparkle: <path d="M12 3C12 8 14 10 19 12C14 14 12 16 12 21C12 16 10 14 5 12C10 10 12 8 12 3Z" />,
  tag: (
    <>
      <path d="M3 12V4h8l10 10-8 8z" />
      <circle cx="7.5" cy="8.5" r="1.2" />
    </>
  ),
};

/** The icon names, in the picker's order. */
export const CALLOUT_ICON_NAMES = Object.keys(CALLOUT_ICON_PATHS);

/** "bulb" → "Bulb" (the icon's accessible name). */
export const calloutIconLabel = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * A callout icon by name, or null when the name is not one of the twelve.
 * @param props.size - The icon's size in px.
 */
export function CalloutGlyph({
  name,
  size = 16,
  strokeWidth = 2,
}: {
  name: string;
  size?: number;
  strokeWidth?: number;
}) {
  const path = CALLOUT_ICON_PATHS[name];
  if (!path) return null;
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {path}
    </svg>
  );
}
