import { useState } from 'react';
import { useBoardAi, useUpdateBoardAi } from '../../../api/aiBoard';
import { extractError } from '../../../api/extractError';
import type { Tier, TierRow } from '../../../types/aiBoard';
import { LoadError, Toggle } from '../aiUi';
import { LOCKED_REASON, OP_WORDS, TIER_STYLE, TIER_WORDS } from './tierWords';
import { LineIcon } from '../../ui/LineIcon';

const ORDER: Tier[] = ['free', 'undo', 'ask'];

/** What the Board AI may do by itself (design/screens/ai-board-wave3.md, A–C): three tiers, the locked set. */
export function BoardAiSection({ projectId }: { projectId: string }) {
  const q = useBoardAi(projectId);
  const save = useUpdateBoardAi(projectId);
  const [error, setError] = useState<string | null>(null);

  const patch = (body: Parameters<typeof save.mutate>[0]) => {
    setError(null);
    save.mutate(body, { onError: (e) => setError(extractError(e)) });
  };

  if (q.isError) return <LoadError what="the Board AI settings" error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <div className="as-skel" style={{ height: 120 }} data-testid="board-ai-loading" />;
  const view = q.data;
  const rows = (tier: Tier) => view.tiers.filter((r) => r.tier === tier);
  const lowerable = (r: TierRow) => !r.locked && r.default === 'undo' && r.tier === 'undo';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }} data-testid="board-ai-section">
      <div className="ai-card" style={{ padding: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Acts as you</div>
          <div className="ai-hint">
            The Board AI does the small, reversible things itself and keeps an Undo. Anything that cannot be walked back
            asks first. The audit says &ldquo;you (through the Board AI)&rdquo;, never the AI alone.
          </div>
        </div>
        <Toggle
          on={view.acts}
          label="Acts as you"
          testId="board-ai-acts"
          disabled={save.isPending}
          onChange={(next) => patch({ acts: next })}
        />
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }} data-testid="board-ai-tiers">
        {ORDER.map((tier) => {
          const s = TIER_STYLE[tier];
          return (
            <div
              key={tier}
              data-testid={`tier-${tier}`}
              style={{
                flex: '1 1 260px',
                minWidth: 260,
                border: `1px solid ${s.border}`,
                borderRadius: 11,
                background: s.bg,
                padding: '13px 15px',
                boxSizing: 'border-box',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 800, color: s.color }}>{TIER_WORDS[tier]}</div>
              <div style={{ fontSize: 12.5, lineHeight: 1.6 }}>{s.blurb.replace('{n}', String(view.bulkTickets))}</div>
              {tier === 'free' && rows('free').length === 0 && (
                <div className="ai-hint">Looking things up always happens at once.</div>
              )}
              <ul style={{ margin: 0, paddingLeft: 17, fontSize: 12, lineHeight: 1.55, color: '#3A4A3E' }}>
                {rows(tier).map((r) => (
                  <li key={r.op} style={{ margin: '0 0 5px' }}>
                    {OP_WORDS[r.op] ?? r.op}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="ai-card" style={{ padding: 0, overflow: 'hidden' }} data-testid="board-ai-table">
        {view.tiers.map((r) => {
          const locked = r.locked;
          const lowered = r.tier === 'free';
          return (
            <div
              key={r.op}
              data-testid={`tier-row-${r.op}`}
              data-locked={locked ? 'true' : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 14px',
                borderBottom: '1px solid #EEF3EF',
                opacity: locked ? 0.62 : 1,
                background: locked ? '#F6F7F6' : undefined,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600 }}>{OP_WORDS[r.op] ?? r.op}</div>
                {locked && <div className="ai-hint">{LOCKED_REASON}</div>}
              </div>
              {locked ? (
                <span className="ai-chip" style={{ background: '#FFFBEF', color: '#7A5A06' }}>
                  <LineIcon name="lock" size={12} /> Asks first
                </span>
              ) : lowerable(r) || lowered ? (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                  <span className="ai-muted">When it acts</span>
                  <select
                    className="ai-select"
                    aria-label={`Tier of: ${OP_WORDS[r.op] ?? r.op}`}
                    value={r.tier}
                    disabled={save.isPending}
                    onChange={(e) => patch({ tiers: { [r.op]: e.target.value as 'free' | 'undo' } })}
                  >
                    <option value="undo">{TIER_WORDS.undo}</option>
                    <option value="free">{TIER_WORDS.free}</option>
                  </select>
                </label>
              ) : (
                <span className="ai-muted">{TIER_WORDS[r.tier]}</span>
              )}
            </div>
          );
        })}
      </div>
      <div className="ai-hint">
        Only the middle tier can be lowered, and only to &ldquo;Just does it&rdquo;: a reversible action you are tired
        of seeing recorded can stop being recorded. Nothing can ever be lifted out of the last tier.
      </div>
      {error && (
        <div className="ai-notice ai-notice-error" role="alert" data-testid="board-ai-error">
          {error}
        </div>
      )}
    </div>
  );
}
