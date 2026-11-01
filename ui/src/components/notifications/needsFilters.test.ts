import { describe, expect, it } from 'vitest';
import type { NotificationRow } from '../../types/notifications';
import { applyNeedsFilter, needsFilterCounts, needsFilterOf } from './needsFilters';

const row = (kind: string, data: Record<string, unknown> = {}, done = false) =>
  ({ id: kind, kind, data, done }) as unknown as NotificationRow;

describe('needs you filters', () => {
  it.each([
    ['board_fault', {}, 'faults'],
    ['run_stuck', { diagnosis: { boardFault: true } }, 'faults'],
    ['run_failed', { diagnosis: { boardFault: true } }, 'faults'],
    ['run_failed', { diagnosis: { cause: 'crash' } }, 'decision'],
    ['run_stopped_memory', {}, 'decision'],
    ['run_stuck', {}, 'decision'],
    ['arbitration', {}, 'decision'],
    ['question', {}, 'asked'],
    ['approval', {}, 'asked'],
    ['merge_conflict', {}, 'code'],
    ['account_signed_out', {}, 'accounts'],
    ['window_urgent', {}, 'accounts'],
    ['something_new', {}, 'decision'],
  ])('puts %s %j in %s', (kind, data, want) => {
    expect(needsFilterOf(row(kind, data))).toBe(want);
  });

  it('counts open rows once each and filters', () => {
    const rows = [row('board_fault'), row('question'), row('arbitration'), row('question', {}, true)];
    expect(needsFilterCounts(rows)).toEqual({ all: 3, faults: 1, decision: 1, asked: 1, code: 0, accounts: 0 });
    expect(applyNeedsFilter(rows, 'asked')).toHaveLength(2);
    expect(applyNeedsFilter(rows, 'all')).toHaveLength(4);
  });
});
