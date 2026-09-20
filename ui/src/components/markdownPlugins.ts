// Small local remark plugins to extend the Markdown dialect used across the
// app (descriptions, comments) beyond plain GFM: `==highlight==` and
// `::: center` / `::: right` alignment blocks. Kept minimal and local rather
// than pulling in a heavier "extended markdown" package.
import { findAndReplace } from 'mdast-util-find-and-replace';
import { visit } from 'unist-util-visit';
import type { PhrasingContent, Root } from 'mdast';
import type { Plugin } from 'unified';

/**
 * Converts `==text==` into a `mark` mdast node that remark-rehype (via the
 * `data.hName` convention for unknown node types) renders as `<mark>text</mark>`.
 * `mark` isn't a real mdast node type, so it's cast through `unknown`.
 */
export const remarkHighlight: Plugin<[], Root> = () => (tree) => {
  findAndReplace(tree, [
    [
      /==([^=\n]+)==/g,
      (_match: string, text: string) =>
        ({
          type: 'mark',
          data: { hName: 'mark' },
          children: [{ type: 'text', value: text }],
        }) as unknown as PhrasingContent,
    ],
  ]);
};

/**
 * Maps `remark-directive` container directives named `center` / `right`
 * (i.e. `::: center` ... `:::`) to a `<div style="text-align: …">` wrapper.
 * `left` is the implicit default and has no directive of its own.
 */
export const remarkAlignDirectives: Plugin<[], Root> = () => (tree) => {
  visit(tree, (node) => {
    if (node.type !== 'containerDirective') return;
    const name = (node as unknown as { name?: string }).name;
    if (name !== 'center' && name !== 'right') return;

    const directiveNode = node as unknown as {
      data?: { hName?: string; hProperties?: Record<string, string> };
    };
    directiveNode.data = {
      ...directiveNode.data,
      hName: 'div',
      hProperties: { style: `text-align: ${name}` },
    };
  });
};
