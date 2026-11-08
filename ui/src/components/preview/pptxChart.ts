/** A chart of a slide as plain data (bar, column, line, area, pie, doughnut, scatter), read from the chart part. */

export interface ChartSeries {
  name: string;
  values: number[];
  xs?: number[];
  color: string;
  pointColors: string[];
  labels: boolean;
}

export interface ChartModel {
  kind: 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter';
  horizontal: boolean;
  grouping: 'clustered' | 'stacked' | 'percent';
  title: string;
  legend: 'none' | 'b' | 'r' | 't' | 'l';
  categories: string[];
  series: ChartSeries[];
  min?: number;
  max?: number;
  gridlines: boolean;
  format: string;
  holeRatio: number;
  smooth: boolean;
  /** Colours for the points of a pie and for series that name none. */
  palette: string[];
}

const attr = (el: Element | null | undefined, name: string) => el?.getAttribute(name) ?? '';
const all = (el: Element | Document, tag: string) => Array.from(el.getElementsByTagNameNS('*', tag));
const kids = (el: Element | null | undefined, tag: string) =>
  Array.from(el?.children ?? []).filter((c) => c.localName === tag);
const first = (el: Element | null | undefined, tag: string): Element | null => kids(el, tag)[0] ?? null;

/** The values of a chart's reference by its formula (`Sheet1!$B$2:$B$5`), for a chart that carries no cached values. */
export type RefLookup = (formula: string) => string[];

function cache(ref: Element | null | undefined, lookup?: RefLookup): string[] {
  if (!ref) return [];
  const pts = all(ref, 'pt');
  if (!pts.length && lookup) {
    const f = all(ref, 'f')[0]?.textContent?.trim();
    if (f) return lookup(f);
  }
  const count = Number(attr(all(ref, 'ptCount')[0], 'val')) || pts.length;
  const out: string[] = Array.from({ length: count }, () => '');
  for (const p of pts) out[Number(attr(p, 'idx'))] = first(p, 'v')?.textContent ?? '';
  return out;
}

function richText(el: Element | null | undefined): string {
  return el
    ? all(el, 'p')
        .map((p) =>
          all(p, 't')
            .map((t) => t.textContent ?? '')
            .join(''),
        )
        .join(' ')
        .trim()
    : '';
}

/**
 * Read a chart part.
 * @param doc - The chart XML.
 * @param fillOf - Reads a `spPr` / `solidFill` element into a CSS colour ('' when there is none).
 * @param palette - Colours for series that name none (the theme's accents).
 */
export function parseChart(
  doc: Document,
  fillOf: (spPr: Element | null | undefined) => string,
  palette: string[],
  lookup?: RefLookup,
): ChartModel | null {
  const plot = all(doc, 'plotArea')[0];
  if (!plot) return null;
  const type = Array.from(plot.children).find((c) =>
    /^(bar|bar3D|line|line3D|area|area3D|pie|pie3D|doughnut|scatter|ofPie)Chart$/.test(c.localName),
  );
  if (!type) return null;
  const base = type.localName.replace(/3D$/, '').replace('Chart', '').replace(/3D/, '');
  const kind: ChartModel['kind'] =
    base === 'bar' || base === 'line' || base === 'area' || base === 'doughnut' || base === 'scatter' ? base : 'pie';
  const grouping = attr(first(type, 'grouping'), 'val');
  const series: ChartSeries[] = kids(type, 'ser').map((ser, i) => {
    const catRef = first(ser, 'cat') ?? first(ser, 'xVal');
    const valRef = first(ser, 'val') ?? first(ser, 'yVal');
    const values = cache(valRef, lookup).map((v) => Number(v) || 0);
    const color = fillOf(first(ser, 'spPr')) || palette[i % palette.length];
    const pointColors: string[] = [];
    for (const dPt of kids(ser, 'dPt'))
      pointColors[Number(attr(first(dPt, 'idx'), 'val'))] = fillOf(first(dPt, 'spPr'));
    const dl = first(ser, 'dLbls') ?? first(type, 'dLbls');
    return {
      name: cache(first(ser, 'tx'), lookup).join('') || richText(first(ser, 'tx')) || `Series ${i + 1}`,
      values,
      xs: kind === 'scatter' ? cache(catRef, lookup).map((v) => Number(v) || 0) : undefined,
      color,
      pointColors,
      labels: attr(first(dl, 'showVal'), 'val') === '1',
    };
  });
  const firstSer = kids(type, 'ser')[0];
  const categories = kind === 'scatter' ? [] : cache(first(firstSer, 'cat'), lookup);
  const valAx = all(plot, 'valAx')[0];
  const scaling = first(valAx, 'scaling');
  const min = first(scaling, 'min');
  const max = first(scaling, 'max');
  const legendEl = all(doc, 'legend')[0];
  const legendPos = attr(first(legendEl, 'legendPos'), 'val') || (legendEl ? 'r' : '');
  return {
    kind,
    horizontal: attr(first(type, 'barDir'), 'val') === 'bar',
    grouping: grouping === 'stacked' ? 'stacked' : grouping === 'percentStacked' ? 'percent' : 'clustered',
    title: richText(all(doc, 'title')[0]),
    legend: (['b', 'r', 't', 'l'].includes(legendPos) ? legendPos : 'none') as ChartModel['legend'],
    categories,
    series,
    min: min ? Number(attr(min, 'val')) : undefined,
    max: max ? Number(attr(max, 'val')) : undefined,
    gridlines: !!first(valAx, 'majorGridlines'),
    format: attr(first(valAx, 'numFmt'), 'formatCode') || attr(all(type, 'numFmt')[0], 'formatCode') || 'General',
    holeRatio: (Number(attr(first(type, 'holeSize'), 'val')) || 50) / 100,
    smooth: attr(first(first(type, 'ser'), 'smooth'), 'val') === '1',
    palette,
  };
}

/** A number as a chart label under an Excel-style format code (decimals, thousands, percent). */
export function formatValue(v: number, code: string): string {
  const section = code.split(';')[0];
  if (!section || section === 'General') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  const percent = section.includes('%');
  const value = percent ? v * 100 : v;
  const decimals = /\.(0+)/.exec(section)?.[1].length ?? 0;
  const text = value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: section.includes(','),
  });
  const prefix = /^[^#0.,]*/.exec(section.replace(/"/g, ''))?.[0] ?? '';
  return `${prefix.replace(/\\/g, '').trim() ? prefix.replace(/\\/g, '') : ''}${text}${percent ? '%' : ''}`;
}
