/** Counts of added and removed lines between two texts (LCS on lines; fine for page-sized documents). */
export function lineDiffCounts(before: string, after: string): { added: number; removed: number } {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const x = a.slice(start, endA);
  const y = b.slice(start, endB);
  if (!x.length || !y.length) return { added: y.length, removed: x.length };
  // O(n·m) LCS length with two rows
  let prev = new Array<number>(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array<number>(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      cur[j] = x[i - 1] === y[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  const common = prev[y.length];
  return { added: y.length - common, removed: x.length - common };
}

/** Number of distinct [[page]] references in a markdown text. */
export function countPageRefs(markdown: string): number {
  return new Set(markdown.match(/\[\[[^\]\n]+\]\]/g) ?? []).size;
}
