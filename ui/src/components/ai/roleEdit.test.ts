import { describe, expect, it } from 'vitest';
import type { AiTeamRole } from '../../types/ai';
import { changedFields, draftOf, isChanged, offKeys, withRoleOff, withRoleOn, withRoleOverride } from './roleEdit';

const role: AiTeamRole = {
  key: 'reviewer',
  name: 'Reviewer',
  description: null,
  prompt: 'Read the diff.',
  model: 'sonnet',
  effort: null,
  tools: null,
  writes: null,
};

describe('role overrides', () => {
  it('sends only the fields that changed', () => {
    const draft = { ...draftOf(role), model: 'haiku' };
    expect(isChanged(role, draftOf(role))).toBe(false);
    expect(isChanged(role, draft)).toBe(true);
    expect(changedFields(role, draft)).toEqual({ model: 'haiku' });
  });

  it('replaces this role override and keeps the others; an empty model means inherit', () => {
    const next = withRoleOverride(
      [
        { key: 'qa', effort: 'low' },
        { key: 'reviewer', model: 'opus' },
      ],
      'reviewer',
      { model: '' },
    );
    expect(next).toContainEqual({ key: 'qa', effort: 'low' });
    expect(next.find((o) => o.key === 'reviewer')).toEqual({ key: 'reviewer', model: null });
  });

  it('turns a role off and on again, keeping its other overrides', () => {
    const off = withRoleOff([{ key: 'reviewer', prompt: 'x' }], 'reviewer');
    expect(offKeys(off)).toEqual(['reviewer']);
    const on = withRoleOn(off, 'reviewer');
    expect(offKeys(on)).toEqual([]);
    expect(on[0].prompt).toBe('x');
  });
});
