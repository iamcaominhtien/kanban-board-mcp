/**
 * The source tiles at the top of the Import dialog (Markdown, Word, HTML, Paste) and the notes that say what each
 * kind of file brings in and leaves out (design "Starting and shaping a page", frames 27, 53 and 54).
 */

import type { ReactNode } from 'react';
import type { ImportSource } from './importConvert';
import './start.css';

/** The tiles, in order, with their label and the file kind under it. */
export const IMPORT_SOURCES: readonly { id: ImportSource; label: string; ext: string; title: string }[] = [
  { id: 'markdown', label: 'Markdown', ext: '.md', title: 'Import Markdown' },
  { id: 'word', label: 'Word', ext: '.docx', title: 'Import a Word file' },
  { id: 'html', label: 'HTML', ext: '.html', title: 'Import HTML' },
  { id: 'paste', label: 'Paste', ext: 'text', title: 'Import from the clipboard' },
];

/** The dialog's accessible name for a source ("Import Markdown", "Import Word"…). */
export function importDialogName(source: ImportSource): string {
  return source === 'paste' ? 'Import pasted text' : `Import ${IMPORT_SOURCES.find((s) => s.id === source)!.label}`;
}

/**
 * The four source tiles.
 * @param props.value - The source that is on.
 * @param props.onChange - Called with the chosen source.
 * @param props.disabled - Switching is off (an import is running).
 */
export function ImportSourceTiles({
  value,
  onChange,
  disabled = false,
}: {
  value: ImportSource;
  onChange: (s: ImportSource) => void;
  disabled?: boolean;
}) {
  return (
    <div className="dk-src-tiles" role="group" aria-label="Import from">
      {IMPORT_SOURCES.map((s) => (
        <button
          key={s.id}
          type="button"
          className="dk-src-tile"
          aria-pressed={value === s.id}
          disabled={disabled}
          data-testid={`import-source-${s.id}`}
          onClick={() => onChange(s.id)}
        >
          <svg
            width="19"
            height="19"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {TILE_ICON[s.id]}
          </svg>
          <b>{s.label}</b>
          <span>{s.ext}</span>
        </button>
      ))}
    </div>
  );
}

/** The board's icon of each source (frame 27): 19 px, stroke 1.8. */
const TILE_ICON: Record<ImportSource, ReactNode> = {
  markdown: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 15V9l3 3 3-3v6M17 9v6M15 13l2 2 2-2" />
    </>
  ),
  word: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M7 8l2 8 3-6 3 6 2-8" />
    </>
  ),
  html: <path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 5l-4 14" />,
  paste: (
    <>
      <rect x="6" y="5" width="12" height="16" rx="2" />
      <path d="M9 5V4h6v1M9 11h6M9 15h4" />
    </>
  ),
};

/** The line under the drop zone: which files the source takes. */
export function sourceHint(source: ImportSource): string {
  switch (source) {
    case 'markdown':
      return 'Markdown files: .md and .markdown. Folders become a page tree and [[links]] are resolved by title.';
    case 'word':
      return 'Word files: .docx. Styles, tables and pictures come with the page; comments and tracked changes are left out.';
    case 'html':
      return 'HTML files: .html and .htm. Scripts are removed; styles are kept where the editor has a match.';
    default:
      return 'Text, Markdown or HTML from the clipboard.';
  }
}

/**
 * "What a Word file brings in" / "What an HTML file brings in": kept and left out, said where the file is chosen.
 * @param props.source - `word` or `html` (nothing is drawn for the others).
 */
export function ImportNotes({ source }: { source: ImportSource }) {
  if (source !== 'word' && source !== 'html') return null;
  const word = source === 'word';
  return (
    <div className="dk-imp-note" data-testid={`import-notes-${source}`}>
      <div style={{ fontWeight: 700, color: '#1E2A22', marginBottom: 4 }}>
        {word ? 'What a Word file brings in' : 'What an HTML file brings in'}
      </div>
      <div>
        <b>Kept:</b>{' '}
        {word
          ? 'Headings, lists, tables, bold, italic and underline, links, pictures and footnotes.'
          : 'Headings, lists, tables, links, pictures, and simple colour and alignment.'}
      </div>
      <div>
        <b>Left out:</b>{' '}
        {word
          ? 'Comments, tracked changes (the final text is kept), macros, headers and footers. Text boxes become plain paragraphs.'
          : 'Scripts, forms, frames, style sheets and class names. An embedded video or frame becomes a link.'}
      </div>
    </div>
  );
}
