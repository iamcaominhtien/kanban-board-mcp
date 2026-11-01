import type { TeamUsage } from '../../types/aiTeam';

/** "41 min", "2 h 05", "3 d": how long something has been going. */
export function fmtDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, seconds ?? 0);
  if (s < 60) return 'under a minute';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}`;
  return `${Math.floor(h / 24)} d`;
}

/** "12 min ago", "1 h ago". */
export function fmtAgo(seconds: number | null | undefined): string {
  if (seconds == null) return '';
  if (seconds < 60) return 'just now';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** Local clock time ("09:58") of an ISO time. */
export function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 14k, 1.2M: a token count. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** $0.41. */
export const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

/** What a runner's usage reads as: dollars when it is priced, else tokens, never $0 (the count says which kind). */
export function usageText(u: TeamUsage, opts: { verbose?: boolean } = {}): string {
  if (u.metered || (u.costUsd ?? 0) > 0) return fmtUsd(u.costUsd ?? 0);
  const tokens = u.tokens ?? 0;
  if (u.tokensCached != null) {
    return `${fmtTokens(tokens)} tokens: ${fmtTokens(Math.max(0, tokens - u.tokensCached))} new, ${fmtTokens(u.tokensCached)} cached`;
  }
  return `${fmtTokens(tokens)} tokens (input per call)${opts.verbose ? ', no cost reported' : ''}`;
}

/** "3 h 40", "52 min": a duration in the short form the Health tiles use. */
export function fmtShort(seconds: number | null | undefined): string {
  if (seconds == null) return '–';
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')}`;
}

export interface Delta {
  text: string;
  /** Whether the change is an improvement; null when there is nothing to compare. */
  better: boolean | null;
}

/** "+3 pts vs previous" and whether that is good: `better` says which direction improves the measure. */
export function deltaOf(
  kind: 'pts' | 'seconds' | 'usd',
  value: number | null | undefined,
  better: 'up' | 'down',
): Delta {
  if (value == null) return { text: 'no earlier range to compare', better: null };
  const rounded = kind === 'pts' ? Math.round(value) : kind === 'seconds' ? Math.round(value / 60) : value;
  if (rounded === 0 || (kind === 'usd' && Math.abs(value) < 0.005))
    return { text: 'no change vs previous', better: null };
  const sign = value > 0 ? '+' : '−';
  const mag = Math.abs(rounded);
  const body = kind === 'pts' ? `${mag} pts` : kind === 'seconds' ? `${mag} min` : `$${mag.toFixed(2)}`;
  return { text: `${sign}${body} vs previous`, better: better === 'up' ? value > 0 : value < 0 };
}
