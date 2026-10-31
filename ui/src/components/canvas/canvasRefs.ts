export const CANVAS_SCHEME = 'canvas:';

const REF = /^canvas:(cv_[0-9a-f]{8})(?:#((?:b|p)_[0-9a-f]{8}))?$/;

/** A canvas address inside a text: the canvas, and optionally one board (`b_…`) or one page tab (`p_…`). */
export interface CanvasRef {
  id: string;
  boardId?: string;
  pageId?: string;
}

/**
 * The canvas in a `canvas:cv_…` image or link address, or null when it is something else.
 * @param href - A markdown link or image address.
 */
export function canvasRefOf(href: string | undefined | null): CanvasRef | null {
  const m = REF.exec((href ?? '').trim());
  if (!m) return null;
  const frag = m[2];
  return {
    id: m[1],
    boardId: frag?.startsWith('b_') ? frag : undefined,
    pageId: frag?.startsWith('p_') ? frag : undefined,
  };
}

interface HastNode {
  type?: string;
  tagName?: string;
  properties?: { href?: unknown; src?: unknown };
  children?: HastNode[];
}

/**
 * Whether a rendered paragraph holds a canvas card (a block must not sit inside a `<p>`). Only the image form is a
 * card; the link form stays a chip in the line.
 * @param node - The paragraph's hast node.
 */
export function hasCanvas(node: HastNode | undefined): boolean {
  return !!node?.children?.some(
    (c) => c.type === 'element' && c.tagName === 'img' && canvasRefOf(String(c.properties?.src ?? '')),
  );
}

/** The markdown matcher for a whole line that is one canvas card: `![label](canvas:cv_…[#b_…])`. */
export const CANVAS_LINE = /^!\[([^\]\n]*)\]\(canvas:(cv_[0-9a-f]{8})(?:#((?:b|p)_[0-9a-f]{8}))?\)[ \t]*$/;

/**
 * Turn each canvas card in a markdown text into a plain image of its overview PNG in the uploads folder, for an
 * export: `![Name](canvas:cv_…)` becomes `![Name](/uploads/canvases/cv_…/overview.png)`, which every markdown reader
 * can show once the data folder is next to it. The chip form becomes plain text.
 * @param markdown - The text.
 */
export function canvasesAsImages(markdown: string): string {
  return markdown
    .replace(
      /!\[([^\]\n]*)\]\(canvas:(cv_[0-9a-f]{8})(?:#(?:b|p)_[0-9a-f]{8})?\)/g,
      '![$1](/uploads/canvases/$2/overview.png)',
    )
    .replace(/(?<!!)\[([^\]\n]*)\]\(canvas:cv_[0-9a-f]{8}(?:#(?:b|p)_[0-9a-f]{8})?\)/g, '$1');
}

/** Whether a markdown text holds any canvas. */
export function hasCanvasRef(markdown: string): boolean {
  return /\(canvas:cv_[0-9a-f]{8}/.test(markdown);
}
