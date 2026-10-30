/** The small four-point star that marks AI actions in Docs (no board icon exists for it). */
export function AiSpark({ size = 14, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8}>
      <path d="M12 3L13.8 9.2L20 11L13.8 12.8L12 19L10.2 12.8L4 11L10.2 9.2Z" strokeLinejoin="round" />
      <path d="M19 16V20M17 18H21" strokeLinecap="round" />
    </svg>
  );
}
