import { describe, expect, it } from 'vitest';
import { buildMetricRows, formatHours, verdictOf } from './workflowMetricsRows';

const m = (o: object) => ({
  templateKey: 'standard',
  tickets: 31,
  medianHours: 6.6667,
  passedFirst: 0.71,
  roundsAvg: 1.25,
  costPerTicket: 2,
  ...o,
});

describe('workflow metrics', () => {
  it('formats hours', () => {
    expect(formatHours(6.6667)).toBe('6 h 40');
    expect(formatHours(0.5)).toBe('30 min');
    expect(formatHours(null)).toBe('no data');
  });

  it('gives no verdict under ten tickets', () => {
    expect(verdictOf(m({ tickets: 9 }))).toBeNull();
    expect(verdictOf(m({ passedFirst: null }))).toBeNull();
    expect(verdictOf(m({ passedFirst: 0.92 }))).toBe('good');
    expect(verdictOf(m({}))).toBe('watch');
    expect(verdictOf(m({ passedFirst: 0.4 }))).toBe('fix');
  });

  it('builds rows with names and the cost against Standard', () => {
    const rows = buildMetricRows(
      [
        m({}),
        m({ templateKey: 'ui', tickets: 9, costPerTicket: 4.8, passedFirst: 0.64 }),
        m({ templateKey: 'res', costPerTicket: null, medianHours: null, passedFirst: null, roundsAvg: null }),
      ],
      [
        { key: 'standard', name: 'Standard feature' },
        { key: 'ui', name: 'Feature with a UI' },
      ],
    );
    expect(rows[0]).toMatchObject({
      name: 'Standard feature',
      passedFirst: '71%',
      rounds: '1.3',
      cost: '$2.00',
      costVsStandard: null,
    });
    expect(rows[1]).toMatchObject({ name: 'Feature with a UI', verdict: null, costVsStandard: 2.4 });
    expect(rows[2]).toMatchObject({ name: 'res', median: 'no data', passedFirst: 'no review', cost: 'n/a' });
  });
});
