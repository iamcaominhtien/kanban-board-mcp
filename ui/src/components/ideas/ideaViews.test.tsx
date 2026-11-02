import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { IdeaReadiness } from '../../types/idea';
import { spreadDots } from './IdeaMatrix';
import { ReadinessBar, StagePill, shortDate } from './ideaShared';

const readiness = (r: Partial<IdeaReadiness>): IdeaReadiness => ({
  state: 'growing',
  total: 0,
  validated: 0,
  testing: 0,
  untested: 0,
  disproved: 0,
  highOpen: 0,
  highDisproved: 0,
  nextId: null,
  ...r,
});

describe('spreadDots (matrix labels)', () => {
  it('moves dots apart so their labels do not sit on top of each other', () => {
    const dots = [0, 1, 2, 3].map(() => ({ x: 0.6, y: 0.82, labelLeft: false }));
    const out = spreadDots(dots);
    const ys = out.map((d) => d.y).sort();
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(0.05);
    out.forEach((d) => {
      expect(d.y).toBeGreaterThan(0.04);
      expect(d.y).toBeLessThan(0.96);
    });
  });

  it('leaves dots that are far apart where they are', () => {
    const dots = [
      { x: 0.1, y: 0.8, labelLeft: false },
      { x: 0.9, y: 0.8, labelLeft: true },
    ];
    expect(spreadDots(dots).map((d) => d.y)).toEqual([0.8, 0.8]);
  });
});

describe('ReadinessBar', () => {
  it('draws one bar with the validated and disproved shares', () => {
    const html = renderToStaticMarkup(
      <ReadinessBar idea={{ assumptions: [], readiness: readiness({ total: 4, validated: 2, disproved: 1 }) }} />,
    );
    expect(html).toContain('width:50%');
    expect(html).toContain('width:25%');
    expect(html).toContain('2 of 4');
  });
});

describe('StagePill and shortDate', () => {
  it('shows the stage name with its icon', () => {
    const html = renderToStaticMarkup(<StagePill stage="exploring" />);
    expect(html).toContain('<svg');
    expect(html).toContain('Exploring');
  });

  it('formats a park date as a short date', () => {
    expect(shortDate(`${new Date().getFullYear()}-12-01`)).toBe('1 Dec');
  });
});
