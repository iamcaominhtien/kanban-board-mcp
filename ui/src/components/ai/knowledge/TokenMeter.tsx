/** "2,490 tokens in every prompt · 31% of 8k": what instructions and kept lessons add to every run. */
export function budgetLabel(budget: number): string {
  return budget >= 1000 && budget % 1000 === 0 ? `${budget / 1000}k` : budget.toLocaleString('en-US');
}

/**
 *
 */
export function TokenMeter({ total, budget }: { total: number; budget: number }) {
  const pct = budget > 0 ? Math.round((total / budget) * 100) : 0;
  const tone = pct >= 100 ? '#c4432a' : pct >= 75 ? '#b4791e' : '#2e6f40';
  return (
    <div
      data-testid="token-meter"
      style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5, fontWeight: 600 }}
    >
      <span>{total.toLocaleString('en-US')} tokens in every prompt</span>
      <span
        role="meter"
        aria-label="Share of the prompt budget"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(pct, 100)}
        style={{ width: 120, height: 6, borderRadius: 3, background: '#e3e8e5', overflow: 'hidden' }}
      >
        <i style={{ display: 'block', height: '100%', width: `${Math.min(pct, 100)}%`, background: tone }} />
      </span>
      <span className="ai-hint" data-testid="token-meter-share">
        {pct}% of {budgetLabel(budget)}
      </span>
    </div>
  );
}
