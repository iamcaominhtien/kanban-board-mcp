import { describe, expect, it } from 'vitest';
import {
  Placer,
  clipToWidth,
  labelBox,
  overlap,
  runAlong,
  segInBox,
  staggerArrows,
  textWidth,
  type Spot,
} from './timelinePlace';

const right = (x: number, y: number): Spot => ({ x, y, anchor: 'start' });

describe('text size', () => {
  it('grows with the words and the font size', () => {
    expect(textWidth('AGT-4')).toBeGreaterThan(20);
    expect(textWidth('AGT-4')).toBeLessThan(40);
    expect(textWidth('AGT-4', 12)).toBeGreaterThan(textWidth('AGT-4', 10));
    expect(textWidth('mmmm')).toBeGreaterThan(textWidth('iiii'));
  });

  it('cuts a text short with an ellipsis', () => {
    const t = clipToWidth('PM Mai approved after 2 min', 60);
    expect(t.endsWith('…')).toBe(true);
    expect(textWidth(t)).toBeLessThanOrEqual(60);
    expect(clipToWidth('short', 200)).toBe('short');
  });

  it('measures a label box from its anchor', () => {
    const start = labelBox('abc', right(100, 50));
    const end = labelBox('abc', { x: 100, y: 50, anchor: 'end' });
    expect(start.x).toBeCloseTo(98.5, 1);
    expect(end.x + end.w).toBeCloseTo(101.5, 1);
    expect(start.y).toBeLessThan(50);
  });
});

describe('geometry', () => {
  it('measures what two boxes share', () => {
    expect(overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(25);
    expect(overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(0);
  });

  it('measures how much of a line runs through a box', () => {
    expect(segInBox({ x1: 0, y1: 5, x2: 100, y2: 5 }, { x: 20, y: 0, w: 30, h: 10 })).toBeCloseTo(30, 5);
    expect(segInBox({ x1: 0, y1: 50, x2: 100, y2: 50 }, { x: 20, y: 0, w: 30, h: 10 })).toBe(0);
  });
});

describe('arrows that would share a line', () => {
  it('sees two arrows that run along the same lanes', () => {
    expect(runAlong({ x1: 100, y1: 50, x2: 400, y2: 52 }, { x1: 400, y1: 51, x2: 200, y2: 53 })).toBe(true);
    // far apart, or not over the same lanes
    expect(runAlong({ x1: 100, y1: 50, x2: 400, y2: 52 }, { x1: 100, y1: 80, x2: 400, y2: 82 })).toBe(false);
    expect(runAlong({ x1: 100, y1: 50, x2: 200, y2: 50 }, { x1: 300, y1: 50, x2: 400, y2: 50 })).toBe(false);
    // two arrows that cross are fine
    expect(runAlong({ x1: 100, y1: 0, x2: 400, y2: 100 }, { x1: 100, y1: 100, x2: 400, y2: 0 })).toBe(false);
  });

  it('moves the later one down, step by step, and keeps time order', () => {
    const shift = staggerArrows([
      { id: 'b', x1: 400, y1: 100, x2: 150, y2: 100 },
      { id: 'a', x1: 400, y1: 100, x2: 250, y2: 100 },
      { id: 'c', x1: 400, y1: 100, x2: 300, y2: 100 },
      { id: 'far', x1: 400, y1: 300, x2: 100, y2: 300 },
    ]);
    // the leftmost reaching arrow keeps its place, the next ones step down
    expect(shift.get('b')).toBe(0);
    expect(new Set([shift.get('a'), shift.get('c')])).toEqual(new Set([7, 14]));
    expect(shift.get('far')).toBe(0);
  });

  it('is deterministic', () => {
    const arrows = [
      { id: 'x', x1: 0, y1: 10, x2: 300, y2: 10 },
      { id: 'y', x1: 300, y1: 11, x2: 0, y2: 11 },
    ];
    expect([...staggerArrows(arrows)]).toEqual([...staggerArrows([...arrows].reverse())]);
  });
});

describe('the placer', () => {
  it('keeps the design spot when nothing is in the way', () => {
    const p = new Placer(500);
    const l = p.place({ key: 'a', text: 'waited 13 min', spots: [right(100, 50), right(100, 80)] });
    expect(l?.x).toBe(100);
    expect(l?.y).toBe(50);
    expect(l?.clipped).toBe(false);
  });

  it('takes the next spot when a label already sits there', () => {
    const p = new Placer(500);
    p.place({ key: 'a', text: 'report back', spots: [right(100, 50)] });
    const l = p.place({ key: 'b', text: 'PM Mai approved after 2 min', spots: [right(100, 52), right(100, 66)] });
    expect(l?.y).toBe(66);
  });

  it('does not count its own mark, only the others', () => {
    const p = new Placer(500);
    p.addSeg('arrow-1', { x1: 0, y1: 47, x2: 400, y2: 47 });
    const own = p.place({ key: 'arrow-1', text: 'hand-off', spots: [right(100, 50), right(100, 80)] });
    expect(own?.y).toBe(50);
    const other = p.place({ key: 'arrow-2', text: 'hand-off', spots: [right(200, 50), right(200, 80)] });
    expect(other?.y).toBe(80);
  });

  it('cuts the words short before it covers a badge', () => {
    const p = new Placer(500);
    p.addBox('glyph', { x: 180, y: 40, w: 15, h: 15 }, 'glyph');
    const l = p.place({ key: 'a', text: 'Changed settings and more words', spots: [right(100, 50)], shrink: true });
    expect(l?.clipped).toBe(true);
    expect(l && l.box.x + l.box.w).toBeLessThanOrEqual(181);
  });

  it('leaves an optional label out rather than cover another label', () => {
    const p = new Placer(500);
    p.place({ key: 'a', text: 'AGT-4 and AGT-5', spots: [right(100, 50)] });
    expect(p.place({ key: 'b', text: 'AGT-4 and AGT-5', spots: [right(100, 50)], optional: true })).toBeNull();
    // a label that must stay takes the least bad spot
    expect(p.place({ key: 'c', text: 'AGT-4 and AGT-5', spots: [right(100, 50), right(105, 56)] })).not.toBeNull();
  });

  it('does not let a label run off the diagram', () => {
    const p = new Placer(200);
    const l = p.place({
      key: 'a',
      text: 'a long label here',
      spots: [right(180, 50), { x: 170, y: 50, anchor: 'end' }],
    });
    expect(l?.anchor).toBe('end');
  });

  it('slides a badge along its line off a bar', () => {
    const p = new Placer(500);
    p.addBox('bar', { x: 241, y: 0, w: 18, h: 200 }, 'mark');
    const at = p.placeOnLine('arrow', { x1: 100, y1: 100, x2: 400, y2: 100 }, 7.5);
    expect(at.y).toBe(100);
    expect(Math.abs(at.x - 250)).toBeGreaterThan(17);
    // the badge is now in the way of the next one at the same place
    const next = p.placeOnLine('arrow-2', { x1: 100, y1: 100, x2: 400, y2: 100 }, 7.5);
    expect(Math.abs(next.x - at.x)).toBeGreaterThan(15);
  });

  it('places a dense minute without any two labels on top of each other', () => {
    // five events a minute apart (11 px), each with a label at the design spot right of its badge
    const p = new Placer(900);
    const placed = [0, 1, 2, 3, 4].map((i) =>
      p.place({
        key: `a${i}`,
        text: ['PM Mai approved after 2 min', 'report back', 'AGT-4', 'run 4', 'hand-off'][i],
        spots: [right(300, 100 + i * 11), right(300, 113 + i * 11), { x: 280, y: 100 + i * 11, anchor: 'end' }],
        shrink: true,
      }),
    );
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i]!.box, placed[j]!.box)).toBe(0);
  });
});

describe('a strict label', () => {
  it('takes only a free spot and otherwise says so', () => {
    const p = new Placer(500);
    p.addBox('bar', { x: 90, y: 30, w: 200, h: 40 }, 'mark');
    expect(p.place({ key: 'a', text: 'approved', spots: [right(100, 50)], strict: true })).toBeNull();
    expect(p.place({ key: 'a', text: 'approved', spots: [right(100, 50), right(100, 90)], strict: true })?.y).toBe(90);
  });
});
