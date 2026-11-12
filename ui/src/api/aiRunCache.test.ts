import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRun, AiRunFull, RunStep } from '../types/ai';
import { aiKeys, type AiBoardData } from './ai';
import {
  applyAiEvent,
  applyStepEvent,
  COUNTERS_EVERY_MS,
  mergeSteps,
  parseAiEvent,
  resetCounterThrottle,
} from './aiRunCache';
import { runCounter } from './runCounters';

beforeEach(() => resetCounterThrottle());

const step = (seq: number, extra: Partial<RunStep> = {}): RunStep => ({
  seq,
  at: '2026-11-05T10:00:00Z',
  agentId: null,
  kind: 'tool',
  tool: 'Bash',
  title: `step ${seq}`,
  detail: {},
  hasOutput: false,
  parentToolId: null,
  toolId: null,
  ...extra,
});

const run = (extra: Partial<AiRunFull> = {}): AiRunFull =>
  ({
    id: 'r1',
    ticketId: 'IAM-12',
    memberId: 't1',
    number: 2,
    state: 'running',
    stepsCount: 2,
    lastOutputAt: null,
    startedAt: 'a',
    endedAt: null,
    summary: null,
    question: null,
    agents: [],
    steps: [step(1), step(2)],
    ...extra,
  }) as unknown as AiRunFull;

function setup() {
  const qc = new QueryClient();
  qc.setQueryData(aiKeys.run('r1'), run());
  qc.setQueryData<AiBoardData>(aiKeys.board('p1'), {
    tickets: {
      'IAM-12': {
        ticketId: 'IAM-12',
        runId: 'r1',
        memberId: 't1',
        state: 'running',
        number: 2,
        startedAt: 'a',
        endedAt: null,
        lastOutputAt: null,
        stepsCount: 2,
        summary: null,
        question: null,
      },
    },
  });
  qc.setQueryData<AiRun[]>(aiKeys.ticketRuns('IAM-12'), [run() as unknown as AiRun]);
  return qc;
}

const stepEvent = (over: object = {}) =>
  JSON.stringify({
    type: 'ai.step',
    run_id: 'r1',
    state: 'running',
    steps_count: 4,
    last_output_at: '2026-11-05T10:05:00Z',
    steps: [
      {
        seq: 3,
        at: 'x',
        agent_id: null,
        kind: 'edit',
        title: 'Edited a.ts',
        detail: { exit_code: 0 },
        has_output: false,
      },
      { seq: 4, at: 'y', agent_id: 'toolu_1', kind: 'read', title: 'Read b.ts', detail: {}, has_output: false },
    ],
    truncated: false,
    agents: [{ id: 'toolu_1', run_id: 'r1', agent_type: 'reviewer', steps_count: 1 }],
    ...over,
  });

describe('mergeSteps', () => {
  it('keeps each seq once, in order, and lets a later copy win', () => {
    const merged = mergeSteps([step(1), step(3)], [step(2), step(3, { title: 'newer' })]);
    expect(merged.map((s) => s.seq)).toEqual([1, 2, 3]);
    expect(merged[2].title).toBe('newer');
  });
  it('returns the same list when nothing arrives', () => {
    const old = [step(1)];
    expect(mergeSteps(old, [])).toBe(old);
  });
});

describe('parseAiEvent', () => {
  it('camel-cases an AI event, details included, and ignores everything else', () => {
    const ev = parseAiEvent(stepEvent());
    expect(ev?.type).toBe('ai.step');
    expect((ev as { runId: string }).runId).toBe('r1');
    expect((ev as { steps: RunStep[] }).steps[0].detail.exitCode).toBe(0);
    expect(parseAiEvent('{"type":"invalidate","topics":["x"]}')).toBeNull();
    expect(parseAiEvent('invalidate')).toBeNull();
    expect(parseAiEvent('{broken')).toBeNull();
  });
});

describe('ai.step', () => {
  it('appends the steps and agents to the open run, and the counters go to the live line and the ticket list', () => {
    const qc = setup();
    const board = qc.getQueryData<AiBoardData>(aiKeys.board('p1'));
    expect(applyAiEvent(qc, stepEvent())).toBe(true);
    const cached = qc.getQueryData<AiRunFull>(aiKeys.run('r1'))!;
    expect(cached.steps.map((s) => s.seq)).toEqual([1, 2, 3, 4]);
    expect(cached.stepsCount).toBe(4);
    expect(cached.agents[0].agentType).toBe('reviewer');
    // the board is read by every card: a counter does not change it (the card's "step N" reads runCounters)
    expect(qc.getQueryData(aiKeys.board('p1'))).toBe(board);
    expect(runCounter('r1')).toEqual({ stepsCount: 4, lastOutputAt: '2026-11-05T10:05:00Z' });
    expect(qc.getQueryData<AiRun[]>(aiKeys.ticketRuns('IAM-12'))![0].stepsCount).toBe(4);
  });

  it('takes nothing for a run nobody opened, but still moves its live counter', () => {
    const qc = setup();
    qc.removeQueries({ queryKey: aiKeys.run('r1') });
    applyAiEvent(qc, stepEvent());
    expect(qc.getQueryData(aiKeys.run('r1'))).toBeUndefined();
    expect(runCounter('r1')?.stepsCount).toBe(4);
  });

  it('asks the open run again when the batch left steps out or does not follow the ones held', () => {
    const qc = setup();
    applyAiEvent(qc, stepEvent({ truncated: true }));
    expect(qc.getQueryState(aiKeys.run('r1'))?.isInvalidated).toBe(true);
    const qc2 = setup();
    applyAiEvent(qc2, stepEvent({ steps: [{ seq: 9, at: 'x', kind: 'tool', title: 'late', detail: {} }] }));
    expect(qc2.getQueryState(aiKeys.run('r1'))?.isInvalidated).toBe(true);
    expect(qc2.getQueryData<AiRunFull>(aiKeys.run('r1'))!.steps).toHaveLength(2);
  });
});

describe('ai.run', () => {
  const ev = (state: string, number = 2) =>
    JSON.stringify({
      type: 'ai.run',
      run: {
        id: 'r1',
        ticket_id: 'IAM-12',
        member_id: 't1',
        number,
        state,
        steps_count: 7,
        started_at: 'a',
        ended_at: 'b',
        last_output_at: 'b',
        summary: 'Done it',
        question: null,
      },
    });

  it('replaces the run in every cache and refreshes the overview', () => {
    const qc = setup();
    applyAiEvent(qc, ev('finished'));
    expect(qc.getQueryData<AiRunFull>(aiKeys.run('r1'))!.state).toBe('finished');
    expect(qc.getQueryData<AiRunFull>(aiKeys.run('r1'))!.steps).toHaveLength(2);
    expect(qc.getQueryData<AiBoardData>(aiKeys.board('p1'))!.tickets['IAM-12']).toMatchObject({
      state: 'finished',
      summary: 'Done it',
      stepsCount: 7,
    });
    expect(qc.getQueryData<AiRun[]>(aiKeys.ticketRuns('IAM-12'))![0].state).toBe('finished');
  });

  it('puts a new run first in the ticket list, and an older run does not take the board entry', () => {
    const qc = setup();
    applyAiEvent(
      qc,
      JSON.stringify({
        type: 'ai.run',
        run: { id: 'r0', ticket_id: 'IAM-12', member_id: 't1', number: 1, state: 'finished' },
      }),
    );
    expect(qc.getQueryData<AiBoardData>(aiKeys.board('p1'))!.tickets['IAM-12'].runId).toBe('r1');
    applyAiEvent(
      qc,
      JSON.stringify({
        type: 'ai.run',
        run: { id: 'r3', ticket_id: 'IAM-12', member_id: 't1', number: 3, state: 'queued' },
      }),
    );
    expect(qc.getQueryData<AiRun[]>(aiKeys.ticketRuns('IAM-12'))![0].id).toBe('r3');
    expect(qc.getQueryData<AiBoardData>(aiKeys.board('p1'))!.tickets['IAM-12'].runId).toBe('r3');
  });
});

describe('ai.step counters', () => {
  const ev = (stepsCount: number, state = 'running') =>
    parseAiEvent(stepEvent({ steps_count: stepsCount, state, steps: [] })) as Parameters<typeof applyStepEvent>[1];

  it('moves the run list at most every few seconds and never the board while the state stays; the open run and the live counter every time', () => {
    const qc = setup();
    const board = qc.getQueryData<AiBoardData>(aiKeys.board('p1'));
    applyStepEvent(qc, ev(4), 1000);
    const runs = qc.getQueryData<AiRun[]>(aiKeys.ticketRuns('IAM-12'));
    expect(runs![0].stepsCount).toBe(4);
    applyStepEvent(qc, ev(5), 2000);
    // the same objects: nothing that reads them re-renders
    expect(qc.getQueryData(aiKeys.board('p1'))).toBe(board);
    expect(qc.getQueryData(aiKeys.ticketRuns('IAM-12'))).toBe(runs);
    expect(qc.getQueryData<AiRunFull>(aiKeys.run('r1'))!.stepsCount).toBe(5);
    expect(runCounter('r1')?.stepsCount).toBe(5);
    applyStepEvent(qc, ev(6), 1000 + COUNTERS_EVERY_MS);
    expect(qc.getQueryData<AiRun[]>(aiKeys.ticketRuns('IAM-12'))![0].stepsCount).toBe(6);
    expect(qc.getQueryData(aiKeys.board('p1'))).toBe(board);
  });

  it('writes the waiting counters of every run on the run lists in one go', () => {
    vi.useFakeTimers();
    try {
      const qc = setup();
      qc.setQueryData<AiRun[]>(aiKeys.ticketRuns('IAM-13'), [{ ...run(), id: 'r2', ticketId: 'IAM-13' } as AiRun]);
      const now = Date.now();
      applyStepEvent(qc, ev(4), now);
      const after = qc.getQueryData(aiKeys.ticketRuns('IAM-12'));
      applyStepEvent(qc, ev(5), now + 100);
      applyStepEvent(qc, { ...ev(9), runId: 'r2' }, now + 200);
      expect(qc.getQueryData(aiKeys.ticketRuns('IAM-12'))).toBe(after);
      vi.advanceTimersByTime(COUNTERS_EVERY_MS);
      expect(qc.getQueryData<AiRun[]>(aiKeys.ticketRuns('IAM-12'))![0].stepsCount).toBe(5);
      expect(qc.getQueryData<AiRun[]>(aiKeys.ticketRuns('IAM-13'))![0].stepsCount).toBe(9);
      expect(runCounter('r2')?.stepsCount).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops waiting counters when the run itself changes', () => {
    vi.useFakeTimers();
    try {
      const qc = setup();
      const now = Date.now();
      applyStepEvent(qc, ev(4), now);
      applyStepEvent(qc, ev(5), now + 100);
      applyAiEvent(qc, JSON.stringify({ type: 'ai.run', run: { ...run(), state: 'finished', steps_count: 7 } }));
      vi.advanceTimersByTime(COUNTERS_EVERY_MS);
      const entry = qc.getQueryData<AiBoardData>(aiKeys.board('p1'))!.tickets['IAM-12'];
      expect(entry.state).toBe('finished');
      expect(entry.stepsCount).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a change of state through at once', () => {
    const qc = setup();
    applyStepEvent(qc, ev(4), 1000);
    applyStepEvent(qc, ev(5, 'needs_input'), 1500);
    const entry = qc.getQueryData<AiBoardData>(aiKeys.board('p1'))!.tickets['IAM-12'];
    expect(entry.state).toBe('needs_input');
    expect(entry.stepsCount).toBe(5);
  });
});

describe('typed AI events read elsewhere', () => {
  it('counts ai.resources and unknown ai.* events as handled, so nothing is refetched', () => {
    const qc = setup();
    const before = qc.getQueryData(aiKeys.board('p1'));
    expect(applyAiEvent(qc, '{"type": "ai.resources", "project_id": "p1", "runs": []}')).toBe(true);
    expect(applyAiEvent(qc, '{"type":"ai.something_new"}')).toBe(true);
    expect(qc.getQueryData(aiKeys.board('p1'))).toBe(before);
    expect(qc.getQueryState(aiKeys.run('r1'))?.isInvalidated).toBe(false);
    // everything else still goes to the generic invalidation
    expect(applyAiEvent(qc, 'invalidate')).toBe(false);
    expect(applyAiEvent(qc, '{"type":"invalidate","topics":["notifications"]}')).toBe(false);
    expect(applyAiEvent(qc, '{"type":"comment_added","ticket_id":"x"}')).toBe(false);
  });
});

describe('ai.message', () => {
  it('asks for the run messages again', () => {
    const qc = new QueryClient();
    qc.setQueryData(aiKeys.runMessages('r1'), []);
    applyAiEvent(qc, '{"type":"ai.message","run_id":"r1","peer":"IAM-3","text":"hi"}');
    expect(qc.getQueryState(aiKeys.runMessages('r1'))?.isInvalidated).toBe(true);
  });
});
