import type { WorkflowMetric, WorkflowName } from '../../types/aiWorkflowBoard';

/** No verdict under this many tickets on a template (the rule the AI tiles use under ten runs). */
export const MIN_TICKETS_FOR_VERDICT = 10;

export type MetricVerdict = 'good' | 'watch' | 'fix' | null;

export interface MetricRow {
  key: string;
  name: string;
  tickets: number;
  median: string;
  passedFirst: string;
  rounds: string;
  cost: string;
  verdict: MetricVerdict;
  /** Cost per ticket against the Standard template, when both are known. */
  costVsStandard: number | null;
}

/** 6.67 -> "6 h 40"; 0.5 -> "30 min"; null -> "no data". */
export function formatHours(h: number | null): string {
  if (h == null) return 'no data';
  const minutes = Math.round(h * 60);
  if (minutes < 60) return `${minutes} min`;
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${hh} h ${String(mm).padStart(2, '0')}`;
}

/** Good / watch / fix by the share that passed review first time; none under ten tickets. */
export function verdictOf(m: WorkflowMetric): MetricVerdict {
  if (m.tickets < MIN_TICKETS_FOR_VERDICT || m.passedFirst == null) return null;
  if (m.passedFirst >= 0.8) return 'good';
  if (m.passedFirst >= 0.6) return 'watch';
  return 'fix';
}

/** The display rows for the tiles and the table. */
export function buildMetricRows(metrics: WorkflowMetric[], names: WorkflowName[]): MetricRow[] {
  const nameOf = new Map(names.map((n) => [n.key, n.name]));
  const standard = metrics.find((m) => m.templateKey === 'standard');
  const base = standard?.costPerTicket ?? null;
  return metrics.map((m) => ({
    key: m.templateKey,
    name: nameOf.get(m.templateKey) ?? m.templateKey,
    tickets: m.tickets,
    median: formatHours(m.medianHours),
    passedFirst: m.passedFirst == null ? 'no review' : `${Math.round(m.passedFirst * 100)}%`,
    rounds: m.roundsAvg == null ? 'none' : m.roundsAvg.toFixed(1),
    cost: m.costPerTicket == null ? 'n/a' : `$${m.costPerTicket.toFixed(2)}`,
    verdict: verdictOf(m),
    costVsStandard:
      base && base > 0 && m.costPerTicket != null && m.templateKey !== 'standard' ? m.costPerTicket / base : null,
  }));
}
