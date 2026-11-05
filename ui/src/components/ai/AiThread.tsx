import { AiAvatar, RunStateChip, fmtElapsed, secondsSince, useAiBoardState, useNow } from './aiUi';
import { aiApi, useAiMutation, useAiRun } from '../../api/ai';
import { extractError } from '../../api/extractError';
import { useToast } from '../Toast';
import './ticketWork.css';
import type { AiRun } from '../../types/ai';
import { LineIcon } from '../ui/LineIcon';
import { roleLook } from './roleLook';

/** The small dark "AI" mark after an AI team's name (design C2: 16px, square corners, sparkle). */
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

/** The role that wrote a comment ("Reviewer", "QA"): the comment went out through the lead's token with `role`. */
export function RoleChip({ role }: { role: string }) {
  const look = roleLook(role.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  return (
    <span
      className="ai-chip"
      data-testid="comment-role"
      style={{
        height: 18,
        background: look.bg,
        color: look.fg,
        border: `1px solid ${look.border}`,
        alignSelf: 'center',
      }}
    >
      {role}
    </span>
  );
}

/** Status of one comment of a thread, shown as a chip at the right of its header. */
export type ThreadState = 'answer' | 'blocked' | 'error';

const STATE_STYLE: Record<ThreadState, { bg: string; color: string; border: string; label: string }> = {
  answer: { bg: '#EEF2F6', color: '#34455A', border: '#34455A33', label: 'Answer' },
  blocked: { bg: '#FDF1EE', color: '#C4432A', border: '#F0C4B8', label: 'Move blocked' },
  error: { bg: '#FDF1EE', color: '#C4432A', border: '#F0C4B8', label: 'Error' },
};

/** The small uppercase state chip of a thread comment. */
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

/** Under a person's answer to a lead's question: the run moved on. */
export function AnswerTransitions({ run }: { run?: Pick<AiRun, 'state'> }) {
  if (!run) return null;
  return (
    <div className="tw-trans" data-testid="answer-transitions">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <RunStateChip state="needs_input" />
        <span aria-hidden="true" style={{ color: '#9AA8A0' }}>
          →
        </span>
        <RunStateChip state={run.state === 'needs_input' ? 'starting' : run.state} />
      </div>
      <div className="tw-tick">
        <LineIcon name="check" size={12} /> Answer sent to the lead
      </div>
    </div>
  );
}

/**
 * The team at work, in the comment thread (design C3 of the AI v2 thread): who, how long, the step it is on, and Stop.
 * Queued runs say why they wait; a run that asks a question points to the AI activity view.
 */
export function RunWorkingRow({ run }: { run: AiRun }) {
  const { members } = useAiBoardState();
  const full = useAiRun(run.id).data;
  const cancel = useAiMutation(() => aiApi.cancel(run.id));
  const toast = useToast();
  const live = run.state === 'running' || run.state === 'starting';
  useNow(1000, live);
  const team = members.get(run.memberId);
  const name = team?.name ?? 'The team';
  const last = [...(full?.steps ?? [])].reverse().find((s) => s.kind !== 'hook' && s.kind !== 'start');
  const stop = async () => {
    try {
      await cancel.mutateAsync(undefined);
    } catch (err) {
      toast.error("Couldn't stop it", extractError(err));
    }
  };
  const label = run.state === 'queued' ? 'QUEUED' : run.state === 'needs_input' ? 'ASKS YOU' : 'WORKING';
  return (
    <div className="ai-root tw-working" data-testid="run-working" data-state={run.state}>
      <span className="tw-working-face">
        {team ? <AiAvatar color={team.color} size={26} /> : null}
        {live && <span className="tw-working-pulse" aria-hidden="true" />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <b style={{ fontSize: 13 }}>{name}</b>
          <span className="tw-working-label">{label}</span>
          {live && <span className="ai-mono ai-muted">{fmtElapsed(secondsSince(run.startedAt ?? run.queuedAt))}</span>}
        </div>
        <div className="ai-muted" style={{ fontSize: 12.5, marginTop: 2 }} data-testid="run-working-text">
          {run.state === 'queued'
            ? (run.waitingReason ?? 'Waiting to start…')
            : run.state === 'needs_input'
              ? 'It asks you a question: answer it in AI activity.'
              : last
                ? last.title
                : `${name} is reading the ticket…`}
          {live && <span className="tw-working-dots" aria-hidden="true" />}
        </div>
      </div>
      {run.state !== 'needs_input' && (
        <button type="button" className="ai-btn ai-btn-sm" onClick={() => void stop()} data-testid="run-working-stop">
          {run.state === 'queued' ? 'Cancel' : 'Stop'}
        </button>
      )}
    </div>
  );
}
