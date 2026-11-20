/**
 * The line icons of the highlight boards (design board "Rich Docs — reading", K), drawn as the boards draw them:
 * a 24-unit view box, round caps and joins, the stroke in the current colour.
 */

const PATHS = {
  /** The marker pen of the Highlights button and the tip (78, 85). */
  marker: ['M9 15l-1 4-4 1 1-4z', 'M9 15L19 5l2 2L11 17z', 'M14 20h7'],
  copy: [
    'M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z',
    'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2',
  ],
  comment: ['M4 5h16v11H9l-5 4z'],
  link: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'],
  more: ['M12 3C12 8 14 10 19 12C14 14 12 16 12 21C12 16 10 14 5 12C10 10 12 8 12 3Z'],
  trash: ['M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'],
  go: ['M5 12h14M13 6l6 6-6 6'],
  close: ['M6 6L18 18', 'M18 6L6 18'],
  people: [
    'M3.5 19c0-3.5 2.5-5.5 5.5-5.5s5.5 2 5.5 5.5M16 5.5a3.2 3.2 0 0 1 0 5.5M17.5 14c2 .6 3 2.2 3 5',
    'M12.2 8a3.2 3.2 0 1 1-6.4 0a3.2 3.2 0 0 1 6.4 0z',
  ],
  warn: ['M12 3.5L22 20H2Z', 'M12 10V14', 'M12 17.2V17.3'],
  chevron: ['M6 9l6 6 6-6'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 0 12h-3'],
  /** Add to the page (75.4, 92). */
  pen: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  /** Use the new quote (87). */
  refresh: ['M4 12a8 8 0 0 1 14-5l2 2M20 4v5h-5M20 12a8 8 0 0 1-14 5l-2-2M4 20v-5h5'],
  /** Send to the team (94). */
  send: ['M21 3L10 14', 'M21 3l-7 18-4-7-7-4z'],
  check: ['M5 12.5L10 17.5L19 7'],
  /** Not sent yet (90). */
  offline: [
    'M3 3l18 18M5 12a10 10 0 0 1 4-2.3M2 8.8A15 15 0 0 1 8 5.6M19 12a10 10 0 0 0-4-2.3M22 8.8a15 15 0 0 0-6-3.2M9 16a5 5 0 0 1 6 0M12 20h.01',
  ],
} as const;

/** The names of the icons. */
export type HlIconName = keyof typeof PATHS | 'dots';

/**
 * One icon.
 * @param props.name - Which.
 * @param props.size - Width and height in CSS pixels.
 * @param props.stroke - Stroke width in view-box units.
 * @param props.color - Stroke colour (default: the current colour).
 */
export function HlIcon({
  name,
  size = 16,
  stroke = 1.9,
  color = 'currentColor',
}: {
  name: HlIconName;
  size?: number;
  stroke?: number;
  color?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {name === 'dots' ? (
        <>
          <circle cx="5" cy="12" r="1.3" />
          <circle cx="12" cy="12" r="1.3" />
          <circle cx="19" cy="12" r="1.3" />
        </>
      ) : (
        PATHS[name].map((d) => <path key={d} d={d} />)
      )}
    </svg>
  );
}
