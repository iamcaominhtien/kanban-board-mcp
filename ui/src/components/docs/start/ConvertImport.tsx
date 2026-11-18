/**
 * The Import dialog for Word files, HTML files and pasted text (design "Starting and shaping a page", frames 27-36 and
 * 50-54, 57): choose files (each listed with its size, a problem said on its row), where they go, then Import. Each
 * file is converted in the browser and saved as a draft page; Stop keeps what is in; a failed file shows its reason
 * with Retry for that one; when the server cannot be reached nothing is lost and the files stay chosen.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { docsKeys } from '../../../api/docs';
import type { DocsTreeNode } from '../../../types/docs';
import { useToast } from '../../Toast';
import { Icon } from '../Icon';
import {
  fileProblem,
  formatSize,
  guessPaste,
  joinWords,
  pasteFindings,
  projectPictureUpload,
  type ImportSource,
  type PasteKind,
} from './importConvert';
import { runImport, type ImportRow, type RunResult } from './importRun';
import { ImportNotes, ImportSourceTiles, importDialogName, sourceHint } from './ImportSources';
import './start.css';

/** Props of {@link ConvertImport}. */
export interface ConvertImportProps {
  projectId: string;
  nodes: DocsTreeNode[];
  source: Exclude<ImportSource, 'markdown'>;
  onSource: (s: ImportSource) => void;
  initialFiles?: File[];
  /** Text to start the Paste box with (from the clipboard). */
  initialText?: string;
  initialParentId?: string | null;
  /** Phone: a full-screen sheet with 64 px tiles and full-width buttons. */
  phone?: boolean;
  onClose: () => void;
  /** Called with the created page ids when the import ends (also after the dialog was closed). */
  onDone: (created: string[]) => void;
}

let seq = 0;
const rowOf = (file: File): ImportRow => ({
  key: `f${++seq}`,
  name: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
  size: file.size,
  file,
  problem: fileProblem(file),
  status: 'ready',
});

const KIND_LABEL: Record<PasteKind, string> = { html: 'HTML', markdown: 'Markdown', text: 'plain text' };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The dialog body for Word, HTML and Paste (Markdown has the server import, in ImportDialog).
 * @param props.source - `word`, `html` or `paste`.
 * @param props.onSource - Switches the tile (Markdown hands back to the Markdown import).
 */
export function ConvertImport({
  projectId,
  nodes,
  source,
  onSource,
  initialFiles,
  initialText = '',
  initialParentId = null,
  phone = false,
  onClose,
  onDone,
}: ConvertImportProps) {
  const toast = useToast();
  const qc = useQueryClient();
  const [rows, setRows] = useState<ImportRow[]>(() => (initialFiles ?? []).map(rowOf));
  const [parentId, setParentId] = useState<string | null>(initialParentId);
  const [phase, setPhase] = useState<'choose' | 'running' | 'done'>('choose');
  const [result, setResult] = useState<RunResult | null>(null);
  const [created, setCreated] = useState<string[]>([]);
  const [text, setText] = useState(initialText);
  const guessed = useMemo(() => guessPaste(text), [text]);
  const [kindOverride, setKindOverride] = useState<PasteKind | null>(null);
  const kind = kindOverride ?? guessed;
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteTitleTouched, setPasteTitleTouched] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stopRef = useRef(false);
  const mounted = useRef(true);
  const filesInput = useRef<HTMLInputElement>(null);
  const toastRef = useRef(toast);
  toastRef.current = toast;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => setKindOverride(null), [guessed]);
  // the paste's title comes from its first heading until the person types one
  useEffect(() => {
    if (pasteTitleTouched) return;
    const h =
      kind === 'html'
        ? /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(text)?.[1]?.replace(/<[^>]+>/g, '')
        : kind === 'markdown'
          ? /^#\s+(.+)$/m.exec(text)?.[1]
          : text.split('\n').find((l) => l.trim());
    setPasteTitle((h ?? '').trim().slice(0, 120));
  }, [text, kind, pasteTitleTouched]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const paste = source === 'paste';
  const sendable = rows.filter((r) => !r.problem);
  const placeLabel = parentId ? (nodes.find((n) => n.id === parentId)?.title ?? 'Top level') : 'Top level';
  const update = (key: string, patch: Partial<ImportRow>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const addFiles = (list: FileList | File[]) => setRows((rs) => [...rs, ...Array.from(list).map(rowOf)]);

  async function go(only?: ImportRow[]) {
    let batch = only ?? sendable;
    if (!only && paste) {
      const row: ImportRow = {
        key: 'paste',
        name: pasteTitle.trim() || 'Pasted page',
        size: new Blob([text]).size,
        paste: { text, kind, title: pasteTitle },
        problem: null,
        status: 'ready',
      };
      setRows([row]);
      batch = [row];
    }
    if (!batch.length) return;
    stopRef.current = false;
    setStopping(false);
    const keys = new Set(batch.map((r) => r.key));
    // rows of an earlier run that still did not come in (a retry of one file leaves the others as they were)
    const othersLeft = rows.filter(
      (r) => !keys.has(r.key) && !r.problem && (r.status === 'failed' || (phase === 'done' && r.status === 'waiting')),
    ).length;
    setRows((rs) => rs.map((r) => (keys.has(r.key) ? { ...r, status: 'waiting', reason: undefined } : r)));
    setPhase('running');
    const res = await runImport(
      batch.map((r) => ({ ...r, status: 'waiting' })),
      {
        projectId,
        parentId,
        upload: projectPictureUpload(projectId),
        stopped: () => stopRef.current,
        update,
        onPage: () => void qc.invalidateQueries({ queryKey: docsKeys.tree(projectId) }),
      },
    );
    const all = [...created, ...res.created];
    setCreated(all);
    // the server could not be reached and nothing came in: back to the chosen files, nothing lost
    if (res.offline && all.length === 0) {
      setRows((rs) => rs.map((r) => (r.status === 'failed' || r.status === 'waiting' ? { ...r, status: 'ready' } : r)));
      setResult(res);
      setPhase('choose');
      return;
    }
    setResult(res);
    const t = toastRef.current;
    if (!res.failed && !res.stopped && !res.offline && othersLeft === 0) {
      t.success(`Imported ${plural(all.length, 'page')} into ${placeLabel}.`);
      onDone(all);
      if (mounted.current) onClose();
      return;
    }
    if (!mounted.current) {
      t.warning('Import finished with a problem', `${all.length} pages were imported. Open Import to try the rest.`);
      onDone(all);
      return;
    }
    setPhase('done');
  }

  const doneRows = rows.filter((r) => r.status === 'done').length;
  const failedRows = rows.filter((r) => r.status === 'failed');
  const notImported = rows.filter((r) => !r.problem && (r.status === 'waiting' || r.status === 'ready'));
  const total = rows.filter((r) => !r.problem).length;
  const offlineNothing = phase === 'choose' && result?.offline && created.length === 0;

  const finishWith = () => {
    onDone(created);
    onClose();
  };

  const stateText = (r: ImportRow) => {
    if (r.problem) return { text: r.problem.title, color: '#C4432A' };
    switch (r.status) {
      case 'done':
        return phase === 'done' && !result?.stopped
          ? { text: '', color: '#2E6F40' }
          : { text: phase === 'done' ? 'imported' : 'Imported', color: '#2E6F40' };
      case 'working':
        return { text: `${r.pct ?? 0}%`, color: '#5B6B60' };
      case 'failed':
        return { text: phase === 'done' ? '' : 'Failed', color: '#C4432A' };
      case 'waiting':
        return { text: phase === 'done' ? 'not imported' : 'Waiting', color: '#5B6B60' };
      default:
        return { text: offlineNothing ? formatSize(r.size) : 'Ready', color: '#5B6B60' };
    }
  };

  // the rows (frames 29, 30, 32): a 20 px state mark, the name 13/600, its state or size on the right
  const markOf = (r: ImportRow) =>
    r.status === 'working' ? (
      <span className="mc-spin dk-imp-spin" aria-hidden="true" />
    ) : (
      <span className="dk-imp-mark" aria-hidden="true">
        {r.status === 'done' && <Icon name="check" size={12} strokeWidth={2.6} />}
        {(r.status === 'failed' || r.problem) && <Icon name="i08" size={11} strokeWidth={2.4} />}
      </span>
    );
  const fileRows = (
    <div className="dk-imp-list" data-testid="import-rows">
      {rows.map((r) => {
        const st = stateText(r);
        const state = r.problem || r.status === 'failed' ? 'failed' : (r.status ?? 'ready');
        const tall = !!(r.problem || (r.status === 'failed' && r.reason) || (r.status === 'done' && r.dropped));
        return (
          <div
            key={r.key}
            className={`dk-imp-row${tall ? ' dk-imp-row-tall' : ''}`}
            data-state={state}
            data-testid="import-row"
          >
            {markOf(r)}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span className="dk-imp-name">{r.name}</span>
                {phase === 'choose' && <span className="dk-imp-size">{formatSize(r.size)}</span>}
              </div>
              {r.problem && <div className="dk-imp-why">{r.problem.text}</div>}
              {r.status === 'failed' && r.reason && (
                <div role="alert" className="dk-imp-why">
                  {r.reason}
                </div>
              )}
              {r.status === 'done' && !!r.dropped && (
                <div className="dk-imp-why dk-imp-why-warn">
                  {plural(r.dropped, 'picture')} could not be kept and {r.dropped === 1 ? 'was' : 'were'} left out.
                </div>
              )}
              {r.status === 'working' && (
                <div className="dk-imp-bar">
                  <div style={{ width: `${r.pct ?? 0}%` }} />
                </div>
              )}
            </div>
            {st.text && (
              <span className={r.status === 'working' ? 'dk-imp-pct' : 'dk-imp-state'} style={{ color: st.color }}>
                {st.text}
              </span>
            )}
            {r.status === 'failed' && phase === 'done' && (
              <button type="button" className="st-btn" data-testid="import-retry" onClick={() => void go([r])}>
                Retry
              </button>
            )}
            {phase === 'choose' && !paste && (
              <button
                type="button"
                className="dk-icobtn"
                aria-label={`Remove ${r.name}`}
                onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
              >
                <Icon name="close" size={14} strokeWidth={1.9} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );

  const placeSelect = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 0 }}>
      <label className="st-field-label" htmlFor="docs-import-place" style={{ fontSize: 11 }}>
        Place under
      </label>
      <select
        id="docs-import-place"
        className="st-input"
        value={parentId ?? ''}
        onChange={(e) => setParentId(e.target.value || null)}
      >
        <option value="">Top level (no parent)</option>
        {nodes.map((n) => (
          <option key={n.id} value={n.id}>
            {n.title}
          </option>
        ))}
      </select>
    </div>
  );

  // frame 31: the paste's Title beside Place under
  const pasteTitleField = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minWidth: 0 }}>
      <label className="st-field-label" htmlFor="docs-paste-title" style={{ fontSize: 11 }}>
        Title
      </label>
      <input
        id="docs-paste-title"
        className="st-input"
        value={pasteTitle}
        placeholder="Page title"
        onChange={(e) => {
          setPasteTitle(e.target.value);
          setPasteTitleTouched(true);
        }}
      />
    </div>
  );

  const accept = source === 'word' ? '.docx' : '.html,.htm';
  const chooseBody = paste ? (
    <>
      <textarea
        className="dks-paste"
        aria-label="Pasted text"
        placeholder="Paste text, Markdown or HTML here"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      {text.trim() && (
        <div className="dk-paste-guess">
          <span className="dk-paste-chip" data-testid="paste-guess">
            Looks like {KIND_LABEL[kind]}
          </span>
          <span className="dk-paste-meta">
            {formatSize(new Blob([text]).size)}
            {pasteFindings(text, kind).length ? ` · ${joinWords(pasteFindings(text, kind))} found` : ''}
          </span>
          {(['html', 'markdown', 'text'] as const)
            .filter((k) => k !== kind)
            .map((k) => (
              <button key={k} type="button" className="dk-paste-switch" onClick={() => setKindOverride(k)}>
                Treat as {KIND_LABEL[k]}
              </button>
            ))}
        </div>
      )}
    </>
  ) : (
    <>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragging(false);
          if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
        }}
        style={{
          display: 'flex',
          flexDirection: phone ? 'column' : 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          padding: rows.length ? '10px 14px' : '26px 14px',
          borderRadius: 10,
          border: dragging ? '2px dashed #2E6F40' : '1.5px dashed #C7D2CB',
          background: dragging ? '#F1F8F3' : '#FBFCFB',
          fontSize: 12.5,
          color: '#5B6B60',
        }}
      >
        <Icon name="i26" size={20} strokeWidth={1.9} style={{ color: '#9AA8A0' }} />
        {rows.length ? 'Drop more files here, or' : phone ? 'Choose from your device' : 'Drop files here, or'}
        <button type="button" className="st-btn st-btn-sm" onClick={() => filesInput.current?.click()}>
          {rows.length ? 'Add more' : 'Choose files…'}
        </button>
      </div>
      <div style={{ fontSize: 12, color: '#5B6B60' }}>{sourceHint(source)}</div>
      {rows.length > 0 && fileRows}
      <ImportNotes source={source} />
    </>
  );

  const title =
    phase === 'running'
      ? 'Importing'
      : phase === 'done'
        ? result?.stopped && !result.failed
          ? 'Import stopped'
          : 'Import finished with a problem'
        : offlineNothing
          ? 'Import failed'
          : 'Import';
  const subtitle =
    phase === 'choose' && !offlineNothing
      ? paste
        ? 'Paste text, Markdown or HTML'
        : rows.length
          ? `${plural(rows.length, source === 'word' ? 'Word file' : 'HTML file')} chosen`
          : 'Bring pages in from other tools'
      : `${source === 'paste' ? 'Pasted text' : source === 'word' ? 'Word files' : 'HTML files'} into ${placeLabel}`;

  let body: React.ReactNode;
  if (phase === 'running') {
    body = (
      <>
        <div className="dk-imp-progress">
          <div
            className="dk-imp-total"
            role="progressbar"
            aria-valuenow={total ? Math.round((doneRows / total) * 100) : 0}
          >
            <div style={{ width: `${total ? (doneRows / total) * 100 : 0}%` }} />
          </div>
          <span className="dk-imp-count">
            {Math.min(total, doneRows + 1)} of {total}
          </span>
        </div>
        {fileRows}
        <div className="dk-imp-hint">
          {phone
            ? 'You can leave this screen. Import keeps going and a toast tells you when it is done.'
            : 'You can keep working. The tree fills in as pages arrive.'}
        </div>
      </>
    );
  } else if (phase === 'done') {
    body = (
      <>
        {result?.stopped && !result.failed ? (
          <div className="dk-imp-alert dk-imp-alert-info" data-testid="import-summary">
            <b>Import stopped.</b> {doneRows} of {total} pages were imported before you stopped. They stay in the tree.
          </div>
        ) : (
          <div className="dk-imp-alert" data-testid="import-summary">
            <b>
              {doneRows} of {plural(total, 'file')} were imported.
            </b>{' '}
            {failedRows.length === 1 ? 'One could not be read.' : `${failedRows.length} could not be read.`}
          </div>
        )}
        {fileRows}
      </>
    );
  } else if (offlineNothing) {
    body = (
      <>
        <div role="alert" className="dk-imp-alert" data-testid="import-offline">
          <b>Nothing was imported.</b> We could not reach the server. Your files are still here; try again when you are
          back online.
        </div>
        {paste ? chooseBody : fileRows}
      </>
    );
  } else {
    body = (
      <>
        <ImportSourceTiles value={source} onChange={onSource} />
        {chooseBody}
        {paste ? (
          <div className="dk-imp-fields">
            {pasteTitleField}
            {placeSelect}
          </div>
        ) : (
          placeSelect
        )}
      </>
    );
  }

  const canImport = paste ? !!text.trim() : sendable.length > 0;
  const importLabel = paste ? 'Import' : sendable.length > 0 ? `Import ${plural(sendable.length, 'file')}` : 'Import';
  const firstProblem = rows.find((r) => r.problem && r.problem.code !== 'markdown');

  let foot: React.ReactNode;
  if (phase === 'running') {
    foot = (
      <button
        type="button"
        className="st-btn st-btn-danger-outline"
        style={phone ? { flex: 1 } : { marginLeft: 'auto' }}
        disabled={stopping}
        onClick={() => {
          stopRef.current = true;
          setStopping(true);
        }}
        data-testid="import-stop"
      >
        {stopping ? 'Stopping…' : 'Stop importing'}
      </button>
    );
  } else if (phase === 'done') {
    foot = (
      <>
        {!phone && <div style={{ flex: 1 }} />}
        {result?.stopped && notImported.length > 0 && (
          <button type="button" className="st-btn" onClick={() => void go(notImported)}>
            Import the other {notImported.length}
          </button>
        )}
        {created.length > 0 && !result?.stopped && (
          <button type="button" className="st-btn" onClick={finishWith}>
            Open the {plural(created.length, 'new page')}
          </button>
        )}
        <button
          type="button"
          className="st-btn st-btn-primary"
          style={phone ? { flex: 1 } : undefined}
          onClick={finishWith}
        >
          Done
        </button>
      </>
    );
  } else {
    foot = (
      <>
        {!phone && (
          <span style={{ fontSize: 12, color: '#5B6B60' }}>
            {firstProblem ? `${firstProblem.name} cannot be imported.` : 'Nothing changes until you import.'}
          </span>
        )}
        {!phone && <div style={{ flex: 1 }} />}
        {!phone && (
          <button type="button" className="st-btn" onClick={onClose}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="st-btn st-btn-primary"
          style={phone ? { flex: 1 } : undefined}
          disabled={!canImport}
          onClick={() => void go()}
          data-testid="import-go"
        >
          <Icon name="i26" size={14} strokeWidth={1.9} />
          {offlineNothing ? 'Try again' : importLabel}
        </button>
      </>
    );
  }

  return (
    <div
      className="docs-root"
      role="dialog"
      aria-modal="true"
      aria-label={importDialogName(source)}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(30,42,34,0.42)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: phone ? 0 : 16,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: phone ? '100%' : 520,
          height: phone ? '100%' : undefined,
          maxWidth: '100%',
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: phone ? 0 : 16,
          border: phone ? 'none' : '1px solid #E3E8E5',
          boxShadow: '0 24px 60px rgba(30,42,34,0.22)',
          background: '#FFFFFF',
          overflow: 'hidden',
          boxSizing: 'border-box',
        }}
      >
        <div className="dk-np-head">
          <div className="dk-np-badge">
            <Icon name="i26" size={17} strokeWidth={1.9} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="dk-np-title">{title}</div>
            <div className="dk-np-sub">{subtitle}</div>
          </div>
          <button type="button" className="dk-np-x" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={16} strokeWidth={1.9} />
          </button>
        </div>
        <div
          style={{
            padding: '18px 22px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            overflowY: 'auto',
            minHeight: 0,
            flex: phone ? 1 : undefined,
          }}
        >
          {body}
        </div>
        <div className="dk-np-foot">{foot}</div>
        <input
          ref={filesInput}
          type="file"
          multiple
          accept={accept}
          hidden
          data-testid="import-file-input"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
