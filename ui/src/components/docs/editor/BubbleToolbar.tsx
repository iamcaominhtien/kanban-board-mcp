import { useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { NodeSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { Icon } from '../Icon';

interface Props {
  editor: Editor;
  linkOpen: boolean;
  setLinkOpen: (open: boolean) => void;
  ticketPrefix: string;
}

const SEP = <span style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.22)', margin: '0 4px' }} />;
const ON = { background: 'rgba(255,255,255,0.18)' };

function normalizeUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  if (/^(https?:|mailto:|tel:|\/|#)/i.test(v)) return v;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(v)) return `https://${v}`;
  return v;
}

const BLOCKS: { label: string; run: (e: Editor) => void; on: (e: Editor) => boolean }[] = [
  { label: 'Text', run: (e) => e.chain().focus().setParagraph().run(), on: (e) => e.isActive('paragraph') },
  {
    label: 'Heading 1',
    run: (e) => e.chain().focus().setHeading({ level: 1 }).run(),
    on: (e) => e.isActive('heading', { level: 1 }),
  },
  {
    label: 'Heading 2',
    run: (e) => e.chain().focus().setHeading({ level: 2 }).run(),
    on: (e) => e.isActive('heading', { level: 2 }),
  },
  {
    label: 'Heading 3',
    run: (e) => e.chain().focus().setHeading({ level: 3 }).run(),
    on: (e) => e.isActive('heading', { level: 3 }),
  },
  {
    label: 'Bulleted list',
    run: (e) => e.chain().focus().toggleBulletList().run(),
    on: (e) => e.isActive('bulletList'),
  },
  {
    label: 'Numbered list',
    run: (e) => e.chain().focus().toggleOrderedList().run(),
    on: (e) => e.isActive('orderedList'),
  },
  { label: 'Task list', run: (e) => e.chain().focus().toggleTaskList().run(), on: (e) => e.isActive('taskList') },
  { label: 'Quote', run: (e) => e.chain().focus().toggleBlockquote().run(), on: (e) => e.isActive('blockquote') },
  { label: 'Code block', run: (e) => e.chain().focus().toggleCodeBlock().run(), on: (e) => e.isActive('codeBlock') },
];

/** Floating selection toolbar (DocsEditor board B): dark bubble; the link button turns it into a URL field. */
export function BubbleToolbar({ editor, linkOpen, setLinkOpen, ticketPrefix }: Props) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: !!e?.isActive('bold'),
      italic: !!e?.isActive('italic'),
      strike: !!e?.isActive('strike'),
      code: !!e?.isActive('code'),
      link: !!e?.isActive('link'),
      href: (e?.getAttributes('link').href as string | undefined) ?? '',
      block: BLOCKS.find((b) => e && b.on(e))?.label ?? 'Text',
    }),
  });
  const [blockOpen, setBlockOpen] = useState(false);
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (linkOpen) {
      setUrl(st?.href ?? '');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkOpen]);

  const apply = () => {
    const href = normalizeUrl(url);
    const chain = editor.chain().focus();
    if (!href) chain.extendMarkRange('link').unsetLink().run();
    else chain.extendMarkRange('link').setLink({ href }).run();
    setLinkOpen(false);
  };
  const cancel = () => {
    setLinkOpen(false);
    editor.commands.focus();
  };

  const Btn = ({
    label,
    on,
    onClick,
    children,
    wide,
  }: {
    label: string;
    on?: boolean;
    onClick: () => void;
    children: React.ReactNode;
    wide?: boolean;
  }) => (
    <button
      type="button"
      className="dk-bubble-btn"
      aria-label={label}
      title={label}
      style={{ ...(on ? ON : null), ...(wide ? { width: 'auto', padding: '0 7px', gap: 4, display: 'flex' } : null) }}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="docsBubble"
      updateDelay={80}
      options={{
        strategy: 'fixed',
        placement: 'top',
        offset: 10,
        flip: true,
        shift: { padding: 8 },
        onHide: () => {
          setBlockOpen(false);
        },
      }}
      shouldShow={({ editor: e, state }) => {
        const { selection } = state;
        if (selection.empty || !e.isEditable) return false;
        if (selection instanceof CellSelection) return false;
        if (selection instanceof NodeSelection) return false;
        if (e.isActive('codeBlock')) return false;
        return e.isFocused || linkOpen;
      }}
    >
      <div
        data-testid="bubble-toolbar"
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          padding: '4px 6px',
          borderRadius: 9,
          background: '#1E2A22',
          boxShadow: '0 10px 24px rgba(30,42,34,0.3)',
          zIndex: 30,
          whiteSpace: 'nowrap',
        }}
      >
        {linkOpen ? (
          <>
            <span style={{ display: 'flex', color: '#EEF3EF', padding: '0 4px' }}>
              <Icon name="i11" size={15} />
            </span>
            <input
              ref={inputRef}
              aria-label="Link URL"
              value={url}
              placeholder="Paste or type a link"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  apply();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  cancel();
                }
              }}
              style={{
                width: 220,
                border: 'none',
                outline: 'none',
                background: 'transparent',
                color: '#EEF3EF',
                fontSize: 12.5,
                fontFamily: 'inherit',
                padding: '0 4px',
                caretColor: '#68BA7F',
              }}
            />
            {SEP}
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={apply}
              style={{
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 12,
                fontWeight: 700,
                color: '#CFFFDC',
                padding: '0 6px',
              }}
            >
              Apply
            </button>
            <button
              type="button"
              aria-label="Cancel"
              onMouseDown={(e) => e.preventDefault()}
              onClick={cancel}
              style={{
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                display: 'flex',
                color: '#B7C9BE',
                padding: 0,
              }}
            >
              <Icon name="i08" size={13} />
            </button>
          </>
        ) : (
          <>
            <Btn label="Bold" on={st?.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
              <span style={{ fontWeight: 800, fontSize: 14 }}>B</span>
            </Btn>
            <Btn label="Italic" on={st?.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
              <span style={{ fontStyle: 'italic', fontFamily: 'Georgia,serif', fontSize: 14 }}>i</span>
            </Btn>
            <Btn label="Strikethrough" on={st?.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
              <Icon name="i47" size={15} />
            </Btn>
            <Btn label="Inline code" on={st?.code} onClick={() => editor.chain().focus().toggleCode().run()}>
              <Icon name="i33" size={15} />
            </Btn>
            {SEP}
            <div style={{ position: 'relative' }}>
              <Btn label="Block type" wide onClick={() => setBlockOpen((o) => !o)}>
                <span style={{ fontSize: 12 }}>{st?.block === 'Text' || !st?.block ? 'Text' : st.block}</span>
                <Icon name="i06" size={11} />
              </Btn>
              {blockOpen && (
                <div className="dk-menu" style={{ position: 'absolute', left: 0, top: 34, width: 170, zIndex: 5 }}>
                  {BLOCKS.map((b) => (
                    <div
                      key={b.label}
                      role="menuitem"
                      className={`dk-mi${b.on(editor) ? ' dk-mi-on' : ''}`}
                      style={{ padding: '6px 10px' }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        b.run(editor);
                        setBlockOpen(false);
                      }}
                    >
                      {b.label}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {SEP}
            <Btn label="Link" on={st?.link} onClick={() => setLinkOpen(true)}>
              <Icon name="i11" size={15} />
            </Btn>
            <Btn
              label="Reference a page or section"
              onClick={() => {
                const { from, to } = editor.state.selection;
                editor
                  .chain()
                  .focus()
                  .insertContent(`[[${editor.state.doc.textBetween(from, to, ' ')}`)
                  .run();
              }}
            >
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>[[</span>
            </Btn>
            <Btn label="Ticket" onClick={() => editor.chain().focus().insertContent(`[[${ticketPrefix}-`).run()}>
              <Icon name="i13" size={15} />
            </Btn>
          </>
        )}
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: -5,
            width: 10,
            height: 10,
            marginLeft: -5,
            background: '#1E2A22',
            transform: 'rotate(45deg)',
          }}
        />
      </div>
    </BubbleMenu>
  );
}
