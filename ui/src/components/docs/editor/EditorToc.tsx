import type { Editor } from '@tiptap/react';
import { useEffect, useMemo, useState } from 'react';
import { cleanEditorMarkdown, headingAnchors } from '../../../utils/docsMarkdown';

/**
 * Built-in "On this page" rail for the editor (the caller can pass its own via the toc slot).
 * @param props.editor - Editor whose headings are listed, or `null`.
 * @param props.markdown - Current Markdown the headings are read from.
 */
export function EditorToc({ editor, markdown }: { editor: Editor | null; markdown: string }) {
  const [tick, setTick] = useState(0);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!editor) return;
    let t: ReturnType<typeof setTimeout>;
    const bump = () => {
      clearTimeout(t);
      t = setTimeout(() => setTick((n) => n + 1), 250);
    };
    editor.on('update', bump);
    return () => {
      clearTimeout(t);
      editor.off('update', bump);
    };
  }, [editor]);

  const heads = useMemo(() => {
    void tick;
    return headingAnchors(editor && !editor.isDestroyed ? cleanEditorMarkdown(editor.getMarkdown()) : markdown).filter(
      (h) => h.level <= 3,
    );
  }, [editor, markdown, tick]);

  useEffect(() => {
    if (!editor) return;
    const scroller = editor.view.dom.closest('[data-testid="editor-scroll"]') as HTMLElement | null;
    if (!scroller) return;
    const onScroll = () => {
      let cur: string | null = null;
      editor.view.dom.querySelectorAll('h1[id],h2[id],h3[id]').forEach((h) => {
        if ((h as HTMLElement).getBoundingClientRect().top < scroller.getBoundingClientRect().top + 90) cur = h.id;
      });
      setActive(cur);
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll);
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [editor, heads]);

  if (!heads.length) return null;
  const on = active ?? heads[0].slug;
  return (
    <div style={{ position: 'sticky', top: 0 }} data-testid="editor-toc">
      <span
        style={{
          display: 'block',
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: '#5B6B60',
          paddingBottom: 10,
        }}
      >
        On this page
      </span>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {heads.map((h) => (
          <a
            key={h.slug}
            onClick={() => {
              const el = editor?.view.dom.querySelector(`#${CSS.escape(h.slug)}`);
              el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              minHeight: 28,
              padding: `0 12px 0 ${12 + (h.level - 2 > 0 ? (h.level - 2) * 10 : 0)}px`,
              borderLeft: `2px solid ${h.slug === on ? '#2E6F40' : '#E3E8E5'}`,
              fontSize: 13,
              fontWeight: h.slug === on ? 700 : 500,
              color: h.slug === on ? '#1E2A22' : '#5B6B60',
              lineHeight: 1.3,
              cursor: 'pointer',
            }}
          >
            {h.text}
          </a>
        ))}
      </div>
    </div>
  );
}
