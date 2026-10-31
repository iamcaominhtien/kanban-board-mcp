import { useEffect, useRef, useState } from 'react';
import type { BlockedItem, CanvasBoard } from '../../api/canvases';
import { CanvasIcon } from './CanvasIcon';
import { boardThumbUrl } from './BoardFrame';
import styles from './Canvas.module.css';

export const SIZE_PRESETS = [
  { id: 'desktop', label: 'Desktop', w: 1280, h: 800 },
  { id: 'laptop', label: 'Laptop', w: 1440, h: 900 },
  { id: 'wide', label: 'Wide', w: 1920, h: 1080 },
  { id: 'tablet', label: 'Tablet', w: 820, h: 1180 },
  { id: 'phone', label: 'Phone', w: 390, h: 844 },
] as const;

/** One line for the chip on a board: "3 blocked". */
export function blockedTotal(list: BlockedItem[] | undefined): number {
  return (list ?? []).reduce((n, b) => n + b.count, 0);
}

/**
 * What was left out of a board, as the chip's list: "1 script", "2 requests to cdn.example.com".
 * @param item - One entry of the board's blocked list.
 */
export function blockedLine(item: BlockedItem): string {
  const n = item.count;
  if (item.kind === 'script') return `${n} script${n === 1 ? '' : 's'}`;
  if (item.kind === 'handler') return `${n} event handler${n === 1 ? '' : 's'}`;
  if (item.kind === 'active') return `${n} frame${n === 1 ? '' : 's'} or embed${n === 1 ? '' : 's'}`;
  return `${n} request${n === 1 ? '' : 's'} to ${item.host ?? 'an outside address'}`;
}

interface MenuProps {
  board: CanvasBoard;
  canEdit: boolean;
  aiAvailable: boolean;
  onEdit: () => void;
  onAskAi: () => void;
  onRename: () => void;
  onSize: (w: number, h: number) => void;
  onCustom: () => void;
  onDuplicate: () => void;
  onReplace: () => void;
  onDownload: () => void;
  onImage: () => void;
  onCopyLink: () => void;
  onDelete: () => void;
}

/**
 * The board menu: Edit (takes the lock), Ask AI, Rename, Size, Duplicate, Replace content, Download, Copy link, Delete.
 * @param props - The board and what each item does.
 */
export function BoardMenu(p: MenuProps) {
  const [sizes, setSizes] = useState(false);
  const editable = p.board.kind === 'html' || p.board.kind === 'empty';
  return (
    <div
      className={`${styles.root} ${styles.menu}`}
      role="menu"
      data-ui
      data-testid="canvas-board-menu"
      style={{ right: 0, top: 30 }}
    >
      {p.canEdit && editable && (
        <button
          type="button"
          role="menuitem"
          className={styles.menuItem}
          onClick={p.onEdit}
          data-testid="canvas-menu-edit"
        >
          <CanvasIcon name="edit" size={14} /> Edit
          <small>Enter</small>
        </button>
      )}
      {p.canEdit && editable && (
        <div className={styles.hint} style={{ padding: '0 10px 4px' }}>
          Locks this board for you
        </div>
      )}
      {p.canEdit && p.aiAvailable && editable && (
        <button type="button" role="menuitem" className={styles.menuItem} onClick={p.onAskAi}>
          <CanvasIcon name="spark" size={14} /> Ask AI to change…
          <small>Ctrl J</small>
        </button>
      )}
      {p.canEdit && (
        <button type="button" role="menuitem" className={styles.menuItem} onClick={p.onRename}>
          <CanvasIcon name="text" size={14} /> Rename
        </button>
      )}
      {p.canEdit && (
        <>
          <button
            type="button"
            role="menuitem"
            className={styles.menuItem}
            onClick={() => setSizes((v) => !v)}
            aria-expanded={sizes}
          >
            <CanvasIcon name="frame" size={14} /> Size
            <small>
              {Math.round(p.board.w)} x {Math.round(p.board.h)}
            </small>
          </button>
          {sizes && (
            <div style={{ padding: '0 4px 4px 22px' }}>
              <div className={styles.menuHead}>Size</div>
              {SIZE_PRESETS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => p.onSize(s.w, s.h)}
                >
                  {s.label}
                  <small>
                    {s.w} x {s.h}
                  </small>
                </button>
              ))}
              <button type="button" role="menuitem" className={styles.menuItem} onClick={p.onCustom}>
                Custom…
                <small>Width 320 to 1920</small>
              </button>
            </div>
          )}
          <button type="button" role="menuitem" className={styles.menuItem} onClick={p.onDuplicate}>
            <CanvasIcon name="copy" size={14} /> Duplicate
            <small>Ctrl D</small>
          </button>
          <button type="button" role="menuitem" className={styles.menuItem} onClick={p.onReplace}>
            <CanvasIcon name="upload" size={14} /> Replace content…
          </button>
        </>
      )}
      <div className={styles.menuSep} />
      <button type="button" role="menuitem" className={styles.menuItem} onClick={p.onDownload}>
        <CanvasIcon name="download" size={14} /> Download
      </button>
      <button type="button" role="menuitem" className={styles.menuItem} onClick={p.onImage}>
        <CanvasIcon name="image" size={14} /> Copy board as image
      </button>
      <button type="button" role="menuitem" className={styles.menuItem} onClick={p.onCopyLink}>
        <CanvasIcon name="link" size={14} /> Copy link to board
      </button>
      {p.canEdit && (
        <>
          <div className={styles.menuSep} />
          <button
            type="button"
            role="menuitem"
            className={`${styles.menuItem} ${styles.menuDanger}`}
            onClick={p.onDelete}
            data-testid="canvas-menu-delete"
          >
            <CanvasIcon name="trash" size={14} /> Delete board
            <small>Del</small>
          </button>
        </>
      )}
    </div>
  );
}

interface BoardsPanelProps {
  canvasId: string;
  boards: CanvasBoard[];
  selected: string[];
  /** Open comments per board id. */
  comments: Record<string, number>;
  onSelect: (id: string) => void;
  /** The new order: the board ids in order. */
  onReorder: (ids: string[]) => void;
  canEdit: boolean;
}

/**
 * The Boards tab: the boards of the current page with a thumbnail, size and kind. Click to jump and select; the number
 * is open comments. Drag a row to set the order Present and the viewer step through.
 * @param props - The boards in order and what a click or a drop does.
 */
export function BoardsPanel({ canvasId, boards, selected, comments, onSelect, onReorder, canEdit }: BoardsPanelProps) {
  const [find, setFind] = useState('');
  const drag = useRef<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const shown = boards.filter((b) => b.name.toLowerCase().includes(find.trim().toLowerCase()));
  const drop = (target: string) => {
    const from = drag.current;
    drag.current = null;
    setOver(null);
    if (!from || from === target) return;
    const ids = boards.map((b) => b.id).filter((i) => i !== from);
    ids.splice(ids.indexOf(target), 0, from);
    onReorder(ids);
  };
  const kindLabel = (b: CanvasBoard) =>
    ({ html: 'HTML', image: 'Image', sketch: 'Sketch', diagram: 'Diagram', empty: 'Empty' })[b.kind];
  return (
    <div data-testid="canvas-boards-panel">
      <input
        className={styles.input}
        placeholder="Find a board…"
        value={find}
        onChange={(e) => setFind(e.target.value)}
        aria-label="Find a board"
      />
      <div style={{ marginTop: 8 }}>
        {shown.map((b, i) => (
          <div
            key={b.id}
            role="button"
            tabIndex={0}
            draggable={canEdit && !find}
            className={`${styles.boardRow} ${selected.includes(b.id) ? styles.boardRowOn : ''} ${over === b.id ? styles.boardRowDrop : ''}`}
            onClick={() => onSelect(b.id)}
            onKeyDown={(e) => e.key === 'Enter' && onSelect(b.id)}
            onDragStart={() => (drag.current = b.id)}
            onDragOver={(e) => {
              if (drag.current) {
                e.preventDefault();
                setOver(b.id);
              }
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              drop(b.id);
            }}
            data-testid="canvas-board-row"
          >
            <span className={styles.hint} style={{ textAlign: 'center' }}>
              {i + 1}
            </span>
            <span className={styles.boardThumb}>
              <img src={boardThumbUrl(canvasId, b)} alt="" loading="lazy" draggable={false} />
            </span>
            <span style={{ minWidth: 0 }}>
              <span className={styles.boardRowName} style={{ display: 'block' }}>
                {b.name}
              </span>
              <span className={styles.boardRowMeta}>
                {Math.round(b.w)} x {Math.round(b.h)} · {kindLabel(b)}
              </span>
            </span>
            {comments[b.id] ? <span className={styles.count}>{comments[b.id]}</span> : <span />}
          </div>
        ))}
        {!shown.length && <div className={styles.hint}>No boards{find ? ' match' : ' on this page yet'}.</div>}
      </div>
      <div className={styles.hint} style={{ marginTop: 10 }}>
        Order is a list, not a position: it is what Present and the viewer step through. By default it follows the
        plane, left to right then top to bottom. Dragging a row sets it by hand.
      </div>
    </div>
  );
}

/** The keys of the editor, shown under the question mark. */
export function KeysList({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [onClose]);
  const rows: [string, string][] = [
    ['V', 'Select'],
    ['H or hold Space', 'Hand: pan the plane'],
    ['B', 'Add a board'],
    ['N', 'Note'],
    ['A', 'Arrow'],
    ['T', 'Label'],
    ['C', 'Comment'],
    ['Ctrl + scroll, Ctrl +/-', 'Zoom, 10% to 400%'],
    ['Scroll, drag with Space', 'Pan the plane'],
    ['0', 'Fit everything on this page tab'],
    ['1', 'Zoom to 100% on the selected board'],
    ['2', 'Zoom to the selection'],
    ['Tab / Shift Tab', 'Select the next / previous board in order'],
    ['Arrow keys / Shift', 'Nudge the selection'],
    ['M', 'Show or hide the map'],
    ['F', 'Focus: hide the header and panels'],
    ['P', 'Present from the selected board'],
    ['E or Enter', 'Edit the selected board'],
    ['Ctrl J', 'Ask AI about the selection'],
    ['Ctrl D', 'Duplicate the selected board'],
    ['Delete', 'Delete the selection'],
    ['Ctrl Z / Ctrl Shift Z', 'Undo / redo layout changes (not source edits)'],
  ];
  return (
    <div className={`${styles.root} ${styles.scrim}`} onClick={onClose} data-canvas-layer>
      <div
        className={styles.dialog}
        role="dialog"
        aria-label="Keys"
        onClick={(e) => e.stopPropagation()}
        data-testid="canvas-keys"
      >
        <div className={styles.dialogHead}>Keys</div>
        <div className={styles.dialogBody} style={{ gap: 6 }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: 'grid', gridTemplateColumns: '210px 1fr', gap: 10, alignItems: 'center' }}>
              <span className={styles.kbd}>{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
        <div className={styles.dialogFoot}>
          <button type="button" className={styles.btn} onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
