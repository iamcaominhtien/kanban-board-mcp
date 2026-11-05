import { RunStateChip } from './aiUi';
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
