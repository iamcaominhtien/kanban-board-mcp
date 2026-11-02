import { useState } from 'react';
import { useBoardAi, useUpdateBoardAi } from '../../../api/aiBoard';
import { extractError } from '../../../api/extractError';
import type { Tier, TierRow } from '../../../types/aiBoard';
import { LoadError, Toggle } from '../aiUi';
import { LOCKED_REASON, OP_WORDS, TIER_BULLETS, TIER_STYLE, TIER_WORDS } from './tierWords';
import { MenuSelect } from '../../ui/MenuSelect';
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
              <ul style={{ margin: 0, paddingLeft: 17, fontSize: 12, lineHeight: 1.55, color: '#3A4A3E' }}>
                {TIER_BULLETS[tier].map((b) => (
                  <li key={b} style={{ margin: '0 0 5px' }}>
                    {b.replace('{n}', String(view.bulkTickets))}
                  </li>
                ))}
                {/* actions lowered into the first tier, after its fixed read-only bullets */}
                {tier === 'free' &&
                  rows('free').map((r) => (
                    <li key={r.op} style={{ margin: '0 0 5px' }} data-testid={`tier-free-${r.op}`}>
                      {OP_WORDS[r.op] ?? r.op}
                    </li>
                  ))}
              </ul>
              {tier === 'ask' && (
                <div style={{ fontSize: 12, color: '#3A4A3E' }}>
                  <b>Never, even if asked:</b> enter a key or password, delete a project.
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="ai-card" style={{ padding: 0, overflow: 'hidden' }} data-testid="board-ai-table">
        {[...view.tiers.filter((r) => !r.locked), ...view.tiers.filter((r) => r.locked)].map((r, i, all) => {
          const locked = r.locked;
          // C: the fixed actions come last, greyed, with the reason said once above them
          const firstLocked = locked && !all[i - 1]?.locked;
          const lowered = r.tier === 'free';
          return (
            <div key={r.op} style={{ display: 'contents' }}>
              {firstLocked && (
                <div className="ai-tier-locked-head" data-testid="tier-locked-reason">
                  <LineIcon name="lock" size={13} />
                  <span>{LOCKED_REASON}</span>
                </div>
              )}
              <div
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
                </div>
                {locked ? (
                  <span className="ai-chip" style={{ background: '#FFFBEF', color: '#7A5A06' }}>
                    <LineIcon name="lock" size={12} /> Asks first
                  </span>
                ) : lowerable(r) || lowered ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <span className="ai-muted">When it acts</span>
                    <MenuSelect
                      variant="chip"
                      label={`Tier of: ${OP_WORDS[r.op] ?? r.op}`}
                      value={r.tier as 'free' | 'undo'}
                      disabled={save.isPending}
                      menuWidth={240}
                      onChange={(v) => patch({ tiers: { [r.op]: v } })}
                      options={[
                        { value: 'undo', label: TIER_WORDS.undo, hint: 'Recorded, with an Undo' },
                        { value: 'free', label: TIER_WORDS.free, hint: 'Not recorded' },
                      ]}
                    />
                  </div>
                ) : (
                  <span className="ai-muted">{TIER_WORDS[r.tier]}</span>
                )}
              </div>
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
