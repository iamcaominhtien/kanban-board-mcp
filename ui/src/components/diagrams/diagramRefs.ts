export const DIAGRAM_SCHEME = 'diagram:';

const ID = /^diagram:(dg_[0-9a-f]{8})$/;

/**
 * The diagram id in a `diagram:dg_…` link or image address, or null when it is something else.
 * @param href - A markdown link or image address.
 */
export function diagramIdOf(href: string | undefined | null): string | null {
  return ID.exec((href ?? '').trim())?.[1] ?? null;
}

interface HastNode {
  type?: string;
  tagName?: string;
  properties?: { href?: unknown; src?: unknown };
  children?: HastNode[];
}

/**
 * Whether a rendered paragraph holds a diagram (a block must not sit inside a `<p>`).
 * @param node - The paragraph's hast node.
 */
export function hasDiagram(node: HastNode | undefined): boolean {
  return !!node?.children?.some(
    (c) =>
      c.type === 'element' &&
      ((c.tagName === 'a' && diagramIdOf(String(c.properties?.href ?? ''))) ||
        (c.tagName === 'img' && diagramIdOf(String(c.properties?.src ?? '')))),
  );
}

/** The markdown matcher for a whole line that is one diagram: `[label](diagram:dg_…)` or the image form. */
export const DIAGRAM_LINE = /^!?\[([^\]\n]*)\]\(diagram:(dg_[0-9a-f]{8})\)[ \t]*$/;
