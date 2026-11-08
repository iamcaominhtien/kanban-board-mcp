// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aiKeys } from '../api/ai';
import type { AiRunFull } from '../types/ai';
import { useSSEInvalidation } from './useSSEInvalidation';

class FakeSource {
  static last: FakeSource | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor(public url: string) {
    FakeSource.last = this;
  }
  close() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('EventSource', FakeSource);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function mount() {
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  renderHook(() => useSSEInvalidation(), { wrapper });
  return qc;
}

describe('useSSEInvalidation', () => {
  it('patches the cache from an ai.step event and does not refetch anything for it', () => {
    const qc = mount();
    qc.setQueryData(aiKeys.run('r1'), {
      id: 'r1',
      state: 'running',
      stepsCount: 1,
      steps: [{ seq: 1 }],
      agents: [],
    } as unknown as AiRunFull);
    qc.setQueryData(['tickets', 'p1'], []);
    const spy = vi.spyOn(qc, 'invalidateQueries');
    FakeSource.last!.onmessage!({
      data: JSON.stringify({
        type: 'ai.step',
        run_id: 'r1',
        state: 'running',
        steps_count: 2,
        last_output_at: null,
        steps: [{ seq: 2, at: 'x', kind: 'tool', title: 'Ran it', detail: {} }],
        truncated: false,
      }),
    });
    vi.advanceTimersByTime(5000);
    expect(qc.getQueryData<AiRunFull>(aiKeys.run('r1'))!.steps.map((s) => s.seq)).toEqual([1, 2]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still invalidates everything for an announcement that is not an AI event', () => {
    const qc = mount();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    FakeSource.last!.onmessage!({ data: 'invalidate' });
    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalled();
  });
});
