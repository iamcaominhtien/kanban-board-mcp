/** When each Docs AI entry point shows (design/screens/docs-ai.md B and docs-ai-care.md G). Pure, so it is tested. */
import type { DocsAiState } from '../api/docsAi';

export type AiGate =
  /** Nothing is shown: Docs AI is off for the project. */
  | { show: false }
  /** Shown, with a reason instead of the actions (no AI member can read the space, or the page is hidden). */
  | { show: true; reason: 'no_member' | 'hidden'; text: string }
  /** Shown and usable. */
  | { show: true; reason: null; text?: undefined };

export interface PageAiFacts {
  /** The page is hidden from AI. */
  hidden: boolean;
}

/** Whether the AI menu / Ask tab / Docs health show, and why they would be limited. */
export function aiGate(state: DocsAiState | undefined, page?: PageAiFacts): AiGate {
  if (!state || state.state === 'off') return { show: false };
  if (state.state === 'no_member') {
    return { show: true, reason: 'no_member', text: 'No AI member can read this space. Open AI members.' };
  }
  if (page?.hidden) {
    return { show: true, reason: 'hidden', text: 'This page is hidden from AI. Ask, summaries and AI runs skip it.' };
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

/** "About $0.01" for a cost estimate, or "Not metered" for a local runner. */
export function costLabel(cost: number, metered: boolean): string {
  if (!metered) return 'Not metered';
  if (cost <= 0) return 'About $0.00';
  return cost < 0.01 ? `About $${cost.toFixed(3)}` : `About $${cost.toFixed(2)}`;
}
