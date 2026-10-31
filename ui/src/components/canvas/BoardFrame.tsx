import { useEffect, useState } from 'react';
import { boardFileUrl, boardPictureUrl, boardSnapshotUrl, type CanvasBoard } from '../../api/canvases';
import { CanvasIcon } from './CanvasIcon';
import styles from './Canvas.module.css';

/** The sandbox of every board frame: no scripts, forms, pop-ups, top navigation or same-origin access. */
export const FRAME_SANDBOX = '';

interface Props {
  canvasId: string;
  board: CanvasBoard;
  /** How big the frame is drawn: 1 is the board's own size. */
  scale: number;
  /** Draw the page live in its locked frame; false shows a picture of its last saved state. */
  live: boolean;
  /** Show this older revision of the content (history, compare). */
  rev?: number;
  /** Called when the page could not be drawn. */
  onBroken?: (broken: boolean) => void;
  /** Changes to draw it again. */
  reloadKey?: number;
}

/**
 * The picture of one board: its HTML page in a locked frame, its picture, its Sketch or Diagram, or an empty frame.
 * The page is served by the API with a policy that allows drawing only, and the frame has an empty `sandbox`, so
 * nothing in it can run a script or reach outside the board.
 * @param props.canvasId - The canvas.
 * @param props.board - The board.
 * @param props.scale - Draw size (1 = the board's size).
 * @param props.live - Draw live (zoom from 40%) or show the snapshot.
 * @param props.rev - Show another revision of the content.
 * @param props.onBroken - Told when the page cannot be drawn.
 * @param props.reloadKey - Change to reload.
 */
export function BoardFrame({ canvasId, board, scale, live, rev, onBroken, reloadKey = 0 }: Props) {
  const w = Math.max(1, board.w * scale);
  const h = Math.max(1, board.h * scale);
  const content = board.content;
  const contentRev = rev ?? content?.rev;
  const entryUrl =
    board.kind === 'html' && content && contentRev ? boardFileUrl(canvasId, board.id, contentRev, content.entry) : null;
  const [state, setState] = useState<'loading' | 'ready' | 'broken'>('loading');
  const showLive = live && !!entryUrl;

  useEffect(() => {
    if (!showLive || !entryUrl) return;
    let off = false;
    setState('loading');
    fetch(entryUrl)
      .then((r) => {
        if (off) return;
        setState(r.ok ? 'ready' : 'broken');
        onBroken?.(!r.ok);
      })
      .catch(() => {
        if (off) return;
        setState('broken');
        onBroken?.(true);
      });
    return () => {
      off = true;
    };
  }, [showLive, entryUrl, reloadKey, onBroken]);

  const box = { width: w, height: h, position: 'relative' as const, overflow: 'hidden', background: '#fff' };
  if (board.kind === 'empty' || (board.kind === 'html' && !content)) {
    return (
      <div style={box} data-testid="board-empty">
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: '#9aa8a0',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: Math.max(9, 14 * scale), fontWeight: 700 }}>Empty frame</div>
        </div>
      </div>
    );
  }
  const pic = board.kind === 'html' ? null : boardPictureUrl(canvasId, board);
  if (pic) {
    return (
      <div style={box}>
        <img
          src={pic + (rev ? '' : '')}
          alt={board.name}
          draggable={false}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'contain', objectPosition: 'top left', display: 'block' }}
          onError={() => onBroken?.(true)}
        />
      </div>
    );
  }
  if (!showLive) {
    return (
      <div style={box}>
        <img
          src={boardSnapshotUrl(canvasId, board.id, contentRev)}
          alt={board.name}
          draggable={false}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top left', display: 'block' }}
        />
      </div>
    );
  }
  return (
    <div style={box} data-testid="board-frame">
      {state === 'broken' ? (
        <div
          className={styles.skeleton}
          style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}
        >
          <div style={{ textAlign: 'center', color: '#5b6b60', padding: 8 }}>
            <CanvasIcon name="warning" size={Math.max(14, 20 * scale)} />
            <div style={{ fontWeight: 700, fontSize: Math.max(10, 13 * scale) }}>{board.name} could not be drawn</div>
          </div>
        </div>
      ) : (
        <>
          {state === 'loading' && <div className={styles.skeleton} style={{ position: 'absolute', inset: 0 }} />}
          <iframe
            key={`${entryUrl}-${reloadKey}`}
            title={board.name}
            src={entryUrl ?? undefined}
            sandbox={FRAME_SANDBOX}
            referrerPolicy="no-referrer"
            tabIndex={-1}
            data-testid="board-iframe"
            style={{
              width: board.w,
              height: board.h,
              border: 0,
              background: '#fff',
              transform: `scale(${scale})`,
              transformOrigin: '0 0',
              pointerEvents: 'none',
              opacity: state === 'ready' ? 1 : 0,
            }}
          />
        </>
      )}
    </div>
  );
}

/** Address of the small picture that stands for a board in lists, the filmstrip and the grid. */
export function boardThumbUrl(canvasId: string, b: CanvasBoard): string {
  return boardPictureUrl(canvasId, b) ?? boardSnapshotUrl(canvasId, b.id, b.content?.rev);
}
