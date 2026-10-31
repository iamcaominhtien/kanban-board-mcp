import { describe, expect, it } from 'vitest';
import type { Timeline } from '../types/aiTeam';
import { withTicketKeys } from './aiTeam';

describe('withTicketKeys', () => {
  it('keys the tickets by their ids again after the camelCase conversion', () => {
    const t = {
      bars: [{ ticketId: 'AGT-3' }],
      arrows: [{ ticketId: 'KAN-12' }],
      waits: [],
      touches: [],
      live: [],
      scope: { kind: 'team', ticketId: null },
      tickets: { agt3: { title: 'Room Booker', status: 'review' }, kan12: { title: 'Export', status: 'todo' } },
    } as unknown as Timeline;
    expect(Object.keys(withTicketKeys(t).tickets).sort()).toEqual(['AGT-3', 'KAN-12']);
    expect(withTicketKeys(t).tickets['AGT-3'].title).toBe('Room Booker');
  });
});
