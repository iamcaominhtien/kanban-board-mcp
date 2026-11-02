/**
 * The editor's Align buttons store a centred or right-aligned block as
 *
 *     ::: center          ::: right
 *     text                text
 *     :::                 :::
 *
 * (utils/markdownWysiwyg.ts). The viewer splits the Markdown on those lines the same way the editor reads them:
 * line by line, never inside a fenced code block, an unclosed block running to the end.
 */

export type Align = 'center' | 'right';

export interface AlignSegment {
  /** null: plain Markdown between aligned blocks. */
  align: Align | null;
  markdown: string;
}

const FENCE = /^\s*(```|~~~)/;

/** Splits Markdown into plain and aligned parts; one plain part when there is no aligned block. */
export function splitAlignBlocks(markdown: string): AlignSegment[] {
  const out: AlignSegment[] = [];
  let current: string[] = [];
  let align: Align | null = null;
  let fence: string | null = null;

  const flush = () => {
    const md = current.join('\n');
    if (align || md.trim()) out.push({ align, markdown: md });
    current = [];
  };

  for (const line of markdown.split('\n')) {
    const f = FENCE.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1] === fence) fence = null;
      current.push(line);
      continue;
    }
    if (!fence) {
      const t = line.trim();
      if (!align && (t === '::: center' || t === '::: right')) {
        flush();
        align = t === '::: center' ? 'center' : 'right';
        continue;
      }
      if (align && t === ':::') {
        flush();
        align = null;
        continue;
      }
    }
    current.push(line);
  }
  flush();
  return out.length ? out : [{ align: null, markdown: '' }];
}

/** The same text without the alignment lines, for one-line places (chips, previews) that cannot align. */
export function stripAlignMarkers(markdown: string): string {
  return splitAlignBlocks(markdown)
    .map((s) => s.markdown)
    .join('\n');
}
