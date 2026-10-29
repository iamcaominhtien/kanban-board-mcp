import type { ReactNode } from 'react';
import type { AiProvider } from '../../types/ai';
import type { AssistState } from '../../types/assist';
import { AiAvatar, SparkleIcon, useAiBoardState } from '../ai/aiUi';
import { useAssist } from './AssistContext';

export const STATUS_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  review: 'Review',
  testing: 'Testing',
  done: 'Done',
  wont_do: "Won't Do",
};

const STATUS_DOT: Record<string, string> = {
  backlog: '#9AA8A0',
  todo: '#3B6FB6',
  'in-progress': '#D9822B',
  review: '#6B5BD2',
  testing: '#B4541A',
  done: '#2E6F40',
  wont_do: '#9AA8A0',
};

/** The Board AI's avatar (the provider glyph on the square AI tile). */
export function BoardAiAvatar({ provider, size = 30 }: { provider?: AiProvider | null; size?: number }) {
  const { members, settings } = useAiBoardState();
  const member = settings?.boardAiId ? members.get(settings.boardAiId) : undefined;
  const mine = member && (!provider || member.provider === provider) ? member : undefined;
  return (
    <AiAvatar
      provider={(provider ?? mine?.provider ?? 'anthropic') as AiProvider}
      color={mine?.color}
      glyph={mine?.glyph}
      size={size}
    />
  );
}

/** A ticket key that opens the ticket. */
export function TicketPill({ id, status, red }: { id: string; status?: string; red?: boolean }) {
  const ctx = useAssist();
  const dot = red ? '#C4432A' : status ? (STATUS_DOT[status] ?? '#2E6F40') : '#2E6F40';
  return (
    <button
      type="button"
      className="as-pill"
      style={{ ['--as-pill-dot' as string]: dot }}
      onClick={() => ctx?.onOpenTicket(id)}
      title={`Open ${id}`}
    >
      {id}
    </button>
  );
}

/** "$0.012 · 3.1k tok", or "Not metered" for a local runner. */
export function CostChip({
  cost,
  tokens,
  metered = true,
  suffix,
}: {
  cost: number;
  tokens?: number;
  metered?: boolean;
  suffix?: string;
}) {
  const tok = tokens ? ` · ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tok` : '';
  return (
    <span className="as-cost" title={metered ? 'Cost of this request' : 'Local runner: subscription, not metered'}>
      {metered ? usd(cost) : 'Not metered'}
      {tok}
      {suffix ? ` ${suffix}` : ''}
    </span>
  );
}

/** Dashed "✦ AI draft" tag. */
export function DraftTag({ children = 'AI draft' }: { children?: ReactNode }) {
  return (
    <span className="as-draft-tag">
      <SparkleIcon size={10} /> {children}
    </span>
  );
}

/** One line under a draft: who applies it, and how Activity reads. */
export function AppliedAs({ person, ai }: { person: string; ai: string }) {
  return (
    <div className="ai-muted" style={{ fontSize: 11.5 }}>
      Applied as <b style={{ color: '#5B6B60' }}>{person}</b>; Activity says “suggested by {ai}”.
    </div>
  );
}

/** The person this browser acts as (X-Actor), "user" when none is chosen. */
export function currentPerson(): string {
  try {
    return localStorage.getItem('kanbanActor') || 'You';
  } catch {
    return 'You';
  }
}

/** Short Board AI label, e.g. "Reviewer (Claude API)". */
export function boardAiLabel(state: AssistState | undefined): string {
  const b = state?.boardAi;
  if (!b?.name) return 'Board AI';
  return b.name;
}

/** Can the Board AI take a request now, and if not, why (I1, I2, I12). */
export function featureBlock(
  state: AssistState | undefined,
  feature: string,
): { reason: string; code: 'not_configured' | 'unavailable' | 'over_budget' | 'feature_off' } | null {
  if (!state) return null;
  if (state.boardAi.state === 'not_configured') return { reason: "Board AI isn't set up", code: 'not_configured' };
  if (state.boardAi.state === 'unavailable')
    return {
      reason: `${state.boardAi.name}: ${state.boardAi.status?.label?.toLowerCase() ?? 'unavailable'}`,
      code: 'unavailable',
    };
  const f = state.features.find((x) => x.key === feature);
  if (f && !f.on) return { reason: `${f.label} is turned off in Settings → AI`, code: 'feature_off' };
  if (state.overBudget) return { reason: 'Monthly cap reached', code: 'over_budget' };
  return null;
}

/** "Oct 22" or "10:41" for today. */
export function dayOrTime(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** "$0.124". */
export function usd(v: number, digits = 3): string {
  return `$${(v ?? 0).toFixed(v >= 1 ? 2 : digits)}`;
}
