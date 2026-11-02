/** Reading a ticket stopped at its token cap (ai-story-flow O). */
import type { AiRun } from '../../../types/ai';
import type { ViewStep, WorkflowView } from '../../../types/aiWorkflow';

/** Used and cap from the stop's own sentence: "Used 412,380 tokens; the cap for one ticket is 400,000." */
export function parseCapDetail(detail: string | null | undefined): { used: number; cap: number } | null {
  const m = /Used ([\d,.\s]+) tokens; the cap for one ticket is ([\d,.\s]+)\./.exec(detail ?? '');
  if (!m) return null;
  const n = (s: string) => Number(s.replace(/[^\d]/g, ''));
  const used = n(m[1]);
  const cap = n(m[2]);
  return Number.isFinite(used) && Number.isFinite(cap) && cap > 0 ? { used, cap } : null;
}

/** Whether a workflow stopped at its token cap. */
export function stoppedAtCap(v: { state: string; stopReason: string | null } | null | undefined): boolean {
  return !!v && v.state === 'stopped' && v.stopReason === 'quota_cap';
}

/** "412k" for 412,380; "9k" for 9,100; "1.2M" for 1,200,000; the number itself under a thousand. */
export function kTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** "412,380". */
export const fullNumber = (n: number) => n.toLocaleString('en-US');

/** The step the workflow stopped on: the one going on, else the last one that ran. */
export function heldStep(view: WorkflowView): ViewStep | undefined {
  return (
    view.steps.find((s) => ['active', 'waiting', 'blocked', 'failed'].includes(s.state) && s.kind === 'ai') ??
    [...view.steps].reverse().find((s) => s.kind === 'ai' && s.state !== 'pending' && s.state !== 'skipped')
  );
}

/** Tokens per step, from the runs of the ticket (a step's runs are matched by its run, else by its member). */
export function tokensPerStep(view: WorkflowView, runs: AiRun[]): { label: string; tokens: number }[] {
  const out: { label: string; tokens: number }[] = [];
  const counted = new Set<string>();
  for (const s of view.steps) {
    if (s.kind !== 'ai') continue;
    const mine = runs.filter((r) => r.mode === 'work' && !counted.has(r.id) && r.id === s.runId);
    mine.forEach((r) => counted.add(r.id));
    const tokens = mine.reduce((a, r) => a + (r.tokensIn || 0) + (r.tokensOut || 0), 0);
    if (tokens > 0) out.push({ label: s.label, tokens });
  }
  return out;
}
