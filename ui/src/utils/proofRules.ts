import type { TestCase } from '../types';

/** The proof of a test case is Markdown (text, links, code, pictures, files). A reason it cannot be shown counts as
 *  an answer, written "Not provable: <why>"; it is not a gap, and it is shown apart from a proof. */
const UNPROVABLE = /^\s*(not provable|không chứng minh được)\b/i;

const given = (tc: TestCase) => tc.status === 'pass' || tc.status === 'fail';

/** True when something is written as the proof (a reason it cannot be shown counts too). */
export function hasProof(tc: TestCase): boolean {
  return (tc.proof ?? '').trim().length > 0;
}

/** True when the proof says the result cannot be shown. */
export function isUnprovable(tc: TestCase): boolean {
  return UNPROVABLE.test(tc.proof ?? '');
}

/** Test cases marked pass or fail with nothing written as proof. */
export function proofGaps(cases: TestCase[]): TestCase[] {
  return cases.filter((tc) => given(tc) && !hasProof(tc));
}

/** Test cases marked pass or fail whose proof says it cannot be shown. */
export function unprovableCases(cases: TestCase[]): TestCase[] {
  return cases.filter((tc) => given(tc) && isUnprovable(tc));
}

/** How a test case is named in a sentence: its code, else its title. */
export const caseName = (tc: TestCase) => tc.code || tc.title;
