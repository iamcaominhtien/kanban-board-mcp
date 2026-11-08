import type { ReactNode } from 'react';

const ico = (d: ReactNode, color = 'currentColor') => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flexShrink: 0 }}
  >
    {d}
  </svg>
);
/** Part of the pull request (wave 3). */
export const SPARKLE = ico(<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />);
/** Part of the pull request (wave 3). */
export const EXTERNAL = ico(<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />);
/** Part of the pull request (wave 3). */
export const BRANCH = ico(
  <>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="9" r="2.5" />
    <path d="M6 8.5v7M18 11.5c0 4-6 3-12 4.5" />
  </>,
  '#A5321E',
);
/** Part of the pull request (wave 3). */
export const BUBBLE = ico(<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20.5l1.4-4.6A8 8 0 1 1 21 12z" />, '#244E78');

export const CI_TEXT: Record<string, string> = {
  green: 'CI is green',
  red: 'CI is red',
  pending: 'CI is running',
  none: 'No CI on this pull request',
};
