import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { assistApi, assistError, useAssistState, useCoverage, useDraft, useTicketDrafts } from '../../api/assist';
import { extractError } from '../../api/extractError';
import type { AssistDraft, DraftKind, Hunk } from '../../types/assist';
import type { Ticket } from '../../types';
import { SparkleIcon, secondsSince } from '../ai/aiUi';
import { shortcutLabel, useAssist } from './AssistContext';
import { AppliedAs, BoardAiAvatar, CostChip, DraftTag, currentPerson, featureBlock } from './assistUi';
import './assist.css';

/** Start a draft and remember its id; errors come back with their code. */
export function useStartDraft(projectId: string) {
  const [draftId, setDraftId] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const start = async (
    kind: DraftKind,
    opts: { ticketId?: string; docId?: string; data?: Record<string, unknown> },
  ) => {
    setStarting(true);
    setError(null);
    try {
      const d = await assistApi.startDraft(projectId, { kind, ...opts });
      setDraftId(d.id);
      return d;
    } catch (e) {
      const body = assistError(e);
      setError({ code: body?.code ?? 'error', message: body?.detail ?? extractError(e) });
      return null;
    } finally {
      setStarting(false);
    }
  };
  return { draftId, setDraftId, error, setError, starting, start };
}

/** C2: skeleton while the draft is written. */
export function DraftLoading({
  draft,
  reading,
  onCancel,
}: {
  draft: AssistDraft | null;
  reading: string;
  onCancel: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = secondsSince(draft?.createdAt) ?? 0;
  return (
    <div className="as-draft" data-testid="draft-loading">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="ai-spin" />
        <b style={{ fontSize: 13 }}>Drafting… {s} s</b>
        <span style={{ flex: 1 }} />
        <button type="button" className="ai-btn ai-btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {s >= 15 && (
        <div className="ai-muted">Still working; the provider is slow. You can keep editing the ticket meanwhile.</div>
      )}
      <div className="as-skel" style={{ height: 14, width: '70%' }} />
      <div className="as-skel" style={{ height: 50 }} />
      <div className="as-skel" style={{ height: 14, width: '45%' }} />
      <div className="ai-muted">{reading}</div>
    </div>
  );
}

/** C3: error, the form is unchanged. */
export function DraftFailed({
  draft,
  onRetry,
  onManual,
}: {
  draft: AssistDraft;
  onRetry: () => void;
  onManual: () => void;
}) {
  return (
    <div className="as-tile as-tile-error" data-testid="draft-failed">
      <div className="as-tile-title">Draft didn’t come back</div>
      <div className="ai-hint">{draft.result.error?.message ?? 'The Board AI did not answer.'}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="ai-btn ai-btn-primary ai-btn-sm" onClick={onRetry}>
          Try again
        </button>
        <button type="button" className="ai-btn ai-btn-sm" onClick={onManual}>
          Fill in by hand
        </button>
      </div>
    </div>
  );
}

/** I4: the draft stopped at the per-request cap. */
export function PartialNotice({
  draft,
  onContinue,
  onAccept,
}: {
  draft: AssistDraft;
  onContinue: () => void;
  onAccept?: () => void;
}) {
  const p = draft.payload.partial;
  if (!p) return null;
  return (
    <div className="as-tile as-tile-warn" data-testid="draft-partial">
      <div className="ai-hint">
        Draft stopped at the per-request cap{p.cap != null ? ` ($${p.cap.toFixed(2)})` : ''}. Only these fields came
        back: {Object.keys(draft.payload.fields ?? {}).join(', ') || 'none'}
        {p.missing.length ? `; ${p.missing.join(', ')} missing.` : '.'}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="ai-btn ai-btn-sm" onClick={onContinue}>
          Continue{p.metered ? ` ($${p.continueCost.toFixed(2)})` : ''}
        </button>
        {onAccept && (
          <button type="button" className="ai-btn ai-btn-sm" onClick={onAccept}>
            Accept what is there
          </button>
        )}
      </div>
    </div>
  );
}

function Overlay({
  title,
  children,
  onClose,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div className="ai-overlay" style={{ zIndex: 1060 }} onClick={onClose} role="presentation">
      <div
        className="ai-modal ai-root"
        style={{ width: wide ? 'min(860px, 94vw)' : 'min(680px, 94vw)', maxHeight: '88vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// C4 Improve description
// ---------------------------------------------------------------------------

function HunkView({ h, on, toggle }: { h: Hunk; on: boolean; toggle: () => void }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <div className="as-diff" style={{ flex: 1 }}>
        {h.removed.map((l, i) => (
          <div key={`r${i}`} className="as-diff-del">
            <span>−</span>
            <span>{l || ' '}</span>
          </div>
        ))}
        {h.added.map((l, i) => (
          <div key={`a${i}`} className="as-diff-add">
            <span>+</span>
            <span style={{ whiteSpace: 'pre-wrap' }}>{l || ' '}</span>
          </div>
        ))}
        {h.note && (
          <div className="as-diff-ctx" style={{ fontSize: 11.5, fontStyle: 'italic' }}>
            {h.note}
          </div>
        )}
      </div>
      <button
        type="button"
        className={`ai-btn ai-btn-sm`}
        style={on ? { borderColor: '#2E6F40', background: '#EAF5ED' } : undefined}
        onClick={toggle}
      >
        {on ? '✓ Accept' : 'Accept'}
      </button>
    </div>
  );
}

/** Improve description on an existing ticket: diff or side by side, per-hunk Accept (C4). */
export function ImproveDescription({
  ticket,
  draftId,
  onClose,
}: {
  ticket: Ticket;
  draftId: string;
  onClose: () => void;
}) {
  const q = useDraft(draftId);
  const d = q.data;
  const [view, setView] = useState<'diff' | 'side'>('diff');
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hunks = useMemo(() => d?.payload.hunks ?? [], [d?.payload.hunks]);
  useEffect(() => {
    if (picked === null && hunks.length) setPicked(new Set(hunks.map((h) => h.id)));
  }, [hunks, picked]);
  const sel = picked ?? new Set<string>();
  const apply = async (ids: string[], force = false) => {
    setBusy(true);
    setError(null);
    try {
      await assistApi.apply(draftId, { hunks: ids, force });
      await q.refetch();
    } catch (e) {
      const body = assistError(e);
      setError(body?.detail ?? extractError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Overlay title="Improve description" onClose={onClose} wide>
      <div className="ai-modal-head" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="ai-mono" style={{ fontWeight: 700 }}>
          {ticket.id}
        </span>
        <b>Improve description</b>
        <DraftTag />
        <span style={{ flex: 1 }} />
        <div className="ai-seg">
          <button type="button" className={view === 'diff' ? 'ai-seg-on' : ''} onClick={() => setView('diff')}>
            Diff
          </button>
          <button type="button" className={view === 'side' ? 'ai-seg-on' : ''} onClick={() => setView('side')}>
            Side by side
          </button>
        </div>
        <button type="button" className="ai-icobtn" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div
        className="ai-modal-body"
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        data-testid="improve-description"
      >
        {!d || d.status === 'pending' ? (
          <DraftLoading
            draft={d ?? null}
            reading="Reading the ticket, its comments and linked docs"
            onCancel={async () => {
              await assistApi.cancel(draftId);
              onClose();
            }}
          />
        ) : d.status === 'failed' ? (
          <DraftFailed
            draft={d}
            onRetry={() => void assistApi.regenerate(draftId).then(() => q.refetch())}
            onManual={onClose}
          />
        ) : d.status === 'applied' || d.status === 'undone' ? (
          <div className="as-tile" style={{ flexDirection: 'row', alignItems: 'center' }}>
            <span style={{ flex: 1 }}>
              {d.status === 'applied'
                ? `Description replaced (${d.result.count} change${d.result.count !== 1 ? 's' : ''} accepted).`
                : 'Undone.'}
            </span>
            {d.status === 'applied' && (
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                onClick={() => void assistApi.undo(draftId).then(() => q.refetch())}
              >
                Undo
              </button>
            )}
            <button type="button" className="ai-btn ai-btn-sm" onClick={onClose}>
              Close
            </button>
          </div>
        ) : !hunks.length ? (
          <div className="ai-hint">The Board AI found nothing to improve.</div>
        ) : view === 'diff' ? (
          <>
            {(d.payload.segments ?? []).map((seg, i) =>
              'keep' in seg ? (
                seg.keep.length ? (
                  <div key={i} className="as-diff-ctx" style={{ fontSize: 12.5 }}>
                    {seg.keep.slice(0, 3).join(' ')}
                    {seg.keep.length > 3 ? ' …' : ''}
                  </div>
                ) : null
              ) : (
                (() => {
                  const h = hunks.find((x) => x.id === seg.hunk)!;
                  return (
                    <HunkView
                      key={i}
                      h={h}
                      on={sel.has(h.id)}
                      toggle={() => {
                        const n = new Set(sel);
                        if (n.has(h.id)) n.delete(h.id);
                        else n.add(h.id);
                        setPicked(n);
                      }}
                    />
                  );
                })()
              ),
            )}
          </>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <div className="as-label">Now</div>
              <pre
                className="as-diff"
                style={{ padding: 10, whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit', fontSize: 12.5 }}
              >
                {d.payload.old}
              </pre>
            </div>
            <div>
              <div className="as-label">AI draft</div>
              <pre
                className="as-diff"
                style={{
                  padding: 10,
                  whiteSpace: 'pre-wrap',
                  margin: 0,
                  fontFamily: 'inherit',
                  fontSize: 12.5,
                  background: '#F6FBF7',
                }}
              >
                {d.payload.new}
              </pre>
            </div>
          </div>
        )}
        {d && (
          <PartialNotice
            draft={d}
            onContinue={() => void assistApi.regenerate(draftId, { allowMore: true }).then(() => q.refetch())}
          />
        )}
        {d?.status === 'open' && hunks.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="ai-btn ai-btn-primary"
                disabled={!sel.size || busy}
                onClick={() => void apply([...sel])}
              >
                Accept selected ({sel.size} of {hunks.length})
              </button>
              <button
                type="button"
                className="ai-btn"
                disabled={busy}
                onClick={() => void apply(hunks.map((h) => h.id))}
              >
                Accept all {hunks.length}
              </button>
              <button type="button" className="ai-link" onClick={() => void assistApi.discard(draftId).then(onClose)}>
                Discard
              </button>
              <span style={{ flex: 1 }} />
              <CostChip cost={d.cost} tokens={d.tokens} metered={d.cost > 0} />
            </div>
            <div className="ai-muted">
              Replaces the description when accepted. The old text stays in history and Activity has an Undo. Acceptance
              criteria and comments are not touched.
            </div>
            {d.conflicts?.length ? (
              <div className="as-tile as-tile-warn">
                <div className="as-tile-title">{ticket.id} changed after this draft</div>
                <div className="ai-hint">{d.conflicts[0].message}.</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="ai-btn ai-btn-primary ai-btn-sm"
                    onClick={() => void assistApi.regenerate(draftId).then(() => q.refetch())}
                  >
                    Refresh draft
                  </button>
                  <button type="button" className="ai-btn ai-btn-sm" onClick={() => void apply([...sel], true)}>
                    Apply anyway
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
        {error && <div className="ai-error-text">{error}</div>}
      </div>
    </Overlay>
  );
}

// ---------------------------------------------------------------------------
// D Split with AI
// ---------------------------------------------------------------------------

/** Split with AI: checkboxes, order, blocked-by, inline title edit, dependency preview (D1, D2). */
export function SplitWithAi({ ticket, draftId, onClose }: { ticket: Ticket; draftId: string; onClose: () => void }) {
  const q = useDraft(draftId);
  const d = q.data;
  const items = useMemo(() => d?.payload.items ?? [], [d?.payload.items]);
  const [sel, setSel] = useState<Set<number> | null>(null);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateParent, setUpdateParent] = useState(false);
  useEffect(() => {
    if (sel === null && items.length) setSel(new Set(items.filter((i) => i.selected).map((i) => i.n)));
  }, [items, sel]);
  const picked = sel ?? new Set<number>();
  const total = items.filter((i) => picked.has(i.n)).reduce((a, i) => a + (i.estimate ?? 0), 0);
  const parentEst = d?.payload.parent?.estimate ?? ticket.estimate ?? null;
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await assistApi.apply(draftId, { selected: [...picked], titles, updateParent });
      await q.refetch();
    } catch (e) {
      setError(assistError(e)?.detail ?? extractError(e));
    } finally {
      setBusy(false);
    }
  };
  const depLabel = (deps: number[]) =>
    deps.length ? `Blocked by sub-ticket${deps.length > 1 ? 's' : ''} ${deps.join(', ')}` : 'Can start now';
  const links = items.flatMap((i) => i.blockedBy.map((b) => [b, i.n] as const));
  const short = (n: number) => {
    const t = titles[String(n)] ?? items.find((i) => i.n === n)?.title ?? '';
    return t.split(' ').slice(0, 4).join(' ');
  };
  return (
    <Overlay title="Split with AI" onClose={onClose} wide>
      <div className="ai-modal-head" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="ai-mono" style={{ fontWeight: 700 }}>
          {ticket.id}
        </span>
        <b style={{ flex: 1 }}>{ticket.title}</b>
        {parentEst != null && (
          <span className="ai-chip" style={{ background: '#F1F4F2', color: '#5B6B60' }}>
            {parentEst} pt
          </span>
        )}
        <button type="button" className="ai-icobtn" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div
        className="ai-modal-body"
        style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
        data-testid="split-with-ai"
      >
        {!d || d.status === 'pending' ? (
          <DraftLoading
            draft={d ?? null}
            reading="Reading the description and acceptance criteria"
            onCancel={async () => {
              await assistApi.cancel(draftId);
              onClose();
            }}
          />
        ) : d.status === 'failed' ? (
          <DraftFailed
            draft={d}
            onRetry={() => void assistApi.regenerate(draftId).then(() => q.refetch())}
            onManual={onClose}
          />
        ) : d.status === 'applied' ? (
          <div className="as-tile">
            <div className="as-tile-title">
              <span className="ai-chip" style={{ background: '#EAF5ED', color: '#2E6F40' }}>
                ✦ AI created {d.result.count} sub-tickets
              </span>
            </div>
            <div className="ai-hint">
              Accepted by {d.appliedBy}. Blocked-by links were created as Relations. Sub-tickets start unassigned.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                onClick={() => void assistApi.undo(draftId).then(() => q.refetch())}
              >
                Undo
              </button>
              <button type="button" className="ai-btn ai-btn-sm" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        ) : d.status !== 'open' ? (
          <div className="ai-muted">Draft {d.status}.</div>
        ) : (
          <>
            <div className="ai-hint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <BoardAiAvatar size={22} />
              <span>
                <b>{d.memberName}</b> proposed {items.length} sub-tickets from the description
                {d.payload.criteria ? ` and ${d.payload.criteria} acceptance criteria` : ''}. Nothing is created until
                you accept.
              </span>
            </div>
            <div className="ai-card" style={{ padding: 0 }}>
              {items.map((it) => {
                const on = picked.has(it.n);
                return (
                  <div
                    key={it.n}
                    style={{
                      display: 'flex',
                      gap: 10,
                      alignItems: 'center',
                      padding: '9px 12px',
                      borderTop: it.n === items[0].n ? 'none' : '1px solid #EDF1EE',
                      opacity: on ? 1 : 0.5,
                      borderLeft: '3px dashed #C7D2CB',
                    }}
                  >
                    <input
                      type="checkbox"
                      className="as-check"
                      checked={on}
                      aria-label={`Include sub-ticket ${it.n}`}
                      onChange={() => {
                        const n = new Set(picked);
                        if (n.has(it.n)) n.delete(it.n);
                        else n.add(it.n);
                        setSel(n);
                      }}
                    />
                    <span className="ai-mono" style={{ width: 18, color: '#9AA8A0' }}>
                      {it.n}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {editing === it.n ? (
                        <input
                          className="ai-input"
                          autoFocus
                          value={titles[String(it.n)] ?? it.title}
                          onChange={(e) => setTitles({ ...titles, [String(it.n)]: e.target.value })}
                          onBlur={() => setEditing(null)}
                          onKeyDown={(e) => e.key === 'Enter' && setEditing(null)}
                          aria-label={`Title of sub-ticket ${it.n}`}
                        />
                      ) : (
                        <button
                          type="button"
                          style={{
                            border: 'none',
                            background: 'none',
                            padding: 0,
                            fontFamily: 'inherit',
                            fontSize: 13,
                            fontWeight: 600,
                            textAlign: 'left',
                            cursor: 'text',
                            color: '#1E2A22',
                          }}
                          onClick={() => setEditing(it.n)}
                          title="Edit title"
                        >
                          {titles[String(it.n)] ?? it.title}
                        </button>
                      )}
                    </div>
                    <span
                      className="ai-chip"
                      style={{
                        background: it.blockedBy.length ? '#FDF2EE' : '#EAF5ED',
                        color: it.blockedBy.length ? '#B4541A' : '#2E6F40',
                      }}
                    >
                      {depLabel(it.blockedBy)}
                    </span>
                    <span
                      className="ai-mono"
                      style={{ fontSize: 12, width: 40, textAlign: 'right' }}
                      title={it.estimateError ?? undefined}
                    >
                      {it.estimate != null ? `${it.estimate} pt` : '—'}
                    </span>
                  </div>
                );
              })}
            </div>
            {links.length > 0 && (
              <div className="as-tile" data-testid="split-deps">
                <div className="as-label" style={{ margin: 0 }}>
                  Blocked-by (left blocks right)
                </div>
                {links.map(([a, b]) => (
                  <div key={`${a}-${b}`} style={{ fontSize: 12.5, display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="as-ctx-chip">
                      <span>
                        {a} {short(a)}
                      </span>
                    </span>
                    →
                    <span className="as-ctx-chip">
                      <span>
                        {b} {short(b)}
                      </span>
                    </span>
                  </div>
                ))}
                <div className="ai-muted">
                  Created as “blocked by” Relations, the same links as the Relations component. The order number is only
                  a suggestion.
                </div>
              </div>
            )}
            {parentEst != null && total > 0 && total !== parentEst && (
              <div className="as-tile as-tile-warn" style={{ flexDirection: 'row', alignItems: 'center' }}>
                <span style={{ flex: 1, fontSize: 12.5 }}>
                  Selected estimates add up to {total} pt; the parent says {parentEst} pt.
                </span>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12.5 }}>
                  <input
                    type="checkbox"
                    className="as-check"
                    checked={updateParent}
                    onChange={(e) => setUpdateParent(e.target.checked)}
                  />
                  Update parent to {total} pt
                </label>
              </div>
            )}
            {feedback !== null && (
              <div className="ai-field">
                <span className="ai-label">What should change?</span>
                <textarea
                  className="ai-textarea"
                  rows={2}
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="ai-btn ai-btn-sm ai-btn-primary"
                    disabled={!feedback.trim()}
                    onClick={async () => {
                      await assistApi.regenerate(draftId, { feedback });
                      setFeedback(null);
                      setSel(null);
                      await q.refetch();
                    }}
                  >
                    Redo the split
                  </button>
                  <button type="button" className="ai-btn ai-btn-sm" onClick={() => setFeedback(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="ai-btn ai-btn-primary"
                disabled={!picked.size || busy}
                onClick={() => void create()}
                data-testid="split-create"
              >
                Create {picked.size} sub-ticket{picked.size !== 1 ? 's' : ''}
              </button>
              <button type="button" className="ai-btn" onClick={() => setFeedback('')}>
                Ask for changes
              </button>
              <button type="button" className="ai-link" onClick={() => void assistApi.discard(draftId).then(onClose)}>
                Discard all
              </button>
              <span style={{ flex: 1 }} />
              {d.expiresAt && (
                <span className="ai-muted">
                  Draft expires in {Math.max(1, Math.round((new Date(d.expiresAt).getTime() - Date.now()) / 86400000))}{' '}
                  days
                </span>
              )}
            </div>
            <AppliedAs person={currentPerson()} ai={d.memberName} />
          </>
        )}
        {error && <div className="ai-error-text">{error}</div>}
      </div>
    </Overlay>
  );
}

/** D3: "AI created 4 sub-tickets" on the parent, with Undo. */
export function SplitBadge({ ticketId }: { ticketId: string }) {
  const drafts = useTicketDrafts(ticketId);
  const d = drafts.data?.find((x) => x.kind === 'split' && x.status === 'applied');
  if (!d) return null;
  return (
    <div
      className="ai-root"
      style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 8px' }}
      data-testid="split-badge"
    >
      <span
        className="ai-chip"
        style={{ background: '#EAF5ED', color: '#2E6F40' }}
        title={`Accepted by ${d.appliedBy}`}
      >
        ✦ AI created {d.result.count} sub-tickets
      </span>
      <span className="ai-muted">Accepted by {d.appliedBy}; blocked-by links are Relations.</span>
      <button type="button" className="ai-link" onClick={() => void assistApi.undo(d.id).then(() => drafts.refetch())}>
        Undo
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// E Test case suggestions
// ---------------------------------------------------------------------------

/** "Suggest cases" next to "Add test case" (A5). */
export function SuggestCasesButton({ ticket, onOpen }: { ticket: Ticket; onOpen: () => void }) {
  const ctx = useAssist();
  const st = useAssistState(ctx?.projectId);
  const block = featureBlock(st.data, 'test_cases');
  if (st.data && st.data.features.find((f) => f.key === 'test_cases' && !f.on)) return null;
  const noCriteria = !(ticket.acceptanceCriteria ?? []).length;
  return (
    <button
      type="button"
      className="ai-btn ai-btn-sm"
      style={{ borderColor: '#BFDCC7', background: '#F6FAF7' }}
      disabled={!!block}
      title={
        block
          ? block.reason
          : noCriteria
            ? 'Needs at least one acceptance criterion to suggest from.'
            : 'Draft cases for criteria without a test'
      }
      onClick={onOpen}
      data-testid="suggest-cases"
    >
      <SparkleIcon size={11} /> Suggest cases
    </button>
  );
}

/** Suggested cases tied to criteria, the coverage matrix, and the no-criteria prompt (E1–E3). */
export function SuggestCasesPanel({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const qc = useQueryClient();
  const sd = useStartDraft(ticket.projectId);
  const q = useDraft(sd.draftId);
  const d = q.data;
  const cov = useCoverage(ticket.id);
  const [sel, setSel] = useState<Set<number> | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noCriteria = !(ticket.acceptanceCriteria ?? []).length;
  const started = useRef(false);
  useEffect(() => {
    if (started.current || noCriteria) return;
    started.current = true;
    void sd.start('test_cases', { ticketId: ticket.id });
  }, [noCriteria, sd, ticket.id]);
  const cases = useMemo(() => d?.payload.cases ?? [], [d?.payload.cases]);
  useEffect(() => {
    if (sel === null && cases.length) {
      setSel(new Set(cases.map((c) => c.n)));
      setOpen(cases[0]?.n ?? null);
    }
  }, [cases, sel]);
  const picked = sel ?? new Set<number>();
  const coverage = cov.data?.coverage ?? d?.payload.coverage ?? [];
  return (
    <div
      className="ai-root"
      style={{ display: 'flex', flexDirection: 'column', gap: 12, margin: '10px 0' }}
      data-testid="suggest-cases-panel"
    >
      {noCriteria && !sd.draftId ? (
        <div className="as-tile" data-testid="no-criteria">
          <div className="as-tile-title">Add acceptance criteria first</div>
          <div className="ai-hint">
            This ticket has none, so there is nothing to tie cases to. Add criteria, or suggest from the description
            only.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="ai-btn ai-btn-sm"
              onClick={() => void sd.start('test_cases', { ticketId: ticket.id, data: { fromDescription: true } })}
            >
              Suggest from description
            </button>
            <button type="button" className="ai-btn ai-btn-sm" onClick={onClose}>
              Add criterion
            </button>
          </div>
        </div>
      ) : !d || d.status === 'pending' ? (
        <DraftLoading
          draft={d ?? null}
          reading="Reading the acceptance criteria, description and existing cases"
          onCancel={async () => {
            if (sd.draftId) await assistApi.cancel(sd.draftId);
            onClose();
          }}
        />
      ) : d.status === 'failed' ? (
        <DraftFailed
          draft={d}
          onRetry={() => void assistApi.regenerate(d.id).then(() => q.refetch())}
          onManual={onClose}
        />
      ) : d.status === 'applied' ? (
        <div className="as-tile" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <span style={{ flex: 1, fontSize: 13 }}>
            Added {d.result.count} test case{d.result.count !== 1 ? 's' : ''} as Pending.
          </span>
          <button
            type="button"
            className="ai-btn ai-btn-sm"
            onClick={() => void assistApi.undo(d.id).then(() => q.refetch())}
          >
            Undo
          </button>
          <button type="button" className="ai-btn ai-btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      ) : d.status === 'open' ? (
        <div className="as-draft">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="ai-hint">
              <b>{d.memberName}</b>{' '}
              {d.payload.fromDescription
                ? `suggested ${cases.length} cases from the description only.`
                : `suggested ${cases.length} cases for the ${d.payload.uncovered ?? 0} criteria without a test.`}
            </span>
            <DraftTag />
            <CostChip cost={d.cost} metered={d.cost > 0} />
            {!d.payload.fromDescription && (
              <span className="ai-chip" style={{ background: '#F1F4F2', color: '#5B6B60' }}>
                {d.payload.covered} of {d.payload.total} criteria covered
              </span>
            )}
          </div>
          {cases.map((c) => (
            <div
              key={c.n}
              style={{
                border: '1px solid #E3E8E5',
                borderRadius: 10,
                padding: '9px 11px',
                background: '#fff',
                opacity: picked.has(c.n) ? 1 : 0.55,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  className="as-check"
                  checked={picked.has(c.n)}
                  aria-label={`Include case ${c.n}`}
                  onChange={() => {
                    const n = new Set(picked);
                    if (n.has(c.n)) n.delete(c.n);
                    else n.add(c.n);
                    setSel(n);
                  }}
                />
                <span className="ai-chip" style={{ background: '#EAF5ED', color: '#2E6F40', height: 18 }}>
                  new
                </span>
                <button
                  type="button"
                  style={{
                    flex: 1,
                    border: 'none',
                    background: 'none',
                    textAlign: 'left',
                    fontFamily: 'inherit',
                    fontSize: 13,
                    fontWeight: 600,
                    cursor: 'pointer',
                    color: '#1E2A22',
                  }}
                  onClick={() => setOpen(open === c.n ? null : c.n)}
                >
                  {c.title}
                </button>
                {c.criterionIndex && (
                  <span className="ai-chip" style={{ background: '#F1EEFB', color: '#6B5BD2' }}>
                    AC {c.criterionIndex}
                  </span>
                )}
              </div>
              {open === c.n && (
                <div style={{ paddingLeft: 26, marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div className="as-label" style={{ margin: 0 }}>
                    Steps
                  </div>
                  <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
                    {c.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                  <div className="as-label" style={{ margin: 0 }}>
                    Expected result
                  </div>
                  <div style={{ fontSize: 12.5 }}>{c.expected}</div>
                </div>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="ai-btn ai-btn-primary"
              disabled={!picked.size || busy}
              data-testid="add-suggested-cases"
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await assistApi.apply(d.id, { selected: [...picked] });
                  await q.refetch();
                  await qc.invalidateQueries();
                } catch (e) {
                  setError(assistError(e)?.detail ?? extractError(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Add {picked.size} test case{picked.size !== 1 ? 's' : ''}
            </button>
            <button
              type="button"
              className="ai-btn"
              onClick={() =>
                void assistApi.regenerate(d.id).then(() => {
                  setSel(null);
                  return q.refetch();
                })
              }
            >
              Regenerate
            </button>
            <button type="button" className="ai-link" onClick={() => void assistApi.discard(d.id).then(onClose)}>
              Discard
            </button>
          </div>
          <div className="ai-muted">
            Added cases start as Pending, written by {currentPerson()} with “suggested by {d.memberName}”.
          </div>
        </div>
      ) : (
        <div className="ai-muted">Draft {d.status}.</div>
      )}
      {sd.error && <div className="ai-notice ai-notice-error">{sd.error.message}</div>}
      {coverage.length > 0 && (
        <div className="as-tile" data-testid="coverage-matrix">
          <div style={{ fontWeight: 700, fontSize: 13 }}>Coverage by acceptance criterion</div>
          {coverage.map((row) => (
            <div key={row.id} style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12.5 }}>
              <span className="ai-chip" style={{ background: '#F1EEFB', color: '#6B5BD2' }}>
                AC {row.index}
              </span>
              <span style={{ flex: 1 }}>{row.text}</span>
              {row.cases.length ? (
                row.cases.map((c) => (
                  <span key={c} className="ai-chip" style={{ background: '#EAF5ED', color: '#2E6F40' }}>
                    {c}
                  </span>
                ))
              ) : (
                <span className="ai-chip" style={{ background: '#FDF2EE', color: '#B4541A' }}>
                  No test
                </span>
              )}
            </div>
          ))}
          <div className="ai-muted">
            Coverage is only an aid. A criterion is “covered” when at least one case is linked to it; the AI does not
            run or judge tests.
          </div>
        </div>
      )}
      {error && <div className="ai-error-text">{error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A4 Ticket header "AI" menu
// ---------------------------------------------------------------------------

/** The ticket header "AI" menu: Improve description, Split with AI, Suggest test cases, Ask about this ticket (A4). */
export function TicketAiMenu({ ticket, onOpenTestCases }: { ticket: Ticket; onOpenTestCases: () => void }) {
  const ctx = useAssist();
  const st = useAssistState(ticket.projectId);
  const [open, setOpen] = useState(false);
  const [improve, setImprove] = useState<string | null>(null);
  const [split, setSplit] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sd = useStartDraft(ticket.projectId);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const drafting = featureBlock(st.data, 'drafting');
  const splitting = featureBlock(st.data, 'split');
  const cases = featureBlock(st.data, 'test_cases');
  const chat = featureBlock(st.data, 'chat');
  const isChild = !!ticket.parentId;
  const items = useMemo(
    () => [
      {
        label: 'Improve description',
        block: drafting?.reason,
        run: async () => {
          const d = await sd.start('description', { ticketId: ticket.id });
          if (d) setImprove(d.id);
        },
      },
      {
        label: 'Split with AI',
        block: splitting?.reason ?? (isChild ? 'A sub-ticket cannot be split again' : undefined),
        run: async () => {
          const d = await sd.start('split', { ticketId: ticket.id });
          if (d) setSplit(d.id);
        },
      },
      { label: 'Suggest test cases', block: cases?.reason, run: async () => onOpenTestCases() },
      {
        label: 'Ask about this ticket',
        block: chat?.reason,
        hint: shortcutLabel(),
        run: async () => ctx?.ask({ scope: 'ticket', ticketId: ticket.id }),
      },
    ],
    [drafting, splitting, cases, chat, isChild, sd, ticket.id, onOpenTestCases, ctx],
  );
  if (!st.data || st.data.boardAi.state === 'not_configured') {
    return null;
  }
  return (
    <div ref={ref} style={{ position: 'relative' }} className="ai-root">
      <button
        type="button"
        className="ai-btn ai-btn-sm"
        style={{ height: 34, borderColor: open ? '#2E6F40' : undefined }}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="ticket-ai-menu"
      >
        <SparkleIcon size={12} /> AI
      </button>
      {open && (
        <div className="as-menu" style={{ top: 40, left: 0 }} role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={!!it.block}
              title={it.block}
              onClick={async () => {
                setOpen(false);
                setError(null);
                await it.run();
              }}
            >
              <span style={{ flex: 1 }}>{it.label}</span>
              {'hint' in it && it.hint && <span className="as-kbd">{it.hint}</span>}
            </button>
          ))}
        </div>
      )}
      {(sd.error || error) && (
        <div className="as-popover" style={{ top: 40, left: 0, width: 280 }} role="alert">
          <div className="ai-error-text">{sd.error?.message ?? error}</div>
          <button type="button" className="ai-link" onClick={() => sd.setError(null)}>
            Close
          </button>
        </div>
      )}
      {improve && <ImproveDescription ticket={ticket} draftId={improve} onClose={() => setImprove(null)} />}
      {split && <SplitWithAi ticket={ticket} draftId={split} onClose={() => setSplit(null)} />}
    </div>
  );
}
