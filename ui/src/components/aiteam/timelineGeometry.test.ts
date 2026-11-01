import { describe, expect, it } from 'vitest';
import { BAR_W, SIDE_W, arrowEnds, barAt, laneBox } from './timelineGeometry';

describe('runs of one AI at the same time', () => {
  it('puts the first on the lifeline and the next ones beside it, never on top', () => {
    const a = laneBox(100, 0);
    const b = laneBox(100, 1);
    const c = laneBox(100, 2);
    expect(a).toEqual({ x: 91, w: BAR_W });
    expect(b.w).toBe(SIDE_W);
    expect(b.x).toBeGreaterThan(a.x + a.w);
    expect(c.x).toBeGreaterThan(b.x + b.w);
    // still inside the lane (half a lane is 54 px)
    expect(c.x + c.w - 100).toBeLessThan(54);
  });
});

describe('arrow ends', () => {
  it('starts and lands 1 px outside the bars, as in the design (bars 663–681 and 447–465)', () => {
    expect(arrowEnds(672, 456, { x: 663, w: 18 }, { x: 447, w: 18 })).toEqual({ x1: 662, x2: 466 });
    expect(arrowEnds(348, 456, { x: 339, w: 18 }, { x: 447, w: 18 })).toEqual({ x1: 358, x2: 446 });
  });

  it('follows a run drawn beside the lifeline', () => {
    const side = laneBox(672, 1);
    expect(arrowEnds(456, 672, null, side).x2).toBe(side.x - 1);
    expect(arrowEnds(672, 456, side, null).x1).toBe(side.x - 1);
    expect(arrowEnds(456, 672, null, null)).toEqual({ x1: 466, x2: 662 });
  });

  it('ends 10 px from a lifeline with no run (you, Autopilot)', () => {
    expect(arrowEnds(672, 132, { x: 663, w: 18 }, null)).toEqual({ x1: 662, x2: 142 });
  });
});

describe('the run an arrow leaves from', () => {
  const bars = [
    { id: 'long', x: 0, w: 18, top: 0, bottom: 200 },
    { id: 'short', x: 20, w: 12, top: 80, bottom: 100 },
  ];
  it('is the run covering the moment that ends closest to it', () => {
    expect(barAt(bars, 100)?.id).toBe('short');
    expect(barAt(bars, 150)?.id).toBe('long');
    expect(barAt(bars, 300)).toBeNull();
  });
});
