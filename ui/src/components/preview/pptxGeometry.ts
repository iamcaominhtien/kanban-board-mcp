/**
 * Shapes of a slide as SVG paths, in the px of the shape's own box: the preset shapes PowerPoint offers (the ones people
 * use) and custom geometry (`a:custGeom`). A shape not listed here is not drawn (its text and pictures still are).
 */

export interface PathPart {
  d: string;
  fill: boolean;
  stroke: boolean;
}

const n = (v: number) => Math.round(v * 100) / 100;
const poly = (pts: [number, number][]) => `M${pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(' L')} Z`;
const one = (d: string): PathPart[] => [{ d, fill: true, stroke: true }];

/** Preset shapes drawn by the browser's own box (CSS), not by a path. */
export const BOX_PRESETS: Record<string, { geometry: 'rect' | 'roundRect' | 'ellipse'; radius?: number }> = {
  rect: { geometry: 'rect' },
  flowChartProcess: { geometry: 'rect' },
  flowChartPredefinedProcess: { geometry: 'rect' },
  flowChartInternalStorage: { geometry: 'rect' },
  textBox: { geometry: 'rect' },
  roundRect: { geometry: 'roundRect' },
  flowChartAlternateProcess: { geometry: 'roundRect', radius: 1 / 6 },
  flowChartTerminator: { geometry: 'roundRect', radius: 0.5 },
  ellipse: { geometry: 'ellipse' },
  flowChartConnector: { geometry: 'ellipse' },
  flowChartSummingJunction: { geometry: 'ellipse' },
  flowChartOr: { geometry: 'ellipse' },
  bevel: { geometry: 'rect' },
  plaque: { geometry: 'rect' },
  flowChartMultidocument: { geometry: 'rect' },
};

function star(count: number, inner: number, w: number, h: number): PathPart[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < count * 2; i++) {
    const r = i % 2 === 0 ? 1 : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / count;
    pts.push([w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a)]);
  }
  return one(poly(pts));
}

/** An arrow along x (length `len`, across `thick`) mapped to the box's direction. */
function arrow(dir: 'right' | 'left' | 'up' | 'down', w: number, h: number, a1: number, a2: number): PathPart[] {
  const horizontal = dir === 'right' || dir === 'left';
  const len = horizontal ? w : h;
  const thick = horizontal ? h : w;
  const ss = Math.min(w, h);
  const shaft = (thick * a1) / 100000 / 2;
  const head = Math.min(len, (ss * a2) / 100000);
  const c = thick / 2;
  const pts: [number, number][] = [
    [0, c - shaft],
    [len - head, c - shaft],
    [len - head, 0],
    [len, c],
    [len - head, thick],
    [len - head, c + shaft],
    [0, c + shaft],
  ];
  const mapped = pts.map(([x, y]): [number, number] =>
    dir === 'right' ? [x, y] : dir === 'left' ? [len - x, y] : dir === 'down' ? [y, x] : [y, len - x],
  );
  return one(poly(mapped));
}

function rounded(w: number, h: number, tl: number, tr: number, br: number, bl: number): string {
  return (
    `M${n(tl)} 0 L${n(w - tr)} 0 ${tr ? `A${n(tr)} ${n(tr)} 0 0 1 ${n(w)} ${n(tr)}` : ''} ` +
    `L${n(w)} ${n(h - br)} ${br ? `A${n(br)} ${n(br)} 0 0 1 ${n(w - br)} ${n(h)}` : ''} ` +
    `L${n(bl)} ${n(h)} ${bl ? `A${n(bl)} ${n(bl)} 0 0 1 0 ${n(h - bl)}` : ''} ` +
    `L0 ${n(tl)} ${tl ? `A${n(tl)} ${n(tl)} 0 0 1 ${n(tl)} 0` : ''} Z`
  );
}

/** The same path flipped left to right inside a box of width `w` (for the paths made above: M L C Q commands only). */
function mirrorX(d: string, w: number): string {
  return d.replace(/([MLCQ])([^MLCQ]*)/g, (_m, cmd: string, rest: string) => {
    const nums = rest.trim().split(/\s+/).map(Number);
    return cmd + nums.map((v, i) => (i % 2 === 0 ? n(w - v) : v)).join(' ') + ' ';
  });
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** A point on the box's ellipse at an OOXML angle (60000ths of a degree, clockwise from the right). */
function onEllipse(w: number, h: number, angle: number): [number, number] {
  const a = rad(angle / 60000);
  const t = Math.atan2((w / 2) * Math.sin(a), (h / 2) * Math.cos(a));
  return [w / 2 + (w / 2) * Math.cos(t), h / 2 + (h / 2) * Math.sin(t)];
}

const sweepOf = (from: number, to: number) => ((((to - from) / 60000) % 360) + 360) % 360;

function regular(count: number, w: number, h: number): PathPart[] {
  const pts: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    pts.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)]);
  }
  return one(poly(pts));
}

function wave(periods: number, w: number, h: number, a: number): string {
  const top: string[] = [];
  const bottom: string[] = [];
  const steps = 24 * periods;
  for (let i = 0; i <= steps; i++) {
    const x = (w * i) / steps;
    const y = a * (1 + Math.sin((2 * Math.PI * periods * i) / steps));
    top.push(`${n(x)} ${n(y)}`);
    bottom.unshift(`${n(x)} ${n(h - 2 * a + y)}`);
  }
  return `M${top.join(' L')} L${bottom.join(' L')} Z`;
}

function sector(w: number, h: number, from: number, to: number): string {
  const [x1, y1] = onEllipse(w, h, from);
  const [x2, y2] = onEllipse(w, h, to);
  const sw = sweepOf(from, to);
  return `M${n(w / 2)} ${n(h / 2)} L${n(x1)} ${n(y1)} A${n(w / 2)} ${n(h / 2)} 0 ${sw > 180 ? 1 : 0} 1 ${n(x2)} ${n(y2)} Z`;
}

/**
 * The path of a preset shape in a box of `w` x `h` px, or null when it is not one we draw.
 * @param prst - The preset's name (`triangle`, `rightArrow`, ...).
 * @param adj - The shape's adjust values by name (`adj`, `adj1`, `adj2`), in 1/100000.
 */
export function presetPaths(prst: string, w: number, h: number, adj: Record<string, number>): PathPart[] | null {
  const ss = Math.min(w, h);
  const a = (name: string, def: number) => adj[name] ?? def;
  switch (prst) {
    case 'triangle':
      return one(
        poly([
          [0, h],
          [(w * a('adj', 50000)) / 100000, 0],
          [w, h],
        ]),
      );
    case 'rtTriangle':
      return one(
        poly([
          [0, 0],
          [0, h],
          [w, h],
        ]),
      );
    case 'diamond':
    case 'flowChartDecision':
      return one(
        poly([
          [w / 2, 0],
          [w, h / 2],
          [w / 2, h],
          [0, h / 2],
        ]),
      );
    case 'parallelogram':
    case 'flowChartData': {
      const x = Math.min(w, (ss * a('adj', 25000)) / 100000);
      return one(
        poly([
          [0, h],
          [x, 0],
          [w, 0],
          [w - x, h],
        ]),
      );
    }
    case 'trapezoid':
    case 'flowChartManualOperation': {
      const x = (ss * a('adj', 25000)) / 100000;
      return one(
        poly([
          [0, h],
          [x, 0],
          [w - x, 0],
          [w, h],
        ]),
      );
    }
    case 'pentagon':
      return one(
        poly([
          [0.5 * w, 0],
          [w, 0.3819 * h],
          [0.809 * w, h],
          [0.191 * w, h],
          [0, 0.3819 * h],
        ]),
      );
    case 'hexagon': {
      const x = (ss * a('adj', 25000)) / 100000;
      return one(
        poly([
          [0, h / 2],
          [x, 0],
          [w - x, 0],
          [w, h / 2],
          [w - x, h],
          [x, h],
        ]),
      );
    }
    case 'octagon': {
      const x = (ss * a('adj', 29289)) / 100000;
      return one(
        poly([
          [0, x],
          [x, 0],
          [w - x, 0],
          [w, x],
          [w, h - x],
          [w - x, h],
          [x, h],
          [0, h - x],
        ]),
      );
    }
    case 'plus': {
      const x = (ss * a('adj', 25000)) / 100000;
      return one(
        poly([
          [x, 0],
          [w - x, 0],
          [w - x, x],
          [w, x],
          [w, h - x],
          [w - x, h - x],
          [w - x, h],
          [x, h],
          [x, h - x],
          [0, h - x],
          [0, x],
          [x, x],
        ]),
      );
    }
    case 'star4':
      return star(4, 0.4, w, h);
    case 'star5':
      return star(5, 0.382, w, h);
    case 'star6':
      return star(6, 0.577, w, h);
    case 'star7':
      return star(7, 0.5, w, h);
    case 'star8':
      return star(8, 0.6, w, h);
    case 'star10':
      return star(10, 0.7, w, h);
    case 'star12':
      return star(12, 0.8, w, h);
    case 'rightArrow':
    case 'leftArrow':
    case 'upArrow':
    case 'downArrow':
      return arrow(prst.replace('Arrow', '') as 'right', w, h, a('adj1', 50000), a('adj2', 50000));
    case 'chevron': {
      const x = Math.min(w, (ss * a('adj', 50000)) / 100000);
      return one(
        poly([
          [0, 0],
          [w - x, 0],
          [w, h / 2],
          [w - x, h],
          [0, h],
          [x, h / 2],
        ]),
      );
    }
    case 'homePlate': {
      const x = Math.min(w, (ss * a('adj', 50000)) / 100000);
      return one(
        poly([
          [0, 0],
          [w - x, 0],
          [w, h / 2],
          [w - x, h],
          [0, h],
        ]),
      );
    }
    case 'round1Rect': {
      const r = (ss * a('adj', 16667)) / 100000;
      return one(rounded(w, h, 0, r, 0, 0));
    }
    case 'round2SameRect': {
      const r1 = (ss * a('adj1', 16667)) / 100000;
      const r2 = (ss * a('adj2', 0)) / 100000;
      return one(rounded(w, h, r1, r1, r2, r2));
    }
    case 'round2DiagRect': {
      const r1 = (ss * a('adj1', 16667)) / 100000;
      const r2 = (ss * a('adj2', 0)) / 100000;
      return one(rounded(w, h, r1, r2, r1, r2));
    }
    case 'snip1Rect': {
      const x = (ss * a('adj', 16667)) / 100000;
      return one(
        poly([
          [0, 0],
          [w - x, 0],
          [w, x],
          [w, h],
          [0, h],
        ]),
      );
    }
    case 'snip2SameRect': {
      const x = (ss * a('adj1', 16667)) / 100000;
      return one(
        poly([
          [x, 0],
          [w - x, 0],
          [w, x],
          [w, h],
          [0, h],
          [0, x],
        ]),
      );
    }
    case 'donut': {
      const t = (ss * a('adj', 25000)) / 100000;
      const ring = (rx: number, ry: number, ox: number, oy: number) =>
        `M${n(ox)} ${n(oy + h / 2)} a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0 a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0 Z`;
      return [{ d: `${ring(w / 2, h / 2, 0, 0)} ${ring(w / 2 - t, h / 2 - t, t, 0)}`, fill: true, stroke: true }];
    }
    case 'can': {
      const ry = Math.min(h / 2, (ss * a('adj', 25000)) / 100000 / 2);
      const body = `M0 ${n(ry)} A${n(w / 2)} ${n(ry)} 0 0 1 ${n(w)} ${n(ry)} L${n(w)} ${n(h - ry)} A${n(w / 2)} ${n(ry)} 0 0 1 0 ${n(h - ry)} Z`;
      const lid = `M0 ${n(ry)} A${n(w / 2)} ${n(ry)} 0 0 0 ${n(w)} ${n(ry)}`;
      return [
        { d: body, fill: true, stroke: true },
        { d: lid, fill: false, stroke: true },
      ];
    }
    case 'heart':
      return one(
        `M${n(w / 2)} ${n(h)} C${n(-0.1 * w)} ${n(0.6 * h)} ${n(0.1 * w)} ${n(-0.1 * h)} ${n(w / 2)} ${n(0.3 * h)} ` +
          `C${n(0.9 * w)} ${n(-0.1 * h)} ${n(1.1 * w)} ${n(0.6 * h)} ${n(w / 2)} ${n(h)} Z`,
      );
    case 'wedgeEllipseCallout': {
      const tx = w / 2 + (w * a('adj1', -20833)) / 100000;
      const ty = h / 2 + (h * a('adj2', 62500)) / 100000;
      const ang = Math.atan2(ty - h / 2, tx - w / 2);
      const base = (d: number): [number, number] => [
        w / 2 + (w / 2) * Math.cos(ang + d),
        h / 2 + (h / 2) * Math.sin(ang + d),
      ];
      const rx = w / 2;
      const ry = h / 2;
      return [
        {
          d: `M0 ${n(ry)} a${n(rx)} ${n(ry)} 0 1 0 ${n(w)} 0 a${n(rx)} ${n(ry)} 0 1 0 ${n(-w)} 0 Z`,
          fill: true,
          stroke: true,
        },
        { d: poly([base(-0.25), [tx, ty], base(0.25)]), fill: true, stroke: true },
      ];
    }
    case 'wedgeRectCallout':
    case 'wedgeRoundRectCallout': {
      const tx = w / 2 + (w * a('adj1', -20833)) / 100000;
      const ty = h / 2 + (h * a('adj2', 62500)) / 100000;
      const below = ty > h;
      const above = ty < 0;
      const left = tx < 0;
      const right = tx > w;
      const px = Math.max(w * 0.15, Math.min(w * 0.85, tx));
      const py = Math.max(h * 0.15, Math.min(h * 0.85, ty));
      if (below)
        return one(
          `M0 0 L${w} 0 L${w} ${h} L${n(px + w * 0.1)} ${h} L${n(tx)} ${n(ty)} L${n(px - w * 0.02)} ${h} L0 ${h} Z`,
        );
      if (above)
        return one(`M0 0 L${n(px - w * 0.02)} 0 L${n(tx)} ${n(ty)} L${n(px + w * 0.1)} 0 L${w} 0 L${w} ${h} L0 ${h} Z`);
      if (left)
        return one(`M0 0 L${w} 0 L${w} ${h} L0 ${h} L0 ${n(py + h * 0.1)} L${n(tx)} ${n(ty)} L0 ${n(py - h * 0.02)} Z`);
      if (right)
        return one(
          `M0 0 L${w} 0 L${w} ${n(py - h * 0.02)} L${n(tx)} ${n(ty)} L${w} ${n(py + h * 0.1)} L${w} ${h} L0 ${h} Z`,
        );
      return one(`M0 0 L${w} 0 L${w} ${h} L0 ${h} Z`);
    }
    case 'heptagon':
      return regular(7, w, h);
    case 'decagon':
      return regular(10, w, h);
    case 'dodecagon':
      return regular(12, w, h);
    case 'flowChartPreparation':
      return one(
        poly([
          [0, h / 2],
          [0.2 * w, 0],
          [0.8 * w, 0],
          [w, h / 2],
          [0.8 * w, h],
          [0.2 * w, h],
        ]),
      );
    case 'flowChartInput':
      return one(
        poly([
          [0.2 * w, 0],
          [w, 0],
          [0.8 * w, h],
          [0, h],
        ]),
      );
    case 'flowChartManualInput':
      return one(
        poly([
          [0, 0.2 * h],
          [w, 0],
          [w, h],
          [0, h],
        ]),
      );
    case 'flowChartMerge':
      return one(
        poly([
          [0, 0],
          [w, 0],
          [w / 2, h],
        ]),
      );
    case 'flowChartExtract':
      return one(
        poly([
          [w / 2, 0],
          [w, h],
          [0, h],
        ]),
      );
    case 'flowChartOffpageConnector':
      return one(
        poly([
          [0, 0],
          [w, 0],
          [w, 0.8 * h],
          [w / 2, h],
          [0, 0.8 * h],
        ]),
      );
    case 'flowChartPunchedCard':
      return one(
        poly([
          [0.2 * w, 0],
          [w, 0],
          [w, h],
          [0, h],
          [0, 0.2 * h],
        ]),
      );
    case 'flowChartDelay':
      return one(`M0 0 L${n(w / 2)} 0 A${n(w / 2)} ${n(h / 2)} 0 0 1 ${n(w / 2)} ${n(h)} L0 ${n(h)} Z`);
    case 'flowChartDocument':
      return one(
        `M0 0 L${n(w)} 0 L${n(w)} ${n(0.9 * h)} C${n(0.75 * w)} ${n(0.75 * h)} ${n(0.6 * w)} ${n(0.8 * h)} ${n(0.5 * w)} ${n(0.9 * h)} ` +
          `C${n(0.35 * w)} ${n(1.0 * h)} ${n(0.2 * w)} ${n(1.0 * h)} 0 ${n(0.9 * h)} Z`,
      );
    case 'flowChartMagneticDisk':
      return presetPaths('can', w, h, { adj: 25000 });
    case 'leftRightArrow':
    case 'upDownArrow': {
      const horizontal = prst === 'leftRightArrow';
      const len = horizontal ? w : h;
      const thick = horizontal ? h : w;
      const shaft = (thick * a('adj1', 50000)) / 100000 / 2;
      const head = Math.min(len / 2, (ss * a('adj2', 50000)) / 100000);
      const c = thick / 2;
      const pts: [number, number][] = [
        [0, c],
        [head, 0],
        [head, c - shaft],
        [len - head, c - shaft],
        [len - head, 0],
        [len, c],
        [len - head, thick],
        [len - head, c + shaft],
        [head, c + shaft],
        [head, thick],
      ];
      return one(poly(pts.map(([x, y]): [number, number] => (horizontal ? [x, y] : [y, x]))));
    }
    case 'frame': {
      const t = (ss * a('adj1', 12500)) / 100000;
      return [
        {
          d: `${poly([
            [0, 0],
            [w, 0],
            [w, h],
            [0, h],
          ])} ${poly([
            [t, t],
            [t, h - t],
            [w - t, h - t],
            [w - t, t],
          ])}`,
          fill: true,
          stroke: true,
        },
      ];
    }
    case 'leftBracket':
    case 'rightBracket': {
      const r = Math.min(w, (ss * a('adj', 8333)) / 100000);
      const d = `M${n(w)} 0 L${n(r)} 0 Q0 0 0 ${n(r)} L0 ${n(h - r)} Q0 ${n(h)} ${n(r)} ${n(h)} L${n(w)} ${n(h)}`;
      return [{ d: prst === 'rightBracket' ? mirrorX(d, w) : d, fill: false, stroke: true }];
    }
    case 'leftBrace':
    case 'rightBrace': {
      const d =
        `M${n(w)} 0 C${n(0.5 * w)} 0 ${n(0.5 * w)} ${n(0.1 * h)} ${n(0.5 * w)} ${n(0.25 * h)} L${n(0.5 * w)} ${n(0.4 * h)} ` +
        `C${n(0.5 * w)} ${n(0.45 * h)} ${n(0.25 * w)} ${n(0.5 * h)} 0 ${n(0.5 * h)} C${n(0.25 * w)} ${n(0.5 * h)} ${n(0.5 * w)} ${n(0.55 * h)} ${n(0.5 * w)} ${n(0.6 * h)} ` +
        `L${n(0.5 * w)} ${n(0.75 * h)} C${n(0.5 * w)} ${n(0.9 * h)} ${n(0.5 * w)} ${n(h)} ${n(w)} ${n(h)}`;
      return [{ d: prst === 'rightBrace' ? mirrorX(d, w) : d, fill: false, stroke: true }];
    }
    case 'arc': {
      const from = a('adj1', 16200000);
      const to = a('adj2', 0);
      const [x1, y1] = onEllipse(w, h, from);
      const [x2, y2] = onEllipse(w, h, to);
      const big = sweepOf(from, to) > 180 ? 1 : 0;
      const d = `M${n(x1)} ${n(y1)} A${n(w / 2)} ${n(h / 2)} 0 ${big} 1 ${n(x2)} ${n(y2)}`;
      return [
        { d: `${d} L${n(w / 2)} ${n(h / 2)} Z`, fill: true, stroke: false },
        { d, fill: false, stroke: true },
      ];
    }
    case 'pie':
      return one(sector(w, h, a('adj1', 0), a('adj2', 16200000)));
    case 'chord': {
      const from = a('adj1', 2700000);
      const to = a('adj2', 16200000);
      const [x1, y1] = onEllipse(w, h, from);
      const [x2, y2] = onEllipse(w, h, to);
      return one(
        `M${n(x1)} ${n(y1)} A${n(w / 2)} ${n(h / 2)} 0 ${sweepOf(from, to) > 180 ? 1 : 0} 1 ${n(x2)} ${n(y2)} Z`,
      );
    }
    case 'blockArc': {
      const from = a('adj1', 10800000);
      const to = a('adj2', 0);
      const t = (ss * a('adj3', 25000)) / 100000;
      const [x1, y1] = onEllipse(w, h, from);
      const [x2, y2] = onEllipse(w, h, to);
      const [x3, y3] = onEllipse(w - 2 * t, h - 2 * t, to);
      const [x4, y4] = onEllipse(w - 2 * t, h - 2 * t, from);
      const big = sweepOf(from, to) > 180 ? 1 : 0;
      return one(
        `M${n(x1)} ${n(y1)} A${n(w / 2)} ${n(h / 2)} 0 ${big} 1 ${n(x2)} ${n(y2)} L${n(x3 + t)} ${n(y3 + t)} ` +
          `A${n(w / 2 - t)} ${n(h / 2 - t)} 0 ${big} 0 ${n(x4 + t)} ${n(y4 + t)} Z`,
      );
    }
    case 'teardrop':
      return one(
        `M0 ${n(h / 2)} A${n(w / 2)} ${n(h / 2)} 0 0 1 ${n(w / 2)} 0 L${n(w)} 0 L${n(w)} ${n(h / 2)} ` +
          `A${n(w / 2)} ${n(h / 2)} 0 0 1 ${n(w / 2)} ${n(h)} A${n(w / 2)} ${n(h / 2)} 0 0 1 0 ${n(h / 2)} Z`,
      );
    case 'moon': {
      const inner = w * (1 - a('adj', 50000) / 100000);
      return one(`M${n(w)} 0 A${n(w)} ${n(h / 2)} 0 0 0 ${n(w)} ${n(h)} A${n(inner)} ${n(h / 2)} 0 0 1 ${n(w)} 0 Z`);
    }
    case 'sun': {
      const rays: string[] = [];
      for (let i = 0; i < 8; i++) {
        const ang = (i * Math.PI) / 4;
        const base = (d: number) =>
          [w / 2 + w * 0.3 * Math.cos(ang + d), h / 2 + h * 0.3 * Math.sin(ang + d)] as [number, number];
        const tip: [number, number] = [w / 2 + (w / 2) * Math.cos(ang), h / 2 + (h / 2) * Math.sin(ang)];
        rays.push(poly([base(-0.28), tip, base(0.28)]));
      }
      const cx = w / 2;
      const cy = h / 2;
      const rx = w * 0.25;
      const ry = h * 0.25;
      rays.push(
        `M${n(cx - rx)} ${n(cy)} a${n(rx)} ${n(ry)} 0 1 0 ${n(2 * rx)} 0 a${n(rx)} ${n(ry)} 0 1 0 ${n(-2 * rx)} 0 Z`,
      );
      return rays.map((d) => ({ d, fill: true, stroke: true }));
    }
    case 'lightningBolt':
      return one(
        poly([
          [0.39 * w, 0],
          [0.6 * w, 0.28 * h],
          [0.51 * w, 0.31 * h],
          [0.77 * w, 0.56 * h],
          [0.68 * w, 0.59 * h],
          [w, h],
          [0.44 * w, 0.7 * h],
          [0.54 * w, 0.66 * h],
          [0.25 * w, 0.45 * h],
          [0.33 * w, 0.42 * h],
          [0, 0.16 * h],
        ]),
      );
    case 'cloud': {
      const pts: [number, number][] = [];
      for (let i = 0; i < 8; i++) {
        const ang = (i * Math.PI) / 4 + Math.PI / 8;
        pts.push([w / 2 + 0.42 * w * Math.cos(ang), h / 2 + 0.36 * h * Math.sin(ang)]);
      }
      const r = Math.min(w, h) * 0.2;
      let d = `M${n(pts[0][0])} ${n(pts[0][1])}`;
      for (let i = 1; i <= 8; i++) {
        const [x, y] = pts[i % 8];
        d += ` A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y)}`;
      }
      return one(`${d} Z`);
    }
    case 'wave':
      return one(wave(1, w, h, (h * a('adj1', 12500)) / 100000));
    case 'doubleWave':
      return one(wave(2, w, h, (h * a('adj1', 12500)) / 100000));
    case 'foldedCorner': {
      const f = (ss * a('adj', 16667)) / 100000;
      return [
        {
          d: poly([
            [0, 0],
            [w, 0],
            [w, h - f],
            [w - f, h],
            [0, h],
          ]),
          fill: true,
          stroke: true,
        },
        { d: `M${n(w - f)} ${n(h)} L${n(w - f)} ${n(h - f)} L${n(w)} ${n(h - f)}`, fill: false, stroke: true },
      ];
    }
    case 'cube': {
      const t = (ss * a('adj', 25000)) / 100000;
      return [
        {
          d: poly([
            [0, t],
            [w - t, t],
            [w - t, h],
            [0, h],
          ]),
          fill: true,
          stroke: true,
        },
        {
          d: poly([
            [0, t],
            [t, 0],
            [w, 0],
            [w - t, t],
          ]),
          fill: true,
          stroke: true,
        },
        {
          d: poly([
            [w - t, t],
            [w, 0],
            [w, h - t],
            [w - t, h],
          ]),
          fill: true,
          stroke: true,
        },
      ];
    }
    case 'mathPlus': {
      const t = (ss * a('adj1', 23520)) / 100000;
      const x = (w - t) / 2;
      const y = (h - t) / 2;
      return one(
        poly([
          [x, 0],
          [x + t, 0],
          [x + t, y],
          [w, y],
          [w, y + t],
          [x + t, y + t],
          [x + t, h],
          [x, h],
          [x, y + t],
          [0, y + t],
          [0, y],
          [x, y],
        ]),
      );
    }
    case 'mathMinus': {
      const t = (h * a('adj1', 23520)) / 100000;
      return one(
        poly([
          [0, (h - t) / 2],
          [w, (h - t) / 2],
          [w, (h + t) / 2],
          [0, (h + t) / 2],
        ]),
      );
    }
    case 'mathEqual': {
      const t = (h * a('adj1', 23520)) / 100000;
      const gap = (h * a('adj2', 11760)) / 100000;
      const top = h / 2 - gap / 2 - t;
      return [
        {
          d: poly([
            [0, top],
            [w, top],
            [w, top + t],
            [0, top + t],
          ]),
          fill: true,
          stroke: true,
        },
        {
          d: poly([
            [0, h / 2 + gap / 2],
            [w, h / 2 + gap / 2],
            [w, h / 2 + gap / 2 + t],
            [0, h / 2 + gap / 2 + t],
          ]),
          fill: true,
          stroke: true,
        },
      ];
    }
    case 'mathMultiply': {
      const t = (ss * a('adj1', 23520)) / 100000 / 1.2;
      const cx = w / 2;
      const cy = h / 2;
      const pts: [number, number][] = [
        [-t / 2, -h / 2],
        [t / 2, -h / 2],
        [t / 2, -t / 2],
        [w / 2, -t / 2],
        [w / 2, t / 2],
        [t / 2, t / 2],
        [t / 2, h / 2],
        [-t / 2, h / 2],
        [-t / 2, t / 2],
        [-w / 2, t / 2],
        [-w / 2, -t / 2],
        [-t / 2, -t / 2],
      ];
      const c45 = Math.SQRT1_2;
      return one(poly(pts.map(([x, y]): [number, number] => [cx + (x * c45 - y * c45), cy + (x * c45 + y * c45)])));
    }
    default:
      return null;
  }
}

/** A connector or line: its path from corner to corner (`straight`, `bent`, `curved`). */
export function linePath(prst: string, w: number, h: number): string {
  if (/^bentConnector[345]$/.test(prst) || prst === 'bentConnector2') {
    return prst === 'bentConnector2'
      ? `M0 0 L${n(w)} 0 L${n(w)} ${n(h)}`
      : `M0 0 L${n(w / 2)} 0 L${n(w / 2)} ${n(h)} L${n(w)} ${n(h)}`;
  }
  if (/^curvedConnector\d$/.test(prst)) return `M0 0 C${n(w / 2)} 0 ${n(w / 2)} ${n(h)} ${n(w)} ${n(h)}`;
  return `M0 0 L${n(w)} ${n(h)}`;
}

type Pt = { x: number; y: number };

/**
 * A custom geometry's paths, scaled from the path's own coordinate space to the box.
 * @param custGeom - The `a:custGeom` element.
 * @param w - Box width in px.
 * @param h - Box height in px.
 */
export function customPaths(custGeom: Element, w: number, h: number): PathPart[] {
  const out: PathPart[] = [];
  const kids = (el: Element, tag: string) => Array.from(el.children).filter((c) => c.localName === tag);
  const lst = kids(custGeom, 'pathLst')[0];
  for (const path of kids(lst ?? custGeom, 'path')) {
    const pw = Number(path.getAttribute('w')) || w;
    const ph = Number(path.getAttribute('h')) || h;
    const sx = w / pw;
    const sy = h / ph;
    const pt = (el: Element): Pt => ({ x: Number(el.getAttribute('x')) * sx, y: Number(el.getAttribute('y')) * sy });
    let d = '';
    let cur: Pt = { x: 0, y: 0 };
    for (const cmd of Array.from(path.children)) {
      const pts = kids(cmd, 'pt').map(pt);
      switch (cmd.localName) {
        case 'moveTo':
          cur = pts[0];
          d += `M${n(cur.x)} ${n(cur.y)} `;
          break;
        case 'lnTo':
          cur = pts[0];
          d += `L${n(cur.x)} ${n(cur.y)} `;
          break;
        case 'cubicBezTo':
          d += `C${pts.map((p) => `${n(p.x)} ${n(p.y)}`).join(' ')} `;
          cur = pts[2];
          break;
        case 'quadBezTo':
          d += `Q${pts.map((p) => `${n(p.x)} ${n(p.y)}`).join(' ')} `;
          cur = pts[1];
          break;
        case 'arcTo': {
          const wr = Number(cmd.getAttribute('wR')) * sx;
          const hr = Number(cmd.getAttribute('hR')) * sy;
          const st = (Number(cmd.getAttribute('stAng')) / 60000) * (Math.PI / 180);
          const sw = (Number(cmd.getAttribute('swAng')) / 60000) * (Math.PI / 180);
          const t1 = Math.atan2(wr * Math.sin(st), hr * Math.cos(st));
          const t2 = Math.atan2(wr * Math.sin(st + sw), hr * Math.cos(st + sw));
          const cx = cur.x - wr * Math.cos(t1);
          const cy = cur.y - hr * Math.sin(t1);
          cur = { x: cx + wr * Math.cos(t2), y: cy + hr * Math.sin(t2) };
          d += `A${n(wr)} ${n(hr)} 0 ${Math.abs(sw) > Math.PI ? 1 : 0} ${sw > 0 ? 1 : 0} ${n(cur.x)} ${n(cur.y)} `;
          break;
        }
        case 'close':
          d += 'Z ';
          break;
        default:
      }
    }
    if (d) {
      out.push({
        d: d.trim(),
        fill: path.getAttribute('fill') !== 'none',
        stroke: path.getAttribute('stroke') !== '0',
      });
    }
  }
  return out;
}
