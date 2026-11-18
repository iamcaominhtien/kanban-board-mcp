/**
 * The History tab of the export dialog (frames 30 to 33): the person's last 20 exports in the project, kept for 7
 * days. Each row says what it was, how big and when, with the one action that fits (Download, Stop, Export again)
 * and a menu (Download, Copy link, Export again with the same options, Delete the file). Cards on a phone.
 */

import { useEffect, useRef, useState } from 'react';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import { useExportHistory, type ExportRow } from './exportApi';
import { FormatBadge, ICONS, Svg } from './ExportFrame';
import { FORMAT_LABEL, fmtSize, scopeText, whenText } from './exportModel';

/** What the rows' buttons do. */
export interface HistoryActions {
  onDownload: (r: ExportRow) => void;
  onCopyLink: (r: ExportRow) => void;
  onStop: (r: ExportRow) => void;
  onExportAgain: (r: ExportRow) => void;
  onRemove: (r: ExportRow) => void;
  onNewExport: () => void;
}

const STATE_TAG: Partial<Record<ExportRow['state'], [string, string]>> = {
  running: ['Exporting', 'dx-pill dx-pill-green'],
  cancelled: ['Cancelled', 'dx-pill'],
  failed: ['Did not finish', 'dx-pill dx-pill-red'],
  expired: ['Expired', 'dx-pill'],
};

function RowMenu({ row, actions }: { row: ExportRow; actions: HistoryActions }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const ready = row.state === 'ready';
  const item = (label: string, fn: () => void, testId: string) => (
    <button
      type="button"
      role="menuitem"
      className="dk-mi"
      data-testid={testId}
      onClick={() => {
        setOpen(false);
        fn();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="dx-row-menu" ref={ref}>
      <button
        type="button"
        className="dk-icobtn dx-row-more"
        aria-label={`More for ${row.fileName ?? 'this export'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="export-row-more"
      >
        <Svg d={ICONS.more} size={16} width={2.6} />
      </button>
      {open && (
        <div className="dk-menu" role="menu" aria-label="Export">
          {ready && item('Download', () => actions.onDownload(row), 'export-row-download')}
          {ready && item('Copy link', () => actions.onCopyLink(row), 'export-row-copy')}
          {row.state !== 'running' &&
            item('Export again with the same options', () => actions.onExportAgain(row), 'export-row-again')}
          {row.state === 'running' && item('Stop', () => actions.onStop(row), 'export-row-stop-menu')}
          {row.state !== 'running' && item('Delete the file', () => actions.onRemove(row), 'export-row-remove')}
        </div>
      )}
    </div>
  );
}

/**
 * The history list.
 * @param props.projectId - The project.
 * @param props.layout - Rows on a desktop or tablet, cards on a phone.
 * @param props.actions - What the buttons do.
 */
export function ExportHistory({
  projectId,
  layout,
  actions,
}: {
  projectId: string;
  layout: DocsLayout;
  actions: HistoryActions;
}) {
  const q = useExportHistory(projectId);
  const rows = q.data ?? [];
  const phone = layout === 'phone';
  if (q.isLoading) return <p className="dx-line">Loading your exports…</p>;
  if (q.isError) return <p className="dx-line dx-line-err">Couldn’t load your exports. Check the connection.</p>;
  return (
    <div className="dx-hist" data-testid="export-history">
      {rows.length === 0 ? (
        <div className="dx-empty" data-testid="export-history-empty">
          <Svg d={ICONS.download} size={22} />
          <b>No exports yet</b>
          Files you export are listed here for 7 days, so you can download them again.
          <button type="button" className="st-btn st-btn-primary" onClick={actions.onNewExport}>
            New export
          </button>
        </div>
      ) : (
        rows.map((r) => {
          const tag = STATE_TAG[r.state];
          const sub = [
            phone ? null : scopeText(r.scope),
            r.scope === 'space' && !phone ? FORMAT_LABEL[r.format] : null,
            r.size ? fmtSize(r.size) : phone ? scopeText(r.scope) : null,
            phone ? whenText(r.createdAt) : null,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <div key={r.id} className="dx-row" data-testid="export-row" data-state={r.state}>
              {!phone && <FormatBadge format={r.format} size={36} />}
              <div className="dx-row-main">
                <div className="dx-row-name">
                  <span>{r.fileName ?? 'Export'}</span>
                  {tag && !phone && <span className={`dx-tag ${tag[1]}`}>{tag[0]}</span>}
                </div>
                <div className="dx-row-sub">{sub}</div>
                {r.state === 'failed' && r.error && <div className="dx-row-sub">{r.error}</div>}
                {phone && tag && r.state !== 'running' && <span className={`dx-tag ${tag[1]}`}>{tag[0]}</span>}
              </div>
              {!phone && <span className="dx-row-when">{whenText(r.createdAt)}</span>}
              {r.state === 'ready' ? (
                <button
                  type="button"
                  className="st-btn dx-row-btn"
                  onClick={() => actions.onDownload(r)}
                  data-testid="export-row-download-btn"
                >
                  <Svg d={ICONS.download} size={14} /> Download
                </button>
              ) : r.state === 'running' ? (
                <button
                  type="button"
                  className="st-btn st-btn-danger-outline dx-row-btn"
                  onClick={() => actions.onStop(r)}
                  data-testid="export-row-stop"
                >
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className="st-btn dx-row-btn"
                  onClick={() => actions.onExportAgain(r)}
                  data-testid="export-row-again-btn"
                >
                  Export again
                </button>
              )}
              <RowMenu row={r} actions={actions} />
            </div>
          );
        })
      )}
      <p className="dx-line" style={{ marginTop: 12 }}>
        Files are kept for 7 days. History shows your last 20 exports.
      </p>
    </div>
  );
}
