/**
 * File attachments in a page (design "Embeds", section E): the inline preview of a file card (frames 39-41): a PDF in
 * the browser's own viewer at the height of a page, a Word file's headings and paragraphs, a spreadsheet's first rows
 * with a tab per sheet. Read only; "Open in viewer" opens the board's file viewer. Also the reader's file block: the
 * card, and the preview when the author chose "Show as preview" (folded at first on a phone).
 */

import { useState } from 'react';
import { uploadUrl } from '../../../api/tickets';
import { useDocsLayout } from '../../../hooks/useDocsLayout';
import { FileAttachmentCard } from '../../FileAttachmentCard';
import { itemFromUpload, usePreview } from '../../preview/PreviewContext';
import { uploadPath, useFilePreview } from './embedApi';
import './embeds.css';

/** How many rows of a sheet the preview shows (the first is the header). */
const SHEET_ROWS = 8;

/** Props of {@link FilePreview}. */
export interface FilePreviewProps {
  src: string;
  name: string;
  size?: number;
}

/** "1,204". */
const count = (n: number) => n.toLocaleString('en-US');

/**
 * The inline preview of a stored file.
 */
export function FilePreview({ src, name, size }: FilePreviewProps) {
  const q = useFilePreview(src, true);
  const viewer = usePreview();
  const [sheet, setSheet] = useState(0);
  const path = uploadPath(src);
  const openViewer = (
    <button
      type="button"
      className="dk-btn-ghost"
      onClick={() => viewer.open([itemFromUpload(path ?? src, name, size)], 0)}
    >
      Open in viewer
    </button>
  );
  let body;
  if (!path) body = <p className="dk-file-pv-note">Only files stored with the project can be previewed.</p>;
  else if (q.isLoading)
    body = <div className="dk-skel dk-file-pv-skel" aria-busy="true" aria-label="Loading the preview" />;
  else if (q.isError || !q.data || q.data.kind === 'none')
    body = <p className="dk-file-pv-note">No preview for this file. Download it, or open it in the viewer.</p>;
  else if (q.data.kind === 'pdf')
    body = (
      <iframe
        className="dk-file-pdf"
        title={`${name}: preview`}
        src={`${uploadUrl(path, name, false, true) || path}#page=1&view=FitH`}
        data-testid="file-pdf-preview"
      />
    );
  else if (q.data.kind === 'word')
    body = (
      <div className="dk-file-word" data-testid="file-word-preview">
        {q.data.blocks.slice(0, 40).map((b, i) =>
          b.type === 'heading' ? (
            <p key={i} className={`dk-file-word-h dk-file-word-h${Math.min(3, b.level ?? 1)}`}>
              {b.text}
            </p>
          ) : (
            <p key={i}>{b.text}</p>
          ),
        )}
        <p className="dk-file-pv-note">Preview shows text and tables. Open the file for the exact layout.</p>
      </div>
    );
  else {
    const sheets = q.data.sheets;
    const cur = sheets[Math.min(sheet, sheets.length - 1)];
    const rows = cur?.rows ?? [];
    const head = rows[0] ?? [];
    const shown = rows.slice(1, SHEET_ROWS);
    const total = Math.max(0, (cur?.totalRows ?? rows.length) - 1);
    body = (
      <div className="dk-file-sheet" data-testid="file-sheet-preview">
        {sheets.length > 1 && (
          <div className="dk-file-tabs" role="tablist" aria-label="Sheets">
            {sheets.map((s, i) => (
              <button
                key={s.name}
                type="button"
                role="tab"
                aria-selected={i === sheet}
                className={i === sheet ? 'on' : undefined}
                onClick={() => setSheet(i)}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
        <div className="dk-file-table-wrap">
          <table className="dk-file-table">
            <thead>
              <tr>
                {head.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => (
                <tr key={i}>
                  {head.map((_c, j) => (
                    <td key={j}>{r[j] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="dk-file-pv-note">
          Showing the first {Math.min(shown.length, total)} of {count(total)} rows
        </p>
      </div>
    );
  }
  return (
    <div className="dk-file-pv" data-testid="file-preview">
      {body}
      <div className="dk-emb-actions">{openViewer}</div>
    </div>
  );
}

/** Props of {@link FileBlock}. */
export interface FileBlockProps {
  attrs: Record<string, unknown>;
}

/**
 * The reader's file block: the card, and its preview when the page shows one.
 */
export function FileBlock({ attrs }: FileBlockProps) {
  const src = (typeof attrs.src === 'string' ? attrs.src : '').replace(/\/api\/uploads\//, '/uploads/');
  const name = (typeof attrs.name === 'string' && attrs.name) || src;
  const size = typeof attrs.size === 'number' ? attrs.size : undefined;
  const phone = useDocsLayout(null) === 'phone';
  const [open, setOpen] = useState<boolean | null>(null);
  if (!src || src.startsWith('uploading:')) return null;
  const wantsPreview = !!attrs.preview;
  const shown = wantsPreview && (open ?? !phone);
  return (
    <>
      <FileAttachmentCard url={src} fileName={name} fileSize={size} />
      {wantsPreview && (
        <button type="button" className="dk-emb-link dk-file-pv-toggle" onClick={() => setOpen(!shown)}>
          {shown ? 'Collapse preview' : 'Preview'}
        </button>
      )}
      {shown && <FilePreview src={src} name={name} size={size} />}
    </>
  );
}
