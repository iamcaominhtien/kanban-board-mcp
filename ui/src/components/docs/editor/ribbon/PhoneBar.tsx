/**
 * The phone bar above the keyboard (Editor board C): the eight things people reach for most, 44 px each, never
 * scrolling: Insert, Aa (the format sheet), bold, italic, colour, list, align and More (everything else of the
 * ribbon). The keyboard stays down while a sheet is up, so the sheets act without moving the caret back.
 */

import type { Editor } from '@tiptap/core';
import { useEditorState } from '@tiptap/react';
import { useState, type ReactNode } from 'react';
import { BottomSheet } from '../../DocsSheets';
import { Icon } from '../../Icon';
import { FONT_LABEL, FONTS, type PageFont } from '../../pageSettings';
import { ColorPicker } from './ColorPicker';
import {
  ALIGNS,
  STYLE_IDS,
  STYLE_INFO,
  applyStyle,
  changeIndent,
  formatState,
  setAlign,
  setFontSize,
  setHighlight,
  setTextColor,
  stepFontSize,
  toggleMark,
} from './format';
import { ClearMenu, DropCapMenu, FontMenu, SpacingMenu } from './menus';
import { cssColor, rememberColor } from './palette';
import { ColorGlyph, Glyph, RBtn } from './parts';
import type { RibbonActions } from './Ribbon';
import { blockLook } from './Ribbon';
import { richStorage, startPainter } from './RichFormatting';

type Sheet = 'format' | 'more' | 'color' | 'highlight' | 'align' | 'font' | 'spacing' | 'dropcap' | 'clear';

const ALIGN_GLYPH = { left: 'alignLeft', center: 'alignCenter', right: 'alignRight', justify: 'alignJustify' } as const;

interface Props {
  editor: Editor | null;
  disabled?: boolean;
  pageHex: string;
  actions: RibbonActions;
  /** The page is stored as Markdown: no colour or alignment buttons. */
  plain?: boolean;
}

/**
 * The phone's formatting bar and its sheets.
 * @param props.editor - The editor.
 * @param props.disabled - Every control off.
 * @param props.pageHex - The page colour.
 * @param props.actions - Insert, link, find, focus, shortcuts.
 * @param props.plain - The page is stored as Markdown.
 */
export function PhoneBar({ editor, disabled, pageHex, actions, plain }: Props) {
  const st = useEditorState({ editor, selector: ({ editor: e }) => (e ? formatState(e) : null) });
  const [sheet, setSheet] = useState<Sheet | null>(null);
  if (!editor || !st) return null;
  const off = !!disabled;
  const textOff = off || st.inCode;
  const close = () => setSheet(null);
  const look = blockLook(editor);
  const size = typeof st.fontSize === 'number' ? st.fontSize : look.size;
  const font =
    typeof st.fontFamily === 'string' && (FONTS as readonly string[]).includes(st.fontFamily)
      ? FONT_LABEL[st.fontFamily as PageFont]
      : look.font;
  const alignNow = st.align === 'mixed' ? 'left' : st.align;

  const row = (label: string, onClick: () => void, opts: { arrow?: boolean; icon?: ReactNode; keys?: string } = {}) => (
    <button type="button" role="menuitem" className="dk-mi" onClick={onClick} disabled={off}>
      {opts.icon ?? <span style={{ width: 17 }} />}
      <span style={{ flex: 1 }}>{label}</span>
      {opts.arrow && <Glyph name="chevronRight" size={14} />}
    </button>
  );

  const sheets: Record<Sheet, { label: string; body: ReactNode }> = {
    format: {
      label: 'Format',
      body: (
        <div className="dk-ph-format" data-testid="format-sheet">
          <div className="dk-rb-group">Style</div>
          <div className="dk-ph-chips" role="menu" aria-label="Styles">
            {STYLE_IDS.map((id) => (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={st.style === id}
                className={`dk-ph-chip${st.style === id ? ' dk-ph-chip-on' : ''}`}
                onClick={() => applyStyle(editor, id)}
              >
                {STYLE_INFO[id].label}
              </button>
            ))}
          </div>
          <div className="dk-ph-line">
            <button
              type="button"
              className="dk-rb-select"
              style={{ flex: 1 }}
              disabled={textOff}
              onClick={() => setSheet('font')}
            >
              <span>{font}</span>
              <Glyph name="chevronRight" size={12} />
            </button>
            <span className="dk-rb-size" role="group" aria-label="Font size">
              <button
                type="button"
                aria-label="Smaller"
                disabled={textOff}
                onClick={() => setFontSize(editor, stepFontSize(size, -1))}
              >
                <Glyph name="minus" size={14} />
              </button>
              <span className="dk-rb-size-v">{Math.round(size * 10) / 10}</span>
              <button
                type="button"
                aria-label="Bigger"
                disabled={textOff}
                onClick={() => setFontSize(editor, stepFontSize(size, 1))}
              >
                <Glyph name="insert" size={14} />
              </button>
            </span>
          </div>
          <div className="dk-ph-line">
            {(
              [
                ['bold', 'Bold', <b key="b">B</b>],
                ['italic', 'Italic', <i key="i">I</i>],
                ['underline', 'Underline', <u key="u">U</u>],
                ['strike', 'Strikethrough', <s key="s">S</s>],
                [
                  'superscript',
                  'Superscript',
                  <span key="sup" className="dk-rb-script">
                    x<sup>2</sup>
                  </span>,
                ],
                [
                  'subscript',
                  'Subscript',
                  <span key="sub" className="dk-rb-script">
                    x<sub>2</sub>
                  </span>,
                ],
              ] as const
            ).map(([m, label, glyph]) => (
              <RBtn key={m} label={label} state={st.marks[m]} disabled={textOff} onClick={() => toggleMark(editor, m)}>
                {glyph}
              </RBtn>
            ))}
          </div>
          {row('Text colour', () => setSheet('color'), {
            arrow: true,
            icon: <ColorGlyph color={st.color && st.color !== 'mixed' ? cssColor('text', st.color) : undefined} />,
          })}
          {row('Highlight', () => setSheet('highlight'), { arrow: true, icon: <Glyph name="painter" /> })}
        </div>
      ),
    },
    more: {
      label: 'More',
      body: (
        <div className="dk-menu-sheet" role="menu" aria-label="More" data-testid="more-sheet">
          <div className="dk-ph-line">
            <RBtn label="Undo" disabled={off || !st.canUndo} onClick={() => editor.commands.undo()}>
              <Glyph name="undo" />
            </RBtn>
            <RBtn label="Redo" disabled={off || !st.canRedo} onClick={() => editor.commands.redo()}>
              <Glyph name="redo" />
            </RBtn>
            <RBtn label="Outdent" disabled={off} onClick={() => changeIndent(editor, -1)}>
              <Glyph name="outdent" />
            </RBtn>
            <RBtn label="Indent" disabled={off} onClick={() => changeIndent(editor, 1)}>
              <Glyph name="indent" />
            </RBtn>
          </div>
          {row(
            'Link',
            () => {
              close();
              actions.onLink();
            },
            { icon: <Icon name="i11" size={17} /> },
          )}
          {row('Line and paragraph spacing', () => setSheet('spacing'), {
            arrow: true,
            icon: <Glyph name="spacing" />,
          })}
          {row('Drop cap', () => setSheet('dropcap'), { arrow: true, icon: <Glyph name="dropCap" /> })}
          {row(
            'Format painter',
            () => {
              startPainter(editor, false);
              close();
            },
            { icon: <Glyph name="painter" /> },
          )}
          {row('Clear formatting', () => setSheet('clear'), { arrow: true, icon: <Glyph name="clear" /> })}
          {actions.onAskAi &&
            row(
              'Ask AI',
              () => {
                close();
                actions.onAskAi?.();
              },
              { icon: <Glyph name="insert" /> },
            )}
          {actions.onFind &&
            row(
              'Find and replace',
              () => {
                close();
                actions.onFind?.(true);
              },
              { icon: <Glyph name="find" /> },
            )}
          {actions.onFocusMode &&
            row(
              'Focus mode',
              () => {
                close();
                actions.onFocusMode?.();
              },
              { icon: <Glyph name="focus" /> },
            )}
          {actions.onShortcuts &&
            row(
              'Keyboard shortcuts',
              () => {
                close();
                actions.onShortcuts?.();
              },
              { icon: <Glyph name="keyboard" /> },
            )}
        </div>
      ),
    },
    color: {
      label: 'Text colour',
      body: (
        <ColorPicker
          touch
          kind="text"
          value={st.color}
          pageHex={pageHex}
          onPick={(v) => {
            setTextColor(editor, v);
            if (v) rememberColor('text', v);
            close();
          }}
        />
      ),
    },
    highlight: {
      label: 'Highlight',
      body: (
        <ColorPicker
          touch
          kind="highlight"
          value={st.marks.highlight === 'off' ? null : (st.highlightColor ?? 'yellow')}
          pageHex={pageHex}
          onPick={(v) => {
            setHighlight(editor, v);
            if (v) rememberColor('highlight', v);
            close();
          }}
        />
      ),
    },
    align: {
      label: 'Alignment',
      body: (
        <div className="dk-menu-sheet" role="menu" aria-label="Alignment">
          {ALIGNS.map((a) => (
            <button
              key={a.value}
              type="button"
              role="menuitemradio"
              aria-checked={st.align === a.value}
              className={`dk-mi${st.align === a.value ? ' dk-mi-on' : ''}`}
              onClick={() => {
                setAlign(editor, a.value);
                close();
              }}
            >
              <Glyph name={ALIGN_GLYPH[a.value]} />
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      ),
    },
    font: { label: 'Font', body: <FontMenu editor={editor} st={st} onDone={() => setSheet('format')} noFocus /> },
    spacing: {
      label: 'Line and paragraph spacing',
      body: <SpacingMenu editor={editor} st={st} onDone={close} noFocus />,
    },
    dropcap: { label: 'Drop cap', body: <DropCapMenu editor={editor} st={st} onDone={close} noFocus /> },
    clear: { label: 'Clear formatting', body: <ClearMenu editor={editor} onDone={close} noFocus /> },
  };

  const painting = richStorage(editor)?.painter.get().mode !== 'off';

  return (
    <>
      <div className="dk-ph-bar" data-testid="phone-bar">
        <RBtn label="Insert" disabled={off} onClick={actions.onInsert}>
          <Glyph name="insert" size={19} strokeWidth={2.1} />
        </RBtn>
        <RBtn
          label="Format"
          expanded={sheet === 'format'}
          disabled={off}
          onClick={() => setSheet('format')}
          testId="phone-format"
        >
          <span style={{ fontSize: 15, fontWeight: 700 }}>Aa</span>
        </RBtn>
        <RBtn label="Bold" state={st.marks.bold} disabled={textOff} onClick={() => toggleMark(editor, 'bold')}>
          <span style={{ fontSize: 16, fontWeight: 800 }}>B</span>
        </RBtn>
        <RBtn label="Italic" state={st.marks.italic} disabled={textOff} onClick={() => toggleMark(editor, 'italic')}>
          <span style={{ fontSize: 17, fontStyle: 'italic', fontFamily: "'Lora', Georgia, serif" }}>I</span>
        </RBtn>
        <RBtn
          label="Text colour"
          className={plain ? 'dk-rb-hide' : undefined}
          expanded={sheet === 'color'}
          disabled={textOff}
          onClick={() => setSheet('color')}
        >
          <ColorGlyph size={19} color={st.color && st.color !== 'mixed' ? cssColor('text', st.color) : undefined} />
        </RBtn>
        <RBtn
          label="Bulleted list"
          state={st.list === 'bullet'}
          disabled={off}
          onClick={() => editor.commands.toggleBulletList()}
        >
          <Icon name="i48" size={18} />
        </RBtn>
        <RBtn
          label="Alignment"
          className={plain ? 'dk-rb-hide' : undefined}
          expanded={sheet === 'align'}
          disabled={off || st.inCode}
          onClick={() => setSheet('align')}
        >
          <Glyph name={ALIGN_GLYPH[alignNow]} size={19} />
        </RBtn>
        <RBtn
          label="More"
          expanded={sheet === 'more'}
          state={painting ? 'on' : undefined}
          onClick={() => setSheet('more')}
          testId="phone-more"
        >
          <Glyph name="more" size={19} strokeWidth={2.4} />
        </RBtn>
      </div>
      {sheet && (
        <BottomSheet label={sheets[sheet].label} onClose={close} testId={`phone-sheet-${sheet}`}>
          {sheets[sheet].body}
        </BottomSheet>
      )}
    </>
  );
}
