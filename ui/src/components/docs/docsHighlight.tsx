import type { ReactNode } from 'react';

/** A tiny tokenizer for sh / json / ts / py code blocks, painted with the board's mc-k / mc-s / mc-p / mc-c / mc-f colours. */

type Tok = [cls: string | null, text: string];

const TS_KW = new Set(
  'const let var function return if else for while do switch case break continue new class extends implements interface type enum import export from as default async await try catch finally throw typeof instanceof in of void this super null undefined true false public private protected readonly static'.split(
    ' ',
  ),
);
const PY_KW = new Set(
  'def class return if elif else for while in not and or is import from as with try except finally raise pass break continue lambda yield async await None True False global nonlocal self'.split(
    ' ',
  ),
);

function scan(src: string, rules: [RegExp, (m: RegExpExecArray) => string | null][]): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let plainStart = 0;
  const flush = (end: number) => {
    if (end > plainStart) out.push([null, src.slice(plainStart, end)]);
  };
  while (i < src.length) {
    let hit = false;
    for (const [re, cls] of rules) {
      re.lastIndex = i;
      const m = re.exec(src);
      if (m && m.index === i && m[0].length > 0) {
        const c = cls(m);
        if (c) {
          flush(i);
          out.push([c, m[0]]);
          i += m[0].length;
          plainStart = i;
          hit = true;
          break;
        }
      }
    }
    if (!hit) i += 1;
  }
  flush(src.length);
  return out;
}

function highlightJson(src: string): Tok[] {
  return scan(src, [
    [/"(?:[^"\\\n]|\\.)*"(?=\s*:)/y, () => 'mc-k'],
    [/"(?:[^"\\\n]|\\.)*"/y, () => 'mc-s'],
    [/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b/y, () => 'mc-f'],
  ]);
}

function highlightTs(src: string): Tok[] {
  return scan(src, [
    [/\/\/[^\n]*|\/\*[\s\S]*?\*\//y, () => 'mc-p'],
    [/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y, () => 'mc-s'],
    [/\b\d+(?:\.\d+)?\b/y, () => 'mc-f'],
    [
      /[A-Za-z_$][\w$]*/y,
      (m) =>
        TS_KW.has(m[0])
          ? 'mc-k'
          : /^\s*\(/.test(src.slice(m.index + m[0].length, m.index + m[0].length + 3))
            ? 'mc-f'
            : null,
    ],
  ]);
}

function highlightPy(src: string): Tok[] {
  return scan(src, [
    [/#[^\n]*/y, () => 'mc-p'],
    [/"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/y, () => 'mc-s'],
    [/\b\d+(?:\.\d+)?\b/y, () => 'mc-f'],
    [
      /[A-Za-z_][\w]*/y,
      (m) =>
        PY_KW.has(m[0])
          ? 'mc-k'
          : /^\s*\(/.test(src.slice(m.index + m[0].length, m.index + m[0].length + 3))
            ? 'mc-f'
            : null,
    ],
  ]);
}

function highlightSh(src: string): Tok[] {
  const out: Tok[] = [];
  let cont = false;
  src.split('\n').forEach((line, idx, all) => {
    const toks = scan(line, [
      [/#.*/y, () => 'mc-p'],
      [/"(?:[^"\\]|\\.)*"|'[^']*'/y, () => 's'],
      [/\$\{?\w+\}?/y, () => 'mc-f'],
    ]);
    let expectCmd = !cont;
    for (const [cls, text] of toks) {
      if (cls === null) {
        // split into words so the first word of a command is painted, and pipes/&&/; start a new command
        for (const part of text.split(/(\s+|\|\||&&|\||;)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) out.push([null, part]);
          else if (/^(\|\||&&|\||;)$/.test(part)) {
            out.push([null, part]);
            expectCmd = true;
          } else if (expectCmd && !part.startsWith('-')) {
            out.push(['mc-c', part]);
            expectCmd = false;
          } else {
            out.push([null, part]);
            expectCmd = false;
          }
        }
      } else out.push([cls === 's' ? 'mc-s' : cls, text]);
      if (cls === 's') expectCmd = false;
    }
    cont = /\\\s*$/.test(line);
    if (idx < all.length - 1) out.push([null, '\n']);
  });
  return out;
}

/** Syntax-highlight code for a language into React nodes. */
export function highlight(code: string, lang?: string): ReactNode {
  const l = (lang ?? '').toLowerCase();
  let toks: Tok[];
  if (['sh', 'bash', 'shell', 'zsh', 'console'].includes(l)) toks = highlightSh(code);
  else if (l === 'json' || l === 'jsonc') toks = highlightJson(code);
  else if (['ts', 'tsx', 'typescript', 'js', 'jsx', 'javascript'].includes(l)) toks = highlightTs(code);
  else if (['py', 'python'].includes(l)) toks = highlightPy(code);
  else return code;
  return toks.map(([cls, text], i) =>
    cls ? (
      <span key={i} className={cls}>
        {text}
      </span>
    ) : (
      text
    ),
  );
}
