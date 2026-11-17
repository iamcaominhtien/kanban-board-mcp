/**
 * The ribbon (Editor board B): on a desktop two rows, row one the text (history, format painter, style, font, size,
 * bold to strike, colour, highlight, super- and subscript, clear, link) and row two the paragraph, insert and tools
 * (alignment, lists, indent, spacing and drop cap, insert, find, focus, shortcuts); on a tablet one strip that scrolls
 * sideways in the same order, with Undo, Redo and Insert pinned at its right end.
 *
 * Controls show five states: off, on, mixed (dashed: the selection holds both), disabled (text formats in a code
 * block) and focused.
 */

import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { useState, type ReactNode } from 'react';
import { Icon } from '../../Icon';
import { LineIcon } from '../../../ui/LineIcon';
import { FONT_LABEL, FONTS, type PageFont } from '../../pageSettings';
import { ColorPicker } from './ColorPicker';
import {
  ALIGNS,
  STYLE_INFO,
  changeIndent,
  formatState,
  setAlign,
  setFontSize,
  setHighlight,
  setTextColor,
  stepFontSize,
  toggleMark,
  type FormatState,
} from './format';
import { ClearMenu, DropCapMenu, FontMenu, ListStartMenu, SizeMenu, SpacingMenu, StyleMenu } from './menus';
import { cssColor, rememberColor } from './palette';
import { ColorGlyph, Glyph, HighlightGlyph, Popover, RBtn } from './parts';
import { richStorage, startPainter, stopPainter } from './RichFormatting';
import { useStore } from './store';

/** What the ribbon's buttons call outside the editor. */
export interface RibbonActions {
  onLink: () => void;
  onPickImage: () => void;
  onPickFile?: () => void;
  onSketch?: () => void;
  onCanvas?: () => void;
  /** Opens the insert menu ("/"). */
  onInsert: () => void;
  onAskAi?: () => void;
  /** Opens Find (`false`) or Find and replace (`true`). */
  onFind?: (replace: boolean) => void;
  onFocusMode?: () => void;
  onShortcuts?: () => void;
  ticketPrefix: string;
}

interface Props {
  editor: Editor | null;
  disabled?: boolean;
  variant: 'top' | 'strip';
  /** The page colour (for colour swatches and the contrast check). */
  pageHex: string;
  actions: RibbonActions;
  /** The page is stored as Markdown (an idea): controls whose format Markdown cannot keep are left out. */
  plain?: boolean;
}

const ALIGN_GLYPH = { left: 'alignLeft', center: 'alignCenter', right: 'alignRight', justify: 'alignJustify' } as const;

/** The size in px and the first font family the page draws the caret's block with (for "18" and "Lora"). */
export function blockLook(editor: Editor): { size: number; font: string } {
  try {
    const { node } = editor.view.domAtPos(editor.state.selection.from);
    const el = node instanceof HTMLElement ? node : node.parentElement;
    const block = el?.closest('p, h1, h2, h3, h4, h5, h6, li, pre, blockquote') ?? el;
    if (!block) return { size: 18, font: 'Plus Jakarta Sans' };
    const cs = getComputedStyle(block);
    const size = parseFloat(cs.fontSize);
    const first = (cs.fontFamily || '')
      .split(',')[0]
      ?.trim()
      .replace(/^['"]|['"]$/g, '');
    return { size: Number.isFinite(size) && size > 0 ? size : 18, font: first || 'Plus Jakarta Sans' };
  } catch {
    return { size: 18, font: 'Plus Jakarta Sans' };
  }
}

/** The label of a stored font key, or of the font the page draws the text in. */
function fontName(st: FormatState, fallback: string): string {
  if (st.fontFamily === 'mixed') return 'Mixed';
  if (typeof st.fontFamily === 'string' && (FONTS as readonly string[]).includes(st.fontFamily))
    return FONT_LABEL[st.fontFamily as PageFont];
  return fallback;
}

/**
 * The editor's ribbon (desktop) or strip (tablet).
 * @param props.editor - The editor it acts on.
 * @param props.disabled - Every control off (a page you can only read).
 * @param props.variant - `top` (two rows) or `strip` (one scrolling row).
 * @param props.pageHex - The page colour.
 * @param props.actions - What the insert and tool buttons call.
 * @param props.plain - Leave out what Markdown cannot keep (colours, fonts, sizes, paragraph attributes).
 */
export function Ribbon({ editor, disabled, variant, pageHex, actions, plain }: Props) {
  const st = useEditorState({ editor, selector: ({ editor: e }) => (e ? formatState(e) : null) });
  const painter = useStore(richStorage(editor)?.painter, { format: null, mode: 'off' as const });
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  if (!editor || !st) return null;

  const off = !!disabled;
  const textOff = off || st.inCode;
  const look = blockLook(editor);
  const size = typeof st.fontSize === 'number' ? st.fontSize : st.fontSize === 'mixed' ? null : look.size;
  const toggle = (id: string) => (e: React.MouseEvent<HTMLElement>) =>
    setMenu((m) => (m?.id === id ? null : { id, anchor: e.currentTarget }));
  const close = () => setMenu(null);
  const run = (fn: () => unknown) => () => {
    fn();
    editor.commands.focus();
  };
  const pop = (id: string, label: string, body: ReactNode, width = 240) =>
    menu?.id === id ? (
      <Popover anchor={menu.anchor} label={label} onClose={close} width={width} testId={`ribbon-pop-${id}`}>
        {body}
      </Popover>
    ) : null;
  const sep = <span className="dk-sep" />;
  const styleLabel = st.style === 'mixed' ? 'Mixed' : st.style ? STYLE_INFO[st.style].label : 'Body';
  const hlValue =
    st.marks.highlight === 'off' ? null : st.highlightColor === 'mixed' ? 'mixed' : (st.highlightColor ?? 'yellow');

  const history = (
    <>
      <RBtn label="Undo" keys="Mod+Z" disabled={off || !st.canUndo} onClick={run(() => editor.commands.undo())}>
        <Glyph name="undo" />
      </RBtn>
      <RBtn label="Redo" keys="Mod+Shift+Z" disabled={off || !st.canRedo} onClick={run(() => editor.commands.redo())}>
        <Glyph name="redo" />
      </RBtn>
    </>
  );
  const insert = (
    <RBtn
      label="Insert"
      keys="/"
      disabled={off}
      onClick={actions.onInsert}
      className="dk-rb-insert"
      testId="ribbon-insert"
    >
      <Glyph name="insert" size={15} strokeWidth={2.2} />
      <span>Insert</span>
      <span className="dk-kbd">/</span>
    </RBtn>
  );

  const painterBtn = (
    <RBtn
      label="Format painter"
      keys="Mod+Alt+C"
      state={painter.mode !== 'off'}
      disabled={off}
      testId="ribbon-painter"
      onClick={(e) => {
        if (painter.mode === 'off') startPainter(editor, false);
        else if (e.detail <= 1) stopPainter(editor);
      }}
      onDoubleClick={() => startPainter(editor, true)}
    >
      <Glyph name="painter" />
    </RBtn>
  );

  const text = (
    <>
      <button
        type="button"
        className="dk-rb-select"
        style={{ width: 112 }}
        aria-label={`Style: ${styleLabel}`}
        aria-haspopup="menu"
        aria-expanded={menu?.id === 'style'}
        disabled={off}
        data-testid="ribbon-style"
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle('style')}
      >
        <span>{styleLabel}</span>
        <Glyph name="chevron" size={11} strokeWidth={2.2} />
      </button>
      {pop('style', 'Styles', <StyleMenu editor={editor} st={st} onDone={close} />, 250)}
      <button
        type="button"
        className="dk-rb-select"
        style={{ width: 128 }}
        data-rich-only
        aria-label={`Font: ${fontName(st, look.font)}`}
        aria-haspopup="menu"
        aria-expanded={menu?.id === 'font'}
        disabled={textOff}
        data-testid="ribbon-font"
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggle('font')}
      >
        <span
          style={{ fontFamily: typeof st.fontFamily === 'string' && st.fontFamily !== 'mixed' ? undefined : look.font }}
        >
          {fontName(st, look.font)}
        </span>
        <Glyph name="chevron" size={11} strokeWidth={2.2} />
      </button>
      {pop('font', 'Font', <FontMenu editor={editor} st={st} onDone={close} />, 240)}
      <span className="dk-rb-size" role="group" aria-label="Font size" data-rich-only>
        <button
          type="button"
          aria-label="Smaller"
          disabled={textOff}
          onMouseDown={(e) => e.preventDefault()}
          onClick={run(() => setFontSize(editor, stepFontSize(size ?? look.size, -1)))}
        >
          <Glyph name="minus" size={12} strokeWidth={2.2} />
        </button>
        <button
          type="button"
          className="dk-rb-size-v"
          aria-label={`Size: ${size === null ? 'mixed' : Math.round(size * 10) / 10}`}
          aria-haspopup="menu"
          aria-expanded={menu?.id === 'size'}
          disabled={textOff}
          data-testid="ribbon-size"
          onMouseDown={(e) => e.preventDefault()}
          onClick={toggle('size')}
        >
          {size === null ? '—' : Math.round(size * 10) / 10}
        </button>
        <button
          type="button"
          aria-label="Bigger"
          disabled={textOff}
          onMouseDown={(e) => e.preventDefault()}
          onClick={run(() => setFontSize(editor, stepFontSize(size ?? look.size, 1)))}
        >
          <Glyph name="insert" size={12} strokeWidth={2.2} />
        </button>
      </span>
      {pop('size', 'Font size', <SizeMenu editor={editor} st={st} onDone={close} styleSize={look.size} />, 200)}
    </>
  );

  const marks = (
    <>
      <RBtn
        label="Bold"
        keys="Mod+B"
        state={st.marks.bold}
        disabled={textOff}
        onClick={run(() => toggleMark(editor, 'bold'))}
      >
        <span style={{ fontSize: 15, fontWeight: 800 }}>B</span>
      </RBtn>
      <RBtn
        label="Italic"
        keys="Mod+I"
        state={st.marks.italic}
        disabled={textOff}
        onClick={run(() => toggleMark(editor, 'italic'))}
      >
        <span style={{ fontSize: 16, fontStyle: 'italic', fontWeight: 600, fontFamily: "'Lora', Georgia, serif" }}>
          I
        </span>
      </RBtn>
      <RBtn
        label="Underline"
        className="dk-rb-rich"
        keys="Mod+U"
        state={st.marks.underline}
        disabled={textOff}
        onClick={run(() => toggleMark(editor, 'underline'))}
      >
        <span style={{ fontSize: 14.5, fontWeight: 700, textDecoration: 'underline', textUnderlineOffset: 3 }}>U</span>
      </RBtn>
      <RBtn
        label="Strikethrough"
        keys="Mod+Shift+X"
        state={st.marks.strike}
        disabled={textOff}
        onClick={run(() => toggleMark(editor, 'strike'))}
      >
        <Icon name="i47" size={16} />
      </RBtn>
      <RBtn
        label="Inline code"
        keys="Mod+E"
        state={st.marks.code}
        disabled={off || st.inCode}
        onClick={run(() => toggleMark(editor, 'code'))}
      >
        <Icon name="i33" size={16} />
      </RBtn>
    </>
  );

  const colours = (
    <>
      <RBtn
        label="Text colour"
        className="dk-rb-rich"
        state={st.color === 'mixed' ? 'mixed' : undefined}
        expanded={menu?.id === 'color'}
        disabled={textOff}
        testId="ribbon-text-colour"
        onClick={toggle('color')}
      >
        <ColorGlyph color={st.color && st.color !== 'mixed' ? cssColor('text', st.color) : undefined} />
        <Glyph name="chevron" size={9} strokeWidth={2.4} />
      </RBtn>
      {pop(
        'color',
        'Text colour',
        <ColorPicker
          kind="text"
          value={st.color}
          pageHex={pageHex}
          onPick={(v) => {
            setTextColor(editor, v);
            if (v) rememberColor('text', v);
            editor.commands.focus();
            close();
          }}
        />,
        256,
      )}
      <span className="dk-rb-split">
        <RBtn
          label="Highlight"
          keys="Mod+Shift+H"
          state={st.marks.highlight}
          disabled={textOff}
          onClick={run(() => toggleMark(editor, 'highlight'))}
        >
          <HighlightGlyph
            color={typeof hlValue === 'string' && hlValue !== 'mixed' ? cssColor('highlight', hlValue) : undefined}
          />
        </RBtn>
        <RBtn
          label="Highlight colours"
          expanded={menu?.id === 'hl'}
          disabled={textOff}
          className="dk-rb-caret dk-rb-rich"
          testId="ribbon-highlight-colour"
          onClick={toggle('hl')}
        >
          <Glyph name="chevron" size={9} strokeWidth={2.4} />
        </RBtn>
      </span>
      {pop(
        'hl',
        'Highlight',
        <ColorPicker
          kind="highlight"
          value={hlValue}
          pageHex={pageHex}
          onPick={(v) => {
            setHighlight(editor, v);
            if (v) rememberColor('highlight', v);
            editor.commands.focus();
            close();
          }}
        />,
        256,
      )}
      <RBtn
        label="Superscript"
        className="dk-rb-rich"
        keys="Mod+."
        state={st.marks.superscript}
        disabled={textOff}
        onClick={run(() => toggleMark(editor, 'superscript'))}
      >
        <span className="dk-rb-script">
          x<sup>2</sup>
        </span>
      </RBtn>
      <RBtn
        label="Subscript"
        className="dk-rb-rich"
        keys="Mod+,"
        state={st.marks.subscript}
        disabled={textOff}
        onClick={run(() => toggleMark(editor, 'subscript'))}
      >
        <span className="dk-rb-script">
          x<sub>2</sub>
        </span>
      </RBtn>
      <RBtn label="Clear formatting" expanded={menu?.id === 'clear'} disabled={off} onClick={toggle('clear')}>
        <Glyph name="clear" />
      </RBtn>
      {pop('clear', 'Clear formatting', <ClearMenu editor={editor} onDone={close} />, 250)}
      <RBtn
        label={st.marks.link === 'on' ? 'Edit link' : 'Link'}
        keys="Mod+K"
        state={st.marks.link === 'on'}
        disabled={off}
        onClick={actions.onLink}
      >
        <Icon name="i11" size={16} />
      </RBtn>
    </>
  );

  const paragraph = (
    <>
      <span role="group" aria-label="Alignment" className="dk-rb-group-inline" data-rich-only>
        {ALIGNS.map((a) => (
          <RBtn
            key={a.value}
            label={`Align ${a.label.toLowerCase()}`}
            keys={a.keys}
            state={st.align === a.value ? 'on' : 'off'}
            disabled={off || st.inCode}
            onClick={run(() => setAlign(editor, a.value))}
          >
            <Glyph name={ALIGN_GLYPH[a.value]} />
          </RBtn>
        ))}
      </span>
      {sep}
      <RBtn
        label="Bulleted list"
        keys="Mod+Shift+8"
        state={st.list === 'bullet'}
        disabled={off}
        onClick={run(() => editor.commands.toggleBulletList())}
      >
        <Icon name="i48" size={16} />
      </RBtn>
      <span className="dk-rb-split">
        <RBtn
          label="Numbered list"
          keys="Mod+Shift+7"
          state={st.list === 'ordered'}
          disabled={off}
          onClick={run(() => editor.commands.toggleOrderedList())}
        >
          <Icon name="i49" size={16} />
        </RBtn>
        <RBtn
          label="Numbered list options"
          expanded={menu?.id === 'olist'}
          disabled={off}
          className="dk-rb-caret"
          onClick={toggle('olist')}
        >
          <Glyph name="chevron" size={9} strokeWidth={2.4} />
        </RBtn>
      </span>
      {pop('olist', 'Numbered list', <ListStartMenu editor={editor} st={st} onDone={close} />, 200)}
      <RBtn
        label="Task list"
        keys="Mod+Shift+9"
        state={st.list === 'task'}
        disabled={off}
        onClick={run(() => editor.commands.toggleTaskList())}
      >
        <Icon name="i50" size={16} />
      </RBtn>
      {sep}
      <RBtn label="Outdent" keys="Shift+Tab" disabled={off || st.inCode} onClick={run(() => changeIndent(editor, -1))}>
        <Glyph name="outdent" />
      </RBtn>
      <RBtn label="Indent" keys="Tab" disabled={off || st.inCode} onClick={run(() => changeIndent(editor, 1))}>
        <Glyph name="indent" />
      </RBtn>
      {sep}
      <RBtn
        label="Line and paragraph spacing"
        className="dk-rb-rich"
        expanded={menu?.id === 'spacing'}
        disabled={off || st.inCode}
        onClick={toggle('spacing')}
      >
        <Glyph name="spacing" />
      </RBtn>
      {pop('spacing', 'Line and paragraph spacing', <SpacingMenu editor={editor} st={st} onDone={close} />, 240)}
      <RBtn
        label="Drop cap"
        className="dk-rb-rich"
        state={st.dropCap ? 'on' : 'off'}
        expanded={menu?.id === 'drop'}
        disabled={off || st.style !== 'body'}
        onClick={toggle('drop')}
      >
        <Glyph name="dropCap" />
      </RBtn>
      {pop('drop', 'Drop cap', <DropCapMenu editor={editor} st={st} onDone={close} />, 220)}
    </>
  );

  const c = () => editor.chain().focus();
  const inserts = (
    <>
      <RBtn label="Image" disabled={off} onClick={actions.onPickImage}>
        <Icon name="i54" size={16} />
      </RBtn>
      <RBtn
        label="Table"
        state={st.inTable}
        disabled={off || st.inTable}
        onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      >
        <Icon name="i52" size={16} />
      </RBtn>
      <RBtn label="Callout" state={st.inCallout} disabled={off} onClick={() => c().toggleCallout('info').run()}>
        <Icon name="i31" size={16} />
      </RBtn>
      <RBtn
        label="Quote"
        keys="Mod+Shift+B"
        state={st.inQuote}
        disabled={off}
        onClick={() => c().toggleBlockquote().run()}
      >
        <Icon name="i51" size={16} />
      </RBtn>
      <RBtn label="Divider" disabled={off || st.inCode} onClick={() => c().setHorizontalRule().run()}>
        <Glyph name="divider" />
      </RBtn>
      <RBtn label="Code block" state={st.inCode} disabled={off} onClick={() => c().toggleCodeBlock().run()}>
        <Icon name="i53" size={16} />
      </RBtn>
      <RBtn label="Reference a page or section" disabled={off} onClick={() => c().insertContent('[[').run()}>
        <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>[[</span>
      </RBtn>
      <RBtn label="Ticket" disabled={off} onClick={() => c().insertContent(`[[${actions.ticketPrefix}-`).run()}>
        <Icon name="i13" size={16} />
      </RBtn>
      {actions.onPickFile && (
        <RBtn label="Attach a file (Excel, Word, PDF…)" disabled={off} onClick={actions.onPickFile}>
          <Icon name="attach" size={16} />
        </RBtn>
      )}
      {actions.onSketch && (
        <RBtn label="Sketch (/draw)" disabled={off} onClick={actions.onSketch}>
          <Icon name="sketch" size={16} />
        </RBtn>
      )}
      {actions.onCanvas && (
        <RBtn label="Canvas (/canvas)" disabled={off} onClick={actions.onCanvas}>
          <Icon name="canvas" size={16} />
        </RBtn>
      )}
    </>
  );

  const tools = (
    <>
      {actions.onFind && (
        <RBtn label="Find and replace" keys="Mod+H" disabled={off} onClick={() => actions.onFind?.(true)}>
          <Glyph name="find" />
        </RBtn>
      )}
      {actions.onFocusMode && (
        <RBtn label="Focus mode" keys="Mod+Shift+F" disabled={off} onClick={actions.onFocusMode}>
          <Glyph name="focus" />
        </RBtn>
      )}
      {actions.onShortcuts && (
        <RBtn label="Keyboard shortcuts" keys="Mod+/" onClick={actions.onShortcuts}>
          <Glyph name="keyboard" />
        </RBtn>
      )}
    </>
  );

  const askAi = actions.onAskAi && (
    <button type="button" onClick={actions.onAskAi} data-testid="docs-ask-ai" className="dk-rb-ai">
      <LineIcon name="sparkle" size={12} /> Ask AI
    </button>
  );

  if (variant === 'strip')
    return (
      <div className={`dk-rb-stripwrap${plain ? ' dk-rb-plain' : ''}`}>
        <div className="dk-rb-strip">
          {painterBtn}
          {sep}
          {text}
          {sep}
          {marks}
          {sep}
          {colours}
          {sep}
          {paragraph}
          {sep}
          {inserts}
          {sep}
          {tools}
          {askAi}
        </div>
        <div className="dk-rb-pinned">
          {history}
          {insert}
        </div>
      </div>
    );

  return (
    <div className={`dk-rb-rows${plain ? ' dk-rb-plain' : ''}`}>
      <div className="dk-rb-row1" role="group" aria-label="Text">
        {history}
        {sep}
        {painterBtn}
        {sep}
        {text}
        {sep}
        {marks}
        {sep}
        {colours}
      </div>
      <div className="dk-rb-row2" role="group" aria-label="Paragraph, insert and tools">
        {paragraph}
        {sep}
        {inserts}
        {insert}
        {sep}
        {tools}
        <span style={{ flex: 1 }} />
        {askAi}
      </div>
    </div>
  );
}
