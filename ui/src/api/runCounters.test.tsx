// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetRunCounters, setRunCounter, useRunStepsCount } from './runCounters';

function Steps({ runId, fallback }: { runId?: string; fallback: number }) {
  return <span data-testid="steps">{useRunStepsCount(runId, fallback)}</span>;
}

describe('run counters', () => {
  beforeEach(() => resetRunCounters());

  it('shows the live counter of its run, never below what the run data says', () => {
    render(
      <>
        <Steps runId="r1" fallback={3} />
        <Steps fallback={7} />
      </>,
    );
    const [one, none] = screen.getAllByTestId('steps');
    expect(one.textContent).toBe('3');
    act(() => setRunCounter('r1', { stepsCount: 12, lastOutputAt: null }));
    expect(one.textContent).toBe('12');
    // another run's counter does not touch it, and a line without a run keeps its own number
    act(() => setRunCounter('r2', { stepsCount: 40, lastOutputAt: null }));
    expect(one.textContent).toBe('12');
    expect(none.textContent).toBe('7');
  });
});
