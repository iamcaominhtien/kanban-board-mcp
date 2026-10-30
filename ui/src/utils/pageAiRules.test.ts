import { describe, expect, it } from 'vitest';
import type { DocsAiState } from '../api/docsAi';
import {
  applyFix,
  estimateLabel,
  findingsTitle,
  fixDiff,
  freshnessHint,
  moneyLabel,
  pageMenu,
  problemLine,
  readsChips,
  readsOf,
  selectionOk,
} from './pageAiRules';
import { aiGate } from './docsAiRules';

const ready = { state: 'ready' } as DocsAiState;
const PAGE = [
  'Rate limits are tracked in KAN-12 and KAN-9; see KAN-12 again.',
  'Tokens follow [[Requirements#Auth]] and [[Data model|the model]].',
  '```\nKAN-77 [[In code]]\n```',
  'Inline `KAN-88` is code.',
].join('\n');

describe('pageMenu', () => {
  it('shows nothing when Docs AI is off', () => {
    expect(pageMenu(aiGate({ ...ready, state: 'off' }), true)).toEqual({ kind: 'none' });
    expect(pageMenu(aiGate(undefined), true)).toEqual({ kind: 'none' });
  });
  it('lists every row for an editor, with Edit with AI below a rule', () => {
    const m = pageMenu(aiGate(ready), true);
    if (m.kind !== 'rows') throw new Error('rows');
    expect(m.rows.map((r) => r.id)).toEqual(['ask', 'summarise', 'check', 'tickets', 'links', 'translate', 'edit']);
    expect(m.rows.find((r) => r.id === 'edit')?.divider).toBe(true);
    expect(m.rows.find((r) => r.id === 'ask')?.shortcut).toBe('Ctrl J');
  });
  it('leaves the writing rows out for a viewer', () => {
    const m = pageMenu(aiGate(ready), false);
    if (m.kind !== 'rows') throw new Error('rows');
    expect(m.rows.map((r) => r.id)).toEqual(['ask', 'summarise', 'check', 'translate']);
  });
  it('shows one row for no AI member and a lock for a hidden page', () => {
    expect(pageMenu(aiGate({ ...ready, state: 'no_member' }), true).kind).toBe('no_member');
    expect(pageMenu(aiGate(ready, { hidden: true }), true)).toMatchObject({ kind: 'hidden' });
  });
});

describe('what the menu says it reads', () => {
  it('counts tickets and linked pages, not code', () => {
    expect(readsOf(PAGE)).toEqual({ tickets: ['KAN-12', 'KAN-9'], pages: ['Requirements', 'Data model'] });
    expect(readsChips(PAGE)).toEqual(['This page', '2 tickets', '2 linked pages']);
    expect(readsChips('Plain text')).toEqual(['This page']);
    expect(readsChips('See KAN-1.')).toEqual(['This page', '1 ticket']);
  });
  it('words the freshness row from the same facts', () => {
    expect(freshnessHint(PAGE)).toBe('Compare with KAN-12, KAN-9 and 2 linked pages');
    expect(freshnessHint('nothing')).toBe('Compare with the tickets and pages it links to');
  });
  it('estimates at least a cent', () => {
    expect(estimateLabel('short')).toBe('About $0.01');
    expect(estimateLabel('x'.repeat(40000))).toMatch(/^About \$0\.\d\d$/);
  });
});

describe('problems and selections', () => {
  it('says paused or over budget the way the states board does', () => {
    expect(problemLine('over_budget', 'Daily cap reached')).toContain('paused until tomorrow');
    expect(problemLine('hidden', '')).toBe('This page is hidden from AI.');
    expect(problemLine('weird', 'The server said this.')).toBe('The server said this.');
  });
  it('needs a few words selected', () => {
    expect(selectionOk('a')).toBe(false);
    expect(selectionOk('two words')).toBe(true);
    expect(selectionOk('x '.repeat(3000))).toBe(false);
  });
});

describe('findings and fixes', () => {
  it('titles the panel', () => {
    expect(findingsTitle(3)).toBe('3 findings');
    expect(findingsTitle(1)).toBe('1 finding');
    expect(findingsTitle(0)).toBe('No findings');
  });
  it('applies a fix to the draft once, and refuses when the text moved', () => {
    expect(applyFix('a b a', 'a', 'X')).toBe('X b a');
    expect(applyFix('hello', 'gone', 'X')).toBeNull();
    expect(applyFix('hello', '', 'X')).toBeNull();
  });
  it('shows only what changed', () => {
    expect(fixDiff('See [[Billing#Plans]] now', 'See [[Billing#Pricing]] now')).toEqual({
      before: 'See [[Billing#',
      removed: 'Plans',
      added: 'Pricing',
      after: ']] now',
    });
  });
});

describe('moneyLabel', () => {
  it('keeps three decimals under a cent', () => {
    expect(moneyLabel(0.004, true)).toBe('$0.004');
    expect(moneyLabel(0.031, true)).toBe('$0.03');
    expect(moneyLabel(0.3, false)).toBe('not metered');
  });
});
