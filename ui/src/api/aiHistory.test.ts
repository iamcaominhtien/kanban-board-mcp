import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTERS, PAGE_SIZE, historyParams, sinceOf } from './aiHistory';

const NOW = Date.parse('2026-11-02T12:00:00Z');

describe('historyParams', () => {
  it('sends only what is set, in the names the server reads', () => {
    const p = historyParams('p1', { ...DEFAULT_FILTERS, days: 0 }, 0, NOW);
    expect(p).toEqual({ project_id: 'p1', limit: PAGE_SIZE, offset: 0 });
  });

  it('turns the view, member, ticket, skill, time and search into params', () => {
    const p = historyParams(
      'p1',
      { view: 'failed', memberId: 'm1', ticketId: ' KAN-1 ', skill: 'tdd', days: 7, q: ' npm test ' },
      2,
      NOW,
    );
    expect(p).toMatchObject({
      member_id: 'm1',
      ticket_id: 'KAN-1',
      state: 'failed,timed_out',
      skill: 'tdd',
      q: 'npm test',
      offset: PAGE_SIZE * 2,
      since: '2026-10-26T12:00:00.000Z',
    });
  });

  it('asks for pinned runs with the pinned flag, not a state', () => {
    const p = historyParams('p1', { ...DEFAULT_FILTERS, view: 'pinned', days: 0 }, 0, NOW);
    expect(p.pinned).toBe(true);
    expect(p.state).toBeUndefined();
  });

  it('maps Needed you to needs_input', () => {
    expect(historyParams('p1', { ...DEFAULT_FILTERS, view: 'needs', days: 0 }, 0, NOW).state).toBe('needs_input');
  });
});

describe('sinceOf', () => {
  it('is undefined for all time', () => {
    expect(sinceOf(0, NOW)).toBeUndefined();
  });

  it('stays the same within a minute, so the list query keeps one key', () => {
    expect(sinceOf(30, NOW + 1)).toBe(sinceOf(30, NOW + 59_000));
    expect(sinceOf(30, NOW + 1)).not.toBe(sinceOf(30, NOW + 60_000));
  });
});
