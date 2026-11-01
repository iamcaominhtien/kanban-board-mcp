import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from './parts';

describe('newId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('makes 12 hex characters from randomUUID', () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(newId()).not.toBe(id);
  });

  it('falls back to getRandomValues where randomUUID is missing (a page that is not a secure context)', () => {
    vi.stubGlobal('crypto', { getRandomValues: (b: Uint8Array) => b.fill(171) });
    expect(newId()).toBe('abababababab');
  });
});
