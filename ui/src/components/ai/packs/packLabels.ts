import type { Pack, PackModel, PackWrites, WorkflowKey } from '../../../types/aiPacks';

export const MODELS: PackModel[] = ['haiku', 'sonnet', 'opus'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const WRITES: PackWrites[] = ['nothing', 'ticket', 'worktree', 'tests', 'canvas'];
export const CEILINGS = ['none', 'backlog', 'todo', 'in-progress', 'review', 'testing', 'done'];

/** Capitalise the first letter. */
export const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const WRITES_LABEL: Record<PackWrites, string> = {
  nothing: 'Nothing in the repo',
  ticket: 'The ticket, not the code',
  worktree: "The ticket's worktree",
  tests: 'Test files',
  canvas: 'Canvas, Docs',
};

/** The model column: model and effort, retry model, or the reviewer's depth models. */
export function modelLabel(p: Pack): string {
  if (p.depthModels)
    return `By depth: ${cap(p.depthModels.light)} / ${cap(p.depthModels.standard)} / ${cap(p.depthModels.deep)}`;
  const base = p.effort ? `${cap(p.model)} · ${p.effort}` : cap(p.model);
  return p.retryModel ? `${base}, ${cap(p.retryModel)} on a retry` : base;
}

/** What the pack may use: its MCP servers, plugins and how many CLI rules it allows. */
/** What the pack may use. */
export function toolsLabel(p: Pack): string {
  const parts = [...p.mcp.map((m) => `${cap(m)} MCP`), ...p.plugins];
  if (p.allow.length) parts.push(`${p.allow.length} allowed command${p.allow.length === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'kanban MCP only';
}

/** The limits line. */
export function limitsLabel(p: Pack): string {
  const { maxParallel, maxRunsPerDay } = p.limits;
  return `${maxParallel} run${maxParallel === 1 ? '' : 's'} at a time, ${maxRunsPerDay} runs a day`;
}

/** The roles each default workflow has steps for (Triage is always in). */
export const WORKFLOW_ROLES: Record<WorkflowKey, string[]> = {
  feature_ui: ['triage', 'ba', 'designer', 'dev', 'qa', 'user_tester', 'reviewer'],
  standard: ['triage', 'ba', 'dev', 'qa', 'reviewer'],
  quick_fix: ['triage', 'dev', 'reviewer'],
  research: ['triage', 'dev', 'ba'],
  docs: ['triage', 'ba', 'reviewer'],
  chore: ['triage', 'dev', 'reviewer'],
};

export const WORKFLOW_NAME: Record<WorkflowKey, string> = {
  feature_ui: 'Feature with a UI',
  standard: 'Standard feature',
  quick_fix: 'Quick fix',
  research: 'Research',
  docs: 'Docs',
  chore: 'Chore',
};

/** The richest workflow whose roles are all in the team; null when even the smallest is not covered. */
export function workflowFor(roles: string[], preferred: WorkflowKey): WorkflowKey {
  const has = (w: WorkflowKey) => WORKFLOW_ROLES[w].every((r) => roles.includes(r));
  if (has(preferred)) return preferred;
  return (['feature_ui', 'standard', 'quick_fix', 'research'] as WorkflowKey[]).find(has) ?? 'quick_fix';
}

/** Roles of `from` that `to` no longer has steps for. */
export function lostRoles(from: WorkflowKey, to: WorkflowKey): string[] {
  return WORKFLOW_ROLES[from].filter((r) => !WORKFLOW_ROLES[to].includes(r));
}

/** Offer data as a JSON file download. */
export function downloadJson(name: string, data: unknown) {
  if (typeof URL === 'undefined' || !URL.createObjectURL) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
