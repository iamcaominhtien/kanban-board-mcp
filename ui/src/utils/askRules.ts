/** Ask the docs: what the palette shows and when (design/screens/docs-ai.md C, docs-ai-care.md G). Pure, so it is tested. */
import type { AskResult, AskScope, AskSource } from '../api/docsAiAsk';
import type { DocsAiState } from '../api/docsAi';
import { aiGate, costLabel } from './docsAiRules';

export interface AskScopeChip {
  id: AskScope;
  label: string;
}

/** "In: This space | This page | All my projects"; "This page" only exists while a page is open. */
export function askScopes(hasPage: boolean): AskScopeChip[] {
  const chips: AskScopeChip[] = [{ id: 'space', label: 'This space' }];
  if (hasPage) chips.push({ id: 'page', label: 'This page' });
  chips.push({ id: 'all', label: 'All my projects' });
  return chips;
}

/** The scope to start in: the open page when Ask was opened from a page, else the space. */
export function defaultScope(hasPage: boolean, wanted?: AskScope): AskScope {
  if (wanted === 'page' && !hasPage) return 'space';
  return wanted ?? 'space';
}

/** The Ask tab exists only when Docs AI is on for the project (docs-ai-care G: "No Ask tab" when it is off). */
export function askTabAvailable(state: DocsAiState | undefined): boolean {
  return aiGate(state).show;
}

export type AskView =
  | { kind: 'idle' }
  | { kind: 'thinking' }
  | { kind: 'answer'; result: AskResult }
  | { kind: 'not_covered'; result: AskResult }
  | { kind: 'disagree'; result: AskResult }
  | { kind: 'error'; code: string; title: string; detail: string; action: 'usage' | 'members' | 'retry' | null };

/** Which result the palette shows for an ask job (or the error the request ended with). */
export function askView(
  running: boolean,
  result: AskResult | null,
  error: { code: string; detail: string } | null,
): AskView {
  if (error) return askError(error.code, error.detail);
  if (running) return { kind: 'thinking' };
  if (!result) return { kind: 'idle' };
  return { kind: result.verdict, result } as AskView;
}

/** The states of docs-ai-care G: no AI member, over budget, paused, anything else. */
export function askError(code: string, detail: string): AskView {
  switch (code) {
    case 'over_budget':
      return {
        kind: 'error',
        code,
        title: 'AI is paused until tomorrow',
        detail: 'The daily cap was reached. Docs AI shares the Board AI’s budget. Reading and editing still work.',
        action: 'usage',
      };
    case 'no_member':
      return {
        kind: 'error',
        code,
        title: 'No AI is set up for Docs',
        detail: 'Pick an AI member that can read this project.',
        action: 'members',
      };
    case 'paused':
      return { kind: 'error', code, title: 'AI is paused', detail, action: 'members' };
    case 'hidden':
      return {
        kind: 'error',
        code,
        title: 'This page is hidden from AI',
        detail: 'Ask, summaries and AI runs skip it. People can still read and edit it.',
        action: null,
      };
    default:
      return { kind: 'error', code, title: 'Couldn’t answer', detail, action: 'retry' };
  }
}

export type AnswerPart = { type: 'text'; text: string } | { type: 'cite'; n: number };

/** Splits an answer into text and citation markers: `[n]` becomes a superscript only when source n exists. */
export function answerParts(answer: string, citations: { n: number }[]): AnswerPart[] {
  const known = new Set(citations.map((c) => c.n));
  const parts: AnswerPart[] = [];
  let last = 0;
  for (const m of answer.matchAll(/(?<!\[)\[(\d{1,2})\](?!\])/g)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ type: 'text', text: answer.slice(last, at) });
    if (known.has(Number(m[1]))) parts.push({ type: 'cite', n: Number(m[1]) });
    last = at + m[0].length;
  }
  if (last < answer.length) parts.push({ type: 'text', text: answer.slice(last) });
  return parts;
}

/** The sources in the order they are numbered. */
export function sourcesOf(result: AskResult): (AskSource & { n: number })[] {
  return [...result.citations].sort((a, b) => a.n - b.n);
}

const MIN = 60_000;

/** "2 min ago" style age for the footer. */
export function indexAge(iso: string | null, now = Date.now()): string {
  if (!iso) return 'not indexed yet';
  const mins = Math.floor((now - new Date(iso).getTime()) / MIN);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

/** "Read 4 pages, cited 2, all visible to you · Index updated 2 min ago · About $0.01". */
export function footerLine(result: AskResult, cost: number, metered: boolean, now = Date.now()): string {
  const read = `Read ${result.pagesRead} page${result.pagesRead === 1 ? '' : 's'}`;
  const cited = result.verdict === 'not_covered' ? '' : `, cited ${result.pagesCited}`;
  const seen = result.pagesRead > 0 ? ', all visible to you' : '';
  const cash = result.askedModel ? ` · ${costLabel(cost, metered).replace('About ', '')}` : '';
  return `${read}${cited}${seen} · Index updated ${indexAge(result.indexUpdatedAt, now)}${cash}`;
}

/** "Just edited, not indexed yet": a page saved in the last minute may be missing from the answer. */
export function justEdited(result: AskResult | null, now = Date.now()): boolean {
  if (!result?.indexUpdatedAt) return false;
  return now - new Date(result.indexUpdatedAt).getTime() < MIN;
}

/** Page too long: "I read the first 12 of 30 sections". */
export function tooLongLine(result: AskResult): string | null {
  const t = result.tooLong;
  return t ? `I read the first ${t.readSections} of ${t.totalSections} sections` : null;
}

/** For two pages that disagree, the older one is the one offered as "Report X as out of date" (it is the likelier). */
export function reportTarget(result: AskResult): AskSource | null {
  if (result.verdict !== 'disagree' || result.conflicts.length < 2) return null;
  return [...result.conflicts].sort((a, b) => a.editedAt.localeCompare(b.editedAt))[0];
}

/** Source to open when a citation is clicked: the page at the heading. */
export function openTarget(s: AskSource): { pageId: string; anchor?: string } {
  return { pageId: s.pageId, anchor: s.anchor ?? undefined };
}

/** Plain text for Copy: the answer without markers, then the sources. */
export function copyText(result: AskResult): string {
  const body = result.answer.replace(/(?<!\[)\[\d{1,2}\](?!\])/g, '').replace(/\s+([.,;:])/g, '$1');
  const src = sourcesOf(result).map(
    (s) => `${s.n}. ${s.path.join(' › ')}${s.heading === s.title ? '' : ` › # ${s.heading}`}`,
  );
  return src.length ? `${body}\n\nSources:\n${src.join('\n')}` : body;
}
