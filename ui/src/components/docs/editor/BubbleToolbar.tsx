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
import { LinkPanel, type LinkTargets } from './LinkPanel';

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
  /**
   * A phone (Editor board, frame 39): 42×44 buttons, only B I U, colours, link, comment and More; strikethrough and
   * the AI items move into More, the block type and the references stay in the Aa sheet and Insert.
   */
  touch?: boolean;
  /** Pages and tickets the link panel offers for what is typed in its address. */
  linkTargets?: LinkTargets;
}

const SEP = <span className="dk-bubble-sep" />;

const BLOCKS: { label: string; run: (e: Editor) => void; on: (e: Editor) => boolean }[] = [
  { label: 'Body', run: (e) => e.chain().focus().setParagraph().run(), on: (e) => e.isActive('paragraph') },
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
  touch,
  linkTargets,
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
        block: BLOCKS.find((b) => e && b.on(e))?.label ?? 'Body',
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
  useEffect(() => {
    // The bar changes width and height between the buttons and the URL field; re-anchor it above the selection.
    editor.view.dispatch(editor.state.tr.setMeta('docsBubble', 'updatePosition'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkOpen]);

  const Btn = ({
    label,
    on,
    onClick,
    children,
    wide,
    expanded,
    className,
  }: {
    label: string;
    /** On, mixed (drawn dashed) or off. */
    on?: boolean | Tri;
    onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
    children: React.ReactNode;
    wide?: boolean;
    expanded?: boolean;
    className?: string;
  }) => {
    const tri = on === true ? 'on' : on === false || on === undefined ? 'off' : on;
    return (
      <button
        type="button"
        className={`dk-bubble-btn${tri === 'on' ? ' dk-rb-on' : tri === 'mixed' ? ' dk-rb-mixed' : ''}${className ? ` ${className}` : ''}`}
        aria-label={label}
        title={label}
        aria-pressed={on === undefined ? undefined : tri === 'mixed' ? 'mixed' : tri === 'on'}
        aria-haspopup={expanded === undefined ? undefined : true}
        aria-expanded={expanded}
        style={wide ? { width: 'auto', padding: '0 9px', gap: 6, display: 'flex' } : undefined}
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
        if (selection.empty) return linkOpen || (e.isFocused && e.isActive('link'));
        if (selection instanceof CellSelection) return false;
        if (selection instanceof NodeSelection) return false;
        if (e.isActive('codeBlock')) return false;
        return e.isFocused || linkOpen || popOpen.current;
      }}
    >
      <div
        data-testid="bubble-toolbar"
        className={`dk-bubble${touch ? ' dk-bubble-touch' : ''}${linkOpen ? ' dk-bubble-linkp' : ''}`}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          padding: 4,
          minHeight: 38,
          boxSizing: 'border-box',
          borderRadius: 10,
          background: '#1E2A22',
          color: '#E8F0EA',
          boxShadow: '0 10px 28px rgba(20,32,24,.32)',
          zIndex: 30,
          whiteSpace: 'nowrap',
        }}
      >
        {linkOpen ? (
          <LinkPanel editor={editor} targets={linkTargets} onClose={() => setLinkOpen(false)} />
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
            {!touch && (
              <>
                <div style={{ position: 'relative' }}>
                  <Btn label="Block type" wide onClick={() => setBlockOpen((o) => !o)}>
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{st?.block ?? 'Body'}</span>
                    <Glyph name="chevron" size={10} strokeWidth={2.4} className="dk-bubble-chev" />
                  </Btn>
                  {blockOpen && (
                    <div className="dk-menu" style={{ position: 'absolute', left: 0, top: 38, width: 170, zIndex: 5 }}>
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
              </>
            )}
            {SEP}
            <Btn label="Bold" on={st?.bold} onClick={() => toggleMark(editor, 'bold')}>
              <span style={{ fontWeight: 800, fontSize: touch ? 16 : 15 }}>B</span>
            </Btn>
            <Btn label="Italic" on={st?.italic} onClick={() => toggleMark(editor, 'italic')}>
              <span
                style={{
                  fontStyle: 'italic',
                  fontWeight: 600,
                  fontFamily: "'Lora', Georgia, serif",
                  fontSize: touch ? 17 : 16,
                }}
              >
                I
              </span>
            </Btn>
            {!plain && (
              <Btn label="Underline" on={st?.underline} onClick={() => toggleMark(editor, 'underline')}>
                <span style={{ fontWeight: 700, fontSize: touch ? 15 : 14, textDecoration: 'underline' }}>U</span>
              </Btn>
            )}
            {!touch && (
              <>
                <Btn label="Strikethrough" on={st?.strike} onClick={() => toggleMark(editor, 'strike')}>
                  <span style={{ fontWeight: 700, fontSize: 14, textDecoration: 'line-through' }}>S</span>
                </Btn>
                <Btn label="Inline code" on={st?.code} onClick={() => toggleMark(editor, 'code')}>
                  <Icon name="i33" size={15} />
                </Btn>
              </>
            )}
            {SEP}
            {!plain && (
              <Btn
                label="Text colour"
                className="dk-bubble-w40"
                on={st?.color === 'mixed' ? 'mixed' : undefined}
                expanded={pop?.id === 'color'}
                onClick={togglePop('color')}
              >
                <ColorGlyph color={st?.color && st.color !== 'mixed' ? cssColor('text', st.color) : '#68BA7F'} />
              </Btn>
            )}
            <Btn
              label="Highlight"
              className={plain ? 'dk-bubble-w40' : 'dk-bubble-hl'}
              on={st?.highlight}
              onClick={() => toggleMark(editor, 'highlight')}
            >
              <HighlightGlyph
                size={15}
                color={typeof hlValue === 'string' && hlValue !== 'mixed' ? cssColor('highlight', hlValue) : undefined}
              />
            </Btn>
            {!plain && (
              <Btn
                label="Highlight colours"
                className="dk-bubble-caret"
                expanded={pop?.id === 'hl'}
                onClick={togglePop('hl')}
              >
                <Glyph name="chevron" size={9} strokeWidth={2.4} />
              </Btn>
            )}
            {SEP}
            <Btn label="Link" on={st?.link} onClick={() => setLinkOpen(true)}>
              <Glyph name="link" size={16} strokeWidth={1.9} />
            </Btn>
            {onComment && (
              <Btn label="Comment" onClick={onComment}>
                <svg
                  aria-hidden="true"
                  width={16}
                  height={16}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.9}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  data-testid="bubble-comment"
                >
                  <path d="M4 5h16v11H9l-5 4z" />
                </svg>
              </Btn>
            )}
            {!touch && (
              <>
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
            <Btn label="More formatting" expanded={pop?.id === 'more'} onClick={togglePop('more')}>
              <Glyph name="more" size={16} strokeWidth={2.6} />
            </Btn>
            {onAi && !touch && (
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
            {onAiBar && !touch && (
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
            width={340}
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
                ...(touch ? ([['Strikethrough', () => toggleMark(editor, 'strike')]] as const) : []),
                ['Superscript', () => toggleMark(editor, 'superscript')],
                ['Subscript', () => toggleMark(editor, 'subscript')],
                ['Clear formatting', () => clearFormatting(editor, 'text')],
                ['Format painter', () => startPainter(editor, false)],
                ...(touch && onAiBar ? ([['AI on the selection', onAiBar]] as const) : []),
                ...(touch && onAi
                  ? (
                      [
                        ['summarise', 'Summarise'],
                        ['rewrite', 'Rewrite'],
                        ['ask', 'Ask AI…'],
                      ] as const
                    ).map(
                      ([action, label]) =>
                        [
                          label,
                          () => {
                            const { from, to } = editor.state.selection;
                            onAi(action, editor.state.doc.textBetween(from, to, '\n'));
                          },
                        ] as const,
                    )
                  : []),
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
