export const SKETCH_SCHEME = 'sketch:';

const ID = /^sketch:(sk_[0-9a-f]{8})$/;

/**
 * The sketch id in a `sketch:sk_…` image or link address, or null when it is something else.
 * @param href - A markdown link or image address.
 */
export function sketchIdOf(href: string | undefined | null): string | null {
  return ID.exec((href ?? '').trim())?.[1] ?? null;
}

interface HastNode {
  type?: string;
  tagName?: string;
  properties?: { href?: unknown; src?: unknown };
  children?: HastNode[];
}

/**
 * Whether a rendered paragraph holds a sketch (a block must not sit inside a `<p>`).
 * @param node - The paragraph's hast node.
 */
export function hasSketch(node: HastNode | undefined): boolean {
  return !!node?.children?.some(
    (c) =>
      c.type === 'element' &&
      ((c.tagName === 'a' && sketchIdOf(String(c.properties?.href ?? ''))) ||
        (c.tagName === 'img' && sketchIdOf(String(c.properties?.src ?? '')))),
  );
}

/** The markdown matcher for a whole line that is one sketch: `![label](sketch:sk_…)` or the link form. */
export const SKETCH_LINE = /^!?\[([^\]\n]*)\]\(sketch:(sk_[0-9a-f]{8})\)[ \t]*$/;

/**
 * Turn each sketch in a markdown text into a plain image of its PNG in the uploads folder, for an export:
 * `![Name](sketch:sk_…)` becomes `![Name](/uploads/sketches/sk_….png)`, which every markdown reader can show
 * once the data folder is next to it.
 * @param markdown - The text.
 */
export function sketchesAsImages(markdown: string): string {
  return markdown.replace(/(!?)\[([^\]\n]*)\]\(sketch:(sk_[0-9a-f]{8})\)/g, '![$2](/uploads/sketches/$3.png)');
}
