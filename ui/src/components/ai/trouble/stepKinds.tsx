/** Icons of the step kinds the board writes itself (skills, helpers, trouble, retries, windows, messages). */
const KINDS: Record<string, { glyph: string; color: string; label: string }> = {
  skill: { glyph: '✦', color: '#5B3AA6', label: 'Skill' },
  subagent: { glyph: '⑂', color: '#5B3AA6', label: 'Helper' },
  trouble: { glyph: '!', color: '#B8860B', label: 'Trouble' },
  retry: { glyph: '↻', color: '#B8860B', label: 'Retry' },
  window: { glyph: '◔', color: '#B8860B', label: 'Window' },
  held: { glyph: '⏸', color: '#B8860B', label: 'Held' },
  message: { glyph: '➤', color: '#2F6FB0', label: 'Message' },
  fresh_session: { glyph: '✱', color: '#2F6FB0', label: 'Fresh conversation' },
};

/** Whether the board wrote this kind of step itself. */
export function isBoardStep(kind: string): boolean {
  return kind in KINDS;
}

/** The mark in front of a step the board wrote. */
export function BoardStepIcon({ kind }: Readonly<{ kind: string }>) {
  const k = KINDS[kind];
  if (!k) return null;
  return (
    <span
      title={k.label}
      aria-label={k.label}
      style={{ color: k.color, fontWeight: 800, width: 13, textAlign: 'center', flexShrink: 0 }}
    >
      {k.glyph}
    </span>
  );
}
