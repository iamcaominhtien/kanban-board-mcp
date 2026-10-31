import { expect, test } from 'vitest';
import { diffCounts, lineDiff } from './lineDiff';

test('a changed line is shown as removed and added, the rest as it was', () => {
  const rows = lineDiff(
    '<main>\n<p class="err">Wrong</p>\n<button>Go</button>\n</main>',
    '<main>\n<input>\n<p class="err">Wrong</p>\n<button>Go</button>\n</main>',
  );
  expect(rows.map((r) => r.t + r.s)).toEqual([
    ' <main>',
    '+<input>',
    ' <p class="err">Wrong</p>',
    ' <button>Go</button>',
    ' </main>',
  ]);
  expect(diffCounts(lineDiff('a\nb\nc', 'a\nB\nc'))).toEqual({ added: 1, removed: 1 });
  expect(diffCounts(lineDiff('same', 'same'))).toEqual({ added: 0, removed: 0 });
});
