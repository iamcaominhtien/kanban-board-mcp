// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiRun } from '../../types/ai';
import { useAiRunNotifications } from './useAiRunNotifications';

const toast = { success: vi.fn(), error: vi.fn(), showToast: vi.fn() };
vi.mock('../Toast', () => ({ useToast: () => toast }));

const HOUR = 3600_000;
const run = (id: string, state: AiRun['state'], queuedAgoMs: number, projectId = 'p1'): AiRun =>
  ({
    id,
    projectId,
    ticketId: `AGT-${id}`,
    memberName: 'Dev An',
    mode: 'work',
    state,
    queuedAt: new Date(Date.now() - queuedAgoMs).toISOString(),
    question: null,
    blockedMove: null,
  }) as unknown as AiRun;

const watch = (projectId: string, runs: AiRun[] | undefined) =>
  renderHook(({ p, r }) => useAiRunNotifications(p, r, () => {}), { initialProps: { p: projectId, r: runs } });

describe('useAiRunNotifications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says nothing on the first load, then tells a run that finishes', () => {
    const view = watch('p1', [run('1', 'running', HOUR)]);
    expect(toast.success).not.toHaveBeenCalled();
    view.rerender({ p: 'p1', r: [run('1', 'finished', HOUR)] });
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success.mock.calls[0][0]).toBe('Dev An finished AGT-1');
  });

  it('does not replay the finished runs of a project it switches to', () => {
    const view = watch('p1', [run('1', 'running', HOUR)]);
    view.rerender({ p: 'p2', r: undefined });
    view.rerender({
      p: 'p2',
      r: [run('13', 'finished', 7 * HOUR, 'p2'), run('14', 'finished', 7 * HOUR, 'p2')],
    });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not tell an old run it had not seen before (one that comes back into the list)', () => {
    const view = watch('p1', []);
    view.rerender({ p: 'p1', r: [run('9', 'finished', 7 * HOUR)] });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('tells a run queued after it started watching even when it finished between two loads', () => {
    const view = watch('p1', []);
    view.rerender({ p: 'p1', r: [run('2', 'finished', -1000)] });
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
