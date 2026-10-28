/** `$formula$` the way Pandoc reads it: no space inside the delimiters and no digit right after the closing one. */
const INLINE_MATH = /\$(?!\s|\$)(?:\\.|[^$\\\n])+?(?<!\s)\$(?!\d)/y;

function escapeInLine(line: string): string {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      out += ch + (line[i + 1] ?? '');
      i++;
    } else if (ch === '$' && line[i + 1] === '$') {
      out += '$$';
      i++;
    } else if (ch === '$') {
      INLINE_MATH.lastIndex = i;
      const m = INLINE_MATH.exec(line);
      if (m) {
        out += m[0];
        i += m[0].length - 1;
      } else {
        out += '\\$';
      }
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Escape `$` signs that do not open a formula (prices like "$5 and $6"), so the reader shows them as text,
 * matching the editor. Code (fenced or inline) and `$$` blocks are left untouched.
 * @param markdown - Page markdown.
 * @returns Markdown where stray dollar signs are written as `\$`.
 */
export function escapeStrayDollars(markdown: string): string {
  let fence: string | null = null;
  let display = false;
  return markdown
    .split('\n')
    .map((line) => {
      const f = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
        return line;
      }
      if (f) {
        fence = f;
        return line;
      }
      if (display || line.trimStart().startsWith('$$')) {
        if ((line.match(/\$\$/g) ?? []).length % 2 === 1) display = !display;
        return line;
      }
      return line
        .split(/(`+)([\s\S]*?)\1/)
        .map((part, idx, parts) => {
          // split() with two groups yields [text, ticks, code, text, ...]: only the text slots are escaped
          if (idx % 3 === 0) return escapeInLine(part);
          if (idx % 3 === 1) return part;
          return part + (parts[idx - 1] ?? '');
        })
        .join('');
    })
    .join('\n');
}
