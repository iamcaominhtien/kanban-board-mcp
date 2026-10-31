/** "12.4k", "1M": tokens as short text. */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * How full a Claude Code conversation is, like the context bar of its status line: `used` of the model's window
 * `size` tokens. `inline` keeps it where it is put; otherwise it sits at the right end of its row.
 */
export function ContextMeter({
  used,
  size,
  inline,
  warnAt = 60,
}: {
  used: number;
  size: number;
  inline?: boolean;
  /** The share (%) at which Claude Code summarises the oldest part: the bar turns amber there. */
  warnAt?: number;
}) {
  const pct = Math.min(100, (used / size) * 100);
  const level = pct >= 85 ? 'hot' : pct >= warnAt ? 'warm' : 'ok';
  const label = pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
  return (
    <span
      className={`as-meter as-meter-${level}`}
      style={inline ? { marginLeft: 0 } : undefined}
      role="img"
      aria-label={`The conversation is ${label} full`}
      title={`${shortTokens(used)} of ${shortTokens(size)} tokens are in this conversation. Claude Code summarises the oldest part when it gets close to full.`}
      data-testid="assist-context-meter"
    >
      <span className="as-meter-bar">
        <i style={{ width: `${Math.max(pct, 3)}%` }} />
      </span>
      <span className="as-meter-num">{label}</span>
    </span>
  );
}
