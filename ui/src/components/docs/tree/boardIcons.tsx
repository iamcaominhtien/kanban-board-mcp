/**
 * The line icons the "Rich Docs" app frame and organising pages boards draw in the tree, the rail and the views,
 * with the boards' own paths (24×24 viewBox, currentColor), so the tree matches the boards' code exactly.
 */

import type { CSSProperties } from 'react';

const PATHS = {
  /** Collapse the tree (double chevron left). */
  collapse: '<path d="M12 6l-6 6 6 6M18 6l-6 6 6 6"/>',
  /** Expand the tree from the rail (chevron right). */
  expand: '<path d="M9 6L15 12L9 18"/>',
  chevronRight: '<path d="M9 6L15 12L9 18"/>',
  chevronDown: '<path d="M6 9L12 15L18 9"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  page: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  /** The ✦ of AI suggestions and "Ask the docs". */
  spark: '<path d="M12 3C12 8 14 10 19 12C14 14 12 16 12 21C12 16 10 14 5 12C10 10 12 8 12 3Z"/>',
  /** "Docs health". */
  shield: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  book: '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h10"/>',
  bin: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>',
  /** "Select pages" (a ticked box). */
  select: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><path d="M8 12l3 3 5-6"/>',
  /** The views: Tree, Gallery, Recent. */
  viewTree: '<path d="M4 5h6M8 12h8M8 19h8M6 5v14M6 12h2"/>',
  viewGallery:
    '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  viewRecent: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  sort: '<path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/>',
  check: '<path d="M5 12.5L10 17.5L19 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  grip: '<g fill="currentColor"><circle cx="9" cy="6" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="18" r="1.2"/></g>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
} as const;

/** A name of one of the boards' icons. */
export type BoardIconName = keyof typeof PATHS;

/**
 * One of the boards' line icons.
 * @param props.name - Which icon.
 * @param props.size - Edge in CSS pixels.
 * @param props.strokeWidth - Stroke width in viewBox units (the boards use 1.8 to 3.2).
 * @param props.color - Stroke colour; `currentColor` when absent.
 */
export function BoardIcon({
  name,
  size = 16,
  strokeWidth = 1.9,
  color,
  style,
}: {
  name: BoardIconName;
  size?: number;
  strokeWidth?: number;
  color?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}
