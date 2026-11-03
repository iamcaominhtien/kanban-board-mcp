import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sortedThisWeekLine } from '../../api/ideas';
import type { Idea, IdeaActivityEntry } from '../../types/idea';
import { LastChange } from './IdeaAssumptions';
import { activityParts } from './IdeaDiscussion';

const entry = (over: Partial<IdeaActivityEntry>): IdeaActivityEntry => ({
  id: 'e1',
  label: 'Assumption marked as testing',
  at: new Date().toISOString(),
  author: 'Hoa Mai',
  kind: 'assumption',
  ...over,
});

describe('activity entries that name their assumption (IW-4)', () => {
  it('shows the assumption and the state change', () => {
    const e = entry({ meta: { assumption: 'a1', assumptionText: 'They pay', from: 'untested', to: 'testing' } });
    expect(activityParts(e)).toEqual({ subject: '“They pay”', from: 'untested', to: 'testing' });
  });

  it('names the assumption added, edited or deleted, and cuts a long text', () => {
    const long = 'x'.repeat(70);
    expect(
      activityParts(entry({ label: 'Assumption added', meta: { assumption: 'a1', assumptionText: 'They pay' } })),
    ).toEqual({ subject: 'added “They pay”' });
    expect(activityParts(entry({ label: 'Assumption deleted', meta: { assumptionText: long } })).subject).toBe(
      `deleted “${'x'.repeat(60)}…”`,
    );
  });

  it('keeps old entries as they read before', () => {
    expect(activityParts(entry({ label: 'Assumption marked as validated' }))).toEqual({
      subject: 'marked as',
      to: 'validated',
    });
    expect(activityParts(entry({ label: 'Assumption edited' }))).toEqual({ subject: 'edited' });
  });
});

describe('LastChange (IP-8)', () => {
  const idea = (trail: IdeaActivityEntry[]) => ({ activityTrail: trail }) as unknown as Idea;

  it('says the latest change of this assumption, by whom', () => {
    const html = renderToStaticMarkup(
      <LastChange
        idea={idea([
          entry({ id: '1', meta: { assumption: 'a1', from: 'untested', to: 'testing' }, author: 'An' }),
          entry({ id: '2', meta: { assumption: 'a2', from: 'untested', to: 'validated' } }),
          entry({ id: '3', label: 'Assumption edited', meta: { assumption: 'a1' } }),
        ])}
        assumptionId="a1"
      />,
    );
    expect(html).toContain('Changed to Testing by An · ');
  });

  it('says "you" for the board user, and nothing when no entry names the assumption', () => {
    expect(
      renderToStaticMarkup(
        <LastChange
          idea={idea([entry({ meta: { assumption: 'a1', to: 'disproved' }, author: 'user' })])}
          assumptionId="a1"
        />,
      ),
    ).toContain('Changed to Disproved by you');
    expect(renderToStaticMarkup(<LastChange idea={idea([entry({})])} assumptionId="a1" />)).toBe('');
  });
});

describe('sortedThisWeekLine (ICT-9)', () => {
  it('reads as drawn, without the zero decisions', () => {
    expect(sortedThisWeekLine({ total: 7, kept: 3, parked: 2, merged: 1, archived: 1, days: 7 })).toBe(
      'You sorted 7 ideas this week: 3 kept, 2 parked, 1 merged, 1 archived.',
    );
    expect(sortedThisWeekLine({ total: 1, kept: 0, parked: 1, merged: 0, archived: 0, days: 7 })).toBe(
      'You sorted 1 idea this week: 1 parked.',
    );
    expect(sortedThisWeekLine({ total: 0, kept: 0, parked: 0, merged: 0, archived: 0, days: 7 })).toBeNull();
    expect(sortedThisWeekLine(undefined)).toBeNull();
  });
});
