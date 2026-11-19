import { describe, expect, it } from 'vitest';
import { askResult } from './docsAiAsk';
import type { DocsAiJob } from './docsAi';

const job = (result: Record<string, unknown>) => ({ state: 'finished', result }) as unknown as DocsAiJob;
const cite = (n: number, title: string, section?: string) => ({ n, pageId: `p${n}`, title, section });

describe('askResult reads the AI v2 answer', () => {
  it('"answered" is an answer and its citations are sources', () => {
    const r = askResult(job({ answer: 'Use tabs [1].', verdict: 'answered', citations: [cite(1, 'Style', 'Indent')] }));
    expect(r?.verdict).toBe('answer');
    expect(r?.citations[0]).toMatchObject({ n: 1, pageId: 'p1', title: 'Style', heading: 'Indent', path: ['Style'] });
    expect(r?.conflicts).toEqual([]);
  });
  it('"conflict" is a disagreement whose sides are the cited pages', () => {
    const r = askResult(
      job({ answer: 'They differ.', verdict: 'conflict', citations: [cite(1, 'A'), cite(2, 'B')], conflicts: [] }),
    );
    expect(r?.verdict).toBe('disagree');
    expect(r?.conflicts.map((c) => c.pageId)).toEqual(['p1', 'p2']);
    expect(r?.conflicts[0].heading).toBe('A');
  });
  it('not covered stays not covered; a running job has no result', () => {
    expect(askResult(job({ answer: '', verdict: 'not_covered', citations: [] }))?.verdict).toBe('not_covered');
    expect(askResult({ state: 'running' } as unknown as DocsAiJob)).toBeNull();
  });
});
