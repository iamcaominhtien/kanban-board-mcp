import type { ReactNode } from 'react';
import { formatValue, type ChartModel } from './pptxChart';

const FONT = 'Calibri, Carlito, "Segoe UI", system-ui, sans-serif';
const INK = '#595959';
const GRID = '#d9d9d9';

function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/** Axis ticks over [lo, hi] (hi rounded up to a tick when the chart does not fix it). */
function ticks(lo: number, hi: number, fixedHi: boolean): number[] {
  const step = niceStep((hi - lo) / 5);
  const top = fixedHi ? hi : Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= top + step * 1e-6; v += step) out.push(Math.round(v / step) * step);
  return out;
}

function arc(cx: number, cy: number, r: number, from: number, to: number, hole = 0): string {
  const pt = (rad: number, a: number): [number, number] => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  const large = to - from > Math.PI ? 1 : 0;
  const [x1, y1] = pt(r, from);
  const [x2, y2] = pt(r, to);
  if (!hole) return `M${cx} ${cy} L${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
  const [x3, y3] = pt(r * hole, to);
  const [x4, y4] = pt(r * hole, from);
  return `M${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2} L${x3} ${y3} A${r * hole} ${r * hole} 0 ${large} 0 ${x4} ${y4} Z`;
}

/**
 * A chart drawn as SVG at the size it has on the slide.
 * @param props.chart - The chart read from the file.
 * @param props.width - Width in px.
 * @param props.height - Height in px.
 */
export function ChartCanvas({ chart, width, height }: { chart: ChartModel; width: number; height: number }) {
  const fs = Math.max(11, Math.min(16, height / 22));
  const pie = chart.kind === 'pie' || chart.kind === 'doughnut';
  const legendItems = pie
    ? chart.categories.map((c, i) => ({
        name: c,
        color: chart.series[0]?.pointColors[i] || chart.palette[i % chart.palette.length],
      }))
    : chart.series.map((s) => ({ name: s.name, color: s.color }));
  const legendW =
    chart.legend === 'r' || chart.legend === 'l'
      ? Math.max(0, ...legendItems.map((l) => l.name.length)) * fs * 0.55 + fs * 2.4
      : 0;
  const legendH = chart.legend === 'b' || chart.legend === 't' ? fs * 2.2 : 0;
  const titleH = chart.title ? fs * 2.6 : fs * 0.8;
  const out: ReactNode[] = [];

  // value axis
  const stacked = chart.grouping !== 'clustered' && chart.kind !== 'scatter';
  const cats = Math.max(chart.categories.length, ...chart.series.map((s) => s.values.length), 1);
  const sums = Array.from({ length: cats }, (_, i) =>
    chart.series.reduce((t, s) => t + Math.max(0, s.values[i] ?? 0), 0),
  );
  const flat = chart.series.flatMap((s) => s.values);
  const dataMax = stacked ? (chart.grouping === 'percent' ? 1 : Math.max(...sums, 0)) : Math.max(...flat, 0);
  const dataMin = stacked ? 0 : Math.min(...flat, 0);
  const lo = chart.min ?? dataMin;
  const hiRaw = chart.max ?? dataMax;
  const hi = hiRaw <= lo ? lo + 1 : hiRaw;
  const tickList = ticks(lo, hi, chart.max != null || chart.grouping === 'percent');
  const top = Math.max(hi, tickList[tickList.length - 1] ?? hi);
  const fmt = (v: number) => formatValue(v, chart.grouping === 'percent' ? '0%' : chart.format);
  const axisW = Math.max(...tickList.map((t) => fmt(t).length), 1) * fs * 0.58 + 10;

  const px0 = (chart.legend === 'l' ? legendW : 0) + (pie ? 8 : axisW);
  const px1 = width - (chart.legend === 'r' ? legendW : 0) - fs * 1.8;
  const py0 = titleH + (chart.legend === 't' ? legendH : 0);
  const py1 = height - (chart.legend === 'b' ? legendH : 0) - (pie ? 8 : fs * 2);
  const pw = Math.max(10, px1 - px0);
  const ph = Math.max(10, py1 - py0);

  if (chart.title)
    out.push(
      <text
        key="title"
        x={width / 2}
        y={fs * 1.7}
        textAnchor="middle"
        fontSize={fs * 1.25}
        fontWeight={600}
        fill="#404040"
      >
        {chart.title}
      </text>,
    );

  if (pie) {
    const s = chart.series[0];
    const total = (s?.values ?? []).reduce((t, v) => t + Math.max(0, v), 0) || 1;
    const r = Math.min(pw, ph) / 2 - 4;
    const cx = px0 + pw / 2;
    const cy = py0 + ph / 2;
    let a = -Math.PI / 2;
    (s?.values ?? []).forEach((v, i) => {
      const share = Math.max(0, v) / total;
      if (!share) return;
      const next = a + share * Math.PI * 2;
      const color = s.pointColors[i] || chart.palette[i % chart.palette.length];
      out.push(
        share >= 0.9999 ? (
          <circle key={`p${i}`} cx={cx} cy={cy} r={r} fill={color} stroke="#fff" />
        ) : (
          <path
            key={`p${i}`}
            d={arc(cx, cy, r, a, next, chart.kind === 'doughnut' ? chart.holeRatio : 0)}
            fill={color}
            stroke="#fff"
            strokeWidth={1.5}
          />
        ),
      );
      if (s.labels && share > 0.04) {
        const mid = (a + next) / 2;
        const lr = chart.kind === 'doughnut' ? (r * (1 + chart.holeRatio)) / 2 : r * 0.65;
        out.push(
          <text
            key={`l${i}`}
            x={cx + lr * Math.cos(mid)}
            y={cy + lr * Math.sin(mid) + fs * 0.35}
            textAnchor="middle"
            fontSize={fs}
            fill="#fff"
            fontWeight={600}
          >
            {chart.format.includes('%') ? formatValue(share, chart.format) : formatValue(v, chart.format)}
          </text>,
        );
      }
      a = next;
    });
  } else {
    const vy = (v: number) => py1 - ((v - lo) / (top - lo)) * ph;
    const vx = (v: number) => px0 + ((v - lo) / (top - lo)) * pw;
    const horizontal = chart.horizontal && chart.kind === 'bar';
    // grid and value labels
    for (const t of tickList) {
      if (horizontal) {
        const x = vx(t);
        if (chart.gridlines) out.push(<line key={`g${t}`} x1={x} x2={x} y1={py0} y2={py1} stroke={GRID} />);
        out.push(
          <text key={`gl${t}`} x={x} y={py1 + fs * 1.4} textAnchor="middle" fontSize={fs} fill={INK}>
            {fmt(t)}
          </text>,
        );
      } else {
        const y = vy(t);
        if (chart.gridlines) out.push(<line key={`g${t}`} x1={px0} x2={px1} y1={y} y2={y} stroke={GRID} />);
        out.push(
          <text key={`gl${t}`} x={px0 - 6} y={y + fs * 0.35} textAnchor="end" fontSize={fs} fill={INK}>
            {fmt(t)}
          </text>,
        );
      }
    }
    out.push(
      horizontal ? (
        <line key="axis" x1={vx(Math.max(lo, 0))} x2={vx(Math.max(lo, 0))} y1={py0} y2={py1} stroke="#bfbfbf" />
      ) : (
        <line key="axis" x1={px0} x2={px1} y1={vy(Math.max(lo, 0))} y2={vy(Math.max(lo, 0))} stroke="#bfbfbf" />
      ),
    );
    if (chart.kind === 'scatter') {
      const xs = chart.series.flatMap((s) => s.xs ?? []);
      const xTicks = ticks(Math.min(...xs, 0), Math.max(...xs, 1), false);
      const xlo = xTicks[0] ?? 0;
      const xhi = xTicks[xTicks.length - 1] ?? 1;
      const sx = (v: number) => px0 + ((v - xlo) / (xhi - xlo || 1)) * pw;
      for (const t of xTicks)
        out.push(
          <text key={`sx${t}`} x={sx(t)} y={py1 + fs * 1.4} textAnchor="middle" fontSize={fs} fill={INK}>
            {formatValue(t, 'General')}
          </text>,
        );
      chart.series.forEach((s, si) =>
        s.values.forEach((v, i) =>
          out.push(<circle key={`s${si}-${i}`} cx={sx(s.xs?.[i] ?? i)} cy={vy(v)} r={4.5} fill={s.color} />),
        ),
      );
    } else {
      const band = (horizontal ? ph : pw) / cats;
      // category labels
      for (let i = 0; i < cats; i++) {
        const label = chart.categories[i] ?? '';
        const c = (i + 0.5) * band;
        out.push(
          horizontal ? (
            <text key={`c${i}`} x={px0 - 6} y={py1 - c + fs * 0.35} textAnchor="end" fontSize={fs} fill={INK}>
              {label}
            </text>
          ) : (
            <text key={`c${i}`} x={px0 + c} y={py1 + fs * 1.4} textAnchor="middle" fontSize={fs} fill={INK}>
              {label}
            </text>
          ),
        );
      }
      const base = new Array<number>(cats).fill(0);
      chart.series.forEach((s, si) => {
        if (chart.kind === 'bar') {
          const group = band * 0.64;
          const each = stacked ? group : group / chart.series.length;
          s.values.forEach((raw, i) => {
            const v = chart.grouping === 'percent' ? raw / (sums[i] || 1) : raw;
            const from = stacked ? base[i] : Math.max(lo, 0);
            const to = stacked ? base[i] + v : v;
            if (stacked) base[i] += v;
            const off = (band - group) / 2 + (stacked ? 0 : si * each);
            const color = s.pointColors[i] || s.color;
            const a = horizontal ? py1 - (i * band + off + each) : px0 + i * band + off;
            if (horizontal)
              out.push(
                <rect
                  key={`b${si}-${i}`}
                  x={Math.min(vx(from), vx(to))}
                  y={a}
                  width={Math.abs(vx(to) - vx(from))}
                  height={each - 1}
                  fill={color}
                />,
              );
            else
              out.push(
                <rect
                  key={`b${si}-${i}`}
                  x={a}
                  y={Math.min(vy(from), vy(to))}
                  width={each - 1}
                  height={Math.abs(vy(to) - vy(from))}
                  fill={color}
                />,
              );
            if (s.labels)
              out.push(
                horizontal ? (
                  <text key={`bl${si}-${i}`} x={vx(to) + 4} y={a + each / 2 + fs * 0.3} fontSize={fs} fill={INK}>
                    {fmt(v)}
                  </text>
                ) : (
                  <text
                    key={`bl${si}-${i}`}
                    x={a + each / 2}
                    y={vy(to) - 4}
                    textAnchor="middle"
                    fontSize={fs}
                    fill={INK}
                  >
                    {fmt(v)}
                  </text>
                ),
              );
          });
        } else {
          const pts = s.values.map((raw, i): [number, number] => {
            const v = chart.grouping === 'percent' ? raw / (sums[i] || 1) : raw;
            const y = stacked ? base[i] + v : v;
            if (stacked) base[i] += v;
            return [px0 + (i + 0.5) * band, vy(y)];
          });
          if (chart.kind === 'area') {
            const baseY = vy(Math.max(lo, 0));
            out.push(
              <path
                key={`a${si}`}
                d={`M${pts[0]?.[0] ?? px0} ${baseY} ${pts.map(([x, y]) => `L${x} ${y}`).join(' ')} L${pts[pts.length - 1]?.[0] ?? px0} ${baseY} Z`}
                fill={s.color}
                fillOpacity={0.7}
              />,
            );
          } else {
            out.push(
              <polyline
                key={`ln${si}`}
                points={pts.map(([x, y]) => `${x},${y}`).join(' ')}
                fill="none"
                stroke={s.color}
                strokeWidth={2.5}
                strokeLinejoin="round"
              />,
            );
            pts.forEach(([x, y], i) => out.push(<circle key={`m${si}-${i}`} cx={x} cy={y} r={3.5} fill={s.color} />));
          }
          if (s.labels)
            pts.forEach(([x, y], i) =>
              out.push(
                <text key={`ll${si}-${i}`} x={x} y={y - 7} textAnchor="middle" fontSize={fs} fill={INK}>
                  {fmt(s.values[i])}
                </text>,
              ),
            );
        }
      });
    }
  }

  // legend
  if (chart.legend !== 'none' && legendItems.length) {
    const rowH = fs * 1.5;
    legendItems.forEach((l, i) => {
      const vertical = chart.legend === 'r' || chart.legend === 'l';
      const each = fs * 0.55;
      const widths = legendItems.map((it) => it.name.length * each + fs * 2.4);
      const total = widths.reduce((t, x) => t + x, 0);
      const x = vertical
        ? chart.legend === 'l'
          ? 8
          : width - legendW + 4
        : (width - total) / 2 + widths.slice(0, i).reduce((t, x2) => t + x2, 0);
      const y = vertical
        ? height / 2 - (legendItems.length * rowH) / 2 + i * rowH + rowH / 2
        : chart.legend === 't'
          ? titleH + fs * 0.8
          : height - fs * 0.9;
      out.push(
        <g key={`lg${i}`}>
          <rect x={x} y={y - fs * 0.4} width={fs * 0.8} height={fs * 0.8} fill={l.color} />
          <text x={x + fs * 1.1} y={y + fs * 0.35} fontSize={fs} fill={INK}>
            {l.name}
          </text>
        </g>,
      );
    });
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fontFamily={FONT}
      style={{ display: 'block' }}
    >
      {out}
    </svg>
  );
}
