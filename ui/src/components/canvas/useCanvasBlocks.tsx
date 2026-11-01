import { useCallback, useState, type MutableRefObject, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { fetchCanvas, type Canvas, type CanvasOwnerKind } from '../../api/canvases';
import { canvasBlockElement } from '../../utils/markdownWysiwyg';
import { useCanvas } from './CanvasContext';
import { CANVAS_LINE } from './canvasRefs';
import { useCanvasStarter } from './useCanvasStarter';
import styles from './Canvas.module.css';

interface Options {
  /** The editable surface the blocks live in. */
  root: RefObject<HTMLElement>;
  /** Where the caret was before a toolbar button took focus. */
  savedRange: MutableRefObject<Range | null>;
  /** Write the surface's content back to the text. */
  sync: () => void;
  readOnly?: boolean;
  ownerKind: CanvasOwnerKind;
  ownerId?: string;
  projectId?: string;
  ownerLabel?: string;
}

/**
 * Canvas support for the WYSIWYG markdown editor: the toolbar action, the block it inserts, clicks on a block and the
 * embed settings ("Show: whole canvas / one board / link only").
 * @param o - The surface, the caret to restore, how to save, and who owns the canvases.
 */
export function useCanvasBlocks(o: Options) {
  const api = useCanvas();
  const { root, savedRange, sync, readOnly } = o;
  const [settings, setSettings] = useState<{ block: HTMLElement; canvas: Canvas } | null>(null);

  const insertBlock = useCallback(
    (md: string) => {
      const surface = root.current;
      const parts = CANVAS_LINE.exec(md);
      if (!surface || !parts) return;
      const block = canvasBlockElement(parts[2], parts[1], parts[3]);
      const saved = savedRange.current;
      let anchor: Node | null = null;
      if (saved && surface.contains(saved.commonAncestorContainer)) {
        anchor = saved.commonAncestorContainer;
        while (anchor.parentNode && anchor.parentNode !== surface) anchor = anchor.parentNode;
        if (anchor === surface) anchor = null;
      }
      surface.insertBefore(block, anchor ? anchor.nextSibling : null);
      if (!block.nextElementSibling) {
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        surface.appendChild(p);
      }
      savedRange.current = null;
      sync();
    },
    [root, savedRange, sync],
  );

  const starter = useCanvasStarter({
    ownerKind: o.ownerKind,
    ownerId: o.ownerId,
    projectId: o.projectId,
    ownerLabel: o.ownerLabel,
    onInsert: insertBlock,
  });

  /** A click inside the surface: "Edit canvas", "Show…" and opening the picture large. Returns true when it did. */
  const handleClick = useCallback(
    (target: HTMLElement): boolean => {
      const block = target.closest('[data-canvas], [data-canvas-chip]') as HTMLElement | null;
      if (!block || !root.current?.contains(block)) return false;
      const id = block.getAttribute('data-canvas') ?? block.getAttribute('data-canvas-chip') ?? '';
      if (!/^cv_[0-9a-f]{8}$/.test(id)) return true;
      const frag = block.getAttribute('data-fragment') ?? undefined;
      const boardId = frag?.startsWith('b_') ? frag : undefined;
      if (target.closest('[data-canvas-edit]')) {
        if (!readOnly && api.available) {
          void api
            .openCanvas({
              ownerKind: o.ownerKind,
              ownerId: o.ownerId || o.projectId || '',
              projectId: o.projectId,
              ownerLabel: o.ownerLabel,
              canvasId: id,
              boardId,
            })
            .then((r) => {
              if (!r) return;
              block.setAttribute('data-label', r.title);
              const name = block.querySelector('[data-canvas-name]');
              if (name) name.textContent = r.title;
              const img = block.querySelector('img');
              if (img) img.setAttribute('src', img.getAttribute('src')!.split('?')[0] + `?v=${r.canvas.rev}`);
              sync();
            });
        }
      } else if (target.closest('[data-canvas-show]')) {
        if (!readOnly) void fetchCanvas(id).then((canvas) => setSettings({ block, canvas }));
      } else api.openViewer({ id, boardId });
      return true;
    },
    [api, root, readOnly, sync, o.ownerKind, o.ownerId, o.projectId, o.ownerLabel],
  );

  /** Change what the card shows: the whole canvas, one board, or only a chip. */
  const applyShow = (mode: 'canvas' | 'board' | 'link', boardId?: string) => {
    if (!settings) return;
    const { block, canvas } = settings;
    const label = block.getAttribute('data-label') || canvas.title;
    const frag = mode === 'board' ? boardId : undefined;
    const next =
      mode === 'link' ? `[${label}](canvas:${canvas.id})` : `![${label}](canvas:${canvas.id}${frag ? `#${frag}` : ''})`;
    const replacement = mode === 'link' ? document.createElement('p') : canvasBlockElement(canvas.id, label, frag);
    if (mode === 'link') replacement.textContent = next;
    block.replaceWith(replacement);
    setSettings(null);
    sync();
  };

  const settingsPanel: ReactNode = settings
    ? createPortal(
        <div className={`${styles.root} ${styles.scrim}`} data-canvas-layer onClick={() => setSettings(null)}>
          <div
            className={styles.dialog}
            role="dialog"
            aria-label="Embed settings"
            onClick={(e) => e.stopPropagation()}
            data-testid="canvas-embed-settings"
          >
            <div className={styles.dialogHead}>Embed settings</div>
            <div className={styles.dialogBody}>
              <span className={styles.fieldLabel}>Show</span>
              <button
                type="button"
                className={styles.option}
                onClick={() => applyShow('canvas')}
                data-testid="canvas-show-canvas"
              >
                Whole canvas<small>All boards of the current page tab</small>
              </button>
              <div>
                <button
                  type="button"
                  className={styles.option}
                  style={{ width: '100%' }}
                  onClick={() => applyShow('board', settings.canvas.doc.boards[0]?.id)}
                  disabled={!settings.canvas.doc.boards.length}
                >
                  One board<small>Pick the board that matters</small>
                </button>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                  {settings.canvas.doc.boards.map((b) => (
                    <button key={b.id} type="button" className={styles.filter} onClick={() => applyShow('board', b.id)}>
                      {b.name}
                    </button>
                  ))}
                </div>
              </div>
              <button type="button" className={styles.option} onClick={() => applyShow('link')}>
                Link only<small>A small chip in the line</small>
              </button>
            </div>
            <div className={styles.dialogFoot}>
              <button type="button" className={styles.btn} onClick={() => setSettings(null)} autoFocus>
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return { starter, handleClick, settingsPanel };
}
