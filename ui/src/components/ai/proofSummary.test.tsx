import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Ticket, TestCase } from '../../types';
import { ProofSummary } from './ReviewGate';

const tc = (code: string, status: TestCase['status'], proof?: string): TestCase => ({
  id: code,
  code,
  title: code,
  status,
  proof,
});
const html = (testCases: TestCase[]) =>
  renderToStaticMarkup(<ProofSummary ticket={{ testCases } as unknown as Ticket} />).replace(/<[^>]+>/g, ' ');

describe('ProofSummary', () => {
  it('says nothing when no result was given', () => {
    expect(html([tc('TC-1', 'pending')])).toBe('');
  });

  it('counts the results with a proof and names the ones without', () => {
    const text = html([
      tc('TC-1', 'pass', 'ok'),
      tc('TC-2', 'pass'),
      tc('TC-3', 'fail', 'Not provable: needs a phone'),
    ]);
    expect(text).toContain('1 of 3 results have a proof');
    expect(text).toContain('1 cannot be shown');
    expect(text).toContain('No proof: TC-2');
    expect(text).toContain('Taken on trust: TC-3');
  });

  it('shows no warning when every result has a proof', () => {
    const text = html([tc('TC-1', 'pass', 'ok'), tc('TC-2', 'fail', 'log')]);
    expect(text).toContain('2 of 2 results have a proof');
    expect(text).not.toContain('No proof');
  });
});
