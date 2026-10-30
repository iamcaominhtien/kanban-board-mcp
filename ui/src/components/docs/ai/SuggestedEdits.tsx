import { useState } from 'react';
import type { CSSProperties } from 'react';
import { docsAiError } from '../../../api/docsAi';
import { useCareProposals, useChangeAction } from '../../../api/docsAiCare';
import { currentChange, pendingCount, type CareChange } from '../../../utils/careRules';
import { Icon } from '../Icon';
import '../docs.css';

const btn: CSSProperties = {
  font: 'inherit',
  fontSize: 12.5,
  fontWeight: 600,
  padding: '5px 12px',
  borderRadius: 7,
  border: '1px solid #D5DDD8',
  background: '#fff',
  color: '#1E2A22',
  cursor: 'pointer',
};
const primary: CSSProperties = { ...btn, background: '#2E6F40', borderColor: '#2E6F40', color: '#fff' };

function ChangeCard({
  change,
  canDecide,
  busy,
  first,
  onAction,
}: {
  change: CareChange;
  canDecide: boolean;
  busy: boolean;
  first: boolean;
  onAction: (a: 'accept' | 'reject' | 'edit', text?: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(change.new);
  const pending = change.status === 'pending' && !change.stale;
  return (
    <div
      data-testid={`suggested-change-${change.n}`}
      style={{
        border: '1px solid #E3E8E5',
        borderRadius: 10,
        background: '#fff',
        padding: '12px 14px',
        opacity: pending || first ? 1 : 0.7,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 6 }}>
        <b style={{ fontSize: 13.5, color: '#1E2A22' }}>Change {change.n}</b>
        <span style={{ fontSize: 12.5, color: '#5B6B60' }}>{change.reason || change.title}</span>
        {change.status !== 'pending' && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 11.5,
              fontWeight: 700,
              color: change.status === 'accepted' ? '#2E6F40' : '#8A978F',
            }}
          >
            {change.status === 'accepted' ? 'Accepted' : 'Skipped'}
          </span>
        )}
        {change.stale && change.status === 'pending' && (
          <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: '#9A6B00' }}>
            Needs a new look
          </span>
        )}
      </div>
      <div style={{ fontSize: 13.5, lineHeight: 1.55, color: '#1E2A22' }}>
        {change.old && (
          <span style={{ background: '#FBE7E4', color: '#8A2A18', textDecoration: 'line-through' }}>{change.old}</span>
        )}{' '}
        <span style={{ background: '#E4F2E7', color: '#1F5A2E' }}>{change.new}</span>
      </div>
      {editing && (
        <div style={{ marginTop: 8 }}>
          <textarea
            aria-label={`New text of change ${change.n}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              font: 'inherit',
              fontSize: 13,
              padding: 8,
              borderRadius: 7,
              border: '1px solid #D5DDD8',
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button
              type="button"
              style={primary}
              disabled={busy || !text.trim()}
              onClick={() => {
                onAction('edit', text);
                setEditing(false);
              }}
            >
              Save text
            </button>
            <button type="button" style={btn} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {pending && canDecide && !editing && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            type="button"
            style={primary}
            disabled={busy}
            onClick={() => onAction('accept')}
            data-testid={`accept-change-${change.n}`}
          >
            <Icon name="check" size={12} strokeWidth={2.4} /> Accept
          </button>
          <button type="button" style={btn} disabled={busy} onClick={() => onAction('reject')}>
            Skip
          </button>
          <button type="button" style={btn} disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Suggested edits of a freshness check, one change at a time (docs-ai-care A2): Accept / Skip / Edit and Accept all.
 * They are the changes of ONE proposal; accepting puts the text into the person's draft, nothing is published.
 */
export function SuggestedEdits({ pageId, proposalId }: { pageId: string; proposalId: string }) {
  const q = useCareProposals(pageId, true);
  const act = useChangeAction(pageId);
  const proposal = q.data?.proposals.find((p) => p.id === proposalId);
  if (!proposal) {
    return (
      <div role="status" style={{ fontSize: 12.5, color: '#5B6B60', padding: '8px 0' }}>
        {q.isLoading ? 'Loading the suggested edits…' : 'These edits are no longer waiting for a review.'}
      </div>
    );
  }
  const left = pendingCount(proposal.changes);
  const next = currentChange(proposal.changes);
  const err = act.error ? (docsAiError(act.error)?.detail ?? 'Could not save that.') : null;
  return (
    <div data-testid="suggested-edits" style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
      <div style={{ fontSize: 12.5, color: '#5B6B60' }}>
        {proposal.changes.length} change{proposal.changes.length === 1 ? '' : 's'} proposed
        {proposal.memberName ? ` by ${proposal.memberName}` : ''}
        {proposal.summary ? ` · ${proposal.summary}` : ''}
      </div>
      {proposal.changes.map((c) => (
        <ChangeCard
          key={c.n}
          change={c}
          first={next?.n === c.n}
          canDecide={proposal.canDecide}
          busy={act.isPending}
          onAction={(a, text) => act.mutate({ proposalId, n: c.n, action: a, text })}
        />
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {proposal.canDecide && left > 0 && (
          <button
            type="button"
            style={primary}
            disabled={act.isPending}
            onClick={() => act.mutate({ proposalId, action: 'acceptAll' })}
          >
            Accept all ({left})
          </button>
        )}
        <span style={{ fontSize: 12, color: '#5B6B60' }}>
          Accepted changes go into your draft of the page. Nothing is published until you press Publish.
        </span>
      </div>
      {err && (
        <div role="alert" style={{ fontSize: 12, color: '#C4432A' }}>
          {err}
        </div>
      )}
    </div>
  );
}
