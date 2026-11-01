import { useState, type ReactNode } from 'react';
import { aiApi, useAiApprovals, useAiMutation } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiRun } from '../../types/ai';
import type { Comment } from '../../types/ticket';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { useToast } from '../Toast';
import { AiAvatar, RunStateChip, fmtElapsed, money, secondsSince, useAiBoardState, useNow } from './aiUi';
import { useAiTicket } from './AiTicketContext';
import './ticketWork.css';
import { ContextMeter } from '../assist/ContextMeter';

const IC = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function ThumbUp({ on }: { on?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" {...IC} fill={on ? 'currentColor' : 'none'} aria-hidden="true">
      <path d="M7 11v9H4v-9zM7 11l4-8c1.5 0 2.5 1 2.5 2.5V9h5.5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 17.8 20H7" />
    </svg>
  );
}
function ThumbDown({ on }: { on?: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" {...IC} fill={on ? 'currentColor' : 'none'} aria-hidden="true">
      <path d="M17 13V4h3v9zM17 13l-4 8c-1.5 0-2.5-1-2.5-2.5V15H5a2 2 0 0 1-2-2.3l1.2-7A2 2 0 0 1 6.2 4H17" />
    </svg>
  );
}

/** The small dark "AI" mark after an AI member's name (design C2: 16px, square corners, sparkle). */
export function AiBadge() {
  return (
    <span className="tw-ai-badge">
      <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style={{ flexShrink: 0 }}>
        <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
      </svg>
      AI
    </span>
  );
}

/** Status of one comment of an ask thread, shown as a chip at the right of its header (design C2). */
export type ThreadState =
  'asked' | 'thinking' | 'streaming' | 'answered' | 'error' | 'asks_again' | 'answer' | 'blocked';

// colours as the design draws them (AiTicketWork C2): neutral until answered (green) or failed (red)
const NEUTRAL = { bg: '#F6FAF7', color: '#5B6B60', border: '#E3E8E5' };
const BAD = { bg: '#FDF1EE', color: '#C4432A', border: '#F0C4B8' };
const STATE_STYLE: Record<ThreadState, { bg: string; color: string; border: string; label: string }> = {
  asked: { ...NEUTRAL, label: 'Asked' },
  thinking: { ...NEUTRAL, label: 'Thinking' },
  streaming: { ...NEUTRAL, label: 'Streaming' },
  answered: { bg: '#F1F8F3', color: '#2E6F40', border: '#BFDCC7', label: 'Answered' },
  error: { ...BAD, label: 'Error' },
  asks_again: { ...NEUTRAL, label: 'Reply asks again' },
  answer: { bg: '#EEF2F6', color: '#34455A', border: '#34455A33', label: 'Answer' },
  blocked: { ...BAD, label: 'Move blocked' },
};

/** The small uppercase state chip of a thread comment (“ASKED CLAUDE CODE · BACKEND”, “THINKING”, “ERROR”). */
export function ThreadChip({ state, label }: { state: ThreadState; label?: string }) {
  const s = STATE_STYLE[state];
  return (
    <span
      className="tw-state"
      style={{ background: s.bg, color: s.color, borderColor: s.border }}
      data-testid={`thread-${state}`}
    >
      {label ?? s.label}
    </span>
  );
}

/** The ask run a person's comment started (its question), if any. */
export function askRunOf(comment: Comment, runs: AiRun[]): AiRun | undefined {
  return runs.find((r) => r.mode === 'ask' && r.sourceCommentId === comment.id);
}

/** A run that never got going: failed, stopped or timed out before it took a single step. */
export function didNotStart(run: AiRun): boolean {
  return ['failed', 'cancelled', 'timed_out'].includes(run.state) && !run.startedAt && run.steps.length === 0;
}

/**
 * The state of a run a comment started, under that comment (design/screens/ai-where-you-work.md, C3): QUEUED
 * (Cancel), READING (Stop), NEEDS YOUR OK (Review), REVIEW when a work run is done, or DID NOT START (Try again).
 * An ask that is already writing shows its text underneath.
 */
export function AskPlaceholder({ run }: { run: AiRun }) {
  const { members, projectId } = useAiBoardState();
  const { openRun } = useAiTicket();
  const ai = members.get(run.memberId);
  const toast = useToast();
  const cancel = useAiMutation(() => aiApi.cancel(run.id));
  const retry = useAiMutation(() => aiApi.retry(run.id));
  const approvals = useAiApprovals(projectId, 'pending').data ?? [];
  useNow(1000, run.state === 'running' || run.state === 'starting');
  const said = run.steps.filter((s) => s.kind === 'say').map((s) => s.text);
  const all = said.join('\n\n');
  const text = all.length > 1200 ? `…${all.slice(-1200)}` : all;
  const live = run.state === 'queued' || run.state === 'starting' || run.state === 'running';
  const streaming = live && run.state === 'running' && run.mode === 'ask' && text.length > 0;
  const waiting = run.state === 'queued';
  const pending = live && !waiting ? approvals.filter((a) => a.runId === run.id) : [];
  const secs = secondsSince(run.startedAt ?? run.queuedAt) ?? 0;
  const name = run.memberName ?? ai?.name ?? 'The AI';
  const act = async (fn: () => Promise<unknown>, fail: string) => {
    try {
      await fn();
    } catch (err) {
      toast.error(fail, extractError(err));
    }
  };
  const stop = () => act(() => cancel.mutateAsync(undefined), "Couldn't stop it");

  let state: 'queued' | 'reading' | 'ok' | 'review' | 'failed' = 'reading';
  let label = 'READING';
  let body: ReactNode = (
    <>
      {name} is {run.mode === 'work' ? 'working on this ticket' : 'reading the ticket and the code'}…
    </>
  );
  let action: ReactNode = (
    <button type="button" className="ai-btn ai-btn-sm" onClick={stop} data-testid="ask-stop">
      Stop
    </button>
  );
  let lead: ReactNode = <span className="ai-spin" />;
  if (waiting) {
    state = 'queued';
    label = 'QUEUED';
    lead = <span className="tw-dot-grey" />;
    body = <>{run.waitingReason ?? 'Waiting for a free slot'}</>;
    action = (
      <button type="button" className="ai-btn ai-btn-sm" onClick={stop} data-testid="ask-stop">
        Cancel
      </button>
    );
  } else if (pending.length) {
    state = 'ok';
    label = 'NEEDS YOUR OK';
    lead = (
      <svg width="15" height="15" viewBox="0 0 24 24" {...IC} style={{ color: '#B4791E' }} aria-hidden="true">
        <rect x="5" y="11" width="14" height="9" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
    );
    body = (
      <>
        Wants to {pending[0].summary.replace(/^wants to\s+/i, '')}. Waiting for an approver.
        {pending.length > 1 ? ` (${pending.length} requests)` : ''}
      </>
    );
    action = (
      <button type="button" className="ai-btn ai-btn-sm" onClick={() => openRun(run.id)} data-testid="ask-review">
        Review
      </button>
    );
  } else if (didNotStart(run)) {
    state = 'failed';
    label = 'DID NOT START';
    lead = (
      <svg width="15" height="15" viewBox="0 0 24 24" {...IC} style={{ color: '#C4432A' }} aria-hidden="true">
        <path d="M12 3.5L22 20H2zM12 10v4M12 17.2v.1" />
      </svg>
    );
    body = <>{run.endedReason ?? 'It could not start.'} Nothing was sent.</>;
    action = (
      <button
        type="button"
        className="ai-btn ai-btn-sm"
        disabled={retry.isPending}
        data-testid="ask-retry"
        onClick={() => act(() => retry.mutateAsync(undefined), "Couldn't try again")}
      >
        Try again
      </button>
    );
  } else if (run.state === 'finished' && run.mode === 'work') {
    state = 'review';
    label = 'REVIEW';
    lead = <span style={{ color: '#2E6F40', fontWeight: 700 }}>✓</span>;
    body = <>{name} finished. The ticket is ready for your review.</>;
    action = (
      <button type="button" className="ai-btn ai-btn-sm" onClick={() => openRun(run.id)} data-testid="ask-review">
        Review
      </button>
    );
  }
  return (
    <div data-testid="ask-placeholder" data-state={state === 'reading' && streaming ? 'streaming' : state}>
      <div className={`tw-runrow ${state === 'failed' ? 'tw-runrow-bad' : state === 'review' ? 'tw-runrow-ok' : ''}`}>
        <span className="tw-runrow-label">{label}</span>
        <span style={{ display: 'inline-flex', width: 18, justifyContent: 'center' }}>{lead}</span>
        <span className="tw-runrow-text">
          {body}
          {state === 'reading' && !waiting && run.state !== 'queued' && (
            <span className="ai-muted ai-mono" style={{ marginLeft: 8 }}>
              {secs}s
            </span>
          )}
        </span>
        {action}
      </div>
      {streaming && (
        <div className="cm-row tw-thread-row" style={{ marginTop: 6 }}>
          {ai ? (
            <AiAvatar provider={ai.provider} color={ai.color} glyph={ai.glyph} size={28} title={ai.name} />
          ) : (
            <span style={{ width: 28 }} />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tw-head">
              <span style={{ fontSize: 13, fontWeight: 700 }}>{run.memberName}</span>
              <AiBadge />
              <span style={{ flex: 1 }} />
              <ThreadChip state="streaming" />
            </div>
            <div style={{ fontSize: 14, lineHeight: 1.65, color: '#3A4A3E' }}>
              <MarkdownRenderer>{text}</MarkdownRenderer>
              <span className="tw-caret" aria-hidden="true" />
              <div className="tw-live">
                <span
                  className="ai-chip"
                  style={{ background: '#F6FAF7', border: '1px solid #E3E8E5', color: '#5B6B60' }}
                >
                  ⚡ <span className="ai-mono">{Math.max(1, Math.round(all.length / 4))} tokens</span>
                </span>
                <span className="ai-muted">Streaming…</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Rating buttons, regenerate and edit-and-re-run under an AI's answer; the run link and cost on the left (C2). */
export function AnswerFooter({
  comment,
  run,
  canAct,
  onReply,
}: {
  comment: Comment;
  run?: AiRun;
  canAct: boolean;
  /** "Reply": answer this comment, which asks the AI again. */
  onReply?: () => void;
}) {
  const meta = comment.ai!;
  const { openRun } = useAiTicket();
  const toast = useToast();
  const [reasons, setReasons] = useState(false);
  const [edit, setEdit] = useState(false);
  const rate = useAiMutation((v: { rating: 'up' | 'down' | 'none'; reasons?: string[] }) =>
    aiApi.feedback(meta.runId, v.rating, v.reasons ?? []),
  );
  const again = useAiMutation(() => aiApi.regenerate(meta.runId, { replace: true }));
  const rating = run?.feedback?.rating;
  const send = async (v: { rating: 'up' | 'down' | 'none'; reasons?: string[] }) => {
    try {
      await rate.mutateAsync(v);
    } catch (err) {
      toast.error("Couldn't save the rating", extractError(err));
    }
  };
  return (
    <div data-testid="ai-comment-meta">
      <div className="tw-meta">
        <button type="button" className="tw-run-link" onClick={() => openRun(meta.runId)} data-testid="answer-run-link">
          <svg width="12" height="12" viewBox="0 0 24 24" {...IC} aria-hidden="true">
            <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
          </svg>
          Run #{meta.runNumber}
          {meta.durationS != null ? ` · ${fmtElapsed(meta.durationS)}` : ''}
        </button>
        <span className="tw-pillbox ai-mono">{meta.metered ? money(meta.costUsd) : 'Ⓢ Not metered'}</span>
        {meta.model && <span className="tw-pillbox tw-model">{meta.model}</span>}
        {run?.contextUsed && run.contextWindow ? (
          <ContextMeter used={run.contextUsed} size={run.contextWindow} inline />
        ) : null}
        {canAct && run && (
          <span className="tw-acts">
            <button
              type="button"
              className={`tw-icon ${rating === 'up' ? 'tw-icon-on' : ''}`}
              aria-label="Good answer"
              aria-pressed={rating === 'up'}
              data-testid="thumb-up"
              onClick={() => void send({ rating: rating === 'up' ? 'none' : 'up' })}
            >
              <ThumbUp on={rating === 'up'} />
            </button>
            <button
              type="button"
              className={`tw-icon ${rating === 'down' ? 'tw-icon-on tw-icon-bad' : ''}`}
              aria-label="Bad answer"
              aria-pressed={rating === 'down'}
              data-testid="thumb-down"
              onClick={() => {
                if (rating === 'down') void send({ rating: 'none' });
                else setReasons(true);
              }}
            >
              <ThumbDown on={rating === 'down'} />
            </button>
            <span className="tw-sep" />
            <button
              type="button"
              className="tw-act"
              disabled={again.isPending}
              data-testid="answer-regenerate"
              onClick={async () => {
                try {
                  await again.mutateAsync(undefined);
                } catch (err) {
                  toast.error("Couldn't ask again", extractError(err));
                }
              }}
            >
              ↻ Regenerate
            </button>
            <button type="button" className="tw-act" data-testid="answer-edit" onClick={() => setEdit(!edit)}>
              ✎ Edit and re-run
            </button>
            {onReply && (
              <button type="button" className="tw-act" data-testid="answer-reply" onClick={onReply}>
                ↩ Reply
              </button>
            )}
          </span>
        )}
      </div>
      {run?.feedback?.rating === 'down' && run.feedback.reasons.length > 0 && !reasons && (
        <div className="ai-muted" style={{ marginTop: 4 }}>
          Marked wrong: {run.feedback.reasons.map((r) => REASONS.find((x) => x.id === r)?.label ?? r).join(', ')}
        </div>
      )}
      {reasons && run && (
        <ThumbsReasons
          onSkip={() => {
            void send({ rating: 'down' });
            setReasons(false);
          }}
          onSend={(r) => {
            void send({ rating: 'down', reasons: r });
            setReasons(false);
          }}
        />
      )}
      {edit && run && <EditRerun run={run} onClose={() => setEdit(false)} />}
    </div>
  );
}

const REASONS = [
  { id: 'incorrect', label: 'Incorrect' },
  { id: 'out_of_date', label: 'Out of date' },
  { id: 'missed_context', label: 'Missed context' },
  { id: 'too_long', label: 'Too long' },
  { id: 'unsafe', label: 'Unsafe' },
];

/** Thumbs down opens a short reason list (C4). */
export function ThumbsReasons({ onSkip, onSend }: { onSkip: () => void; onSend: (reasons: string[]) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <div className="tw-card" data-testid="thumbs-reasons">
      <b style={{ fontSize: 13.5 }}>What was wrong with this answer?</b>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
        {REASONS.map((r) => {
          const on = picked.includes(r.id);
          return (
            <button
              key={r.id}
              type="button"
              className={`tw-chipbtn ${on ? 'tw-chipbtn-on' : ''}`}
              aria-pressed={on}
              onClick={() => setPicked(on ? picked.filter((x) => x !== r.id) : [...picked, r.id])}
            >
              {r.label}
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="ai-btn ai-btn-sm" onClick={onSkip}>
          Skip
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-btn-primary"
          onClick={() => onSend(picked)}
          data-testid="send-feedback"
        >
          Send feedback
        </button>
      </div>
    </div>
  );
}

/** Edit and re-run: change the question, keep or replace the old answer (C3). Nothing changes until Re-run. */
export function EditRerun({ run, onClose }: { run: AiRun; onClose: () => void }) {
  const toast = useToast();
  const [question, setQuestion] = useState(run.instruction);
  const [replace, setReplace] = useState(false);
  const again = useAiMutation(() => aiApi.regenerate(run.id, { question: question.trim(), replace }));
  return (
    <div className="tw-card" data-testid="edit-rerun">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <b style={{ fontSize: 14 }}>Edit and re-run</b>
        <span className="ai-muted">replaces nothing until you confirm</span>
      </div>
      <textarea
        className="ai-textarea"
        style={{ marginTop: 8, minHeight: 64 }}
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        aria-label="Question"
        data-testid="edit-rerun-text"
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        {[
          { v: false, label: 'Keep old answer' },
          { v: true, label: 'Replace it' },
        ].map((o) => (
          <button
            key={o.label}
            type="button"
            className={`ai-option ${replace === o.v ? 'ai-option-active' : ''}`}
            style={{ width: 'auto', padding: '6px 12px' }}
            onClick={() => setReplace(o.v)}
          >
            <span className={`ai-radio ${replace === o.v ? 'ai-radio-on' : ''}`} /> {o.label}
          </button>
        ))}
        <span className="ai-muted">+ 1 new comment</span>
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
        <button type="button" className="ai-btn ai-btn-sm" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="ai-btn ai-btn-sm ai-btn-primary"
          disabled={!question.trim() || again.isPending}
          data-testid="edit-rerun-go"
          onClick={async () => {
            try {
              await again.mutateAsync(undefined);
              onClose();
            } catch (err) {
              toast.error("Couldn't re-run", extractError(err));
            }
          }}
        >
          Re-run
        </button>
      </div>
    </div>
  );
}

/** An AI could not answer: the reason, nothing was changed, and Retry / Open run log / Dismiss (C2, Error). */
export function AskErrorCard({ comment, run, onDismiss }: { comment: Comment; run?: AiRun; onDismiss: () => void }) {
  const meta = comment.ai!;
  const { openRun } = useAiTicket();
  const toast = useToast();
  const retry = useAiMutation(() => aiApi.retry(meta.runId));
  // “Couldn't answer: <reason>. Nothing was changed.” → title and reason
  const m = comment.text.match(/^Couldn.t answer:\s*(.*)$/s);
  const reason = (m ? m[1] : comment.text).trim();
  const active = run && ['queued', 'starting', 'running'].includes(run.state);
  return (
    <div className="tw-error" data-testid="ask-error">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#C4432A', fontWeight: 700, fontSize: 15 }}>
        <svg width="17" height="17" viewBox="0 0 24 24" {...IC} aria-hidden="true">
          <path d="M12 3.5L22 20H2zM12 10v4M12 17.2v.1" />
        </svg>
        {run && didNotStart(run) ? 'Did not start' : 'Couldn’t answer'}
      </div>
      <div style={{ fontSize: 13.5, margin: '8px 0 10px', color: '#3A4A3E' }}>
        {reason}
        {run && didNotStart(run) ? ' Nothing was sent.' : ''}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="ai-btn ai-btn-sm"
          disabled={retry.isPending || !!active}
          data-testid="ask-retry"
          onClick={async () => {
            try {
              await retry.mutateAsync(undefined);
            } catch (err) {
              toast.error("Couldn't retry", extractError(err));
            }
          }}
        >
          {run && didNotStart(run) ? 'Try again' : '↻ Retry'}
        </button>
        <button type="button" className="ai-link" onClick={() => openRun(meta.runId)}>
          Open run log
        </button>
        <button type="button" className="ai-link" onClick={onDismiss} data-testid="ask-dismiss">
          Dismiss
        </button>
        <span style={{ flex: 1 }} />
        <span className="tw-pillbox ai-mono">{money(meta.costUsd ?? 0)}</span>
      </div>
    </div>
  );
}

/** Under a person's answer to the AI's question: the run moved on, Pending is cleared, the hold stayed (E3). */
export function AnswerTransitions({ run }: { run?: AiRun }) {
  if (!run) return null;
  const live = ['queued', 'starting', 'running', 'needs_input'].includes(run.state);
  return (
    <div className="tw-trans" data-testid="answer-transitions">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <RunStateChip state="needs_input" />
        <span aria-hidden="true" style={{ color: '#9AA8A0' }}>
          →
        </span>
        <RunStateChip state={run.state === 'needs_input' ? 'starting' : run.state} />
      </div>
      <div className="tw-tick">✓ Pending cleared by the answer</div>
      {live && <div className="tw-tick">✓ Hold kept by {run.memberName}</div>}
    </div>
  );
}
