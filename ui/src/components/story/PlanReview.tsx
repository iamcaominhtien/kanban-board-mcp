import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStoryAction } from '../../api/stories';
import type { StoryPlanItem, StoryView } from '../../types/story';
import { Ico, RoleBadge, StoryStateChip, byWord, coverNumbers, errorText, fmtSpan, roleOf, waitsWord } from './storyUi';
import styles from './story.module.css';

/**
 * Change the plan in place: the order of its tickets and what each one waits for (PATCH /stories/{id}/plan).
 * A ticket can only wait for one that comes before it.
 */
export function PlanEditor({
  story,
  onCancel,
  onSaved,
}: {
  story: StoryView;
  onCancel: () => void;
  onSaved?: () => void;
}) {
  const [items, setItems] = useState<StoryPlanItem[]>(() =>
    [...(story.plan?.items ?? [])].sort((a, b) => a.order - b.order),
  );
  const [error, setError] = useState<string | null>(null);
  const action = useStoryAction(story.id, story.projectId);

  const move = (i: number, by: -1 | 1) => {
    setItems((all) => {
      const j = i + by;
      if (j < 0 || j >= all.length) return all;
      const next = [...all];
      [next[i], next[j]] = [next[j], next[i]];
      // A ticket waits only for tickets before it
      return next.map((it, k) => {
        const before = new Set(next.slice(0, k).map((x) => x.ticketId));
        return { ...it, order: k + 1, after: it.after.filter((id) => before.has(id)) };
      });
    });
  };

  const toggleWait = (i: number, id: string) =>
    setItems((all) =>
      all.map((it, k) =>
        k === i ? { ...it, after: it.after.includes(id) ? it.after.filter((x) => x !== id) : [...it.after, id] } : it,
      ),
    );

  async function save() {
    setError(null);
    try {
      await action.mutateAsync({
        kind: 'edit',
        items: items.map((it) => ({ ticketId: it.ticketId, after: it.after })),
      });
      onSaved?.();
    } catch (err) {
      setError(errorText(err, 'The plan could not be changed.'));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="plan-editor">
      <div style={{ border: '1px solid #E3E8E5', borderRadius: 12, overflow: 'hidden' }}>
        <div
          className={styles.label}
          style={{
            display: 'grid',
            gridTemplateColumns: '22px minmax(0,1fr) 60px 200px',
            gap: 10,
            padding: '8px 14px',
            background: '#FBFCFB',
          }}
        >
          <span>#</span>
          <span>Ticket</span>
          <span>Order</span>
          <span>Waits for</span>
        </div>
        {items.map((it, i) => (
          <div
            key={it.ticketId}
            style={{
              display: 'grid',
              gridTemplateColumns: '22px minmax(0,1fr) 60px 200px',
              gap: 10,
              alignItems: 'center',
              padding: '9px 14px',
              borderTop: '1px solid #EEF3EF',
            }}
            data-testid="plan-editor-row"
          >
            <span style={{ fontSize: 12, fontWeight: 700, color: '#5B6B60' }}>{i + 1}</span>
            <span style={{ minWidth: 0 }}>
              <span className={styles.mono}>{it.ticketId}</span>{' '}
              <span style={{ fontSize: 13, fontWeight: 600 }}>{it.title}</span>
            </span>
            <span style={{ display: 'inline-flex', gap: 2 }}>
              <button
                type="button"
                className={styles.iconBtn}
                style={{ width: 24, height: 24 }}
                disabled={i === 0}
                aria-label={`Move ${it.ticketId} up`}
                onClick={() => move(i, -1)}
              >
                <Ico name="up" size={13} />
              </button>
              <button
                type="button"
                className={styles.iconBtn}
                style={{ width: 24, height: 24 }}
                disabled={i === items.length - 1}
                aria-label={`Move ${it.ticketId} down`}
                onClick={() => move(i, 1)}
              >
                <Ico name="down" size={13} />
              </button>
            </span>
            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {i === 0 ? (
                <span className={styles.hint}>first</span>
              ) : (
                items.slice(0, i).map((b, k) => {
                  const on = it.after.includes(b.ticketId);
                  return (
                    <button
                      key={b.ticketId}
                      type="button"
                      aria-pressed={on}
                      title={`${it.ticketId} waits for ${b.ticketId}`}
                      className={styles.chip}
                      style={{
                        cursor: 'pointer',
                        border: `1px solid ${on ? '#2E6F40' : '#E3E8E5'}`,
                        background: on ? '#E6F2EA' : '#fff',
                        color: on ? '#1F5A31' : '#5B6B60',
                        fontFamily: 'inherit',
                      }}
                      onClick={() => toggleWait(i, b.ticketId)}
                    >
                      {k + 1}
                    </button>
                  );
                })
              )}
            </span>
          </div>
        ))}
      </div>
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={action.isPending}
          onClick={() => void save()}
          data-testid="plan-editor-save"
        >
          {action.isPending ? 'Saving…' : 'Save the plan'}
        </button>
        <button type="button" className={styles.btn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The plan, waiting for you (design/screens/ai-story-flow.md F, right card): the PM's note, the tickets in order with
 * who holds them and the criteria they cover, then Approve and run, Change the plan, Tell the PM what to change, Reject.
 */
export function PlanReviewCard({
  story,
  onClose,
  onClosed,
}: {
  story: StoryView;
  /** Shown as a dialog: the close button. */
  onClose?: () => void;
  /** The plan was approved, sent back or rejected. */
  onClosed?: () => void;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'tell' | 'reject'>('view');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const action = useStoryAction(story.id, story.projectId);
  const plan = story.plan;
  const items = [...(plan?.items ?? [])].sort((a, b) => a.order - b.order);
  const toNumbers = coverNumbers(items);
  const covered = new Set(items.flatMap((i) => toNumbers(i.covers)));
  const total = story.criteria.length;
  const missing = story.criteria.map((_, i) => i + 1).filter((n) => !covered.has(n));
  const pmName = story.pm?.name ?? 'PM';
  const writtenIn = plan?.at && story.handedAt ? fmtSpan(story.handedAt, plan.at, true) : null;

  async function run(a: Parameters<typeof action.mutateAsync>[0], fallback: string) {
    setError(null);
    try {
      await action.mutateAsync(a);
      setNote('');
      setMode('view');
      onClosed?.();
    } catch (err) {
      setError(errorText(err, fallback));
    }
  }

  return (
    <div
      style={{
        border: '1px solid #E3E8E5',
        borderRadius: 14,
        background: '#fff',
        boxShadow: onClose ? '0 14px 40px rgba(30,42,34,0.10)' : undefined,
        boxSizing: 'border-box',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        maxHeight: onClose ? 'calc(100vh - 32px)' : undefined,
      }}
      data-testid="plan-review"
    >
      <div className={styles.dialogHead} style={{ alignItems: 'center' }}>
        <span
          style={{
            width: 27,
            height: 27,
            borderRadius: 7,
            background: '#E6ECF5',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Ico name="story" size={15} color="#1B3A6B" width={2} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <b style={{ fontSize: 15 }}>Plan for {story.title}</b>
            <StoryStateChip face={story.planWaiting ? 'plan_needs_you' : 'planning'} />
          </div>
          <div className={styles.hint}>
            {story.id}
            {plan ? ` · written by ${byWord(plan.by, pmName)}${writtenIn ? ` in ${writtenIn}` : ''}` : ''}
            {plan && plan.version > 1 ? ` · version ${plan.version}` : ''}
          </div>
        </div>
        {onClose && (
          <button type="button" className={styles.iconBtn} aria-label="Close" onClick={onClose}>
            <Ico name="x" size={15} width={2} />
          </button>
        )}
      </div>

      <div className={styles.dialogBody} style={{ padding: '14px 18px', gap: 12 }}>
        {!plan ? (
          <div className={styles.hint}>The PM is still writing the plan.</div>
        ) : mode === 'edit' ? (
          <PlanEditor story={story} onCancel={() => setMode('view')} onSaved={() => setMode('view')} />
        ) : (
          <>
            {plan.note && (
              <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 13, lineHeight: 1.5 }}>
                <RoleBadge role="pm" size={24} title={pmName} />
                <span>{plan.note}</span>
              </div>
            )}
            <div style={{ border: '1px solid #E3E8E5', borderRadius: 12, overflow: 'hidden' }}>
              <div
                className={styles.label}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '22px minmax(0,1fr) 110px 120px',
                  gap: 10,
                  padding: '8px 14px',
                  background: '#FBFCFB',
                }}
              >
                <span>#</span>
                <span>Ticket</span>
                <span>Held by</span>
                <span>Covers</span>
              </div>
              {items.map((it) => {
                const role = roleOf(it.heldBy?.role);
                const nums = toNumbers(it.covers);
                return (
                  <div
                    key={it.ticketId}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '22px minmax(0,1fr) 110px 120px',
                      gap: 10,
                      alignItems: 'center',
                      padding: '10px 14px',
                      borderTop: '1px solid #EEF3EF',
                    }}
                    data-testid="plan-review-row"
                  >
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#5B6B60' }}>{it.order}</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{it.title}</div>
                      <div className={styles.hint} style={{ fontSize: 11.5 }}>
                        {waitsWord(it, items)}
                      </div>
                    </div>
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      {it.heldBy ? (
                        <>
                          <RoleBadge role={it.heldBy.role} title={it.heldBy.name} />
                          <span style={{ fontSize: 12 }}>{role.label}</span>
                        </>
                      ) : (
                        <span className={styles.hint}>nobody yet</span>
                      )}
                    </span>
                    <span style={{ fontSize: 11.5, color: '#1F5A31', fontWeight: 600 }}>
                      {nums.length > 0 ? `criterion ${nums.join(', ')}` : <span className={styles.hint}>none</span>}
                    </span>
                  </div>
                );
              })}
            </div>
            {total > 0 &&
              (missing.length === 0 ? (
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    padding: '9px 12px',
                    borderRadius: 9,
                    background: '#E6F2EA',
                    fontSize: 12.5,
                    color: '#1F5A31',
                  }}
                >
                  <Ico name="circleCheck" size={14} color="#1F5A31" width={2} />
                  <b>All {total} criteria are covered.</b>
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    padding: '9px 12px',
                    borderRadius: 9,
                    background: '#FEF3D9',
                    fontSize: 12.5,
                    color: '#7A5A06',
                  }}
                  data-testid="plan-review-missing"
                >
                  <Ico name="warn" size={14} color="#7A5A06" width={2} />
                  <b>
                    {total - missing.length} of {total} criteria are covered.
                  </b>
                  Not covered: criterion {missing.join(', ')}.
                </div>
              ))}

            {mode === 'tell' && (
              <div className={styles.field}>
                <span className={styles.fieldLabel}>What should the PM change?</span>
                <textarea
                  className={styles.input}
                  value={note}
                  autoFocus
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Split the export button into its own ticket, and test boards with 5,000 tickets."
                  data-testid="plan-tell-note"
                />
                <span className={styles.hint} style={{ fontSize: 11.5 }}>
                  The PM writes version {(plan.version ?? 1) + 1} and shows it to you again.
                </span>
              </div>
            )}
            {mode === 'reject' && (
              <div className={styles.field}>
                <span className={styles.fieldLabel}>Reject the plan</span>
                <span className={styles.hint}>
                  The plan&rsquo;s tickets go to Won&rsquo;t do and the Story goes back to Draft.
                </span>
                <input
                  className={styles.input}
                  value={note}
                  autoFocus
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Why, for the PM (optional)"
                  data-testid="plan-reject-note"
                />
              </div>
            )}
            {error && (
              <div className={styles.error} role="alert">
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {mode === 'tell' ? (
                <>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={!note.trim() || action.isPending}
                    onClick={() =>
                      void run({ kind: 'revise', note: note.trim() }, 'The PM could not take the change. Try again.')
                    }
                    data-testid="plan-tell-send"
                  >
                    <Ico name="send" size={14} color="#fff" width={1.9} />
                    Send to the PM
                  </button>
                  <button type="button" className={styles.btn} onClick={() => setMode('view')}>
                    Cancel
                  </button>
                </>
              ) : mode === 'reject' ? (
                <>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnReject}`}
                    disabled={action.isPending}
                    onClick={() =>
                      void run({ kind: 'reject', note: note.trim() || undefined }, 'The plan could not be rejected.')
                    }
                    data-testid="plan-reject-confirm"
                  >
                    <Ico name="x" size={14} color="#A5321E" width={2} />
                    Reject the plan
                  </button>
                  <button type="button" className={styles.btn} onClick={() => setMode('view')}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={action.isPending || !story.planWaiting}
                    title={story.planWaiting ? undefined : 'The plan is not waiting for an approval.'}
                    onClick={() => void run({ kind: 'approve' }, 'The plan could not be approved.')}
                    data-testid="plan-approve"
                  >
                    <Ico name="play" size={13} color="#fff" width={2} />
                    Approve and run
                  </button>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => setMode('edit')}
                    data-testid="plan-change"
                  >
                    <Ico name="draft" size={13} width={2} />
                    Change the plan
                  </button>
                  <button type="button" className={styles.btn} onClick={() => setMode('tell')} data-testid="plan-tell">
                    <Ico name="chat" size={13} width={2} />
                    Tell the PM what to change
                  </button>
                  <span style={{ flex: 1 }} />
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnReject}`}
                    onClick={() => setMode('reject')}
                    data-testid="plan-reject"
                  >
                    <Ico name="x" size={13} color="#A5321E" width={2} />
                    Reject
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The plan waiting for you, as a dialog over the board (opened from the card's amber strip). */
export function PlanReviewDialog({ story, onClose }: { story: StoryView; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Plan for ${story.title}`}
        style={{ width: 700, maxWidth: '100%', display: 'flex', flexDirection: 'column' }}
      >
        <PlanReviewCard story={story} onClose={onClose} onClosed={onClose} />
      </div>
    </div>,
    document.body,
  );
}
