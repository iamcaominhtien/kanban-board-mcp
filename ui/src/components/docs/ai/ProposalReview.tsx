import { useEffect, useState, type CSSProperties } from 'react';
import { docsAiError } from '../../../api/docsAi';
import { useProposalActions, type DocsAiProposal, type ProposalChange } from '../../../api/docsAiProposals';
import {
  acceptable,
  baseLine,
  changeState,
  memberLabel,
  proposedText,
  STATUS_LABEL,
  statesLegend,
} from '../../../utils/docsProposalRules';
import { Icon } from '../Icon';

const btn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  height: 30,
  padding: '0 12px',
  border: '1px solid #DCE0DC',
  borderRadius: 7,
  background: '#fff',
  color: '#1E2A22',
  fontSize: 12.5,
  fontWeight: 600,
  cursor: 'pointer',
};
const primary: CSSProperties = { ...btn, border: 0, background: '#2E6F40', color: '#fff' };
const chip = (bg: string, color: string): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  height: 20,
  padding: '0 8px',
  borderRadius: 10,
  background: bg,
  color,
  fontSize: 11,
  fontWeight: 600,
});

function Diff({ c }: { c: ProposalChange }) {
  const box: CSSProperties = {
    margin: 0,
    padding: '6px 8px',
    borderRadius: 6,
    fontSize: 12.5,
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'inherit',
  };
  return (
    <div style={{ display: 'grid', gap: 4, marginTop: 8 }} data-testid="proposal-diff">
      {c.kind === 'title' && <div style={{ fontSize: 11.5, color: '#6A6F6B' }}>Page title</div>}
      {c.old && (
        <pre style={{ ...box, background: '#FDF0EE', color: '#A2341F', textDecoration: 'line-through' }}>{c.old}</pre>
      )}
      {c.new ? (
        <pre style={{ ...box, background: '#EAF6EE', color: '#1F5A33' }}>{c.new}</pre>
      ) : (
        <div style={{ fontSize: 12, color: '#6A6F6B' }}>Removed.</div>
      )}
    </div>
  );
}

/**
 * "Proposed changes · 3": the changes an AI member proposes for the page, each with its reason, Accept / Reject /
 * Edit, and Accept all / Reject all (docs-ai-care B). Accepted changes go into the reviewer's own draft; nothing is
 * published here. The changes are shown as a list of old → new (the page itself is not marked inline).
 * @param props.proposal - The proposal to review.
 * @param props.pageId - Its page.
 * @param props.days - Days a proposal waits before it expires (Settings › Docs).
 * @param props.earlier - Decided proposals of the page, listed below.
 * @param props.onClose - Close the panel.
 */
export function ProposalReview({
  proposal: p,
  pageId,
  days,
  earlier,
  onClose,
}: {
  proposal: DocsAiProposal;
  pageId: string;
  days: number;
  earlier: DocsAiProposal[];
  onClose: () => void;
}) {
  const act = useProposalActions(pageId);
  const [editing, setEditing] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [legend, setLegend] = useState(false);
  const waiting = p.status === 'waiting';
  const decide = waiting && p.canDecide;
  const busy =
    act.accept.isPending ||
    act.reject.isPending ||
    act.edit.isPending ||
    act.acceptAll.isPending ||
    act.rejectAll.isPending;

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(docsAiError(e)?.detail ?? 'Something went wrong. Try again.');
    }
  };
  const n = acceptable(p);

  return (
    <aside
      role="dialog"
      aria-label="Proposed changes"
      data-testid="proposal-review-panel"
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(420px, 100vw)',
        zIndex: 70,
        display: 'flex',
        flexDirection: 'column',
        background: '#fff',
        borderLeft: '1px solid #E4E7E4',
        boxShadow: '-12px 0 32px rgba(20, 30, 24, 0.12)',
      }}
    >
      <header style={{ padding: '16px 18px 10px', borderBottom: '1px solid #EEF0EE' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 16, flex: 1 }}>Proposed changes · {p.changes.length}</h2>
          <span style={chip('#F1ECFB', '#6B4FBB')}>✦ {p.memberName ?? 'AI'}</span>
          <button type="button" aria-label="Close" onClick={onClose} style={{ ...btn, padding: '0 8px', border: 0 }}>
            <Icon name="close" size={15} strokeWidth={1.9} />
          </button>
        </div>
        <div style={{ marginTop: 6, fontSize: 12.5, color: '#5E655F' }}>
          {memberLabel(p)} {proposedText(p.changes.length)}
          {p.ticketId ? `, for ${p.ticketId}` : ''}.
        </div>
        <div
          style={{ marginTop: 4, fontSize: 12.5, color: p.changedSince ? '#B26A0B' : '#5E655F' }}
          data-testid="proposal-base"
        >
          {baseLine(p)}
        </div>
        {!waiting && (
          <div style={{ marginTop: 6 }}>
            <span style={chip('#EEF0EE', '#3C4A40')}>{STATUS_LABEL[p.status]}</span>
            {p.decisionNote && (
              <span style={{ marginLeft: 6, fontSize: 12, color: '#5E655F' }}>“{p.decisionNote}”</span>
            )}
          </div>
        )}
      </header>
      <div style={{ flex: 1, overflow: 'auto', padding: '12px 18px', display: 'grid', gap: 10, alignContent: 'start' }}>
        {p.changes.map((c) => {
          const st = changeState(c);
          return (
            <section
              key={c.n}
              data-testid="proposal-change"
              data-state={st}
              style={{
                padding: '12px 14px',
                border: '1px solid #E4E7E4',
                borderRadius: 10,
                opacity: st === 'rejected' ? 0.65 : 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <b style={{ fontSize: 13.5, flex: 1 }}>
                  {c.n}. {c.title}
                </b>
                {st === 'accepted' && <span style={chip('#EAF6EE', '#2E6F40')}>Accepted</span>}
                {st === 'rejected' && <span style={chip('#EEF0EE', '#5E655F')}>Rejected</span>}
                {st === 'stale' && <span style={chip('#FDF3E3', '#B26A0B')}>Needs a new look</span>}
              </div>
              {c.reason && <div style={{ marginTop: 3, fontSize: 12.5, color: '#5E655F' }}>Reason: {c.reason}</div>}
              {c.section && <div style={{ fontSize: 11.5, color: '#8A8F8B' }}>In # {c.section}</div>}
              {editing === c.n ? (
                <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={5}
                    aria-label="New text"
                    style={{ width: '100%', fontSize: 12.5, padding: 8, borderRadius: 6, border: '1px solid #DCE0DC' }}
                  />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      style={primary}
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          await act.edit.mutateAsync({ id: p.id, n: c.n, text });
                          setEditing(null);
                        })
                      }
                    >
                      Save
                    </button>
                    <button type="button" style={btn} onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <Diff c={c} />
              )}
              {decide && st === 'pending' && editing !== c.n && (
                <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                  <button
                    type="button"
                    style={primary}
                    disabled={busy}
                    data-testid="proposal-accept"
                    onClick={() => void run(() => act.accept.mutateAsync({ id: p.id, n: c.n }))}
                  >
                    <Icon name="check" size={13} strokeWidth={2.2} /> Accept
                  </button>
                  <button
                    type="button"
                    style={btn}
                    disabled={busy}
                    data-testid="proposal-reject"
                    onClick={() => void run(() => act.reject.mutateAsync({ id: p.id, n: c.n }))}
                  >
                    Reject
                  </button>
                  {c.kind === 'text' && (
                    <button
                      type="button"
                      style={btn}
                      disabled={busy}
                      onClick={() => {
                        setText(c.new);
                        setEditing(c.n);
                      }}
                    >
                      <Icon name="i15" size={13} strokeWidth={1.9} /> Edit
                    </button>
                  )}
                </div>
              )}
              {decide && st === 'stale' && (
                <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                  <button
                    type="button"
                    style={btn}
                    disabled={busy}
                    onClick={() => void run(() => act.reject.mutateAsync({ id: p.id, n: c.n }))}
                  >
                    Reject
                  </button>
                  <span style={{ fontSize: 12, color: '#8A8F8B', alignSelf: 'center' }}>
                    The page no longer has this text.
                  </span>
                </div>
              )}
            </section>
          );
        })}
        {earlier.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: '#8A8F8B', textTransform: 'uppercase' }}>Earlier</div>
            {earlier.map((e) => (
              <div key={e.id} style={{ display: 'flex', gap: 8, fontSize: 12.5, padding: '6px 0', color: '#3C4A40' }}>
                <span style={{ flex: 1 }}>
                  {e.memberName} · {e.changes.length} {e.changes.length === 1 ? 'change' : 'changes'}
                  {e.ticketId ? ` · ${e.ticketId}` : ''}
                </span>
                <span style={chip('#EEF0EE', '#3C4A40')}>{STATUS_LABEL[e.status]}</span>
              </div>
            ))}
          </div>
        )}
        <div>
          <button
            type="button"
            onClick={() => setLegend((v) => !v)}
            style={{ ...btn, border: 0, padding: 0, height: 24, color: '#5E655F' }}
          >
            <Icon name={legend ? 'chevronDown' : 'chevronRight'} size={12} strokeWidth={2} /> States of a proposal
          </button>
          {legend && (
            <div style={{ display: 'grid', gap: 6, marginTop: 6 }} data-testid="proposal-states">
              {statesLegend(days).map((s) => (
                <div key={s.key} style={{ display: 'flex', gap: 8, fontSize: 12 }}>
                  <span
                    style={{ width: 8, height: 8, marginTop: 5, borderRadius: 4, background: s.color, flex: 'none' }}
                  />
                  <span>
                    <b>{s.label}</b> {s.text}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <footer style={{ padding: '12px 18px 16px', borderTop: '1px solid #EEF0EE', display: 'grid', gap: 8 }}>
        {error && (
          <div role="alert" style={{ fontSize: 12.5, color: '#C4432A' }}>
            {error}
          </div>
        )}
        {decide && (
          <>
            {rejecting ? (
              <div style={{ display: 'grid', gap: 6 }}>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Why? (optional; the AI member sees it)"
                  aria-label="Reason for rejecting"
                  style={{ height: 30, padding: '0 8px', borderRadius: 6, border: '1px solid #DCE0DC', fontSize: 12.5 }}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    style={{ ...btn, color: '#C4432A' }}
                    disabled={busy}
                    data-testid="proposal-reject-all-confirm"
                    onClick={() =>
                      void run(async () => {
                        await act.rejectAll.mutateAsync({ id: p.id, note: note.trim() || undefined });
                        setRejecting(false);
                      })
                    }
                  >
                    Reject all
                  </button>
                  <button type="button" style={btn} onClick={() => setRejecting(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  style={primary}
                  disabled={busy || n === 0}
                  data-testid="proposal-accept-all"
                  onClick={() => void run(() => act.acceptAll.mutateAsync({ id: p.id }))}
                >
                  Accept all ({n})
                </button>
                <button type="button" style={btn} disabled={busy} onClick={() => setRejecting(true)}>
                  Reject all
                </button>
              </div>
            )}
          </>
        )}
        {waiting && !p.canDecide && (
          <div style={{ fontSize: 12.5, color: '#5E655F' }}>
            Only people who can edit this page decide its proposals.
          </div>
        )}
        <div style={{ fontSize: 12, color: '#5E655F' }}>
          Accepted changes go into <b>your draft</b>. You publish it yourself, like any edit.
        </div>
      </footer>
    </aside>
  );
}
