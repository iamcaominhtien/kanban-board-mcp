/** One piece of a word-level diff. */
export interface DiffSeg {
  kind: 'same' | 'del' | 'add';
  text: string;
}

const MAX_TOKENS = 1600;

function tokens(text: string): string[] {
  return text.split(/(\s+)/).filter((t) => t !== '');
}

/**
 * Word-level diff of two texts (longest common subsequence), so a draft can show what changed: removed words struck
 * through, added words marked. Whitespace stays with the words. Very long texts fall back to "all removed, all added".
 * @param before - The text as it is now.
 * @param after - The text the AI wrote.
 */
export function wordDiff(before: string, after: string): DiffSeg[] {
  const a = tokens(before);
  const b = tokens(after);
  if (before === after) return before ? [{ kind: 'same', text: before }] : [];
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return [
      ...(before ? [{ kind: 'del' as const, text: before }] : []),
      ...(after ? [{ kind: 'add' as const, text: after }] : []),
    ];
  }
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: length of the common subsequence of a[i..] and b[j..]
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffSeg[] = [];
  const push = (kind: DiffSeg['kind'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push('del', a[i++]);
    } else {
      push('add', b[j++]);
    }
  }
  while (i < n) push('del', a[i++]);
  while (j < m) push('add', b[j++]);
  return out;
}
