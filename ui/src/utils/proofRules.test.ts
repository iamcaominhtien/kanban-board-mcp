import { describe, expect, it } from 'vitest';
import type { TestCase } from '../types';
import { hasProof, isUnprovable, proofGaps, unprovableCases } from './proofRules';

const tc = (code: string, status: TestCase['status'], proof?: string | null): TestCase => ({
  id: code,
  code,
  title: code,
  status,
  proof,
});

describe('proofRules', () => {
  it('counts only a written proof, not white space', () => {
    expect(hasProof(tc('TC-1', 'pass', '![a](/uploads/a.png)'))).toBe(true);
    expect(hasProof(tc('TC-2', 'pass', '  '))).toBe(false);
    expect(hasProof(tc('TC-3', 'pass', null))).toBe(false);
  });

  it('lists the results that were given without a proof', () => {
    const cases = [
      tc('TC-1', 'pass', 'ok'),
      tc('TC-2', 'pass'),
      tc('TC-3', 'fail', ''),
      tc('TC-4', 'pending'),
      tc('TC-5', 'running'),
    ];
    expect(proofGaps(cases).map((c) => c.code)).toEqual(['TC-2', 'TC-3']);
  });

  it('tells a reason it cannot be shown from a proof, in English or Vietnamese', () => {
    expect(isUnprovable(tc('TC-1', 'pass', 'Not provable: needs a real iPhone'))).toBe(true);
    expect(isUnprovable(tc('TC-2', 'pass', 'Không chứng minh được vì cần thiết bị thật'))).toBe(true);
    expect(isUnprovable(tc('TC-3', 'pass', 'It is not provable here'))).toBe(false);
    const cases = [tc('TC-1', 'pass', 'Not provable: taste'), tc('TC-2', 'pass', 'ok')];
    expect(unprovableCases(cases).map((c) => c.code)).toEqual(['TC-1']);
    expect(proofGaps(cases)).toEqual([]);
  });
});
