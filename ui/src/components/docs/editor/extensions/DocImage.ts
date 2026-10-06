import Image from '@tiptap/extension-image';

/** Image whose width round-trips as `![alt|480](url)`. */
export const DocImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => {
          const w = el.getAttribute('width') ?? el.style.width;
          return w ? parseInt(w, 10) || null : null;
        },
        renderHTML: (attrs) => (attrs.width ? { width: attrs.width, style: `width:${attrs.width}px;max-width:100%;height:auto` } : {}),
      },
    };
  },

  parseMarkdown(token, h) {
    const raw = (token as unknown as { text?: string }).text ?? '';
    const m = /^(.*?)\s*\|\s*(?:width=)?(\d+)(?:px)?(?:x\d+(?:px)?)?$/i.exec(raw);
    const t = token as unknown as { href: string; title?: string | null };
    return h.createNode('image', {
      src: t.href,
      title: t.title ?? null,
      alt: m ? m[1] : raw,
      width: m ? parseInt(m[2], 10) : null,
    });
  },

  renderMarkdown(node) {
    const a = node.attrs ?? {};
    const alt = `${a.alt ?? ''}${a.width ? `|${a.width}` : ''}`;
    return `![${alt}](${a.src ?? ''}${a.title ? ` "${a.title}"` : ''})`;
  },
}).configure({ inline: false, allowBase64: false });
