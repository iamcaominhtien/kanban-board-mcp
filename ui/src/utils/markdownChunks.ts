/**
 * Cut a long Markdown page into pieces that can be rendered one after the other (DocsMarkdown, progressive): the
 * first piece shows at once and the rest follow frame by frame, so a 4,000-line page shows its top in a moment and
 * never blocks the page for a second.
 *
 * A piece only ever ends right before a heading (`#`, `##`, `###`) that is not inside a code fence or a `$$` math
 * block, which is where a Markdown block always ends: a list, a quote, a table or a paragraph cannot run across it.
 * A page with reference-style link or footnote definitions is not cut (a definition in one piece would not reach a
 * use in another).
 */

export interface MarkdownChunk {
  /** The piece, preceded by as many empty lines as come before it, so the line numbers of its nodes are the page's. */
  text: string;
  /** Line (0-based) of the page the piece starts at. */
  start: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,3}\s/;
const DEFINITION = /^ {0,3}\[[^\]\n]+\]:\s/m;

/**
 * Split `markdown` into pieces of about `size` lines (the first one about `first` lines).
 * @param markdown - The page.
 * @param first - Lines of the first piece, the part that shows at once.
 * @param size - Lines of each later piece.
 * @returns At least one piece; one piece holding everything when the page is short or cannot be cut.
 */
export function splitMarkdown(markdown: string, first = 120, size = 220): MarkdownChunk[] {
  const lines = markdown.split('\n');
  if (lines.length <= first + size / 2 || DEFINITION.test(markdown)) return [{ text: markdown, start: 0 }];
  const cuts: number[] = [];
  let fence: string | null = null;
  let math = false;
  let from = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (line.trim() === '$$') {
      math = !math;
      continue;
    }
    if (math) continue;
    const want = cuts.length ? size : first;
    if (i - from >= want && HEADING.test(line)) {
      cuts.push(i);
      from = i;
    }
  }
  // a short last piece goes with the one before it
  if (cuts.length && lines.length - cuts[cuts.length - 1] < size / 4) cuts.pop();
  const starts = [0, ...cuts];
  return starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    return { start, text: '\n'.repeat(start) + lines.slice(start, end).join('\n') };
  });
}
