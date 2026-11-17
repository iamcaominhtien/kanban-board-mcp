/**
 * Export from the page header and the page menu (design board "Rich Docs — reading", frame 26): one short menu of
 * four formats. Picking one asks for the export dialog with that format chosen; "Export…" in More asks for it with
 * the last format used. The dialog itself comes later: until something answers the `docs:open-export` event, the
 * caller falls back (Markdown still downloads as before).
 */

import { useEffect, useRef } from 'react';
import { Icon } from './Icon';

export type ExportFormat = 'docx' | 'pdf' | 'html' | 'md';

export const EXPORT_FORMATS: readonly { format: ExportFormat; label: string; note: string }[] = [
  { format: 'docx', label: 'Word', note: '.docx · a document you can keep editing' },
  { format: 'pdf', label: 'PDF', note: '.pdf · for sending and printing' },
  { format: 'html', label: 'HTML', note: '.html · a web page file' },
  { format: 'md', label: 'Markdown', note: '.md · plain text with simple marks' },
];

/** The window event that asks for the export dialog: `detail` is `{pageId, format}` (`format` null: the last one). */
export const OPEN_EXPORT_EVENT = 'docs:open-export';
const LAST_KEY = 'docsExportFormat';

/** The format exported last on this device (Markdown at first). */
export function lastExportFormat(): ExportFormat {
  try {
    const v = localStorage.getItem(LAST_KEY);
    return EXPORT_FORMATS.some((f) => f.format === v) ? (v as ExportFormat) : 'md';
  } catch {
    return 'md';
  }
}

/**
 * Asks for the export dialog of a page. Remembers the format.
 * @param pageId - The page to export.
 * @param format - The chosen format; `null` for the last one used.
 * @returns Whether something opened it (a listener called `preventDefault()`); false means nothing did yet.
 */
export function openExport(pageId: string, format: ExportFormat | null): boolean {
  const chosen = format ?? lastExportFormat();
  try {
    localStorage.setItem(LAST_KEY, chosen);
  } catch {
    /* storage blocked */
  }
  const ev = new CustomEvent(OPEN_EXPORT_EVENT, { detail: { pageId, format: chosen }, cancelable: true });
  return !window.dispatchEvent(ev);
}

/**
 * The "Export this page as" menu under the header's Export button.
 * @param props.onPick - Called with the chosen format.
 * @param props.onClose - Called to close the menu.
 */
export function ExportMenu({ onPick, onClose }: { onPick: (f: ExportFormat) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="dk-menu docs-root"
      role="menu"
      aria-label="Export this page as"
      data-popover
      style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 280, zIndex: 60 }}
    >
      <div className="dk-menu-head">Export this page as</div>
      {EXPORT_FORMATS.map((f) => (
        <button
          key={f.format}
          type="button"
          role="menuitem"
          className="dk-mi dk-mi-2line"
          data-testid={`export-${f.format}`}
          onClick={() => {
            onClose();
            onPick(f.format);
          }}
        >
          <span style={{ color: '#5B6B60', display: 'flex' }}>
            <Icon name="i43" size={15} strokeWidth={1.8} />
          </span>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <b>{f.label}</b>
            <span>{f.note}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
