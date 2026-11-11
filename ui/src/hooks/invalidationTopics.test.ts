import { describe, expect, it } from 'vitest';
import { keysFor, topicsOf } from './invalidationTopics';

describe('invalidation topics', () => {
  it('reads the topics of a typed announcement, and anything else means everything', () => {
    expect(topicsOf('{"type":"invalidate","topics":["notifications"]}')).toEqual(['notifications']);
    expect(topicsOf('invalidate')).toBeNull();
    expect(topicsOf('')).toBeNull();
    expect(topicsOf('{"type":"docs_published","topics":["ai"]}')).toBeNull();
    expect(topicsOf('{"type":"invalidate","topics":[]}')).toBeNull();
    expect(topicsOf('{not json')).toBeNull();
  });

  it('refetches everything for the old ai topic: the AI is patched by typed events now', () => {
    expect(keysFor(new Set(['ai']))).toBeNull();
    expect(keysFor(null)).toBeNull();
  });

  it('maps the notifications topic to the notifications queries only', () => {
    expect(topicsOf('{"type":"invalidate","topics":["notifications"],"head":7}')).toEqual(['notifications']);
    expect(keysFor(new Set(['notifications']))).toEqual([['notifications']]);
  });

  it('maps a ticket comment to the ticket, its lists, its activity and Docs, not to everything', () => {
    expect(topicsOf('{"type": "invalidate", "topics": ["comments"]}')).toEqual(['comments']);
    const keys = keysFor(new Set(['comments']))!;
    expect(keys).toContainEqual(['ticket']);
    expect(keys).toContainEqual(['tickets']);
    // the Docs a ticket reaches, not every Docs query (an open page is not refetched for each comment)
    expect(keys).toContainEqual(['docs', 'ticket']);
    expect(keys).toContainEqual(['docs', 'backlinks']);
    expect(keys).not.toContainEqual(['docs']);
    expect(keys).not.toContainEqual(['ai']);
    // the note of who it notified that follows it does not refetch everything either
    expect(topicsOf('{"type": "comment_added", "ticket_id": "KAN-1", "comment_id": "c1"}')).toEqual(['comments']);
  });

  it('maps the tickets and docs topics to their queries only', () => {
    const keys = keysFor(new Set(['tickets', 'docs']))!;
    expect(keys).toContainEqual(['ticket']);
    expect(keys).toContainEqual(['tickets']);
    expect(keys).toContainEqual(['ticket-lane-counts']);
    expect(keys).toContainEqual(['docs']);
    expect(keys).not.toContainEqual(['ai']);
  });

  it('maps what an MCP tool wrote on a ticket to the ticket and the Docs it reaches', () => {
    const keys = keysFor(new Set(['tickets', 'ticket_docs']))!;
    expect(keys).toContainEqual(['tickets']);
    expect(keys).toContainEqual(['docs', 'work']);
    expect(keys).not.toContainEqual(['docs']);
  });

  it('refetches everything when a topic is unknown', () => {
    expect(keysFor(new Set(['notifications', 'something-new']))).toBeNull();
  });
});
