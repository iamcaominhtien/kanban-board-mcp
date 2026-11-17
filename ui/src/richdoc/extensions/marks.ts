/**
 * The marks format 1 adds: underline, superscript, subscript and `textStyle` (colour, font, size). Plain Markdown has
 * no syntax for them, so they write nothing there and the text stays (README.md, "The two Markdown flavours").
 */

import { Mark, mergeAttributes, type Attribute } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import { cssColor } from '../../components/docs/editor/ribbon/palette';
import { FONT_FAMILY, type PageFont } from '../../components/docs/pageSettings';
import { dataAttr, type AttrKind } from './attr';

/**
 * `dataAttr` that also draws the value: the `data-*` attribute is what is read back, the inline style is what the
 * editor shows (a palette name through its page variable, so it follows the page background).
 * @param name - The attribute.
 * @param kind - How `data-*` stores it.
 * @param css - The CSS declaration for a value, or null to draw nothing.
 */
function styledAttr(name: string, kind: AttrKind, css: (v: unknown) => string | null): Attribute {
  const base = dataAttr(name, null, kind);
  return {
    ...base,
    renderHTML: (attrs) => {
      const out = (base.renderHTML?.(attrs) ?? {}) as Record<string, unknown>;
      const decl = attrs[name] == null ? null : css(attrs[name]);
      return decl ? { ...out, style: decl } : out;
    },
  };
}

const colorCss = (kind: 'text' | 'highlight') => (v: unknown) => {
  const c = cssColor(kind, v);
  return c ? `${kind === 'text' ? 'color' : 'background-color'}: ${c}` : null;
};

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
      color: styledAttr('color', 'string', colorCss('text')),
      fontFamily: styledAttr('fontFamily', 'string', (v) =>
        typeof v === 'string' && v in FONT_FAMILY ? `font-family: ${FONT_FAMILY[v as PageFont]}` : null,
      ),
      fontSize: styledAttr('fontSize', 'json', (v) =>
        typeof v === 'number' && Number.isFinite(v) ? `font-size: ${v}px` : null,
      ),
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
    return { color: styledAttr('color', 'string', colorCss('highlight')) };
  },
}).configure({ multicolor: true });
