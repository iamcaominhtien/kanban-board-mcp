import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  canvasDownloadUrl,
  canvasFailure,
  canvasKeys,
  canvasMarkdown,
  copyCanvas,
  moveToDocs,
  useCanvas as useCanvasQuery,
} from '../../api/canvases';
import { actorName, relativeTime } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { CanvasIcon } from './CanvasIcon';
import { useCanvas } from './CanvasContext';
import { CanvasStatic } from './CanvasStatic';
import { MoveToDocsDialog } from './MoveToDocsDialog';
import { boardThumbUrl } from './BoardFrame';
import { useWidth } from './useWidth';
import styles from './Canvas.module.css';

interface Props {
  id: string;
  /** The text written in the markdown; the alt text when the canvas cannot be read. */
  label: string;
  /** One board only, from `canvas:cv_…#b_…`. */
  boardId?: string;
  /** One page tab, from `canvas:cv_…#p_…`. */
  pageId?: string;
  /** Narrower layout for tickets and comments. */
  small?: boolean;
  /** Hide Edit (a read-only history view, a viewer). */
  readOnly?: boolean;
  /** Called with the new id and title after "Save as copy", so the text can point to the copy. */
  onReplace?: (newId: string, newTitle: string) => void;
  /** Called when "Remove from text" is chosen. */
  onRemove?: () => void;
}

/**
 * A canvas inline in a markdown field: an overview of the boards (or one board), a footer with its name, the number
 * of boards and who edited it, and Edit, Download, View full size and Copy link on hover. Clicking it opens the large
 * view. It always shows the latest version.
 * @param props.id - Canvas id from `canvas:cv_…`.
 * @param props.label - Alt text from the markdown.
 * @param props.boardId - Show only this board.
 * @param props.pageId - Show this page tab.
 * @param props.small - Narrower layout.
 * @param props.readOnly - Never offer Edit.
 * @param props.onReplace - Handler for "Save as copy".
 * @param props.onRemove - Handler for "Remove from text".
 */
export function CanvasEmbed({ id, label, boardId, pageId, small, readOnly, onReplace, onRemove }: Props) {
  const api = useCanvas();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useCanvasQuery(id);
  const { ref, width } = useWidth<HTMLSpanElement>(small ? 520 : 720);
  const [menu, setMenu] = useState(false);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!menu) return;
    const off = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [menu]);

  const cls = `${styles.root} ${styles.embed} ${small ? styles.embedSmall : ''}`;
  if (q.isLoading) {
    return (
      <span className={cls} aria-busy="true" data-testid="canvas-loading">
        <span className={`${styles.embedStage} ${styles.skeleton}`} style={{ height: 180, display: 'block' }} />
      </span>
    );
  }
  if (q.isError || !q.data) {
    return (
      <span className={cls} data-testid="canvas-missing" role="note" onClick={(e) => e.stopPropagation()}>
        <span className={styles.embedState}>
          <span className={styles.embedStateTitle}>Canvas not found</span>
          <span>It was deleted, or you do not have access. Alt text: “{label}”.</span>
        </span>
      </span>
    );
  }
  const c = q.data;
  const doc = c.doc;
  const board = boardId ? doc.boards.find((b) => b.id === boardId) : undefined;
  const missingBoard = !!boardId && !board;
  const canEdit = api.available && c.canEdit && !readOnly;
  const view = () => api.openViewer({ id: c.id, boardId: board?.id, pageId });
  const edit = async () => {
    const r = await api.openCanvas({
      ownerKind: c.ownerKind,
      ownerId: c.ownerId,
      canvasId: c.id,
      boardId: board?.id,
      projectId: c.projectId ?? undefined,
    });
    if (r) void qc.invalidateQueries({ queryKey: canvasKeys.one(c.id) });
  };
  const copyLink = () => {
    void navigator.clipboard
      ?.writeText(canvasMarkdown(c, board?.id))
      .then(() => toast.success('Link copied', canvasMarkdown(c, board?.id)));
  };
  const saveCopy = async () => {
    setMenu(false);
    try {
      const copy = await copyCanvas(c.id);
      if (onReplace) onReplace(copy.id, copy.title);
      else
        void navigator.clipboard
          ?.writeText(copy.markdown)
          .then(() => toast.success('Saved a copy', 'Its markdown is copied.'));
    } catch (e) {
      toast.error('Could not save a copy', canvasFailure(e).message);
    }
  };

  const doMove = async (r: { name: string; parentId: string | null }) => {
    setBusy(true);
    setMoveError(null);
    try {
      await moveToDocs(c.id, { title: r.name, parentId: r.parentId });
      setMoving(false);
      void qc.invalidateQueries({ queryKey: canvasKeys.one(c.id) });
      toast.success('Moved to Docs', `“${r.name}” is now a page. The text keeps showing the canvas.`);
    } catch (e) {
      setMoveError(canvasFailure(e).message);
    } finally {
      setBusy(false);
    }
  };

  const shownCount = board ? 1 : doc.boards.length;
  return (
    <figure
      ref={wrap}
      className={`${cls} ${menu ? styles.embedOpenMenu : ''}`}
      data-testid="canvas-embed"
      data-canvas={c.id}
      style={{ margin: '10px 0' }}
      onClick={(e) => e.stopPropagation()}
    >
      <span
        ref={ref}
        className={styles.embedStage}
        onClick={view}
        data-testid="canvas-embed-stage"
        style={{ display: 'block' }}
      >
        {missingBoard ? null : (
          <CanvasStatic
            canvasId={c.id}
            doc={doc}
            pageId={pageId}
            boardId={board?.id}
            width={width}
            maxHeight={small ? 300 : 460}
            bare={!!board}
            live
          />
        )}
        {missingBoard && (
          <CanvasStatic canvasId={c.id} doc={doc} pageId={pageId} width={width} maxHeight={small ? 300 : 460} />
        )}
      </span>
      {missingBoard && (
        <span className={styles.embedNote} data-testid="canvas-board-missing">
          That frame was deleted, so the whole canvas is shown.
        </span>
      )}
      <span className={styles.toolbar} role="toolbar" aria-label="Canvas actions">
        {canEdit && (
          <button type="button" className={styles.tbBtn} onClick={() => void edit()} data-testid="canvas-edit">
            <CanvasIcon name="edit" size={14} /> Edit
          </button>
        )}
        <a
          className={styles.tbBtn}
          href={canvasDownloadUrl(c.id, board?.id)}
          download
          data-testid="canvas-download"
          style={{ textDecoration: 'none' }}
        >
          <CanvasIcon name="download" size={14} /> Download
        </a>
        <button type="button" className={styles.tbBtn} onClick={view} data-testid="canvas-view">
          <CanvasIcon name="expand" size={14} /> View full size
        </button>
        <button type="button" className={styles.tbBtn} onClick={copyLink} data-testid="canvas-copy-link">
          <CanvasIcon name="link" size={14} /> Copy link
        </button>
        {canEdit && (
          <span style={{ position: 'relative' }}>
            <button
              type="button"
              className={styles.tbBtn}
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((v) => !v)}
              data-testid="canvas-menu"
            >
              <CanvasIcon name="more" size={14} />
            </button>
            {menu && (
              <div className={styles.menu} role="menu" style={{ right: 0, top: 30 }}>
                {c.projectId && !c.pageId && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      setMenu(false);
                      setMoving(true);
                    }}
                    data-testid="canvas-move-to-docs"
                  >
                    <CanvasIcon name="file" size={14} /> Move to Docs…
                  </button>
                )}
                <button type="button" role="menuitem" className={styles.menuItem} onClick={() => void saveCopy()}>
                  <CanvasIcon name="copy" size={14} /> Save as copy
                </button>
                {onRemove && (
                  <>
                    <div className={styles.menuSep} />
                    <button
                      type="button"
                      role="menuitem"
                      className={`${styles.menuItem} ${styles.menuDanger}`}
                      onClick={() => {
                        setMenu(false);
                        onRemove();
                      }}
                    >
                      <CanvasIcon name="trash" size={14} /> Remove from text
                    </button>
                  </>
                )}
              </div>
            )}
          </span>
        )}
      </span>
      <figcaption className={styles.embedFooter}>
        <span className={styles.chip}>
          <CanvasIcon name="canvas" size={12} /> Canvas
        </span>
        <span className={styles.embedName}>{board ? `${board.name} · ${c.title}` : c.title}</span>
        <span>
          {shownCount} {board ? 'frame' : shownCount === 1 ? 'frame' : 'frames'}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          {c.version > 1 ? 'Edited' : 'Added'} by {actorName(c.updatedBy)} · {relativeTime(c.updatedAt)}
        </span>
      </figcaption>
      {moving && c.projectId && (
        <MoveToDocsDialog
          projectId={c.projectId}
          defaultName={c.title}
          busy={busy}
          error={moveError}
          onMove={(r) => void doMove(r)}
          onCancel={() => setMoving(false)}
        />
      )}
    </figure>
  );
}

interface ChipProps {
  id: string;
  label: string;
  boardId?: string;
}

/**
 * A canvas as a small chip inside a sentence ("Link only"). Hover shows a small picture of the first board; a click
 * opens the large view.
 * @param props.id - Canvas id.
 * @param props.label - The link text.
 * @param props.boardId - Open at this board.
 */
export function CanvasChip({ id, label, boardId }: ChipProps) {
  const api = useCanvas();
  const q = useCanvasQuery(id);
  const first = q.data?.doc.boards.find((b) => b.id === boardId) ?? q.data?.doc.boards[0];
  return (
    <span
      className={`${styles.root} ${styles.refChip}`}
      role="button"
      tabIndex={0}
      data-testid="canvas-chip"
      onClick={(e) => {
        e.stopPropagation();
        api.openViewer({ id, boardId });
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          api.openViewer({ id, boardId });
        }
      }}
    >
      <CanvasIcon name="canvas" size={13} />
      {label || q.data?.title || 'Canvas'}
      {q.data && first && (
        <span className={styles.refPreview}>
          <img src={boardThumbUrl(id, first)} alt="" style={{ width: '100%', display: 'block' }} />
        </span>
      )}
    </span>
  );
}
