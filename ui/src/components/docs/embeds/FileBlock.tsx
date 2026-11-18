/**
 * File attachments in a page (design "Embeds", section E): the inline preview of a file card (frames 39-41): a PDF in
 * the browser's own viewer at the height of a page, a Word file's headings and paragraphs, a spreadsheet's first rows
 * with a tab per sheet. Read only; "Open in viewer" opens the board's file viewer. Also the reader's file block: the
 * card, and the preview when the author chose "Show as preview" (folded at first on a phone).
 */

import { useState, type ReactNode } from 'react';
import { uploadUrl } from '../../../api/tickets';
import { useDocsLayout } from '../../../hooks/useDocsLayout';
import { getFileTypeMeta } from '../../../utils/fileIcons';
import { itemFromUpload, usePreview } from '../../preview/PreviewContext';
import { FileBadge } from '../editor/blocks/embedUi';
import { formatBytes } from '../editor/blocks/ui';
import { uploadPath, useFilePreview } from './embedApi';
import { EmbIcon } from './embIcons';
import './embeds.css';

/** How many rows of a sheet the preview shows (the first is the header). */
const SHEET_ROWS = 8;

/** Props of {@link FilePreview}. */
export interface FilePreviewProps {
  src: string;
  name: string;
  size?: number;
  /** "Collapse preview" in the preview's footer; unset hides it. */
  onCollapse?: () => void;
}

/** "1,204". */
const count = (n: number) => n.toLocaleString('en-US');

/**
 * The inline preview of a stored file (frames 39-41): the preview, then a footer with what it shows, Collapse
 * preview and Open in viewer.
 */
export function FilePreview({ src, name, size, onCollapse }: FilePreviewProps) {
  const q = useFilePreview(src, true);
  const viewer = usePreview();
  const [sheet, setSheet] = useState(0);
  const path = uploadPath(src);
  let body: ReactNode;
  let note: ReactNode = null;
  let kind = 'none';
  if (!path) note = 'Only files stored with the project can be previewed.';
  else if (q.isLoading)
    body = <div className="dk-skel dk-file-pv-skel" aria-busy="true" aria-label="Loading the preview" />;
  else if (q.isError || !q.data || q.data.kind === 'none')
    note = 'No preview for this file. Download it, or open it in the viewer.';
  else if (q.data.kind === 'pdf') {
    kind = 'pdf';
    body = (
      <iframe
        className="dk-file-pdf"
        title={`${name}: preview`}
        src={`${uploadUrl(path, name, false, true) || path}#page=1&view=FitH`}
        data-testid="file-pdf-preview"
      />
    );
  } else if (q.data.kind === 'word') {
    kind = 'word';
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
      </div>
    );
    note = 'Preview shows text and tables. Open the file for the exact layout.';
  } else {
    kind = 'sheet';
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
      </div>
    );
    note = `Showing the first ${Math.min(shown.length, total)} of ${count(total)} rows`;
  }
  return (
    <div className={`dk-file-pv dk-file-pv-${kind}`} data-testid="file-preview">
      {body && <div className="dk-file-pv-body">{body}</div>}
      <div className="dk-file-pv-foot">
        <span className="dk-file-pv-note">{note}</span>
        {onCollapse && (
          <button type="button" className="st-btn st-btn-sm" onClick={onCollapse}>
            Collapse preview
          </button>
        )}
        <button
          type="button"
          className="st-btn st-btn-primary st-btn-sm"
          onClick={() => viewer.open([itemFromUpload(path ?? src, name, size)], 0)}
        >
          <EmbIcon name="size" size={12} sw={2.2} />
          Open in viewer
        </button>
      </div>
    </div>
  );
}

/** Props of {@link FileCard}. */
export interface FileCardProps {
  /** The stored path (`/uploads/…`) or the address of the file. */
  src: string;
  name: string;
  size?: number;
  /** Shown at the end of the card, before Download (Preview / Collapse preview). */
  extra?: ReactNode;
}

/**
 * A file card as a reader sees it (frame 38): the type badge, the name and "PDF · 1.2 MB", Download and More (Open in
 * viewer, Copy link).
 */
export function FileCard({ src, name, size, extra }: FileCardProps) {
  const viewer = usePreview();
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const path = uploadPath(src) ?? src;
  const download = path.startsWith('/uploads/') ? uploadUrl(path, name, true) : src;
  const meta = getFileTypeMeta(name);
  return (
    <div className="dk-fc" data-testid="doc-file-card">
      <div className="dk-fc-row">
        <FileBadge name={name} />
        <span className="dk-fc-text">
          <strong className="dk-fc-name">{name}</strong>
          <span className="dk-fc-meta">{size != null ? `${meta.label} · ${formatBytes(size)}` : meta.label}</span>
        </span>
        <span className="dk-fc-actions">
          {extra}
          <a className="st-btn st-btn-sm" href={download} download={name}>
            <EmbIcon name="download" size={12} sw={2.2} />
            Download
          </a>
          <span className="dk-fc-more">
            <button
              type="button"
              className="dk-fc-ib"
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((m) => !m)}
            >
              <EmbIcon name="more" size={16} />
            </button>
            {menu && (
              <div className="dk-fc-menu" role="menu" aria-label={name} onMouseLeave={() => setMenu(false)}>
                <div className="dk-fc-menu-head">{name}</div>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(false);
                    viewer.open([itemFromUpload(path, name, size)], 0);
                  }}
                >
                  <span className="dk-fc-menu-ic">
                    <EmbIcon name="eye" size={15} />
                  </span>
                  Open in viewer
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void navigator.clipboard?.writeText(download).then(() => {
                      setCopied(true);
                      setTimeout(() => {
                        setCopied(false);
                        setMenu(false);
                      }, 900);
                    });
                  }}
                >
                  <span className="dk-fc-menu-ic">
                    <EmbIcon name="link" size={15} />
                  </span>
                  {copied ? 'Link copied' : 'Copy link'}
                </button>
              </div>
            )}
          </span>
        </span>
      </div>
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
  if (shown)
    return (
      <div className="dk-fc dk-fc-open">
        <div className="dk-fc-row">
          <FileBadge name={name} />
          <span className="dk-fc-text">
            <strong className="dk-fc-name">{name}</strong>
            <span className="dk-fc-meta">
              {size != null ? `${getFileTypeMeta(name).label} · ${formatBytes(size)}` : getFileTypeMeta(name).label}
            </span>
          </span>
        </div>
        <FilePreview src={src} name={name} size={size} onCollapse={() => setOpen(false)} />
      </div>
    );
  return (
    <FileCard
      src={src}
      name={name}
      size={size}
      extra={
        wantsPreview && (
          <button type="button" className="st-btn st-btn-sm" onClick={() => setOpen(true)}>
            Preview
          </button>
        )
      }
    />
  );
}
