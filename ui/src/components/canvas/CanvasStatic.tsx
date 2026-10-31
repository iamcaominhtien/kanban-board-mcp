import { useMemo } from 'react';
import type { CanvasDoc } from '../../api/canvases';
import { BoardFrame, boardThumbUrl } from './BoardFrame';
import { arrowLine, boundsOf, type Rect } from './planeMath';
import styles from './Canvas.module.css';

export const NOTE_BG: Record<string, string> = {
  yellow: '#FFF3B8',
  green: '#E3F3E7',
  blue: '#DDECFA',
  pink: '#FCE2E9',
  purple: '#EFE8FB',
  grey: '#E8ECE9',
};

interface Props {
  canvasId: string;
  doc: CanvasDoc;
  /** The page tab to draw (the first when omitted). */
  pageId?: string;
  /** Draw only this board. */
  boardId?: string;
  /** Width of the drawing in pixels. */
  width: number;
  /** Tallest the drawing may be. */
  maxHeight?: number;
  /** Draw board names above the boards. */
  names?: boolean;
  /** Plain picture without the dotted plane (a board alone). */
  bare?: boolean;
  /** Draw each page live in its locked frame (a few boards, a card in a text); false uses the pictures. */
  live?: boolean;
}

/**
 * A still picture of a page tab (or of one board): boards as their last pictures, notes, labels and arrows. Used by
 * the inline card, the grid and the history. It never starts a frame, so a canvas with many boards stays quick.
 * @param props.canvasId - The canvas.
 * @param props.doc - The canvas file.
 * @param props.pageId - Page tab.
 * @param props.boardId - Draw only this board.
 * @param props.width - Draw width.
 * @param props.maxHeight - Tallest drawing.
 * @param props.names - Show the board names.
 * @param props.bare - No plane background.
 * @param props.live - Draw the pages live (few boards) instead of pictures.
 */
export function CanvasStatic({ canvasId, doc, pageId, boardId, width, maxHeight = 420, names, bare, live }: Props) {
  const page = pageId ?? doc.pages[0]?.id;
  const items = useMemo(() => {
    const boards = doc.boards.filter((b) => (boardId ? b.id === boardId : b.page === page));
    const notes = boardId ? [] : doc.notes.filter((n) => n.page === page);
    const labels = boardId ? [] : doc.labels.filter((n) => n.page === page);
    const arrows = boardId ? [] : doc.arrows.filter((n) => n.page === page);
    const rects: Rect[] = [
      ...boards.map((b) => ({ x: b.x, y: b.y - (names ? 22 : 0), w: b.w, h: b.h + (names ? 22 : 0) })),
      ...notes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
      ...labels.map((l) => ({ x: l.x, y: l.y, w: Math.max(40, l.text.length * l.size * 0.6), h: l.size * 1.4 })),
    ];
    return { boards, notes, labels, arrows, box: boundsOf(rects) };
  }, [doc, page, boardId, names]);
  const { box } = items;
  if (!box) {
    return (
      <div className={styles.staticPlane} style={{ width, height: Math.min(maxHeight, width * 0.45) }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: '#9aa8a0',
            fontWeight: 700,
          }}
        >
          No frames yet
        </div>
      </div>
    );
  }
  const pad = bare ? 0 : 24;
  const scale = Math.min((width - pad * 2) / box.w, (maxHeight - pad * 2) / box.h, 1.5);
  const inner = Math.round(box.w * scale + pad * 2);
  const w = bare ? inner : width; // a card fills its row; the boards are centred on the plane
  const h = Math.round(box.h * scale + pad * 2);
  const shift = Math.round((w - inner) / 2);
  const at = (x: number, y: number) => ({ left: (x - box.x) * scale + pad + shift, top: (y - box.y) * scale + pad });
  const drawLive = !!live && items.boards.length <= 8 && scale >= 0.12;
  const byId = new Map<string, Rect>([
    ...items.boards.map((b) => [b.id, { x: b.x, y: b.y, w: b.w, h: b.h }] as [string, Rect]),
    ...items.notes.map((n) => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h }] as [string, Rect]),
  ]);
  return (
    <div
      className={bare ? styles.plain : styles.staticPlane}
      style={{ width: w, height: h, position: 'relative', overflow: names ? 'visible' : 'hidden' }}
      data-testid="canvas-static"
    >
      <svg width={w} height={h} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} aria-hidden="true">
        <defs>
          <marker
            id={`ah-${canvasId}`}
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto"
          >
            <path d="M0 0L10 5L0 10Z" fill="#5b6b60" />
          </marker>
        </defs>
        {items.arrows.map((a) => {
          const from = byId.get(a.from);
          const to = byId.get(a.to);
          if (!from || !to) return null;
          const l = arrowLine(from, to);
          const p = at(l.x1, l.y1);
          const q = at(l.x2, l.y2);
          return (
            <line
              key={a.id}
              x1={p.left}
              y1={p.top}
              x2={q.left}
              y2={q.top}
              stroke="#5b6b60"
              strokeWidth={1.5}
              markerEnd={`url(#ah-${canvasId})`}
            />
          );
        })}
      </svg>
      {items.boards.map((b) => (
        <div
          key={b.id}
          className={styles.sBoard}
          style={{ ...at(b.x, b.y), width: b.w * scale, height: b.h * scale }}
          data-board={b.id}
        >
          {names && (
            <div className={styles.sBoardName} style={{ top: -19, fontSize: Math.max(10, 11.5) }}>
              {b.name}
              <span>
                {Math.round(b.w)} x {Math.round(b.h)}
              </span>
            </div>
          )}
          {drawLive ? (
            <BoardFrame canvasId={canvasId} board={b} scale={scale} live />
          ) : (
            <img src={boardThumbUrl(canvasId, b)} alt={b.name} loading="lazy" draggable={false} />
          )}
        </div>
      ))}
      {items.notes.map((n) => (
        <div
          key={n.id}
          className={styles.sNote}
          style={{
            ...at(n.x, n.y),
            width: n.w * scale,
            height: n.h * scale,
            background: NOTE_BG[n.color],
            fontSize: Math.max(6, 17 * scale),
            padding: Math.max(2, 9 * scale),
          }}
        >
          {n.text}
        </div>
      ))}
      {items.labels.map((l) => (
        <div key={l.id} className={styles.sLabel} style={{ ...at(l.x, l.y), fontSize: Math.max(7, l.size * scale) }}>
          {l.text}
        </div>
      ))}
    </div>
  );
}
