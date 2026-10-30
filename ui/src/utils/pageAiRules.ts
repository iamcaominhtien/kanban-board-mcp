/** Rules of the page AI menu, the reader helpers and Check this page (design/screens/docs-ai.md B, E, F). Pure. */
import type { FindingKind } from '../api/docsAiPage';
import { aiGate, costLabel, menuRows, type AiGate } from './docsAiRules';

export interface MenuRow {
  id: string;
  title: string;
  hint: string;
  icon: string;
  /** Shortcut shown on the right. */
  shortcut?: string;
  /** A rule is drawn above this row (it opens the editor). */
  divider?: boolean;
}

const COPY: Record<string, Omit<MenuRow, 'id'>> = {
  ask: {
    title: 'Ask this page',
    hint: 'Questions about this page and the tickets it links to',
    icon: 'i58',
    shortcut: 'Ctrl J',
  },
  summarise: {
    title: 'Summarise',
    hint: 'A short summary above the page. Not saved unless you insert it',
    icon: 'i42',
  },
  check: { title: 'Check if up to date', hint: 'Compare with the tickets and pages it links to', icon: 'i41' },
  tickets: { title: 'Create tickets from this page', hint: 'Finds items that have no ticket yet', icon: 'plus' },
  links: { title: 'Suggest links', hint: 'Pages and tickets mentioned in the text', icon: 'link' },
  translate: { title: 'Translate view…', hint: 'Read it in another language. The page is not changed', icon: 'i47' },
  edit: { title: 'Edit with AI…', hint: 'Opens the editor with /ai ready', icon: 'i15', divider: true },
};

export type PageMenu =
  /** The rows to list. */
  | { kind: 'rows'; rows: MenuRow[] }
  /** One row that opens AI members (no AI member can read the project). */
  | { kind: 'no_member'; text: string }
  /** A lock and a one-line reason (the page is hidden from AI). */
  | { kind: 'hidden'; text: string }
  /** Nothing renders. */
  | { kind: 'none' };

/** What the AI menu shows for a page. Viewers do not see the writing rows; Docs AI off shows nothing at all. */
export function pageMenu(gate: AiGate, canEdit: boolean): PageMenu {
  if (!gate.show) return { kind: 'none' };
  if (gate.reason === 'no_member') return { kind: 'no_member', text: gate.text };
  if (gate.reason === 'hidden') return { kind: 'hidden', text: gate.text };
  return { kind: 'rows', rows: menuRows(canEdit).map((r) => ({ id: r.id, ...COPY[r.id] })) };
}

export { aiGate };

const TICKET = /\b[A-Z][A-Z0-9]{1,5}-\d+\b/g;
const PAGE_LINK = /\[\[([^\][|#\n]{1,200})(?:#[^\][|\n]{1,200})?(?:\|[^\][\n]{1,200})?\]\]/g;

/** Tickets and linked pages the page mentions: what a request reads besides the page itself. */
export function readsOf(markdown: string): { tickets: string[]; pages: string[] } {
  const body = markdown.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const pages = [...new Set([...body.matchAll(PAGE_LINK)].map((m) => m[1].trim()))];
  const tickets = [...new Set(body.replace(PAGE_LINK, ' ').match(TICKET) ?? [])];
  return { tickets, pages };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Chips under the menu: "This page", "3 tickets", "2 linked pages" (nothing for zero). */
export function readsChips(markdown: string): string[] {
  const r = readsOf(markdown);
  return [
    'This page',
    ...(r.tickets.length ? [plural(r.tickets.length, 'ticket', 'tickets')] : []),
    ...(r.pages.length ? [plural(r.pages.length, 'linked page', 'linked pages')] : []),
  ];
}

/** Hint of the freshness row: "Compare with KAN-9, KAN-12 and 2 linked pages". */
export function freshnessHint(markdown: string): string {
  const r = readsOf(markdown);
  const parts = [...r.tickets.slice(0, 3)];
  if (r.tickets.length > 3) parts.push(`${r.tickets.length - 3} more`);
  if (r.pages.length) parts.push(plural(r.pages.length, 'linked page', 'linked pages'));
  if (!parts.length) return COPY.check.hint;
  return `Compare with ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]}`;
}

/** A rough dollar estimate of a request that reads this much text ("About $0.01"). */
export function estimateCost(markdown: string): number {
  const tokens = markdown.length / 4 + 1200;
  return Math.max(0.01, Math.round(tokens * 0.000006 * 100) / 100);
}

/** "About $0.01" for the menu footer. */
export function estimateLabel(markdown: string): string {
  return costLabel(estimateCost(markdown), true);
}

/** Languages offered in "Translate view…" (any other can be typed). */
export const LANGUAGES = ['Vietnamese', 'English', 'French', 'German', 'Spanish', 'Japanese', 'Chinese', 'Portuguese'];

/** The one-line state a failed page AI call shows (docs-ai-care G), or the server's own message. */
export function problemLine(code: string, detail: string): string {
  switch (code) {
    case 'docs_ai_off':
      return 'Docs AI is off for this project.';
    case 'hidden':
      return 'This page is hidden from AI.';
    case 'no_member':
      return 'No AI member can read this space. Open AI members.';
    case 'paused':
    case 'over_budget':
      return `AI is paused until tomorrow. ${detail}`.trim();
    default:
      return detail || 'Could not finish. Try again.';
  }
}

/** Selections worth sending: a few words, not a stray click. */
export function selectionOk(text: string): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length >= 2 && text.length <= 4000;
}

/** Title of the state shown in place of the answer while it is not ready. */
export function jobStateLabel(state: string | undefined): string {
  if (state === 'queued') return 'Waiting…';
  if (state === 'running') return 'Reading the page…';
  return '';
}

export const FINDING_LABEL: Record<FindingKind, string> = {
  unclear: 'Unclear',
  missing: 'Missing',
  unknown_link: 'Unknown link',
  style: 'Style',
};

/** "3 findings" / "No findings". */
export function findingsTitle(n: number): string {
  return n === 0 ? 'No findings' : plural(n, 'finding', 'findings');
}

/** Replace the first occurrence of `old` with `next` in a Markdown draft (the fix a person accepts). Null if `old` is no longer there. */
export function applyFix(markdown: string, old: string, next: string): string | null {
  const at = markdown.indexOf(old);
  if (!old || at < 0) return null;
  return markdown.slice(0, at) + next + markdown.slice(at + old.length);
}

/** What a fix changes, for the small diff: the text before, the words removed, the words added and the text after. */
export function fixDiff(old: string, next: string): { before: string; removed: string; added: string; after: string } {
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  // grow to whole words so "Plans" -> "Pricing" is not shown as "lans" -> "ricing"
  while (start > 0 && /\w/.test(old[start - 1] ?? '')) start--;
  while (end > 0 && /\w/.test(old[old.length - end] ?? '')) end--;
  return {
    before: old.slice(0, start),
    removed: old.slice(start, old.length - end),
    added: next.slice(start, next.length - end),
    after: old.slice(old.length - end),
  };
}

/** "$0.004" next to an answer (small amounts keep three decimals); "not metered" for a local runner. */
export function moneyLabel(cost: number, metered: boolean): string {
  if (!metered) return 'not metered';
  return `$${cost < 0.01 ? cost.toFixed(3) : cost.toFixed(2)}`;
}
