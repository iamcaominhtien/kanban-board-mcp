import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCanvas as useCanvasQuery, useCanvasThreads, type CanvasBoard } from '../../api/canvases';
import { useCanvas, type ViewCanvasRequest } from './CanvasContext';
import { BoardFrame, boardThumbUrl } from './BoardFrame';
import { CanvasIcon } from './CanvasIcon';
import { CommentsPanel } from './CommentsPanel';
import { NOTE_BG } from './CanvasStatic';
import { orderedBoards, stepBoard } from './planeMath';
import { useSize } from './useWidth';
import styles from './Canvas.module.css';

type Width = 'desktop' | 'tablet' | 'phone';
const WIDTHS: Record<Width, number> = { desktop: 1280, tablet: 820, phone: 390 };

interface Props {
  request: ViewCanvasRequest;
  /** `view` is the large view of an embed; `present` is the dark full screen. */
  mode: 'view' | 'present';
  me: string;
  onClose: () => void;
  /** Called with "Open canvas" (the editor). */
  onEdit?: (canvasId: string, boardId?: string) => void;
}

/**
 * The large view of a canvas, from an embed: step through the boards in order, a filmstrip, the width switch, the
 * comments panel and the all-boards grid (G). Read only for everyone, takes no lock. With `mode="present"` it is the
 * dark full screen for a meeting.
 * @param props.request - Which canvas, board and page tab.
 * @param props.mode - Large view or Present.
 * @param props.me - Who is looking.
 * @param props.onClose - Called on Close or Esc.
 * @param props.onEdit - Open the editor.
 */
export function CanvasViewer({ request, mode, me, onClose, onEdit }: Props) {
  const api = useCanvas();
  const q = useCanvasQuery(request.id);
  const c = q.data;
  const [page, setPage] = useState<string | undefined>(request.pageId);
  const [current, setCurrent] = useState<string | null>(request.boardId ?? null);
  const [width, setWidth] = useState<Width>('desktop');
  const [grid, setGrid] = useState(false);
  const [side, setSide] = useState(!!request.comments);
  const [notes, setNotes] = useState(false);
  const [barVisible, setBarVisible] = useState(true);
  const [selThread, setSelThread] = useState<string | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const { ref: stageRef, size } = useSize<HTMLDivElement>();
  const present = mode === 'present';

  const pageId = page ?? c?.doc.pages[0]?.id;
  const list = useMemo(() => (c && pageId ? orderedBoards(c.doc, pageId) : []), [c, pageId]);
  const board: CanvasBoard | undefined = list.find((b) => b.id === current) ?? list[0];
  const index = board ? list.findIndex((b) => b.id === board.id) : -1;
  const threads = useCanvasThreads(request.id, !!c && (side || (present && notes)));

  const go = useCallback(
    (dir: 1 | -1) => {
      const next = stepBoard(list, board?.id ?? null, dir);
      if (next) setCurrent(next.id);
    },
    [list, board],
  );

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable=true]')) {
        if (e.key === 'Escape') (target as HTMLElement).blur();
        return;
      }
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        if (grid) setGrid(false);
        else onClose();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault();
        go(1);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
        e.preventDefault();
        go(-1);
      } else if (e.key.toLowerCase() === 'g') {
        setGrid((v) => !v);
      } else if (e.key.toLowerCase() === 'p' && !present && c) {
        api.present({ id: c.id, boardId: board?.id, pageId });
        onClose();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [go, grid, onClose, present, api, c, board, pageId]);

  // Present: the small bar shows on mouse move and hides after 3 seconds
  useEffect(() => {
    if (!present) return;
    const show = () => {
      setBarVisible(true);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setBarVisible(false), 3000);
    };
    show();
    window.addEventListener('mousemove', show);
    return () => {
      window.removeEventListener('mousemove', show);
      window.clearTimeout(hideTimer.current);
    };
  }, [present]);

  const pad = present ? 24 : 60;
  const shownW = board ? (board.kind === 'html' || board.kind === 'empty' ? WIDTHS[width] : board.w) : 0;
  const shown = board ? { ...board, w: present ? board.w : shownW } : undefined;
  const scale = shown ? Math.max(0.05, Math.min((size.w - pad * 2) / shown.w, (size.h - pad * 2) / shown.h, 1.6)) : 1;

  const near = useMemo(() => {
    if (!c || !board) return [];
    const ids = new Set(
      c.doc.arrows.filter((a) => a.from === board.id || a.to === board.id).flatMap((a) => [a.from, a.to]),
    );
    return c.doc.notes.filter((n) => ids.has(n.id));
  }, [c, board]);

  const empty = !!c && !list.length;
  let content;
  if (q.isLoading) content = <div style={{ margin: 'auto', color: '#9db3a5' }}>Loading…</div>;
  else if (q.isError || !c)
    content = (
      <div style={{ margin: 'auto', textAlign: 'center' }} data-testid="canvas-viewer-missing">
        <b>Canvas not found</b>
        <div style={{ color: '#9db3a5' }}>It was deleted, or you do not have access.</div>
      </div>
    );
  else if (empty) content = <div style={{ margin: 'auto', color: '#9db3a5' }}>This page has no frames yet.</div>;
  else if (grid) {
    content = (
      <div className={styles.gridView} data-testid="canvas-grid">
        {list.map((b, i) => (
          <button
            key={b.id}
            type="button"
            className={`${styles.gridCell} ${b.id === board?.id ? styles.gridCellOn : ''}`}
            onClick={() => {
              setCurrent(b.id);
              setGrid(false);
            }}
          >
            <span className={styles.gridThumb}>
              <img src={boardThumbUrl(c.id, b)} alt={b.name} loading="lazy" />
            </span>
            <div style={{ marginTop: 6, fontWeight: 700, fontSize: 13 }}>
              {i + 1} · {b.name}
            </div>
            <div style={{ color: '#9db3a5', fontSize: 12 }}>
              {Math.round(b.w)} x {Math.round(b.h)}
            </div>
          </button>
        ))}
      </div>
    );
  } else if (shown) {
    content = (
      <div
        className={styles.viewerStage}
        ref={stageRef}
        style={present ? { background: '#0b120d', overflow: 'hidden' } : undefined}
      >
        {list.length > 1 && (
          <>
            <button
              type="button"
              className={styles.navBtn}
              style={{ left: 14 }}
              aria-label="Previous board"
              onClick={() => go(-1)}
            >
              <CanvasIcon name="left" size={20} />
            </button>
            <button
              type="button"
              className={styles.navBtn}
              style={{ right: 14 }}
              aria-label="Next board"
              onClick={() => go(1)}
            >
              <CanvasIcon name="right" size={20} />
            </button>
          </>
        )}
        <div
          className={styles.viewerBoard}
          data-testid="canvas-viewer-board"
          style={{ width: shown.w * scale, height: shown.h * scale }}
        >
          <BoardFrame canvasId={c.id} board={shown} scale={scale} live />
        </div>
        {present && notes && near.length > 0 && (
          <div
            style={{
              position: 'fixed',
              left: 24,
              top: 24,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              maxWidth: 220,
            }}
          >
            {near.map((n) => (
              <div
                key={n.id}
                style={{
                  background: NOTE_BG[n.color],
                  color: '#3a2e0a',
                  padding: '9px 10px',
                  borderRadius: 3,
                  font: "500 18px/1.15 'Caveat', cursive",
                  boxShadow: '0 3px 8px rgba(0,0,0,.3)',
                }}
              >
                {n.text}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  const tabs = c && c.doc.pages.length > 1 && (grid || !present) && (
    <div className={styles.tabs} style={{ background: '#0b120d', borderColor: '#1e2a22' }}>
      {c.doc.pages.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`${styles.tab} ${p.id === pageId ? styles.tabOn : ''}`}
          onClick={() => {
            setPage(p.id);
            setCurrent(null);
          }}
        >
          {p.name}
        </button>
      ))}
    </div>
  );

  return createPortal(
    <div
      className={present ? styles.present : `${styles.root} ${styles.viewer}`}
      role="dialog"
      aria-modal="true"
      aria-label={c?.title ?? 'Canvas'}
      data-testid={present ? 'canvas-present' : 'canvas-viewer'}
      data-canvas-layer
      style={present ? { display: 'flex', flexDirection: 'column', alignItems: 'stretch' } : undefined}
    >
      {!present && (
        <div className={styles.viewerBar}>
          <span className={styles.chip}>
            <CanvasIcon name="canvas" size={12} /> CANVAS
          </span>
          <b style={{ fontSize: 15 }}>{c?.title ?? 'Canvas'}</b>
          {board && (
            <span className={styles.hint}>
              {index + 1} of {list.length} · {board.name}
            </span>
          )}
          <span className={styles.spacer} />
          <div className={styles.segmented} role="group" aria-label="Page width">
            {(['desktop', 'tablet', 'phone'] as Width[]).map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={width === w}
                onClick={() => setWidth(w)}
                title={`${WIDTHS[w]} px`}
              >
                <CanvasIcon name={w} size={14} /> {w[0].toUpperCase() + w.slice(1)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm} ${grid ? styles.btnOn : ''}`}
            aria-pressed={grid}
            onClick={() => setGrid((v) => !v)}
            title="All boards (G)"
          >
            <CanvasIcon name="grid" size={14} /> All
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm} ${side ? styles.btnOn : ''}`}
            aria-pressed={side}
            onClick={() => setSide((v) => !v)}
          >
            <CanvasIcon name="comment" size={14} /> Comments
            {!!c?.openComments && <span className={styles.count}>{c.openComments}</span>}
          </button>
          {c && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => {
                api.present({ id: c.id, boardId: board?.id, pageId });
                onClose();
              }}
              title="Present (P)"
            >
              <CanvasIcon name="present" size={14} /> Present
            </button>
          )}
          {c?.canEdit && onEdit && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => onEdit(c.id, board?.id)}
              data-testid="canvas-open-editor"
            >
              Open canvas
            </button>
          )}
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm}`}
            onClick={onClose}
            autoFocus
            data-testid="canvas-viewer-close"
          >
            Close
          </button>
        </div>
      )}
      {tabs}
      <div className={styles.viewerMain} style={{ position: 'relative' }}>
        {content}
        {!present && side && c && (
          <aside className={styles.viewerSide} data-testid="canvas-viewer-comments">
            <div className={styles.sideBody}>
              <CommentsPanel
                canvasId={c.id}
                title={c.title}
                threads={threads.data ?? []}
                boards={c.doc.boards}
                boardId={board?.id ?? null}
                selectedThread={selThread}
                onSelectThread={setSelThread}
                canComment={c.role !== 'viewer'}
                me={me}
                filters={['open', 'resolved', 'board']}
                newOnBoard
              />
            </div>
          </aside>
        )}
        {present && notes && side && c && (
          <aside className={styles.presentComments}>
            <CommentsPanel
              canvasId={c.id}
              title={c.title}
              threads={threads.data ?? []}
              boards={c.doc.boards}
              boardId={board?.id ?? null}
              selectedThread={selThread}
              onSelectThread={setSelThread}
              canComment={false}
              me={me}
              filters={['open']}
            />
          </aside>
        )}
      </div>
      {!present && list.length > 1 && !grid && c && (
        <div className={styles.filmstrip} data-testid="canvas-filmstrip">
          {list.map((b, i) => (
            <button
              key={b.id}
              type="button"
              className={`${styles.film} ${b.id === board?.id ? styles.filmOn : ''}`}
              onClick={() => setCurrent(b.id)}
              title={`${i + 1} · ${b.name}`}
              aria-label={b.name}
            >
              <img src={boardThumbUrl(c.id, b)} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {!present && <div className={styles.keysHint}>← → move · Space next · G all boards · P present · Esc close</div>}
      {present && (
        <div
          className={`${styles.presentBar} ${barVisible ? '' : styles.presentBarHidden}`}
          role="toolbar"
          aria-label="Present"
        >
          <button type="button" className={styles.pbBtn} onClick={() => go(-1)} aria-label="Previous">
            <CanvasIcon name="left" size={16} />
          </button>
          <span style={{ padding: '0 8px', fontWeight: 700 }} data-testid="present-position">
            {index + 1} / {list.length}
          </span>
          <button type="button" className={styles.pbBtn} onClick={() => go(1)} aria-label="Next">
            <CanvasIcon name="right" size={16} />
          </button>
          <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.2)', margin: '0 4px' }} />
          <button
            type="button"
            className={`${styles.pbBtn} ${notes ? styles.pbOn : ''}`}
            aria-pressed={notes}
            onClick={() => setNotes((v) => !v)}
          >
            <CanvasIcon name="note" size={14} /> Notes
          </button>
          <button
            type="button"
            className={`${styles.pbBtn} ${side ? styles.pbOn : ''}`}
            aria-pressed={side}
            onClick={() => {
              setSide((v) => !v);
              setNotes(true);
            }}
          >
            <CanvasIcon name="comment" size={14} /> Comments
          </button>
          <button
            type="button"
            className={`${styles.pbBtn} ${grid ? styles.pbOn : ''}`}
            aria-pressed={grid}
            onClick={() => setGrid((v) => !v)}
            title="All boards (G)"
          >
            <CanvasIcon name="grid" size={14} />
          </button>
          <span style={{ width: 1, height: 18, background: 'rgba(255,255,255,.2)', margin: '0 4px' }} />
          <button type="button" className={styles.pbBtn} onClick={onClose} data-testid="present-exit">
            Exit
          </button>
        </div>
      )}
    </div>,
    document.body,
  );
}
