/**
 * The marks format 1 adds: underline, superscript, subscript and `textStyle` (colour, font, size). Plain Markdown has
 * no syntax for them, so they write nothing there and the text stays (README.md, "The two Markdown flavours").
 */

import { Mark, mergeAttributes } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import { dataAttr } from './attr';

/** A mark shown as one HTML element (`u`, `sup`, `sub`), with no Markdown of its own. */
function tagMark(name: string, tag: string) {
  return Mark.create({
    name,
    parseHTML: () => [{ tag }],
    renderHTML: ({ HTMLAttributes }) => [tag, mergeAttributes(HTMLAttributes), 0],
  });
}

/** Underlined text (`<u>`). */
export const Underline = tagMark('underline', 'u');

/** Superscript (`<sup>`); excludes subscript. */
export const Superscript = tagMark('superscript', 'sup').extend({ excludes: 'subscript' });

/** Subscript (`<sub>`); excludes superscript. */
export const Subscript = tagMark('subscript', 'sub').extend({ excludes: 'superscript' });

/** Text colour (a palette name or `#rrggbb`), font (a schema.json font key) and size (px), on a `<span>`. */
export const TextStyle = Mark.create({
  name: 'textStyle',

  addAttributes() {
    return {
      color: dataAttr('color', null),
      fontFamily: dataAttr('fontFamily', null),
      fontSize: dataAttr('fontSize', null, 'json'),
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span',
        getAttrs: (el) =>
          el.hasAttribute('data-color') || el.hasAttribute('data-font-family') || el.hasAttribute('data-font-size')
            ? {}
            : false,
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
});

/**
 * The highlight with a colour (format 1): a palette name or `#rrggbb` in `data-color`, `null` for the default yellow.
 * Plain Markdown writes `==text==` whatever the colour.
 */
export const RichHighlight = Highlight.extend({
  addAttributes() {
    return { color: dataAttr('color', null) };
  },
}).configure({ multicolor: true });
