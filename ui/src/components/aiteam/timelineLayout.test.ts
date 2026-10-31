import { describe, expect, it } from 'vitest';
import type { Timeline, TimelineBar, TimelineWait } from '../../types/aiTeam';
import { BREAK_H, CAP_H, PX_PER_MIN, assignLanes, buildAxis, lengthText } from './timelineLayout';

const T0 = new Date('2026-10-31T08:00:00').getTime();
const at = (min: number) => new Date(T0 + min * 60000).toISOString();

function bar(id: string, from: number, to: number | null, extra: Partial<TimelineBar> = {}): TimelineBar {
  return {
    id,
    memberId: 'm1',
    ticketId: 'KAN-1',
    number: 1,
    mode: 'work',
    state: to == null ? 'running' : 'finished',
    trigger: 'assign',
    autopilot: false,
    queuedAt: at(from),
    startedAt: at(from),
    endedAt: to == null ? null : at(to),
    endKind: to == null ? null : 'ok',
    endedReason: null,
    endedBy: null,
    stopCode: null,
    peakRssMb: null,
    lastRssMb: null,
    restarts: [],
    steps: 3,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: null,
    costUsd: 0,
    metered: false,
    summary: '',
    question: null,
    paused: false,
    heldByPause: false,
    model: null,
    ...extra,
  };
}

function data(bars: TimelineBar[], until: number, waits: TimelineWait[] = []): Timeline {
  return {
    range: 'today',
    since: at(0),
    until: at(until),
    now: at(until),
    following: true,
    scope: { kind: 'team', ticketId: null },
    lifelines: [],
    bars,
    arrows: [],
    waits,
    touches: [],
    docs: [],
    pauses: [],
    pausedAll: false,
    pausedAt: null,
    pausedBy: null,
    live: [],
    density: [],
    truncated: false,
    lastEndedAt: null,
    tickets: {},
    autopilot: { on: false, delegate: null, graceMin: null },
  };
}

describe('timeline axis', () => {
  it('folds a stretch longer than ten minutes in which nothing runs into one labelled break', () => {
    const d = data([bar('a', 0, 5), bar('b', 80, 90)], 90);
    const axis = buildAxis(d, 'compact', T0 + 90 * 60000);
    expect(axis.breaks).toHaveLength(1);
    expect(axis.breaks[0].label).toBe('1 h 15 min with nothing running');
    // 5 + 10 minutes to scale, plus the break
    expect(axis.height).toBeCloseTo(15 * PX_PER_MIN + BREAK_H, 3);
    // the clock stays real on both sides of the break
    expect(axis.y(T0 + 80 * 60000)).toBeCloseTo(5 * PX_PER_MIN + BREAK_H, 3);
  });

  it('does not fold a stretch of ten minutes or less', () => {
    const d = data([bar('a', 0, 5), bar('b', 14, 20)], 20);
    expect(buildAxis(d, 'compact', T0 + 20 * 60000).breaks).toHaveLength(0);
  });

  it('never folds a wait, and shows a queue like a run', () => {
    const wait: TimelineWait = {
      id: 'w',
      memberId: 'm1',
      ticketId: 'KAN-1',
      runId: 'a',
      kind: 'question',
      from: at(5),
      to: at(55),
      text: 'Which one?',
    };
    const d = data([bar('a', 0, 5, { state: 'needs_input' })], 55, [wait]);
    const axis = buildAxis(d, 'compact', T0 + 55 * 60000);
    expect(axis.breaks).toHaveLength(0);
    expect(axis.height).toBeCloseTo(55 * PX_PER_MIN, 3);
  });

  it('caps a wait over an hour at 150 px', () => {
    const wait: TimelineWait = {
      id: 'w',
      memberId: 'm1',
      ticketId: 'KAN-1',
      runId: 'a',
      kind: 'question',
      from: at(0),
      to: at(320),
      text: 'Which one?',
    };
    const d = data([bar('a', 0, 5, { state: 'needs_input' })], 330, [wait]);
    const axis = buildAxis(d, 'compact', T0 + 330 * 60000);
    expect(axis.caps).toHaveLength(1);
    expect(axis.caps[0].h).toBe(CAP_H);
    // the ten minutes after the wait are drawn to scale below the cap
    expect(axis.height).toBeCloseTo(CAP_H + 10 * PX_PER_MIN, 3);
    expect(axis.y(T0 + 330 * 60000) - axis.y(T0 + 320 * 60000)).toBeCloseTo(10 * PX_PER_MIN, 3);
  });

  it('does not squeeze another AI that works while a long wait goes on', () => {
    const wait: TimelineWait = {
      id: 'w',
      memberId: 'm1',
      ticketId: 'KAN-1',
      runId: 'a',
      kind: 'question',
      from: at(0),
      to: null,
      text: 'Which one?',
    };
    const other = bar('b', 100, 110, { memberId: 'm2', ticketId: 'KAN-2' });
    const d = data([bar('a', 0, null, { state: 'needs_input', endedAt: null, endKind: null }), other], 200, [wait]);
    const axis = buildAxis(d, 'compact', T0 + 200 * 60000);
    // the other AI's ten minutes stay to scale
    expect(axis.y(T0 + 110 * 60000) - axis.y(T0 + 100 * 60000)).toBeCloseTo(10 * PX_PER_MIN, 3);
    // only the quiet stretches of the wait are capped
    expect(axis.caps.length).toBeGreaterThan(0);
    expect(axis.caps.every((c) => c.h <= CAP_H)).toBe(true);
  });

  it('maps a y position back to the time, through a fold', () => {
    const d = data([bar('a', 0, 5), bar('b', 80, 90)], 90);
    const axis = buildAxis(d, 'compact', T0 + 90 * 60000);
    for (const m of [0, 3, 5, 80, 85, 90]) {
      expect(axis.timeAt(axis.y(T0 + m * 60000))).toBeCloseTo(T0 + m * 60000, -2);
    }
    // inside the fold it stays between the two clocks
    const mid = axis.timeAt(5 * PX_PER_MIN + BREAK_H / 2);
    expect(mid).toBeGreaterThan(T0 + 5 * 60000);
    expect(mid).toBeLessThan(T0 + 80 * 60000);
  });

  it('Real time folds and caps nothing', () => {
    const d = data([bar('a', 0, 5), bar('b', 80, 90)], 90);
    const axis = buildAxis(d, 'real', T0 + 90 * 60000);
    expect(axis.breaks).toHaveLength(0);
    expect(axis.height).toBeCloseTo(90 * PX_PER_MIN, 3);
  });

  it('is monotonic: a later time is never higher up', () => {
    const d = data([bar('a', 0, 5), bar('b', 80, 90, { endedAt: null, state: 'running', endKind: null })], 120);
    const axis = buildAxis(d, 'compact', T0 + 120 * 60000);
    let last = -1;
    for (let m = 0; m <= 120; m += 3) {
      const y = axis.y(T0 + m * 60000);
      expect(y).toBeGreaterThanOrEqual(last);
      last = y;
    }
  });
});

describe('timeline helpers', () => {
  it('writes lengths of time', () => {
    expect(lengthText(45 * 60000)).toBe('45 min');
    expect(lengthText(70 * 60000)).toBe('1 h 10 min');
    expect(lengthText(2 * 3600000)).toBe('2 h');
  });

  it('puts overlapping bars on separate lanes', () => {
    const lanes = assignLanes([
      { id: 'a', a: 0, b: 10 },
      { id: 'b', a: 5, b: 15 },
      { id: 'c', a: 12, b: 20 },
    ]);
    expect(lanes.get('a')).toBe(0);
    expect(lanes.get('b')).toBe(1);
    expect(lanes.get('c')).toBe(0);
  });
});
