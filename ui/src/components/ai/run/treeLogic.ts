import type { RunAgent, RunStep } from '../../../types/ai';

/**
 * One node of a run's two-level tree: a step of the lead, and for a `subagent` step the steps of that agent
 * (`agentId` of a child = `toolId` of the lead's subagent step). `step` is null for an agent whose own step is not
 * loaded yet (the run's newest steps were fetched, and its start is older than that).
 */
export interface TreeNode {
  key: string;
  step: RunStep | null;
  agent: RunAgent | null;
  children: RunStep[];
}

/** Steps of the lead, in order, each `subagent` step carrying its agent's steps. */
export function buildTree(steps: readonly RunStep[], agents: readonly RunAgent[]): TreeNode[] {
  const byAgent = new Map<string, RunStep[]>();
  const lead: RunStep[] = [];
  for (const s of steps) {
    if (s.agentId) {
      const list = byAgent.get(s.agentId) ?? [];
      list.push(s);
      byAgent.set(s.agentId, list);
    } else lead.push(s);
  }
  const agentById = new Map(agents.map((a) => [a.id, a]));
  const shown = new Set<string>();
  const nodes: TreeNode[] = lead.map((step) => {
    const id = step.kind === 'subagent' ? step.toolId : null;
    if (id) shown.add(id);
    return {
      key: `s${step.seq}`,
      step,
      agent: id ? (agentById.get(id) ?? null) : null,
      children: id ? (byAgent.get(id) ?? []) : [],
    };
  });
  // Steps of an agent whose start is not loaded: they go first, under the agent's name
  const orphans: TreeNode[] = [];
  for (const [id, children] of byAgent) {
    if (shown.has(id)) continue;
    orphans.push({ key: `a${id}`, step: null, agent: agentById.get(id) ?? null, children });
  }
  orphans.sort((a, b) => (a.children[0]?.seq ?? 0) - (b.children[0]?.seq ?? 0));
  return [...orphans, ...nodes];
}

/** The highest seq in a list, 0 when empty. */
export function lastSeq(steps: readonly RunStep[]): number {
  return steps.reduce((m, s) => Math.max(m, s.seq), 0);
}

/** Whether a subagent has steps the app does not hold yet (its counter is ahead of what was loaded). */
export function hasMoreChildren(node: TreeNode): boolean {
  return !!node.agent && node.agent.stepsCount > node.children.length;
}

/** Whether the lead has older steps than the first one held. */
export function hasEarlierLead(steps: readonly RunStep[], stepsCount: number): boolean {
  const lead = steps.filter((s) => !s.agentId);
  if (!lead.length) return stepsCount > 0;
  return lead[0].seq > 1;
}

/** Kinds that can hold something a person wants to read in full (a command's output, a text's whole). */
export function opensOutput(step: RunStep): boolean {
  return step.hasOutput;
}

/** "+12 −3" of an edit, "" when the step carries no counts. */
export function diffWords(step: RunStep): string {
  const { added, removed } = step.detail;
  if (typeof added !== 'number' && typeof removed !== 'number') return '';
  const out: string[] = [];
  if (typeof added === 'number') out.push(`+${added}`);
  if (typeof removed === 'number' && removed > 0) out.push(`−${removed}`);
  return out.join(' ');
}

/** The tone of a step: errors and failing commands read red. */
export function stepTone(step: RunStep): 'bad' | 'warn' | 'quiet' | 'plain' {
  if (step.kind === 'error') return 'bad';
  if (step.kind === 'command' && typeof step.detail.exitCode === 'number' && step.detail.exitCode !== 0) return 'bad';
  if (step.kind === 'rate_limited') return 'warn';
  if (step.kind === 'text' || step.kind === 'hook' || step.kind === 'message') return 'quiet';
  return 'plain';
}
