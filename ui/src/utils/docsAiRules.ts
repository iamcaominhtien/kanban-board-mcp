/** When each Docs AI entry point shows (design/screens/docs-ai.md B and docs-ai-care.md G). Pure, so it is tested. */
import type { DocsAiState } from '../api/docsAi';

export type AiGate =
  /** Nothing is shown: Docs AI is off for the project. */
  | { show: false }
  /** Shown, with a reason instead of the actions (no AI team can read the space). */
  | { show: true; reason: 'no_member'; text: string }
  /** Shown and usable. */
  | { show: true; reason: null; text?: undefined };

/** Whether the AI menu / Ask tab / Docs health show, and why they would be limited. */
export function aiGate(state: DocsAiState | undefined): AiGate {
  if (!state || state.state === 'off') return { show: false };
  if (state.state === 'no_member') {
    // the team chosen in Settings is paused: the rows stay, and each answer is the server's one sentence about it
    if (state.problem?.code === 'paused') return { show: true, reason: null };
    return { show: true, reason: 'no_member', text: 'No AI team can read this space. Open Members.' };
  }
  return { show: true, reason: null };
}

/** Menu rows a person may use: viewers still ask, summarise, check and translate; writing rows are for editors. */
export function menuRows(canEdit: boolean): { id: string; writes: boolean }[] {
  const rows = [
    { id: 'ask', writes: false },
    { id: 'summarise', writes: false },
    { id: 'check', writes: false },
    { id: 'tickets', writes: true },
    { id: 'links', writes: true },
    { id: 'translate', writes: false },
    { id: 'edit', writes: true },
  ];
  return rows.filter((r) => canEdit || !r.writes);
}

/** "About $0.01" for a cost the run reported, otherwise "Not metered" (a subscription runner reports none). */
export function costLabel(cost: number, metered: boolean): string {
  if (!metered || cost <= 0) return 'Not metered';
  return cost < 0.01 ? `About $${cost.toFixed(3)}` : `About $${cost.toFixed(2)}`;
}
