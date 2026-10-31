import type { ReactNode } from 'react';
import type { Idea, IdeaReadiness, IdeaStage, ReadinessState } from '../../types/idea';
import { READINESS_LABELS, STAGE_LABELS } from '../../types/idea';
import { Avatar } from '../docs/docsShared';
import './ideas.css';

/** Pill with the stage's name, coloured by stage. */
export function StagePill({ stage }: { stage: IdeaStage }) {
  return <span className={`is-stage is-stage-${stage}`}>{STAGE_LABELS[stage]}</span>;
}

/** The purple chip that marks what an AI member wrote, until a person edits it. */
export function AiChip({ title }: { title?: string }) {
  return (
    <span className="is-ai-chip" title={title ?? 'Written by an AI member'}>
      AI
    </span>
  );
}

/**
 * The bar of a list row: one cell per assumption, green validated, red disproved, amber being tested, grey untested.
 * @param props.idea - The idea whose assumptions are drawn.
 */
export function ReadinessBar({ idea }: { idea: Pick<Idea, 'assumptions' | 'readiness'> }) {
  const { total, validated } = idea.readiness;
  if (total === 0) return <span className="is-muted">No assumptions</span>;
  return (
    <span className="is-readiness" title={`${validated} of ${total} assumptions validated`}>
      <span className="is-bar" aria-hidden="true">
        {idea.assumptions.map((a) => (
          <span key={a.id} className={`is-seg is-seg-${a.state}`} />
        ))}
      </span>
      <span className="is-readiness-n">
        {validated} of {total}
      </span>
    </span>
  );
}

const READINESS_HELP: Record<ReadinessState, string> = {
  not_started: 'No assumptions written yet.',
  growing: 'Some assumptions are tested. High-impact ones are still open.',
  ready: 'Every high-impact assumption is validated and none is disproved.',
  at_risk: 'A high-impact assumption was disproved. Rethink before promoting.',
};

/** "Ready", "Growing", "At risk" or "Not started" with the reason in the tooltip. */
export function ReadinessBadge({ readiness }: { readiness: IdeaReadiness }) {
  return (
    <span className={`is-rbadge is-rbadge-${readiness.state}`} title={READINESS_HELP[readiness.state]}>
      {READINESS_LABELS[readiness.state]}
    </span>
  );
}

/** Round avatars of the people who want an idea, "+n" for the rest. */
export function Demand({ voters, max = 3 }: { voters: string[]; max?: number }) {
  if (voters.length === 0) return <span className="is-muted">—</span>;
  return (
    <span className="is-demand" title={`${voters.length} ${voters.length === 1 ? 'person wants' : 'people want'} this`}>
      {voters.slice(0, max).map((v) => (
        <Avatar key={v} name={v} size={20} />
      ))}
      {voters.length > max && <span className="is-more">+{voters.length - max}</span>}
    </span>
  );
}

/** Where an idea came from, as one short line ("from Doc “AI limits”", "Suggested by Claude Code"). */
export function sourceLine(idea: Pick<Idea, 'source' | 'sourceRef' | 'createdBy'>): string | null {
  const ref = idea.sourceRef ?? {};
  switch (idea.source) {
    case 'ai':
      return `Suggested by ${ref.by ?? idea.createdBy ?? 'an AI member'}${ref.id ? ` on ${ref.id}` : ''}`;
    case 'doc':
      return `from Doc “${ref.label ?? ref.id ?? ''}”`;
    case 'comment':
      return `from a comment${ref.label ? ` in ${ref.label}` : ''}`;
    case 'ticket':
      return `from ${ref.label ?? ref.id ?? 'a ticket'}`;
    case 'selection':
      return ref.label ? `from “${ref.label}”` : 'from highlighted text';
    case 'picture':
      return 'from a picture';
    case 'import':
      return 'imported';
    default:
      return null;
  }
}

/** "stale:38" → "Stale 38 days"; the warnings a list row shows. */
export function warningLabel(w: string): { text: string; tone: 'warn' | 'risk' } {
  const [kind, n] = w.split(':');
  if (kind === 'stale') return { text: `Stale ${n} days`, tone: 'warn' };
  if (kind === 'waiting') return { text: `Waiting ${n} days`, tone: 'warn' };
  return { text: 'At risk', tone: 'risk' };
}

/** The ticket link of a promoted idea: "Building · KAN-251 in Mobile App". */
export function ticketLabel(idea: Idea): ReactNode {
  return idea.ticket ? idea.ticket.id : '—';
}

/** Local date as YYYY-MM-DD, `days` from today. */
export function dateIn(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The lightbulb of the Idea Space. */
export function BulbIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M12 2a7 7 0 0 0-4 12.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 2z" />
    </svg>
  );
}

/** Keyboard key cap. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="is-kbd">{children}</kbd>;
}
