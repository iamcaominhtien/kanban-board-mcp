import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { client } from './client';
import { SAFETY_POLL_MS } from './pollIntervals';

export type Verdict = 'good' | 'watch' | 'fix';
export type HealthRange = '7d' | '30d';

export interface MeasureBase {
  verdict: Verdict | null;
}
export interface Reliability extends MeasureBase {
  value: number | null;
  ok: number;
  ended: number;
  failed: number;
  timedOut: number;
  cancelled: number;
}
export interface Autonomy extends MeasureBase {
  /** Touches per ticket. */
  value: number | null;
  touches: number;
  tickets: number;
  /** Tickets with AI work that no person touched. */
  clean: number;
  avoidable: number;
}
export interface Speed extends MeasureBase {
  runMedianS: number | null;
  toReviewMedianS: number | null;
  toReviewTickets: number;
}
export interface Quality extends MeasureBase {
  value: number | null;
  reopened: number;
  finishedTickets: number;
  /** Problems a Reviewer reported in the range; null when no run reported any. */
  findings: number | null;
  runsWithFindings: number;
}
export interface Cost extends MeasureBase {
  usd: number;
  tokens: number;
  runs: number;
  pricedRuns: number;
  tokensOnlyRuns: number;
  perRun: number | null;
  tokensPerRun: number | null;
  capPerRun: number | null;
  runsOverCap: number;
  monthlyCap: number | null;
  monthSpend: number;
  monthShare: number | null;
}
export interface Measures {
  reliability: Reliability;
  autonomy: Autonomy;
  speed: Speed;
  quality: Quality;
  cost: Cost;
}

export interface TeamHealth {
  id: string;
  name: string;
  removed: boolean;
  runs: number;
  judged: boolean;
  status: 'idle' | 'too_few' | 'healthy' | 'watch' | 'fix';
  paused: boolean;
  measures: Measures;
}

/** What a fix item's button does. */
export type FixAction =
  | { type: 'setting'; label: string; page: string; setting: string }
  | { type: 'run'; label: string; runId: string }
  | { type: 'team'; label: string; teamId: string }
  | { type: 'ticket'; label: string; ticketId: string }
  | { type: 'tab'; label: string; tab: 'memory' | 'stepped'; mark?: 'avoidable' };

export interface HealthFix {
  id: string;
  severity: 'fix' | 'watch';
  title: string;
  evidence: string;
  suggestion: string;
  tickets: string[];
  teamId: string | null;
  runId: string | null;
  action: FixAction;
}

export interface Health {
  range: HealthRange;
  since: string;
  until: string;
  runs: number;
  tickets: number;
  minRuns: number;
  canJudge: boolean;
  hasTeams: boolean;
  state: Verdict | 'unknown';
  title: string;
  text: string;
  counts: Record<Verdict, number>;
  measures: Measures;
  previous: {
    reliability: number | null;
    autonomy: number | null;
    quality: number | null;
    runMedianS: number | null;
    usd: number;
    pricedRuns: number;
    tokens: number;
    runs: number;
  };
  teams: TeamHealth[];
  fixes: HealthFix[];
}

/** The Health page of a project: a verdict, five measures, a row per team and what to fix. */
export function useHealth(projectId: string, range: HealthRange = '7d') {
  return useQuery({
    queryKey: ['ai', 'health', projectId, range] as const,
    queryFn: async () =>
      (await client.get<Health>(`/projects/${projectId}/ai/team/health`, { params: { range } })).data,
    enabled: !!projectId,
    placeholderData: keepPreviousData,
    refetchInterval: SAFETY_POLL_MS,
  });
}
