import { describe, expect, it } from 'vitest';
import type { Entry } from '../../types/aiHistory';
import {
  asText,
  buildSteps,
  cutMiddle,
  describeTool,
  endWords,
  fmtBytes,
  fmtTook,
  givenOf,
  usedSkills,
} from './historyFormat';

const tool = (name: string, input: unknown, extra: object = {}): Extract<Entry, { type: 'tool' }> => ({
  type: 'tool',
  at: '2026-11-02T11:22:00Z',
  name,
  input,
  ...extra,
});

describe('describeTool', () => {
  it('says what each kind of call did', () => {
    expect(describeTool(tool('Bash', { command: 'npm test -- --run' }))).toEqual({
      kind: 'command',
      title: 'Ran npm test -- --run',
    });
    expect(describeTool(tool('Edit', { file_path: 'a/b.ts' })).title).toBe('Edited a/b.ts');
    expect(describeTool(tool('Skill', { skill: 'tdd' }))).toEqual({ kind: 'skill', title: 'Used the skill tdd' });
    expect(describeTool(tool('Agent', { subagent_type: 'Explore', description: 'find it' })).kind).toBe('subagent');
    expect(describeTool(tool('mcp__kanban__ticket_update', {}))).toEqual({
      kind: 'board',
      title: 'Board: ticket update',
    });
  });
});

describe('buildSteps', () => {
  const entries: Entry[] = [
    { type: 'sent', at: '2026-11-02T11:22:00Z', prompt: 'do it' },
    { type: 'init', at: '2026-11-02T11:22:01Z', model: 'sonnet' },
    { type: 'say', at: '2026-11-02T11:22:02Z', text: 'Reading the ticket.' },
    tool('Bash', { command: 'ls' }, { endedAt: '2026-11-02T11:22:40Z', isError: true }),
    { type: 'note', at: '2026-11-02T11:23:00Z', kind: 'retry', text: 'Trying again' },
    { type: 'result', at: '2026-11-02T11:24:00Z', isError: false, turns: 4 },
  ];
  const steps = buildSteps(entries);

  it('leaves out what opens the run', () => {
    expect(steps.map((s) => s.entry.type)).toEqual(['say', 'tool', 'note', 'result']);
  });
  it('carries tone and time taken', () => {
    expect(steps[1].tone).toBe('error');
    expect(steps[1].tookS).toBe(40);
    expect(steps[2].title).toBe('Retry: Trying again');
    expect(steps[3].title).toBe('Finished after 4 turns');
  });
  it('splits what was given', () => {
    const g = givenOf(entries);
    expect(g.sent?.prompt).toBe('do it');
    expect(g.init?.model).toBe('sonnet');
    expect(g.messages).toHaveLength(0);
  });
});

describe('usedSkills', () => {
  it('lists skills and subagents once', () => {
    const e = [
      tool('Skill', { skill: 'tdd' }),
      tool('Skill', { skill: 'tdd' }),
      tool('Task', { subagent_type: 'Explore' }),
    ];
    expect(usedSkills(e)).toEqual(['tdd', 'Explore']);
  });
});

describe('text helpers', () => {
  it('cuts long output in the middle', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const cut = cutMiddle(text, 5);
    expect(cut.hidden).toBe(90);
    expect(cut.shown).toContain('90 lines hidden');
    expect(cut.shown).toContain('line 99');
    expect(cutMiddle('short').hidden).toBe(0);
  });
  it('formats', () => {
    expect(asText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(asText(null)).toBe('');
    expect(fmtBytes(2.1 * 1024 ** 3)).toBe('2.1 GB');
    expect(fmtTook(840)).toBe('14 min');
    expect(fmtTook(null)).toBe('—');
  });
  it('names how a run ended', () => {
    expect(endWords({ state: 'finished', diagnosis: null, endedReason: 'done' })).toEqual({
      label: 'Finished',
      why: null,
    });
    expect(endWords({ state: 'failed', diagnosis: { boardFault: true } as never, endedReason: 'x' }).why).toBe(
      'Board fault',
    );
  });
});
