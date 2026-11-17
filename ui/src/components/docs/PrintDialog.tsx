/**
 * The short Print panel before the browser's own print dialog (design board "Rich Docs — reading", frame 54).
 * Everything has a default; Print builds the sheet (printPage.ts) and opens the browser's dialog.
 */

import { useState } from 'react';
import { Switch } from '../settings/settingsUi';
import { DOCS_SCRIM, useEscape } from './docsShared';
import { Icon } from './Icon';
import { DEFAULT_PRINT, type PrintOptions } from './printPage';
import './reader.css';

type BoolKey = 'meta' | 'cover' | 'colours' | 'urls' | 'highlights' | 'headerFooter' | 'chapterBreak';

const ROWS: readonly { key: BoolKey; title: string; hint: string }[] = [
  { key: 'meta', title: 'Title, author and date', hint: 'Above the content.' },
  { key: 'cover', title: 'Cover image', hint: 'Print the cover above the title.' },
  { key: 'colours', title: 'Colours and background', hint: 'Off prints dark text on white and saves ink.' },
  { key: 'urls', title: 'Show web addresses', hint: 'After each link to another site.' },
  {
    key: 'highlights',
    title: 'Include highlights',
    hint: 'Off by default. Prints everyone’s highlights with a marker.',
  },
  { key: 'headerFooter', title: 'Header and footer', hint: 'Page title, date and page count.' },
  { key: 'chapterBreak', title: 'Start chapters on a new page', hint: 'Only for pages in a book.' },
];

/**
 * The Print panel.
 * @param props.hasCover - The page has a cover (the cover row shows).
 * @param props.inBook - The page is in a book (the chapter row shows).
 * @param props.onPrint - Called with the choices.
 * @param props.onClose - Called on Cancel or Escape.
 */
export function PrintDialog({
  hasCover,
  inBook,
  onPrint,
  onClose,
}: {
  hasCover: boolean;
  inBook: boolean;
  onPrint: (opts: PrintOptions) => void;
  onClose: () => void;
}) {
  useEscape(onClose);
  const [opts, setOpts] = useState<PrintOptions>(DEFAULT_PRINT);
  const rows = ROWS.filter((r) => (r.key === 'cover' ? hasCover : r.key === 'chapterBreak' ? inBook : true));
  return (
    <div
      className="docs-root"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        background: DOCS_SCRIM,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="Print" className="dk-print-dialog" data-testid="print-dialog">
        <div className="dk-print-dialog-head">
          <span className="dk-print-dialog-title">Print</span>
          <button type="button" className="dk-icobtn dk-print-close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={16} strokeWidth={1.9} />
          </button>
        </div>
        {rows.map((r) => (
          <div key={r.key} className="dk-rs-switch">
            <span>
              <b>{r.title}</b>
              <span>{r.hint}</span>
            </span>
            <Switch
              on={opts[r.key]}
              label={r.title}
              testId={`print-${r.key}`}
              onChange={(v) => setOpts((o) => ({ ...o, [r.key]: v }))}
            />
          </div>
        ))}
        <div className="dk-rs-row">
          <span className="dk-rs-label">Paper</span>
          <div className="dk-rseg" role="group" aria-label="Paper">
            {(['a4', 'letter'] as const).map((p) => (
              <button
                key={p}
                type="button"
                aria-pressed={opts.paper === p}
                onClick={() => setOpts((o) => ({ ...o, paper: p }))}
              >
                {p === 'a4' ? 'A4' : 'Letter'}
              </button>
            ))}
          </div>
        </div>
        <div className="dk-rs-row">
          <span className="dk-rs-label">Margins</span>
          <div className="dk-rseg" role="group" aria-label="Margins">
            {(['narrow', 'normal', 'wide'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={opts.margins === m}
                onClick={() => setOpts((o) => ({ ...o, margins: m }))}
              >
                {m[0].toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <p className="dk-rs-note">
          Only the page prints: no sidebar, tree or buttons. Sepia and Night reading themes never print.
        </p>
        <div style={{ display: 'flex', gap: 8, paddingTop: 2 }}>
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="st-btn st-btn-primary" onClick={() => onPrint(opts)} data-testid="print-go">
            <Icon name="page" size={14} strokeWidth={1.9} />
            Print
          </button>
        </div>
      </div>
    </div>
  );
}
