/**
 * The paste chip (Editor board K): a small "Paste options" chip at the end of a paste of rich text from Word or a web
 * page, offering Keep formatting, Match page style and Plain text. One click changes the paste in place (Undo puts it
 * back); the chip stays until the next edit or Esc. Its menu also holds this device's default ("Next time").
 */

import type { Editor } from '@tiptap/core';
import { useLayoutEffect, useState } from 'react';
import { BottomSheet } from '../../DocsSheets';
import { Glyph } from './parts';
import {
  PASTE_DEFAULTS,
  PASTE_MODES,
  cleanupNote,
  readPasteDefault,
  writePasteDefault,
  type PasteDefault,
} from './pasteMode';
import { closePasteChip, repaste, richStorage } from './RichFormatting';
import { useStore } from './store';

const LABEL: Record<PasteDefault, string> = Object.fromEntries(PASTE_DEFAULTS.map((d) => [d.value, d.label])) as Record<
  PasteDefault,
  string
>;

/**
 * The chip and its options.
 * @param props.editor - The editor.
 * @param props.sheet - Phone: the options open as a bottom sheet.
 */
export function PasteChip({ editor, sheet }: { editor: Editor | null; sheet?: boolean }) {
  const chip = useStore(richStorage(editor)?.paste, null);
  const [open, setOpen] = useState(false);
  const [setting, setSetting] = useState<PasteDefault>(readPasteDefault);
  const [changing, setChanging] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    setOpen(!!chip?.ask);
    setChanging(false);
    setSetting(readPasteDefault());
  }, [chip?.from, chip?.ask]);

  useLayoutEffect(() => {
    if (!editor || !chip || editor.isDestroyed) {
      setPos(null);
      return;
    }
    try {
      const at = Math.min(chip.to, editor.state.doc.content.size);
      const c = editor.view.coordsAtPos(at);
      setPos({ left: Math.min(c.left + 4, window.innerWidth - 150), top: c.bottom + 4 });
    } catch {
      setPos(null);
    }
  }, [editor, chip]);

  if (!editor || !chip) return null;
  const note = chip.source === 'web' ? cleanupNote(chip.removed) : '';

  const options = (
    <div className="dk-paste-opts" role="menu" aria-label="Paste options" data-testid="paste-options">
      {!sheet && <div className="dk-paste-head">Paste options</div>}
      <div className="dk-rb-note">Ctrl Shift V pastes plain text</div>
      {PASTE_MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          role="menuitemradio"
          aria-checked={chip.mode === m.value}
          className={`dk-mi dk-paste-opt${chip.mode === m.value ? ' dk-mi-on' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            repaste(editor, m.value);
            setOpen(false);
          }}
        >
          <span className="dk-paste-check">{chip.mode === m.value && <Glyph name="check" size={14} />}</span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontWeight: 600 }}>{m.label}</span>
            <span className="dk-rb-note" style={{ padding: 0 }}>
              {chip.source === 'web' && m.webNote ? m.webNote : m.note}
            </span>
          </span>
        </button>
      ))}
      {note && <div className="dk-rb-note">{note}</div>}
      {changing ? (
        <div role="radiogroup" aria-label="When I paste" className="dk-paste-setting">
          <div className="dk-rb-group">When I paste</div>
          <div className="dk-rb-note">Applies to text from Word, web pages and other apps.</div>
          {PASTE_DEFAULTS.map((d) => (
            <label key={d.value} className="dk-mi">
              <input
                type="radio"
                name="docs-paste-default"
                checked={setting === d.value}
                onChange={() => {
                  writePasteDefault(d.value);
                  setSetting(d.value);
                  setChanging(false);
                }}
              />
              <span>{d.label}</span>
              {d.value === 'match' && <span className="dk-rb-keys">recommended</span>}
            </label>
          ))}
        </div>
      ) : (
        <div className="dk-paste-next">
          <span>
            Next time: <b>{LABEL[setting]}</b>
          </span>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setChanging(true)}>
            Change
          </button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div
        className="dk-paste-chip docs-root"
        style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999, zIndex: 70 }}
        data-testid="paste-chip"
      >
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
        >
          <Glyph name="clipboard" size={14} />
          <span>Pasted</span>
          <span className="dk-paste-mode">{PASTE_MODES.find((m) => m.value === chip.mode)?.label}</span>
          <Glyph name="chevron" size={10} strokeWidth={2.4} />
        </button>
        <button
          type="button"
          className="dk-paste-x"
          aria-label="Close paste options"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => closePasteChip(editor)}
        >
          ×
        </button>
        {open && !sheet && <div className="dk-menu dk-paste-pop">{options}</div>}
      </div>
      {open && sheet && (
        <BottomSheet label="Paste options" onClose={() => setOpen(false)} testId="paste-sheet">
          {options}
        </BottomSheet>
      )}
    </>
  );
}
