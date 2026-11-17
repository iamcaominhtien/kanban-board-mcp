import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { useEditorState } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { NodeSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { Icon } from '../Icon';
import { LineIcon } from '../../ui/LineIcon';
import { ColorPicker } from './ribbon/ColorPicker';
import {
  clearFormatting,
  markAttr,
  markState,
  setHighlight,
  setTextColor,
  toggleMark,
  type Tri,
} from './ribbon/format';
import { cssColor, rememberColor } from './ribbon/palette';
import { ColorGlyph, Glyph, HighlightGlyph, Popover } from './ribbon/parts';
import { startPainter } from './ribbon/RichFormatting';

interface Props {
  editor: Editor;
  linkOpen: boolean;
  setLinkOpen: (open: boolean) => void;
  ticketPrefix: string;
  /** Show a Comment button; called when it is pressed. */
  onComment?: () => void;
  /** Board AI on the selection: Summarise, Rewrite, Ask AI… (design/screens/ai-board-assistant.md, A6). */
  onAi?: (action: 'summarise' | 'rewrite' | 'ask', text: string) => void;
  /** Shows an "AI" item that swaps this bar for the AI selection bar (Improve, Shorten, Explain, Ask…). */
  onAiBar?: () => void;
  /** The "Ask the team" button (a Docs page with an AI team): it takes the place of the AI items. */
  askTeam?: ReactNode;
  /** The page colour, for the colour swatches (default white). */
  pageHex?: string;
  /** The text is stored as Markdown (an idea): no underline or colours. */
  plain?: boolean;
}

const SEP = <span style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.22)', margin: '0 4px' }} />;

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

/** The editor's scroll column, once the editor view is mounted. */
function editorColumn(editor: Editor): Element | null {
  try {
    return editor.view.dom.closest('[data-testid="editor-scroll"]');
  } catch {
    return null;
  }
}

/**
 * Floating selection toolbar (DocsEditor board B): dark bubble; the link button turns it into a URL field.
 * @param props.editor - Tiptap editor the toolbar acts on.
 * @param props.linkOpen - Show the URL field instead of the buttons.
 * @param props.setLinkOpen - Called to open or close the URL field.
 * @param props.ticketPrefix - Ticket key prefix used by the reference button.
 * @param props.onComment - Shows a Comment button that starts an inline comment on the selection.
 * @param props.onAi - Shows Summarise / Rewrite / Ask AI… for the selection.
 * @param props.onAiBar - Shows an "AI" item that opens the AI selection bar in place of this one.
 * @param props.askTeam - The "Ask the team" button, drawn where the AI items go.
 * @param props.pageHex - The page colour, for the colour swatches.
 * @param props.plain - The text is stored as Markdown: no underline or colours.
 */
export function BubbleToolbar({
  editor,
  linkOpen,
  setLinkOpen,
  ticketPrefix,
  onComment,
  onAi,
  onAiBar,
  askTeam,
  pageHex = '#FFFFFF',
  plain,
}: Props) {
  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const tri = (m: string): Tri => (e ? markState(e.state, m) : 'off');
      return {
        bold: tri('bold'),
        italic: tri('italic'),
        underline: tri('underline'),
        strike: tri('strike'),
        code: tri('code'),
        highlight: tri('highlight'),
        color: e ? markAttr(e.state, 'textStyle', 'color') : null,
        highlightColor: e ? markAttr(e.state, 'highlight', 'color') : null,
        link: !!e?.isActive('link'),
        href: (e?.getAttributes('link').href as string | undefined) ?? '',
        // a caret on a link: the bar turns into the link's actions
        caretOnLink: !!e && e.state.selection.empty && e.isActive('link'),
        block: BLOCKS.find((b) => e && b.on(e))?.label ?? 'Text',
      };
    },
  });
  const [blockOpen, setBlockOpen] = useState(false);
  // a colour or More popover is open: it keeps the bar up while a field in it has the focus
  const [pop, setPop] = useState<{ id: 'color' | 'hl' | 'more'; anchor: HTMLElement } | null>(null);
  const popOpen = useRef(false);
  popOpen.current = !!pop;
  const togglePop = (id: 'color' | 'hl' | 'more') => (e: ReactMouseEvent<HTMLButtonElement>) => {
    const anchor = e.currentTarget;
    setPop((p) => (p?.id === id ? null : { id, anchor }));
  };
  const [url, setUrl] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (linkOpen) {
      setUrl(st?.href ?? '');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
    // The bar changes width and height between the buttons and the URL field; re-anchor it above the selection.
    editor.view.dispatch(editor.state.tr.setMeta('docsBubble', 'updatePosition'));
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
    expanded,
  }: {
    label: string;
    /** On, mixed (drawn dashed) or off. */
    on?: boolean | Tri;
    onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
    children: React.ReactNode;
    wide?: boolean;
    expanded?: boolean;
  }) => {
    const tri = on === true ? 'on' : on === false || on === undefined ? 'off' : on;
    return (
      <button
        type="button"
        className={`dk-bubble-btn${tri === 'on' ? ' dk-rb-on' : tri === 'mixed' ? ' dk-rb-mixed' : ''}`}
        aria-label={label}
        title={label}
        aria-pressed={on === undefined ? undefined : tri === 'mixed' ? 'mixed' : tri === 'on'}
        aria-haspopup={expanded === undefined ? undefined : true}
        aria-expanded={expanded}
        style={wide ? { width: 'auto', padding: '0 7px', gap: 4, display: 'flex' } : undefined}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
      >
        {children}
      </button>
    );
  };
  const hlValue =
    st?.highlight === 'off' || !st ? null : st.highlightColor === 'mixed' ? 'mixed' : (st.highlightColor ?? 'yellow');
  const link = st?.href ?? '';

  return (
    <BubbleMenu
      editor={editor}
      pluginKey="docsBubble"
      updateDelay={80}
      // Mounted on <body>: inside the editor's position:relative column, Floating UI measures against that column
      // while the bar is still position:absolute, and the fixed bar then lands offset by the column's top-left.
      appendTo={() => document.body}
      style={{ zIndex: 60 }}
      options={{
        strategy: 'fixed',
        placement: 'top',
        offset: 10,
        flip: true,
        // keep the bar over the page column: centred on a selection near its left edge it would slide under the
        // app's sidebar
        shift: { padding: 8, boundary: editorColumn(editor) ?? 'clippingAncestors' },
        onHide: () => {
          setBlockOpen(false);
          setPop(null);
        },
      }}
      shouldShow={({ editor: e, state }) => {
        const { selection } = state;
        if (!e.isEditable) return false;
        if (selection.empty) return (e.isFocused || linkOpen) && e.isActive('link');
        if (selection instanceof CellSelection) return false;
        if (selection instanceof NodeSelection) return false;
        if (e.isActive('codeBlock')) return false;
        return e.isFocused || linkOpen || popOpen.current;
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
          minHeight: 36,
          boxSizing: 'border-box',
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
        ) : st?.caretOnLink ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 1 }} data-testid="bubble-link">
            <span className="dk-bubble-link" title={link}>
              <Icon name="i11" size={14} />
              {link.replace(/^https?:\/\//, '')}
            </span>
            {SEP}
            <Btn label="Open link" onClick={() => window.open(link, '_blank', 'noopener,noreferrer')}>
              <Glyph name="open" size={15} />
            </Btn>
            <Btn label="Copy link" onClick={() => void navigator.clipboard?.writeText(link).catch(() => undefined)}>
              <Glyph name="copy" size={15} />
            </Btn>
            <Btn label="Edit link" onClick={() => setLinkOpen(true)}>
              <Glyph name="edit" size={15} />
            </Btn>
            <Btn label="Remove link" onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}>
              <Glyph name="unlink" size={15} />
            </Btn>
          </div>
        ) : (
          <>
            <Btn label="Bold" on={st?.bold} onClick={() => toggleMark(editor, 'bold')}>
              <span style={{ fontWeight: 800, fontSize: 14 }}>B</span>
            </Btn>
            <Btn label="Italic" on={st?.italic} onClick={() => toggleMark(editor, 'italic')}>
              <span style={{ fontStyle: 'italic', fontFamily: 'Georgia,serif', fontSize: 14 }}>i</span>
            </Btn>
            {!plain && (
              <Btn label="Underline" on={st?.underline} onClick={() => toggleMark(editor, 'underline')}>
                <span style={{ fontWeight: 700, fontSize: 13.5, textDecoration: 'underline' }}>U</span>
              </Btn>
            )}
            <Btn label="Strikethrough" on={st?.strike} onClick={() => toggleMark(editor, 'strike')}>
              <Icon name="i47" size={15} />
            </Btn>
            <Btn label="Inline code" on={st?.code} onClick={() => toggleMark(editor, 'code')}>
              <Icon name="i33" size={15} />
            </Btn>
            {!plain && (
              <Btn
                label="Text colour"
                on={st?.color === 'mixed' ? 'mixed' : undefined}
                expanded={pop?.id === 'color'}
                onClick={togglePop('color')}
              >
                <ColorGlyph
                  size={15}
                  color={st?.color && st.color !== 'mixed' ? cssColor('text', st.color) : '#E8F0EA'}
                />
              </Btn>
            )}
            <Btn label="Highlight" on={st?.highlight} onClick={() => toggleMark(editor, 'highlight')}>
              <HighlightGlyph
                color={typeof hlValue === 'string' && hlValue !== 'mixed' ? cssColor('highlight', hlValue) : undefined}
              />
            </Btn>
            {!plain && (
              <Btn label="Highlight colours" expanded={pop?.id === 'hl'} onClick={togglePop('hl')}>
                <Glyph name="chevron" size={10} strokeWidth={2.4} />
              </Btn>
            )}
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
            <Btn label="More formatting" expanded={pop?.id === 'more'} onClick={togglePop('more')}>
              <Glyph name="more" size={15} strokeWidth={2.4} />
            </Btn>
            {onAi && (
              <>
                {SEP}
                {(
                  [
                    ['summarise', 'Summarise'],
                    ['rewrite', 'Rewrite'],
                    ['ask', 'Ask AI…'],
                  ] as const
                ).map(([action, label]) => (
                  <Btn
                    key={action}
                    label={label}
                    wide
                    onClick={() => {
                      const { from, to } = editor.state.selection;
                      onAi(action, editor.state.doc.textBetween(from, to, '\n'));
                    }}
                  >
                    <span style={{ fontSize: 12 }} data-testid={`bubble-ai-${action}`}>
                      {label}
                    </span>
                  </Btn>
                ))}
              </>
            )}
            {onAiBar && (
              <>
                {SEP}
                <Btn label="AI on the selection" wide onClick={onAiBar}>
                  <LineIcon name="sparkle" size={14} />
                  <span style={{ fontSize: 12 }} data-testid="bubble-ai-bar">
                    AI
                  </span>
                  <Icon name="chevronDown" size={10} strokeWidth={2.3} />
                </Btn>
              </>
            )}
            {askTeam && (
              <>
                {SEP}
                {askTeam}
              </>
            )}
            {onComment && (
              <>
                {SEP}
                <Btn label="Comment" wide onClick={onComment}>
                  <Icon name="comment" size={15} />
                  <span style={{ fontSize: 12 }} data-testid="bubble-comment">
                    Comment
                  </span>
                </Btn>
              </>
            )}
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
        {pop && (pop.id === 'color' || pop.id === 'hl') && (
          <Popover
            anchor={pop.anchor}
            label={pop.id === 'color' ? 'Text colour' : 'Highlight'}
            width={256}
            onClose={() => setPop(null)}
            testId={`bubble-pop-${pop.id}`}
          >
            <ColorPicker
              kind={pop.id === 'color' ? 'text' : 'highlight'}
              value={pop.id === 'color' ? (st?.color ?? null) : hlValue}
              pageHex={pageHex}
              onPick={(v) => {
                if (pop.id === 'color') setTextColor(editor, v);
                else setHighlight(editor, v);
                if (v) rememberColor(pop.id === 'color' ? 'text' : 'highlight', v);
                setPop(null);
                editor.commands.focus();
              }}
            />
          </Popover>
        )}
        {pop?.id === 'more' && (
          <Popover anchor={pop.anchor} label="More formatting" role="menu" width={220} onClose={() => setPop(null)}>
            {(
              [
                ['Superscript', () => toggleMark(editor, 'superscript')],
                ['Subscript', () => toggleMark(editor, 'subscript')],
                ['Clear formatting', () => clearFormatting(editor, 'text')],
                ['Format painter', () => startPainter(editor, false)],
              ] as const
            ).map(([label, run]) => (
              <button
                key={label}
                type="button"
                role="menuitem"
                className="dk-mi dk-rb-row"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  run();
                  setPop(null);
                  editor.commands.focus();
                }}
              >
                {label}
              </button>
            ))}
          </Popover>
        )}
      </div>
    </BubbleMenu>
  );
}
