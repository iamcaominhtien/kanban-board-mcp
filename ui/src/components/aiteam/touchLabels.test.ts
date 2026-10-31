import { describe, expect, it } from 'vitest';
import { touchLabels } from './timelineDraw';

const y = (at: string) => Number(at);
const mark = (at: number, what = 'Changed settings') => ({ at: String(at), what });

describe('touchLabels', () => {
  it('labels marks that are far apart one by one', () => {
    const out = touchLabels([mark(0), mark(40)], y);
    expect(out.map((o) => o.label)).toEqual(['Changed settings', 'Changed settings']);
  });

  it('gives one label to marks that sit on top of each other', () => {
    const out = touchLabels([mark(100), mark(104), mark(108)], y);
    expect(out.filter((o) => o.label).map((o) => o.label)).toEqual(['Changed settings ×3']);
  });

  it('says how many more when the marks differ', () => {
    const out = touchLabels([mark(0), mark(5, 'Paused an AI')], y);
    expect(out.filter((o) => o.label).map((o) => o.label)).toEqual(['Changed settings +1 more']);
  });
});
