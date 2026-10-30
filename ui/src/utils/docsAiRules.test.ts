import { describe, expect, it } from 'vitest';
import type { DocsAiState } from '../api/docsAi';
import { aiGate, costLabel, menuRows } from './docsAiRules';

const base = { state: 'ready' } as DocsAiState;

describe('aiGate', () => {
  it('shows nothing while Docs AI is off or not loaded', () => {
    expect(aiGate(undefined)).toEqual({ show: false });
    expect(aiGate({ ...base, state: 'off' })).toEqual({ show: false });
  });
  it('shows one row that opens AI members when no AI member can read the space', () => {
    const g = aiGate({ ...base, state: 'no_member' });
    expect(g).toMatchObject({ show: true, reason: 'no_member' });
  });
  it('shows a lock and a reason on a page hidden from AI', () => {
    expect(aiGate(base, { hidden: true })).toMatchObject({ show: true, reason: 'hidden' });
  });
  it('is usable otherwise', () => {
    expect(aiGate(base, { hidden: false })).toEqual({ show: true, reason: null });
  });
});

describe('menuRows', () => {
  it('hides the writing rows from people who cannot edit', () => {
    const viewer = menuRows(false).map((r) => r.id);
    expect(viewer).toEqual(['ask', 'summarise', 'check', 'translate']);
    expect(menuRows(true).map((r) => r.id)).toEqual(expect.arrayContaining(['tickets', 'links', 'edit', 'ask']));
  });
});

describe('costLabel', () => {
  it('says Not metered for a local runner and rounds small costs', () => {
    expect(costLabel(0.5, false)).toBe('Not metered');
    expect(costLabel(0.004, true)).toBe('About $0.004');
    expect(costLabel(0.031, true)).toBe('About $0.03');
    expect(costLabel(0, true)).toBe('About $0.00');
  });
});
