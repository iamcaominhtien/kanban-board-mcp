import { describe, expect, it } from 'vitest';
import type { DocsAiState } from '../api/docsAi';
import type { AskResult, AskSource } from '../api/docsAiAsk';
import {
  answerParts,
  askScopes,
  askTabAvailable,
  askView,
  copyText,
  defaultScope,
  footerLine,
  indexAge,
  justEdited,
  reportTarget,
  tooLongLine,
} from './askRules';

const src = (over: Partial<AskSource> = {}): AskSource => ({
  pageId: 'p1',
  projectId: 'pr',
  title: 'Auth',
  path: ['Requirements', 'Auth'],
  heading: 'Rotation',
  anchor: 'rotation',
  quote: 'q',
  editedAt: '2026-10-02T10:00:00Z',
  ...over,
});
const result = (over: Partial<AskResult> = {}): AskResult => ({
  question: 'q',
  scope: 'space',
  pageId: null,
  answer: 'Rotate it [1].',
  verdict: 'answer',
  citations: [{ ...src(), n: 1 }],
  closest: [],
  conflicts: [],
  pagesRead: 4,
  pagesCited: 2,
  indexUpdatedAt: '2026-10-30T10:00:00Z',
  tooLong: null,
  askedModel: true,
  ...over,
});

describe('scope chips', () => {
  it('has This page only while a page is open', () => {
    expect(askScopes(false).map((c) => c.label)).toEqual(['This space', 'All my projects']);
    expect(askScopes(true).map((c) => c.label)).toEqual(['This space', 'This page', 'All my projects']);
  });
  it('falls back to the space when the page scope is asked for without a page', () => {
    expect(defaultScope(false, 'page')).toBe('space');
    expect(defaultScope(true, 'page')).toBe('page');
    expect(defaultScope(true)).toBe('space');
  });
});

describe('the Ask tab', () => {
  it('exists only when Docs AI is not off', () => {
    expect(askTabAvailable(undefined)).toBe(false);
    expect(askTabAvailable({ state: 'off' } as DocsAiState)).toBe(false);
    expect(askTabAvailable({ state: 'ready' } as DocsAiState)).toBe(true);
    expect(askTabAvailable({ state: 'no_member' } as DocsAiState)).toBe(true);
  });
});

describe('which state shows', () => {
  it('idle, thinking, answer, not covered, disagree', () => {
    expect(askView(false, null, null).kind).toBe('idle');
    expect(askView(true, null, null).kind).toBe('thinking');
    expect(askView(false, result(), null).kind).toBe('answer');
    expect(askView(false, result({ verdict: 'not_covered' }), null).kind).toBe('not_covered');
    expect(askView(false, result({ verdict: 'disagree' }), null).kind).toBe('disagree');
  });
  it('maps the error codes to the states of the design', () => {
    const over = askView(false, null, { code: 'over_budget', detail: 'x' });
    expect(over).toMatchObject({ kind: 'error', title: 'AI is paused until tomorrow', action: 'usage' });
    expect(askView(false, null, { code: 'no_member', detail: 'x' })).toMatchObject({ action: 'members' });
    expect(askView(false, null, { code: 'boom', detail: 'It broke' })).toMatchObject({
      detail: 'It broke',
      action: 'retry',
    });
  });
});

describe('citation numbering', () => {
  it('turns [n] into a marker only when that source exists', () => {
    const parts = answerParts('A [1]. B [2]. See [[Auth]].', [{ n: 1 }]);
    expect(parts).toEqual([
      { type: 'text', text: 'A ' },
      { type: 'cite', n: 1 },
      { type: 'text', text: '. B ' },
      { type: 'text', text: '. See [[Auth]].' },
    ]);
  });
});

describe('footer and notes', () => {
  const now = new Date('2026-10-30T10:02:00Z').getTime();
  it('says what was read, cited, how fresh the index is and the cost', () => {
    expect(footerLine(result(), 0.012, true, now)).toBe(
      'Read 4 pages, cited 2, all visible to you · Index updated 2 min ago · $0.01',
    );
  });
  it('does not mention citations or cost when nothing was asked of the model', () => {
    const r = result({ verdict: 'not_covered', pagesRead: 0, pagesCited: 0, askedModel: false });
    expect(footerLine(r, 0, true, now)).toBe('Read 0 pages · Index updated 2 min ago');
  });
  it('flags a page edited in the last minute', () => {
    expect(justEdited(result(), new Date('2026-10-30T10:00:30Z').getTime())).toBe(true);
    expect(justEdited(result(), now)).toBe(false);
    expect(indexAge(null)).toBe('not indexed yet');
  });
  it('says how much of a long page was read', () => {
    expect(tooLongLine(result({ tooLong: { readSections: 12, totalSections: 30 } }))).toBe(
      'I read the first 12 of 30 sections',
    );
    expect(tooLongLine(result())).toBeNull();
  });
});

describe('two pages disagree', () => {
  it('offers to report the older page', () => {
    const r = result({
      verdict: 'disagree',
      conflicts: [
        src({ pageId: 'a', title: 'Decision log', editedAt: '2026-10-02T00:00:00Z' }),
        src({ pageId: 'b', title: 'Auth', editedAt: '2026-09-12T00:00:00Z' }),
      ],
    });
    expect(reportTarget(r)?.title).toBe('Auth');
    expect(reportTarget(result())).toBeNull();
  });
});

describe('copy', () => {
  it('drops the markers and lists the sources', () => {
    expect(copyText(result())).toBe('Rotate it.\n\nSources:\n1. Requirements › Auth › # Rotation');
  });
});
