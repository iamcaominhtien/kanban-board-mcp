import { useState } from 'react';
import { aiApi, useAiMutation } from '../../api/ai';
import { extractError } from '../../api/extractError';
import type { AiRun } from '../../types/ai';
import type { Comment } from '../../types/ticket';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { useToast } from '../Toast';
import { AiAvatar, RunStateChip, fmtElapsed, money, secondsSince, useAiBoardState, useNow } from './aiUi';
import { useAiTicket } from './AiTicketContext';
import './ticketWork.css';

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

/** Status of one comment of an ask thread, shown as a chip at the right of its header (design C2). */
export type ThreadState =
  'asked' | 'thinking' | 'streaming' | 'answered' | 'error' | 'asks_again' | 'answer' | 'blocked';

const STATE_STYLE: Record<ThreadState, { bg: string; color: string; label: string }> = {
  asked: { bg: '#F6FAF7', color: '#5B6B60', label: 'Asked' },
  thinking: { bg: '#F6FAF7', color: '#3A4A3E', label: 'Thinking' },
  streaming: { bg: '#F1F8F3', color: '#2E6F40', label: 'Streaming' },
  answered: { bg: '#F1F8F3', color: '#2E6F40', label: 'Answered' },
  error: { bg: '#FBEEEA', color: '#C4432A', label: 'Error' },
  asks_again: { bg: '#F6FAF7', color: '#5B6B60', label: 'Reply asks again' },
  answer: { bg: '#EEF2F6', color: '#34455A', label: 'Answer' },
  blocked: { bg: '#FBEEEA', color: '#C4432A', label: 'Move blocked' },
};

/** The small uppercase state chip of a thread comment (“ASKED CLAUDE CODE · BACKEND”, “THINKING”, “ERROR”). */
export function ThreadChip({ state, label }: { state: ThreadState; label?: string }) {
  const s = STATE_STYLE[state];
  return (
    <span
      className="tw-state"
      style={{ background: s.bg, color: s.color, borderColor: s.color + '33' }}
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

/** What an ask run in progress shows in the thread: Thinking until text arrives, then Streaming. */
export function AskPlaceholder({ run }: { run: AiRun }) {
  const { members } = useAiBoardState();
  const ai = members.get(run.memberId);
  const toast = useToast();
  const cancel = useAiMutation(() => aiApi.cancel(run.id));
  useNow(1000, run.state === 'running' || run.state === 'starting');
  const said = run.steps.filter((s) => s.kind === 'say').map((s) => s.text);
  const all = said.join('\n\n');
  const text = all.length > 1200 ? `…${all.slice(-1200)}` : all;
  const streaming = run.state === 'running' && text.length > 0;
  const waiting = run.state === 'queued';
  const secs = secondsSince(run.startedAt ?? run.queuedAt) ?? 0;
  const stop = async () => {
    try {
      await cancel.mutateAsync(undefined);
    } catch (err) {
      toast.error("Couldn't stop it", extractError(err));
    }
  };
  return (
    <div
      className="cm-row tw-thread-row"
      data-testid="ask-placeholder"
      data-state={streaming ? 'streaming' : 'thinking'}
    >
      {ai ? (
        <AiAvatar provider={ai.provider} color={ai.color} glyph={ai.glyph} size={32} title={ai.name} />
      ) : (
        <span style={{ width: 32 }} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="tw-head">
          <span style={{ fontSize: 14, fontWeight: 700 }}>{run.memberName}</span>
          <span className="ai-chip" style={{ height: 18, background: '#1E2A22', color: '#fff' }}>
            AI
          </span>
          <span style={{ flex: 1 }} />
          <ThreadChip state={streaming ? 'streaming' : 'thinking'} />
        </div>
        {streaming ? (
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
              <button type="button" className="ai-link" onClick={stop} data-testid="ask-stop">
                Stop
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="tw-live" style={{ marginTop: 4 }}>
              <span className="ai-spin" />
              <span style={{ fontSize: 13.5, color: '#5B6B60' }}>
                {waiting ? (run.waitingReason ?? 'Waiting to start') : 'Thinking…'}
              </span>
              {!waiting && <span className="ai-muted ai-mono">{secs}s</span>}
              <button type="button" className="ai-link" onClick={stop} data-testid="ask-stop">
                Stop
              </button>
            </div>
            <div className="tw-skel" style={{ width: '92%' }} />
            <div className="tw-skel" style={{ width: '64%' }} />
          </>
        )}
      </div>
    </div>
  );
}

/** Rating buttons, regenerate and edit-and-re-run under an AI's answer; the run link and cost on the left (C2). */
export function AnswerFooter({ comment, run, canAct }: { comment: Comment; run?: AiRun; canAct: boolean }) {
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
        {meta.model && <span className="tw-pillbox">{meta.model}</span>}
        <span style={{ flex: 1 }} />
        {canAct && run && (
          <>
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
          </>
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
        Couldn’t answer
      </div>
      <div style={{ fontSize: 13.5, margin: '8px 0 10px', color: '#3A4A3E' }}>{reason}</div>
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
          ↻ Retry
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
