import { useEffect, useMemo, useState } from 'react';
import { assistApi, assistError, useAssistState, useDraft } from '../../api/assist';
import { extractError } from '../../api/extractError';
import type { AssigneeSuggestion, AssistDraft, DraftField } from '../../types/assist';
import { MemberAvatar } from '../MemberAvatar';
import { SparkleIcon } from '../ai/aiUi';
import { useAssist } from './AssistContext';
import { DraftTag, featureBlock, STATUS_LABEL } from './assistUi';
import { DraftFailed, DraftLoading, PartialNotice, useStartDraft } from './TicketAi';
import './assist.css';

type FieldKey = 'title' | 'description' | 'type' | 'priority' | 'labels' | 'estimate' | 'criteria' | 'assignee';
type FieldState = 'pending' | 'accepted' | 'rejected';

export interface ManualFill {
  title?: string;
  description?: string;
  type?: string;
  priority?: string;
  estimate?: number | null;
  assignee?: string | null;
}

const LABEL: Record<FieldKey, string> = {
  title: 'Title',
  description: 'Description',
  type: 'Type',
  priority: 'Priority',
  labels: 'Labels',
  estimate: 'Estimate',
  criteria: 'Acceptance criteria',
  assignee: 'Assignee',
};

function FieldCard({
  k,
  state,
  setState,
  children,
  note,
  editing,
  onEdit,
  wide,
}: {
  k: FieldKey;
  state: FieldState;
  setState: (s: FieldState) => void;
  children: React.ReactNode;
  note?: string;
  editing?: boolean;
  onEdit?: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className={`as-field ${state === 'accepted' ? 'as-field-accepted' : state === 'rejected' ? 'as-field-rejected' : ''}`}
      style={wide ? { gridColumn: '1 / -1' } : undefined}
      data-testid={`draft-field-${k}`}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className="ai-label" style={{ flex: 1 }}>
          {LABEL[k]}
        </span>
        {state === 'rejected' ? (
          <>
            <span className="ai-muted">Rejected</span>
            <button type="button" className="ai-link" onClick={() => setState('pending')}>
              Undo
            </button>
          </>
        ) : state === 'accepted' ? (
          <>
            <span className="ai-chip" style={{ background: '#EAF5ED', color: '#2E6F40', border: '1px solid #BFDCC7' }}>
              ✓ Accepted
            </span>
            {onEdit && (
              <button type="button" className="as-sq" aria-label={`Edit ${LABEL[k]}`} onClick={onEdit}>
                ✎
              </button>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              className="as-sq as-sq-on"
              aria-label={`Accept ${LABEL[k]}`}
              onClick={() => setState('accepted')}
            >
              ✓
            </button>
            <button
              type="button"
              className="as-sq"
              aria-label={`Reject ${LABEL[k]}`}
              onClick={() => setState('rejected')}
            >
              ✕
            </button>
            {onEdit && (
              <button
                type="button"
                className={`as-sq ${editing ? 'as-sq-on' : ''}`}
                aria-label={`Edit ${LABEL[k]}`}
                onClick={onEdit}
              >
                ✎
              </button>
            )}
          </>
        )}
      </div>
      <div className="as-field-value">{children}</div>
      {note && (
        <div className="ai-muted" style={{ fontSize: 11.5 }}>
          {note}
        </div>
      )}
    </div>
  );
}

/** "Draft with AI" in the New Ticket modal (A3, C1–C3, C5): one sentence becomes a full draft; each field is
 * accepted, rejected or edited; only "Create Ticket" creates anything. Similar tickets are checked first. */
export function DraftWithAi({
  projectId,
  members,
  onFillManual,
  onCreated,
  onUseExisting,
  onCancel,
  onActive,
}: {
  projectId: string;
  members: { id: string; name: string; color: string; kind?: string }[];
  onFillManual: (fill: ManualFill) => void;
  onCreated: (ticketId: string) => void;
  onUseExisting: (ticketId: string) => void;
  onCancel: () => void;
  /** True while a draft is shown (the modal hides its own form fields). */
  onActive?: (active: boolean) => void;
}) {
  const ctx = useAssist();
  const st = useAssistState(projectId);
  const [prompt, setPrompt] = useState('');
  const sd = useStartDraft(projectId);
  const q = useDraft(sd.draftId);
  const d = q.data;
  const [states, setStates] = useState<Partial<Record<FieldKey, FieldState>>>({});
  const [edits, setEdits] = useState<Partial<Record<FieldKey, unknown>>>({});
  const [editing, setEditing] = useState<FieldKey | null>(null);
  const [assignee, setAssignee] = useState<string | null>(null);
  const [dupOk, setDupOk] = useState(false);
  const [why, setWhy] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const block = featureBlock(st.data, 'drafting');
  const drafting = st.data?.features.find((f) => f.key === 'drafting');
  const fields = useMemo(() => (d?.payload.fields ?? {}) as Record<string, DraftField>, [d?.payload.fields]);
  const errors = d?.payload.errors ?? {};
  const keys = useMemo(
    () =>
      (['title', 'description', 'type', 'priority', 'labels', 'estimate', 'criteria'] as FieldKey[]).filter(
        (k) => fields[k],
      ),
    [fields],
  );
  const suggestions = (d?.payload.assignee ?? []) as AssigneeSuggestion[];
  const stateOf = (k: FieldKey): FieldState => states[k] ?? (k === 'title' ? 'accepted' : 'pending');
  const valueOf = <T,>(k: FieldKey): T => (k in edits ? edits[k] : fields[k]?.value) as T;
  const metered = st.data?.boardAi.metered;

  const draft = async () => {
    setStates({});
    setEdits({});
    setDupOk(false);
    await sd.start('ticket', { data: { prompt } });
  };
  const values = () => {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (stateOf(k) === 'accepted') out[k] = valueOf(k);
    if (assignee) out.assignee = assignee;
    return out;
  };
  const create = async () => {
    if (!d) return;
    setBusy(true);
    setError(null);
    try {
      const r = await assistApi.apply(d.id, { fields: values() });
      onCreated(String(r.result.ticketId));
    } catch (e) {
      setError(assistError(e)?.detail ?? extractError(e));
    } finally {
      setBusy(false);
    }
  };
  const acceptAll = () => {
    const next: Partial<Record<FieldKey, FieldState>> = {};
    for (const k of keys) next[k] = 'accepted';
    setStates(next);
    if (!assignee) {
      const best = suggestions.find((s) => s.best) ?? suggestions[0];
      if (best) setAssignee(best.memberId);
    }
  };
  const fillByHand = (src: AssistDraft | undefined) => {
    const f = (src?.payload.fields ?? {}) as Record<string, DraftField>;
    onFillManual({
      title: (f.title?.value as string) ?? prompt,
      description: f.description?.value as string | undefined,
      type: f.type?.value as string | undefined,
      priority: f.priority?.value as string | undefined,
      estimate: (f.estimate?.value as number | undefined) ?? null,
    });
    sd.setDraftId(null);
  };
  const open = d?.status === 'open';
  const active = !!d && ['open', 'pending'].includes(d.status);
  useEffect(() => {
    onActive?.(active);
  }, [active, onActive]);
  const similar = d?.payload.similar ?? [];
  const nAccept = keys.length;

  if (drafting && !drafting.on) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }} className="ai-root" data-testid="draft-with-ai">
      <div className="as-strip">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SparkleIcon size={13} />
          <b style={{ fontSize: 13.5 }}>Draft with AI</b>
          {st.data?.boardAi.name && (
            <span className="ai-chip" style={{ background: '#1E2A22', color: '#fff', height: 20 }}>
              ✦ {st.data.boardAi.name}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {open && valueOf<string>('type') && (
            <span className="as-ctx-chip">
              <span>🗋 Template: {String(valueOf<string>('type')).replace(/^\w/, (c) => c.toUpperCase())}</span>
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="ai-input"
            style={{ flex: 1, borderColor: '#2E6F40' }}
            placeholder="One sentence: what should the ticket do?"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (prompt.trim() && !block) void draft();
              }
            }}
            disabled={!!block}
            title={block?.reason}
            aria-label="Describe the ticket in one sentence"
            data-testid="draft-prompt"
          />
          <button
            type="button"
            className="ai-btn ai-btn-primary"
            disabled={!prompt.trim() || !!block || sd.starting || d?.status === 'pending'}
            onClick={() => void draft()}
            title={block?.reason}
            data-testid="draft-button"
          >
            ↗ Draft
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span className="as-ctx-chip" style={{ maxWidth: 'none' }}>
            <span>🔍 {d?.payload.reads ?? 'Reads labels, members, similar tickets'}</span>
          </span>
          <span className="as-cost">{metered ? '~$0.01 est.' : 'Not metered'}</span>
          {block && <span className="ai-muted">{block.reason}</span>}
        </div>
      </div>
      {sd.error && <div className="ai-notice ai-notice-error">{sd.error.message}</div>}
      {d?.status === 'pending' && (
        <DraftLoading
          draft={d}
          reading="Reading labels, members and similar tickets"
          onCancel={() => void assistApi.cancel(d.id).then(() => sd.setDraftId(null))}
        />
      )}
      {d?.status === 'failed' && (
        <DraftFailed draft={d} onRetry={() => void draft()} onManual={() => fillByHand(undefined)} />
      )}
      {open && similar.length > 0 && !dupOk && (
        <div className="as-tile as-tile-warn" data-testid="similar-tickets">
          <div className="as-tile-title" style={{ color: '#B4541A' }}>
            ⚠ Similar tickets found
          </div>
          {similar.map((t) => (
            <div
              key={t.id}
              className="as-tile"
              style={{ flexDirection: 'row', alignItems: 'center', padding: '8px 10px' }}
            >
              <button type="button" className="as-pill" onClick={() => ctx?.onOpenTicket(t.id)}>
                {t.id}
              </button>
              <span style={{ flex: 1, fontSize: 13 }}>{t.title}</span>
              <span className="ai-chip" style={{ background: '#EAF1FB', color: '#2F5FA8' }}>
                {STATUS_LABEL[t.status] ?? t.statusLabel}
              </span>
              <span className="ai-mono" style={{ color: '#B4541A', fontSize: 12, fontWeight: 700 }}>
                {t.match}% match
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => onUseExisting(similar[0].id)}>
              Use {similar[0].id} instead
            </button>
            <button type="button" className="ai-btn ai-btn-sm" onClick={() => setDupOk(true)}>
              Create anyway
            </button>
            <button type="button" className="ai-link" onClick={() => setWhy((v) => !v)}>
              Why these?
            </button>
          </div>
          {why && (
            <div className="ai-hint">
              Matched on shared words: {similar.map((t) => `${t.id}: ${t.why.join(', ') || '—'}`).join(' · ')}. A local
              word match, not an AI call.
            </div>
          )}
        </div>
      )}
      {open && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="ai-label">AI draft · review each field</span>
            <DraftTag />
            <span style={{ flex: 1 }} />
            <button type="button" className="ai-link" onClick={() => void draft()}>
              Regenerate ↻
            </button>
            <button type="button" className="ai-btn ai-btn-sm" onClick={acceptAll} data-testid="draft-accept-all">
              Accept all {nAccept + (suggestions.length ? 1 : 0)}
            </button>
          </div>
          <PartialNotice
            draft={d!}
            onContinue={() => void assistApi.regenerate(d!.id, { allowMore: true }).then(() => q.refetch())}
            onAccept={acceptAll}
          />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {keys.map((k) => {
              const f = fields[k];
              const v = valueOf<unknown>(k);
              const isEditing = editing === k;
              let content: React.ReactNode;
              if (k === 'title') {
                content = isEditing ? (
                  <input
                    className="ai-input"
                    value={String(v ?? '')}
                    onChange={(e) => setEdits({ ...edits, title: e.target.value })}
                  />
                ) : (
                  <div style={{ fontSize: 15, fontWeight: 600 }}>{String(v)}</div>
                );
              } else if (k === 'description') {
                content = isEditing ? (
                  <textarea
                    className="ai-textarea"
                    rows={6}
                    value={String(v ?? '')}
                    onChange={(e) => setEdits({ ...edits, description: e.target.value })}
                  />
                ) : (
                  <pre
                    className="ai-code"
                    style={{ display: 'block', whiteSpace: 'pre-wrap', padding: 10, margin: 0, fontSize: 12 }}
                  >
                    {String(v)}
                  </pre>
                );
              } else if (k === 'type' || k === 'priority') {
                const opts = k === 'type' ? ['bug', 'feature', 'task', 'chore'] : ['low', 'medium', 'high', 'critical'];
                content = isEditing ? (
                  <select
                    className="ai-input"
                    value={String(v)}
                    onChange={(e) => setEdits({ ...edits, [k]: e.target.value })}
                  >
                    {opts.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <div style={{ fontSize: 14, textTransform: 'capitalize' }}>{String(v)}</div>
                );
              } else if (k === 'labels') {
                const labels = (v as string[]) ?? [];
                content = (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {labels.map((l) => (
                      <span
                        key={l}
                        className="ai-chip"
                        style={{
                          background: (f.new ?? []).includes(l) ? '#F1F4F2' : '#EAF1FB',
                          color: (f.new ?? []).includes(l) ? '#5B6B60' : '#2F5FA8',
                        }}
                      >
                        {(f.new ?? []).includes(l) ? `+ NEW: ${l}` : l.toUpperCase()}
                        {isEditing && (
                          <button
                            type="button"
                            style={{ border: 'none', background: 'none', cursor: 'pointer' }}
                            aria-label={`Remove ${l}`}
                            onClick={() => setEdits({ ...edits, labels: labels.filter((x) => x !== l) })}
                          >
                            ✕
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                );
              } else if (k === 'estimate') {
                content = isEditing ? (
                  <div className="ai-seg">
                    {[1, 2, 3, 5, 8, 13].map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={v === n ? 'ai-seg-on' : ''}
                        onClick={() => setEdits({ ...edits, estimate: n })}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: 15 }}>{String(v)} pt</div>
                );
              } else {
                const crit = (v as string[]) ?? [];
                content = (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {crit.map((c, i) =>
                      isEditing ? (
                        <input
                          key={i}
                          className="ai-input"
                          value={c}
                          onChange={(e) =>
                            setEdits({ ...edits, criteria: crit.map((x, j) => (j === i ? e.target.value : x)) })
                          }
                        />
                      ) : (
                        <div key={i} style={{ display: 'flex', gap: 8, fontSize: 13 }}>
                          <span>☐</span>
                          {c}
                        </div>
                      ),
                    )}
                  </div>
                );
              }
              const note =
                k === 'labels' && (f.new ?? []).length
                  ? `${(f.new ?? []).map((x) => `“${x}”`).join(', ')} ${f.new!.length > 1 ? 'are' : 'is'} created only if you accept it.`
                  : f.note;
              return (
                <FieldCard
                  key={k}
                  k={k}
                  state={stateOf(k)}
                  setState={(s) => setStates({ ...states, [k]: s })}
                  note={note}
                  editing={isEditing}
                  onEdit={() => setEditing(isEditing ? null : k)}
                  wide={k === 'title' || k === 'description'}
                >
                  {content}
                </FieldCard>
              );
            })}
            {Object.entries(errors).map(([k, e]) => (
              <div key={k} className="as-field as-field-error" data-testid={`draft-invalid-${k}`}>
                <span className="ai-label">{LABEL[k as FieldKey] ?? k}</span>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{e.message}</div>
                <div className="ai-hint">
                  The AI returned {String(e.raw)}. Other fields are fine and can be accepted; this one is held back.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="ai-btn ai-btn-sm"
                    onClick={() => void assistApi.regenerate(d!.id, { field: k }).then(() => q.refetch())}
                  >
                    Regenerate field
                  </button>
                  <button type="button" className="ai-btn ai-btn-sm" onClick={() => setRawOpen((v) => !v)}>
                    {rawOpen ? 'Hide raw' : 'Show raw'}
                  </button>
                </div>
                {rawOpen && (
                  <pre
                    className="ai-code"
                    style={{ display: 'block', whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto', margin: 0 }}
                  >
                    {d!.raw}
                  </pre>
                )}
              </div>
            ))}
            {suggestions.length > 0 && (
              <div className="as-field" style={{ gridColumn: '1 / -1' }} data-testid="draft-field-assignee">
                <span className="ai-label">Suggested assignee · why</span>
                {suggestions.map((s) => {
                  const member = members.find((m) => m.id === s.memberId);
                  return (
                    <label
                      key={s.memberId}
                      style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}
                    >
                      <input
                        type="radio"
                        name="draft-assignee"
                        className="as-check"
                        checked={assignee === s.memberId}
                        onChange={() => setAssignee(s.memberId)}
                      />
                      {member ? <MemberAvatar member={member as never} size={24} /> : null}
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
                          {s.name}
                          {s.best && (
                            <span className="ai-chip" style={{ background: '#EAF5ED', color: '#2E6F40', height: 18 }}>
                              Best match
                            </span>
                          )}
                          {s.kind === 'ai' && (
                            <>
                              <span className="ai-chip" style={{ background: '#1E2A22', color: '#fff', height: 18 }}>
                                AI
                              </span>
                              <span className="ai-chip" style={{ background: '#EAF5ED', color: '#2E6F40', height: 18 }}>
                                Online
                              </span>
                            </>
                          )}
                        </div>
                        <div className="ai-hint">{s.reasons}</div>
                      </div>
                    </label>
                  );
                })}
                {assignee && (
                  <button
                    type="button"
                    className="ai-link"
                    style={{ alignSelf: 'flex-start' }}
                    onClick={() => setAssignee(null)}
                  >
                    Leave unassigned
                  </button>
                )}
                <div className="ai-muted">
                  Based on recent assignments and open work. Nothing is assigned until you accept.
                </div>
              </div>
            )}
          </div>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid #EDF1EE', paddingTop: 12 }}
          >
            <span className="ai-muted" style={{ flex: 1, fontSize: 12 }}>
              Rejected fields stay empty. Nothing is created until you press Create Ticket.
            </span>
            <button type="button" className="ai-btn" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="ai-link" onClick={() => fillByHand(d)}>
              Edit in the form
            </button>
            <button
              type="button"
              className="ai-btn ai-btn-primary"
              disabled={busy || stateOf('title') !== 'accepted' || (similar.length > 0 && !dupOk)}
              title={similar.length > 0 && !dupOk ? 'Look at the similar tickets first' : undefined}
              onClick={() => void create()}
              data-testid="draft-create"
            >
              Create Ticket
            </button>
          </div>
          {error && <div className="ai-error-text">{error}</div>}
        </>
      )}
    </div>
  );
}
