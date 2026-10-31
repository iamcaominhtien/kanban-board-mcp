export interface DiffRow {
  t: ' ' | '+' | '-';
  s: string;
}

/**
 * A line diff of two texts (longest common subsequence), for "Changed lines are highlighted in the source".
 * Long files fall back to a coarse prefix/suffix diff so the page stays quick.
 * @param a - The text before.
 * @param b - The text after.
 */
export function lineDiff(a: string, b: string): DiffRow[] {
  const x = a.split('\n');
  const y = b.split('\n');
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const mx = x.slice(head, x.length - tail);
  const my = y.slice(head, y.length - tail);
  const rows: DiffRow[] = x.slice(0, head).map((s) => ({ t: ' ', s }));
  if (mx.length * my.length > 4_000_000) {
    rows.push(...mx.map((s) => ({ t: '-' as const, s })), ...my.map((s) => ({ t: '+' as const, s })));
  } else {
    const n = mx.length;
    const m = my.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i][j] = mx[i] === my[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (mx[i] === my[j]) {
        rows.push({ t: ' ', s: mx[i] });
        i++;
        j++;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) rows.push({ t: '-', s: mx[i++] });
      else rows.push({ t: '+', s: my[j++] });
    }
    while (i < n) rows.push({ t: '-', s: mx[i++] });
    while (j < m) rows.push({ t: '+', s: my[j++] });
  }
  rows.push(...x.slice(x.length - tail).map((s) => ({ t: ' ' as const, s })));
  return rows;
}

/** How many lines were added and removed. */
export function diffCounts(rows: DiffRow[]): { added: number; removed: number } {
  return { added: rows.filter((r) => r.t === '+').length, removed: rows.filter((r) => r.t === '-').length };
}
