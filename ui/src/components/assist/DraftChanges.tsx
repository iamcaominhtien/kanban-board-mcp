import { useEffect, useMemo, useState } from 'react';
import { assistApi, assistError, useDraft } from '../../api/assist';
import { extractError } from '../../api/extractError';
import type { AssistDraft, DraftChange } from '../../types/assist';
import { hhmm } from '../ai/aiUi';
import { AppliedAs, DraftTag, STATUS_LABEL, TicketPill, currentPerson } from './assistUi';

const FIELD_LABEL: Record<string, string> = {
  status: 'Status',
  priority: 'Priority',
  assignee: 'Assignee',
  due_date: 'Due date',
  estimate: 'Estimate',
  title: 'Title',
};

function show(ch: DraftChange, side: 'from' | 'to'): string {
  const v = side === 'from' ? ch.from : ch.to;
  if (ch.op === 'assignee') return (side === 'from' ? ch.fromName : ch.toName) ?? 'Unassigned';
  if (ch.op === 'status') return STATUS_LABEL[String(v)] ?? String(v);
  if (ch.op === 'priority') return String(v ?? '').replace(/^\w/, (c) => c.toUpperCase());
  if (ch.op === 'estimate') return v == null ? 'No estimate' : `${v} pt`;
  if (ch.op === 'due_date')
    return v ? new Date(String(v)).toLocaleDateString([], { month: 'short', day: 'numeric' }) : 'No date';
  return v == null ? '—' : String(v);
}

/** A "changes" draft: the diff, checkboxes, Apply / Edit / Discard, conflict and viewer states, result line with
 * Undo (B2, B10, I6, I7, F1 draft comment). */
export function DraftChanges({
  draftId,
  initial,
  onRefresh,
  compact,
}: {
  draftId: string;
  initial?: AssistDraft | null;
  /** "Refresh draft" after a conflict (re-asks the chat or re-acts on the insight). */
  onRefresh?: () => void;
  compact?: boolean;
}) {
  const q = useDraft(draftId);
  const d = q.data ?? initial ?? null;
  const [picked, setPicked] = useState<Set<number> | null>(null);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [viewer, setViewer] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const changes = useMemo(() => d?.payload.changes ?? [], [d?.payload.changes]);

  useEffect(() => {
    if (picked === null && changes.length) setPicked(new Set(changes.map((_, i) => i)));
  }, [changes, picked]);

  if (!d) return <div className="as-skel" style={{ height: 80 }} />;
  if (d.status === 'pending')
    return (
      <div className="as-draft" data-testid="draft-pending">
        <DraftTag>Drafting…</DraftTag>
        <div className="as-skel" style={{ height: 14, width: '80%' }} />
        <div className="as-skel" style={{ height: 14, width: '60%' }} />
      </div>
    );
  if (d.status === 'failed')
    return <div className="ai-notice ai-notice-error">{d.result.error?.message ?? 'The draft did not come back.'}</div>;

  const sel = picked ?? new Set<number>();
  const n = changes.filter((_, i) => sel.has(i)).length;
  const person = currentPerson();

  const apply = async (force = false) => {
    setBusy(true);
    setError(null);
    try {
      await assistApi.apply(d.id, { selected: [...sel], edits, force });
      setConflict(null);
      setEditing(false);
      await q.refetch();
    } catch (e) {
      const body = assistError(e);
      if (body?.code === 'conflict') setConflict(body.detail);
      else if (body?.code === 'viewer') setViewer(body.detail);
      else setError(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  if (d.status === 'applied' || d.status === 'undone') {
    const count = d.result.count ?? 0;
    return (
      <div className="as-tile" style={{ flexDirection: 'row', alignItems: 'center' }} data-testid="draft-result">
        <span style={{ color: '#2E6F40', fontWeight: 700 }}>✓</span>
        <span style={{ flex: 1, fontSize: 13 }}>
          {d.status === 'undone' ? (
            <>
              Undone{d.result.undo?.skipped.length ? ` · ${d.result.undo.skipped.length} left as people set them` : ''}
            </>
          ) : (
            <>
              <b>
                Applied {count} change{count !== 1 ? 's' : ''}
              </b>{' '}
              <span className="ai-muted">at {hhmm(d.appliedAt)}</span>
              {d.result.errors?.length ? (
                <span className="ai-muted"> · {d.result.errors.length} could not be applied</span>
              ) : null}
            </>
          )}
        </span>
        {d.status === 'applied' && (
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await assistApi.undo(d.id);
                await q.refetch();
              } catch (e) {
                setError(extractError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Undo
          </button>
        )}
        {error && <div className="ai-error-text">{error}</div>}
      </div>
    );
  }
  if (d.status === 'discarded' || d.status === 'expired')
    return <div className="ai-muted">Draft {d.status}. Nothing was changed.</div>;

  return (
    <div className="as-draft" data-testid="draft-changes">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <DraftTag>Draft changes · {changes.length}</DraftTag>
        <span style={{ flex: 1 }} />
        <span className="ai-muted" style={{ fontSize: 12 }}>
          Not applied
        </span>
      </div>
      {changes.map((ch, i) => (
        <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            className="as-check"
            checked={sel.has(i)}
            aria-label={`Include change ${i + 1}`}
            onChange={() => {
              const next = new Set(sel);
              if (next.has(i)) next.delete(i);
              else next.add(i);
              setPicked(next);
            }}
          />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {ch.op === 'comment' ? (
              <>
                <div style={{ fontSize: 13, fontWeight: 700 }}>New comment on {ch.ticket}</div>
                {editing ? (
                  <textarea
                    className="ai-textarea"
                    rows={3}
                    value={edits[String(i)] ?? ch.text ?? ''}
                    onChange={(e) => setEdits({ ...edits, [String(i)]: e.target.value })}
                    aria-label="Comment text"
                  />
                ) : (
                  <div className="as-diff">
                    <div className="as-diff-add">
                      <span>+</span>
                      <span style={{ whiteSpace: 'pre-wrap' }}>{edits[String(i)] ?? ch.text}</span>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <TicketPill id={ch.ticket} />
                  <b style={{ fontSize: 13 }}>{FIELD_LABEL[ch.op] ?? ch.op}</b>
                </div>
                <div className="as-diff">
                  <div className="as-diff-del">
                    <span>−</span>
                    <span>{show(ch, 'from')}</span>
                  </div>
                  <div className="as-diff-add">
                    <span>+</span>
                    <span>{show(ch, 'to')}</span>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      ))}
      {d.payload.problems?.length ? <div className="ai-muted">Left out: {d.payload.problems.join('; ')}.</div> : null}
      {conflict && (
        <div className="as-tile as-tile-warn" data-testid="draft-conflict">
          <div className="as-tile-title">{changes[0]?.ticket ?? 'A ticket'} changed after this draft</div>
          <div className="ai-hint">{conflict}; this draft was written before.</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {onRefresh && (
              <button type="button" className="ai-btn ai-btn-primary ai-btn-sm" onClick={onRefresh}>
                Refresh draft
              </button>
            )}
            <button type="button" className="ai-btn ai-btn-sm" disabled={busy} onClick={() => void apply(true)}>
              Apply anyway
            </button>
          </div>
        </div>
      )}
      {viewer || d.viewer ? (
        <div className="as-tile as-tile-slate" data-testid="draft-viewer">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button type="button" className="ai-btn ai-btn-primary ai-btn-sm" disabled>
              Apply {n} change{n !== 1 ? 's' : ''}
            </button>
            <span className="ai-chip" style={{ background: '#EEF1F5', color: '#5B6B7A' }}>
              🔒 Viewer
            </span>
          </div>
          <div className="ai-hint">
            {viewer ?? `Ask the project lead${d.lead ? `, ${d.lead},` : ''} to apply this. Copy the draft to share it.`}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              onClick={() => {
                const text = changes
                  .map((c) =>
                    c.op === 'comment'
                      ? `${c.ticket}: comment “${c.text}”`
                      : `${c.ticket}: ${FIELD_LABEL[c.op]} ${show(c, 'from')} → ${show(c, 'to')}`,
                  )
                  .join('\n');
                void navigator.clipboard?.writeText(text);
                setCopied(true);
              }}
            >
              {copied ? 'Copied' : 'Copy draft'}
            </button>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              onClick={async () => {
                try {
                  const r = await assistApi.requestApply(d.id);
                  setViewer(`Asked ${r.lead ?? 'the project lead'} on ${r.ticketId}.`);
                } catch (e) {
                  setError(extractError(e));
                }
              }}
            >
              Request apply
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!n || busy}
            onClick={() => void apply(false)}
            data-testid="draft-apply"
          >
            {changes.length === 1 && changes[0].op === 'comment'
              ? 'Post comment'
              : `Apply ${n} change${n !== 1 ? 's' : ''}`}
          </button>
          <button type="button" className="ai-btn" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Done' : 'Edit'}
          </button>
          <button
            type="button"
            className="ai-link"
            onClick={async () => {
              await assistApi.discard(d.id);
              await q.refetch();
            }}
          >
            Discard
          </button>
        </div>
      )}
      {!compact && <AppliedAs person={person} ai={d.memberName || 'the Board AI'} />}
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}
