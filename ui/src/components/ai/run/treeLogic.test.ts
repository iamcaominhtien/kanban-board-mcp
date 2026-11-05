import { describe, expect, it } from 'vitest';
import type { RunAgent, RunStep } from '../../../types/ai';
import { buildTree, diffWords, hasEarlierLead, hasMoreChildren, lastSeq, stepTone } from './treeLogic';

const step = (seq: number, extra: Partial<RunStep> = {}): RunStep => ({
  seq,
  at: '2026-11-05T10:00:00Z',
  agentId: null,
  kind: 'tool',
  tool: null,
  title: `s${seq}`,
  detail: {},
  hasOutput: false,
  parentToolId: null,
  toolId: null,
  ...extra,
});
const agent = (id: string, stepsCount: number): RunAgent => ({
  id,
  runId: 'r',
  agentType: 'reviewer',
  claudeId: null,
  startedAt: 'a',
  endedAt: null,
  stepsCount,
  lastText: null,
});

describe('buildTree', () => {
  it('puts a role steps under the lead subagent step whose toolId is their agentId', () => {
    const steps = [
      step(1),
      step(2, { kind: 'subagent', toolId: 'toolu_a', title: 'Reviewer' }),
      step(3, { agentId: 'toolu_a' }),
      step(4),
      step(5, { agentId: 'toolu_a' }),
    ];
    const tree = buildTree(steps, [agent('toolu_a', 2)]);
    expect(tree.map((n) => n.step?.seq)).toEqual([1, 2, 4]);
    expect(tree[1].children.map((c) => c.seq)).toEqual([3, 5]);
    expect(tree[1].agent?.agentType).toBe('reviewer');
    expect(tree[0].children).toEqual([]);
  });

  it('keeps steps of a role whose own step is older than the window, in a node of their own, first', () => {
    const tree = buildTree([step(10, { agentId: 'toolu_old' }), step(11)], [agent('toolu_old', 5)]);
    expect(tree[0].step).toBeNull();
    expect(tree[0].agent?.id).toBe('toolu_old');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[1].step?.seq).toBe(11);
  });
});

describe('paging helpers', () => {
  it('knows when a role has steps that are not loaded', () => {
    const [node] = buildTree([step(2, { kind: 'subagent', toolId: 'a' }), step(3, { agentId: 'a' })], [agent('a', 4)]);
    expect(hasMoreChildren(node)).toBe(true);
    const [full] = buildTree([step(2, { kind: 'subagent', toolId: 'a' }), step(3, { agentId: 'a' })], [agent('a', 1)]);
    expect(hasMoreChildren(full)).toBe(false);
  });
  it('knows when the lead has older steps than the first held', () => {
    expect(hasEarlierLead([step(51), step(52)], 52)).toBe(true);
    expect(hasEarlierLead([step(1), step(2)], 2)).toBe(false);
    expect(hasEarlierLead([], 0)).toBe(false);
    expect(hasEarlierLead([step(7, { agentId: 'x' })], 9)).toBe(true);
  });
  it('finds the last seq', () => {
    expect(lastSeq([step(3), step(9), step(4)])).toBe(9);
    expect(lastSeq([])).toBe(0);
  });
});

describe('step looks', () => {
  it('words an edit size and tones failures', () => {
    expect(diffWords(step(1, { detail: { added: 12, removed: 3 } }))).toBe('+12 −3');
    expect(diffWords(step(1, { detail: { added: 4, removed: 0 } }))).toBe('+4');
    expect(diffWords(step(1))).toBe('');
    expect(stepTone(step(1, { kind: 'command', detail: { exitCode: 2 } }))).toBe('bad');
    expect(stepTone(step(1, { kind: 'command', detail: { exitCode: 0 } }))).toBe('plain');
    expect(stepTone(step(1, { kind: 'error' }))).toBe('bad');
    expect(stepTone(step(1, { kind: 'text' }))).toBe('quiet');
  });
});
