import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  addBoard,
  boardFileUrl,
  canvasFailure,
  fetchBoardSource,
  heartbeatBoard,
  lockBoard,
  saveBoardContent,
  unlockBoard,
  type CanvasBoard,
  type CanvasFailure,
} from '../../api/canvases';
import { formatFileSize } from '../../utils/fileIcons';
import { CanvasIcon } from './CanvasIcon';
import { dataUrl, previewDocument } from './sourcePreview';
import styles from './Canvas.module.css';

interface Props {
  canvasId: string;
  canvasTitle: string;
  board: CanvasBoard;
  /** Lock idle time in seconds (from the server's limits). */
  lockIdleSeconds?: number;
  /** Called after Save to canvas, with the saved board. */
  onSaved: (board: CanvasBoard) => void;
  /** Called on Cancel, or when the editor could not start. */
  onClose: () => void;
  /** A new board was made from a lost-lock draft ("Save as new board"). */
  onNewBoard?: (board: CanvasBoard) => void;
}

type Width = 'desktop' | 'tablet' | 'phone';
const PREVIEW: Record<Width, string> = { desktop: '100%', tablet: '768px', phone: '390px' };
const draftKey = (c: string, b: string) => `kanban-canvas-source:${c}:${b}`;
const TEXT = /\.(html?|css|txt|md|json)$/i;

/**
 * Edit a board's source with a live, locked preview, the same frame Preview uses. Opening it takes the lock on this
 * board (nobody else can change its content, everyone can still look, comment and move it); the lock ends on Save,
 * Cancel, closing, or after 10 idle minutes (the person is told first). A draft is kept on this computer.
 * @param props - The canvas, the board and what to do when it ends.
 */
export function SourceEditor({
  canvasId,
  canvasTitle,
  board,
  lockIdleSeconds = 600,
  onSaved,
  onClose,
  onNewBoard,
}: Props) {
  const [phase, setPhase] = useState<'locking' | 'ready' | 'busy' | 'lost' | 'blocked'>('locking');
  const [blocker, setBlocker] = useState<CanvasFailure | null>(null);
  const [files, setFiles] = useState<{ path: string; text: string }[]>([]);
  const [entry, setEntry] = useState('index.html');
  const [active, setActive] = useState('index.html');
  const [contentRev, setContentRev] = useState<number | null>(null);
  const [assets, setAssets] = useState<Record<string, string>>({});
  const [width, setWidth] = useState<Width>('desktop');
  const [error, setError] = useState<CanvasFailure | null>(null);
  const [idleWarn, setIdleWarn] = useState(false);
  const [draftKept, setDraftKept] = useState(false);
  const [copied, setCopied] = useState(false);
  const last = useRef(Date.now());
  const has = useRef(false);

  const touch = useCallback(() => {
    last.current = Date.now();
    setIdleWarn(false);
  }, []);

  // take the lock, then read the source
  useEffect(() => {
    let off = false;
    (async () => {
      try {
        await lockBoard(canvasId, board.id);
        has.current = true;
        const src = await fetchBoardSource(canvasId, board.id);
        if (off) return;
        const saved = (() => {
          try {
            const raw = localStorage.getItem(draftKey(canvasId, board.id));
            return raw
              ? (JSON.parse(raw) as { rev: number | null; files: { path: string; text: string }[]; entry: string })
              : null;
          } catch {
            return null;
          }
        })();
        const useDraft = !!saved && saved.rev === src.rev;
        const list = useDraft
          ? saved.files
          : src.files.length
            ? src.files
            : [{ path: 'index.html', text: '<h1>New frame</h1>\n' }];
        setFiles(list);
        setEntry(useDraft ? saved.entry : src.entry);
        setActive(useDraft ? saved.entry : src.entry);
        setContentRev(src.rev);
        setDraftKept(useDraft);
        setPhase('ready');
        // the board's pictures and fonts, for the preview
        const bin = board.content?.files.filter((f) => !TEXT.test(f.path)) ?? [];
        const next: Record<string, string> = {};
        await Promise.all(
          bin.slice(0, 60).map(async (f) => {
            try {
              const r = await fetch(boardFileUrl(canvasId, board.id, src.rev ?? 0, f.path));
              if (r.ok)
                next[f.path] = dataUrl(
                  await r.arrayBuffer(),
                  r.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
                );
            } catch {
              /* a missing picture shows as missing */
            }
          }),
        );
        if (!off) setAssets(next);
      } catch (e) {
        if (off) return;
        const f = canvasFailure(e);
        setBlocker(f);
        setPhase('blocked');
      }
    })();
    return () => {
      off = true;
      if (has.current) {
        has.current = false;
        void unlockBoard(canvasId, board.id).catch(() => undefined);
      }
    };
  }, [canvasId, board.id, board.content?.files]);

  // heartbeat while the person is here; stop when they have been idle, so the lock can end
  useEffect(() => {
    if (phase !== 'ready') return;
    const t = window.setInterval(async () => {
      const idle = (Date.now() - last.current) / 1000;
      setIdleWarn(idle > lockIdleSeconds * 0.9);
      if (idle > lockIdleSeconds - 5) return; // let it lapse
      try {
        const r = await heartbeatBoard(canvasId, board.id);
        if (!r.alive) {
          // the lock ended (a restart, or somebody took it): try to get it back, else say so
          try {
            await lockBoard(canvasId, board.id);
          } catch (e) {
            has.current = false;
            setBlocker(canvasFailure(e));
            setPhase('lost');
          }
        }
      } catch {
        /* offline: the draft below keeps the work */
      }
    }, 20_000);
    return () => window.clearInterval(t);
  }, [phase, canvasId, board.id, lockIdleSeconds]);

  // a draft is kept on this computer
  useEffect(() => {
    if (phase !== 'ready' && phase !== 'lost') return;
    const t = window.setTimeout(() => {
      try {
        localStorage.setItem(draftKey(canvasId, board.id), JSON.stringify({ rev: contentRev, files, entry }));
        setDraftKept(true);
      } catch {
        /* ignore */
      }
    }, 600);
    return () => window.clearTimeout(t);
  }, [files, entry, phase, canvasId, board.id, contentRev]);

  const activeFile = files.find((f) => f.path === active) ?? files[0];
  const size = useMemo(() => files.reduce((n, f) => n + new Blob([f.text]).size, 0), [files]);
  const preview = useMemo(() => {
    const text = Object.fromEntries(files.map((f) => [f.path, f.text]));
    return previewDocument(text[entry] !== undefined ? entry : (files[0]?.path ?? 'index.html'), text, assets);
  }, [files, entry, assets]);
  const lines = (activeFile?.text.match(/\n/g)?.length ?? 0) + 1;

  const clearDraft = () => {
    try {
      localStorage.removeItem(draftKey(canvasId, board.id));
    } catch {
      /* ignore */
    }
  };
  const save = async () => {
    setError(null);
    setPhase('busy');
    try {
      const out = await saveBoardContent(canvasId, board.id, {
        files,
        entry,
        baseContentRev: contentRev,
        release: true,
      });
      has.current = false;
      clearDraft();
      onSaved(out.board);
    } catch (e) {
      const f = canvasFailure(e);
      setError(f);
      setPhase(f.code === 'board_locked' ? 'lost' : 'ready');
      if (f.code === 'board_locked') setBlocker(f);
    }
  };
  const saveAsNewBoard = async () => {
    setPhase('busy');
    try {
      const form = files.map((f) => ({ file: new Blob([f.text], { type: 'text/plain' }), path: f.path }));
      const out = await addBoard(canvasId, { kind: 'html', name: `${board.name} (mine)`, entry }, form);
      clearDraft();
      onNewBoard?.(out.board);
      onClose();
    } catch (e) {
      setError(canvasFailure(e));
      setPhase('lost');
    }
  };
  const cancel = () => {
    if (has.current) {
      has.current = false;
      void unlockBoard(canvasId, board.id).catch(() => undefined);
    }
    onClose();
  };

  const setText = (text: string) => {
    touch();
    setFiles((fs) => fs.map((f) => (f.path === activeFile?.path ? { ...f, text } : f)));
  };
  const addFile = () => {
    const name = window.prompt('File name (for example style.css)', 'style.css')?.trim();
    if (!name || files.some((f) => f.path === name)) return;
    if (!TEXT.test(name)) {
      setError({
        code: 'invalid_file',
        message: 'Add an .html, .css, .txt, .md or .json file here. Pictures and fonts come with Replace content.',
        status: 422,
      });
      return;
    }
    setFiles((fs) => [...fs, { path: name, text: '' }]);
    setActive(name);
  };

  if (phase === 'blocked') {
    return createPortal(
      <div className={`${styles.scrim} ${styles.root}`} data-canvas-layer>
        <div
          className={styles.dialog}
          role="alertdialog"
          aria-label="Someone else is editing"
          data-testid="canvas-source-blocked"
        >
          <div className={styles.dialogHead}>
            {blocker?.code === 'board_locked'
              ? `${blocker.holder} is editing ${board.name}`
              : 'Could not open the source'}
          </div>
          <div className={styles.dialogBody}>
            <div>
              {blocker?.code === 'board_locked'
                ? 'You can still look, comment and move the board. Edit is off until they save or leave.'
                : blocker?.message}
            </div>
            {blocker?.code === 'board_locked' && (
              <div className={styles.hint}>
                The lock ends when they save or cancel, close the editor, or have been idle for 10 minutes.
              </div>
            )}
          </div>
          <div className={styles.dialogFoot}>
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onClose} autoFocus>
              OK
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div
      className={`${styles.root} ${styles.sourceLayer}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${board.name}`}
      data-testid="canvas-source-editor"
      data-canvas-layer
      onKeyDownCapture={(e) => {
        touch();
        if (e.key === 'Escape') {
          e.stopPropagation();
          cancel();
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          if (phase === 'ready') void save();
        }
      }}
      onPointerDownCapture={touch}
    >
      <div className={styles.header}>
        <span className={styles.chip}>
          <CanvasIcon name="code" size={12} /> HTML
        </span>
        <b style={{ fontSize: 15 }}>{board.name}</b>
        <span className={styles.hint}>on canvas {canvasTitle}</span>
        <span className={styles.spacer} />
        {phase === 'ready' && (
          <span className={styles.chip} style={{ background: '#e8f1fa' }} data-testid="canvas-locked-for-you">
            <CanvasIcon name="lock" size={12} /> Locked for you
          </span>
        )}
        {draftKept && <span className={styles.hint}>Draft kept on this computer</span>}
        <button type="button" className={styles.btn} onClick={cancel} data-testid="canvas-source-cancel">
          Cancel
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          disabled={phase !== 'ready'}
          onClick={() => void save()}
          data-testid="canvas-source-save"
        >
          {phase === 'busy' ? 'Saving…' : 'Save to canvas'}
        </button>
      </div>
      {idleWarn && phase === 'ready' && (
        <div
          className={`${styles.bannerWarn}`}
          style={{
            padding: '8px 16px',
            borderBottom: '1px solid #f1d98a',
            display: 'flex',
            gap: 12,
            alignItems: 'center',
          }}
          role="status"
        >
          <CanvasIcon name="warning" size={16} /> You have been idle. The lock on {board.name} ends in about a minute so
          others can edit it.
          <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={touch}>
            Keep editing
          </button>
        </div>
      )}
      {error && (
        <div
          className={styles.bannerErr}
          style={{ padding: '10px 16px', borderBottom: '1px solid #efb4a6' }}
          role="alert"
          data-testid="canvas-source-error"
        >
          <b>
            {error.code === 'board_too_large'
              ? `This board is ${formatFileSize(error.sizeBytes ?? size)}`
              : error.code === 'board_conflict'
                ? `${error.latestAuthor ?? 'Someone'} saved a newer version`
                : 'Could not save'}
          </b>
          <div style={{ fontSize: 13 }}>{error.message}</div>
          <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
            <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={() => setError(null)}>
              Back to editor
            </button>
            {error.code === 'board_conflict' && (
              <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={() => void saveAsNewBoard()}>
                Save as new board
              </button>
            )}
          </div>
        </div>
      )}
      {phase === 'lost' && (
        <div
          className={styles.bannerWarn}
          style={{ padding: '12px 16px', borderBottom: '1px solid #f1d98a' }}
          role="alert"
          data-testid="canvas-lock-lost"
        >
          <b>Your lock on {board.name} ended</b>
          <div style={{ fontSize: 13 }}>
            {blocker?.holder ? `${blocker.holder} is editing it now. ` : ''}Your changes are kept as a draft on this
            computer. Nothing is lost.
          </div>
          <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
              onClick={() => void saveAsNewBoard()}
            >
              Save as new board
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => {
                void navigator.clipboard
                  ?.writeText(files.map((f) => `/* ${f.path} */\n${f.text}`).join('\n\n'))
                  .then(() => setCopied(true));
              }}
            >
              {copied ? 'Copied' : 'Copy my source'}
            </button>
          </div>
        </div>
      )}
      <div className={styles.sourceBody}>
        <div className={styles.sourceCode}>
          <div className={styles.fileTabs} role="tablist">
            {files.map((f) => (
              <button
                key={f.path}
                type="button"
                role="tab"
                aria-selected={f.path === activeFile?.path}
                className={`${styles.tab} ${f.path === activeFile?.path ? styles.tabOn : ''}`}
                onClick={() => setActive(f.path)}
              >
                {f.path}
                {f.path === entry && <span className={styles.hint}>page</span>}
              </button>
            ))}
            <button type="button" className={styles.tab} onClick={addFile}>
              + Add file
            </button>
            <span className={styles.spacer} />
            <span className={styles.hint}>
              {lines} lines · {formatFileSize(size)}
            </span>
          </div>
          {phase === 'locking' ? (
            <div className={styles.hint} style={{ padding: 16 }}>
              Taking the lock…
            </div>
          ) : (
            <textarea
              className={styles.editorArea}
              value={activeFile?.text ?? ''}
              spellCheck={false}
              aria-label={`Source of ${activeFile?.path ?? 'file'}`}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && !e.shiftKey) {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const s = el.selectionStart;
                  setText(`${el.value.slice(0, s)}  ${el.value.slice(el.selectionEnd)}`);
                  requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
                }
              }}
              data-testid="canvas-source-text"
              disabled={phase !== 'ready'}
            />
          )}
        </div>
        <div className={styles.sourcePreview}>
          <div className={styles.previewBar}>
            <div className={styles.segmented} role="group" aria-label="Preview width">
              {(['desktop', 'tablet', 'phone'] as Width[]).map((w) => (
                <button key={w} type="button" aria-pressed={width === w} onClick={() => setWidth(w)}>
                  {w[0].toUpperCase() + w.slice(1)}
                </button>
              ))}
            </div>
            <span
              className={styles.chip}
              style={{ background: '#f1f8f3', color: '#1f5a31' }}
              title="Scripts, forms, pop-ups and outside requests are off"
            >
              Safe preview
            </span>
            <span className={styles.spacer} />
            <span className={styles.hint}>
              {Math.round(board.w)} x {Math.round(board.h)}
            </span>
          </div>
          <div className={styles.previewStage}>
            <iframe
              className={styles.previewFrame}
              style={{ width: PREVIEW[width] }}
              title="Live preview"
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={preview.srcDoc}
              data-testid="canvas-source-preview"
            />
          </div>
          {(preview.scripts > 0 || preview.external.images + preview.external.styles + preview.external.other > 0) && (
            <div className={styles.hint} style={{ padding: '6px 12px', background: '#fff8e1' }}>
              Left out of the preview and of the saved board:{' '}
              {[
                preview.scripts && `${preview.scripts} script${preview.scripts === 1 ? '' : 's'}`,
                preview.external.images &&
                  `${preview.external.images} outside image${preview.external.images === 1 ? '' : 's'}`,
                preview.external.styles &&
                  `${preview.external.styles} outside style${preview.external.styles === 1 ? '' : 's'}`,
                preview.external.other && `${preview.external.other} other`,
              ]
                .filter(Boolean)
                .join(', ')}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
