import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useProjectOps } from '../../api/aiProjectOps';
import { useCreateStory, useStoryAction } from '../../api/stories';
import type { StoryApprove, StoryView } from '../../types/story';
import { Ico, errorText } from './storyUi';
import styles from './story.module.css';

const DEFAULT_BUDGET = 2_000_000;

interface GiveStoryDialogProps {
  projectId: string;
  /** A Draft that already exists: only how it runs is asked (POST /stories/{id}/hand). */
  story?: StoryView | null;
  onClose: () => void;
  /** The Story the PM now has. */
  onDone?: (story: StoryView) => void;
}

/** The project's `autonomy.approve` (who takes the design approval, Team on its own): person or the PM. */
function projectApprove(ops: unknown): StoryApprove | null {
  const raw = (ops as { autonomy?: { approve?: unknown } } | undefined)?.autonomy?.approve;
  if (typeof raw !== 'string') return null;
  return /^pm$/i.test(raw) ? 'pm' : 'person';
}

/**
 * Give a Story to the PM (design/screens/ai-story-flow.md F, left card): title, goal, the criteria that say it is done,
 * who sees the plan first (pre-selected from the project's autonomy.approve) and the most it may spend.
 */
export function GiveStoryDialog({ projectId, story, onClose, onDone }: GiveStoryDialogProps) {
  const handing = !!story;
  const ops = useProjectOps(projectId);
  const fromProject = projectApprove(ops.data);
  const [title, setTitle] = useState(story?.title ?? '');
  const [goal, setGoal] = useState(story?.goal ?? '');
  const [criteria, setCriteria] = useState<string[]>(
    story && story.criteria.length > 0 ? story.criteria.map((c) => c.text) : [''],
  );
  const [approve, setApprove] = useState<StoryApprove | null>(story?.approve ?? null);
  const [budget, setBudget] = useState<number>(story?.tokens.budget || DEFAULT_BUDGET);
  const [error, setError] = useState<string | null>(null);
  const criterionRefs = useRef<(HTMLInputElement | null)[]>([]);
  const errorRef = useRef<HTMLDivElement | null>(null);
  const focusLast = useRef(false);
  const create = useCreateStory(projectId);
  const hand = useStoryAction(story?.id ?? '', projectId);
  const busy = create.isPending || hand.isPending;
  const chosen: StoryApprove = approve ?? fromProject ?? 'person';

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

  useEffect(() => {
    if (!focusLast.current) return;
    focusLast.current = false;
    criterionRefs.current[criteria.length - 1]?.focus();
  }, [criteria.length]);

  // the error sits under the fold of a long form: bring it into view, or the button seems to do nothing
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [error]);

  const canSubmit = handing || (title.trim().length > 0 && goal.trim().length > 0);

  async function submit() {
    if (!canSubmit || busy) return;
    setError(null);
    try {
      const result = handing
        ? await hand.mutateAsync({ kind: 'hand', approve: chosen, budgetTokens: budget })
        : await create.mutateAsync({
            title: title.trim(),
            goal: goal.trim(),
            criteria: criteria.map((c) => c.trim()).filter(Boolean),
            approve: chosen,
            budgetTokens: budget,
            hand: true,
          });
      onDone?.(result);
      onClose();
    } catch (err) {
      setError(errorText(err, 'The Story could not be given to the PM. Try again.'));
    }
  }

  const option = (value: StoryApprove, head: string, sub: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={chosen === value}
      className={`${styles.option} ${chosen === value ? styles.optionOn : ''}`}
      onClick={() => setApprove(value)}
      data-testid={`story-approve-${value}`}
    >
      <span className={`${styles.radio} ${chosen === value ? styles.radioOn : ''}`} />
      <span style={{ fontSize: 12.5, lineHeight: 1.45 }}>
        <b>{head}</b>
        <span className={styles.hint} style={{ display: 'block', fontSize: 11.5 }}>
          {sub}
        </span>
      </span>
    </button>
  );

  return createPortal(
    <div
      className={styles.overlay}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="Give a Story to the PM">
        <div className={styles.dialogHead}>
          <div style={{ flex: 1 }}>
            <b style={{ fontSize: 15 }}>Give a Story to the PM</b>
            <div className={styles.hint} style={{ marginTop: 2 }}>
              The PM plans it, splits it into tickets, runs them and tells you when it is done.
            </div>
          </div>
          <button type="button" className={styles.iconBtn} aria-label="Close" onClick={onClose}>
            <Ico name="x" size={15} width={2} />
          </button>
        </div>

        <div className={styles.dialogBody}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Title</span>
            <input
              className={styles.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Weather app, web version"
              readOnly={handing}
              autoFocus={!handing}
              data-testid="story-title"
            />
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Goal, in your own words</span>
            <textarea
              className={styles.input}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="What you want, in a sentence or two."
              readOnly={handing}
              data-testid="story-goal"
            />
            <span className={styles.hint} style={{ fontSize: 11.5 }}>
              Say what you want, not how. The PM and the BA turn it into tickets.
            </span>
          </label>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>It is done when</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {criteria.map((c, i) => (
                <div key={i} className={styles.input}>
                  <Ico name="circleCheck" size={14} color="#5B6B60" width={1.8} />
                  <input
                    ref={(el) => {
                      criterionRefs.current[i] = el;
                    }}
                    value={c}
                    aria-label={`Criterion ${i + 1}`}
                    placeholder="I can …"
                    readOnly={handing}
                    onChange={(e) => setCriteria((all) => all.map((x, j) => (j === i ? e.target.value : x)))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !handing) {
                        e.preventDefault();
                        focusLast.current = true;
                        setCriteria((all) => [...all, '']);
                      }
                    }}
                  />
                  {!handing && criteria.length > 1 && (
                    <button
                      type="button"
                      className={styles.iconBtn}
                      style={{ width: 22, height: 22 }}
                      aria-label={`Remove criterion ${i + 1}`}
                      onClick={() => setCriteria((all) => all.filter((_, j) => j !== i))}
                    >
                      <Ico name="x" size={12} width={2} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {!handing && (
              <button
                type="button"
                className={styles.link}
                style={{ fontSize: 12.5, fontWeight: 600, gap: 6, alignSelf: 'flex-start' }}
                onClick={() => {
                  focusLast.current = true;
                  setCriteria((all) => [...all, '']);
                }}
              >
                <Ico name="plus" size={13} color="#1B3A6B" />
                Add a criterion
              </button>
            )}
            <span className={styles.hint} style={{ fontSize: 11.5 }}>
              The PM checks each of these at the end, and only then closes the Story.
            </span>
          </div>

          <div className={styles.field} role="radiogroup" aria-label="Before it runs">
            <span className={styles.fieldLabel}>Before it runs</span>
            {option(
              'person',
              'Show me the plan first',
              'The PM writes it and waits. You approve, change it, or send it back.',
            )}
            {option(
              'pm',
              'The PM approves its own plan',
              'It runs at once. You can still read the plan and override a decision.',
            )}
            <span className={styles.hint} style={{ fontSize: 11.5 }} data-testid="story-approve-hint">
              {fromProject === 'pm' ? (
                <>
                  Pre-selected <i>as for designs in this project</i> (Team on its own): <b>The PM</b>.
                </>
              ) : fromProject === 'person' ? (
                <>
                  Pre-selected from this project&rsquo;s setting for who approves designs (Team on its own): <b>You</b>.
                </>
              ) : (
                <>Who approves designs in this project is not set, so the plan is shown to you first.</>
              )}
            </span>
          </div>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Spend at most</span>
            <span className={styles.input}>
              <Ico name="battery" size={14} color="#5B6B60" width={1.7} />
              <input
                inputMode="numeric"
                value={budget ? budget.toLocaleString('en-US') : ''}
                placeholder="No limit"
                aria-label="Spend at most, in tokens"
                onChange={(e) => setBudget(Number(e.target.value.replace(/[^0-9]/g, '')) || 0)}
                data-testid="story-budget"
              />
              <span className={styles.hint}>tokens</span>
            </span>
            <span className={styles.hint} style={{ fontSize: 11.5 }}>
              The Story stops and asks when it reaches this. It is counted across all its tickets.
            </span>
          </label>

          {error && (
            <div ref={errorRef} className={styles.error} role="alert">
              {error}
            </div>
          )}
        </div>

        <div className={styles.dialogFoot}>
          <span style={{ flex: 1 }} />
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={!canSubmit || busy}
            onClick={() => void submit()}
            data-testid="story-give"
          >
            <Ico name="send" size={14} color="#fff" width={1.9} />
            {busy ? 'Giving it to the PM…' : 'Give it to the PM'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
