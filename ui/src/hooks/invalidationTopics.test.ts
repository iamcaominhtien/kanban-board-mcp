import { describe, expect, it } from 'vitest';
import { keysFor, topicsOf } from './invalidationTopics';

describe('invalidation topics', () => {
  it('reads the topics of a typed announcement, and anything else means everything', () => {
    expect(topicsOf('{"type":"invalidate","topics":["ai"]}')).toEqual(['ai']);
    expect(topicsOf('invalidate')).toBeNull();
    expect(topicsOf('')).toBeNull();
    expect(topicsOf('{"type":"docs_published","topics":["ai"]}')).toBeNull();
    expect(topicsOf('{"type":"invalidate","topics":[]}')).toBeNull();
    expect(topicsOf('{not json')).toBeNull();
  });

  it('maps a topic to the queries that depend on it', () => {
    expect(keysFor(new Set(['ai']))).toEqual([['ai'], ['ticket_workspace'], ['ticket_branches']]);
    expect(keysFor(null)).toBeNull();
  });

  it('refetches everything when a topic is unknown', () => {
    expect(keysFor(new Set(['ai', 'something-new']))).toBeNull();
  });
});
