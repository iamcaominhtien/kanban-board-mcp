import { boardFileUrl, type CanvasBoard } from '../../api/canvases';

/**
 * The height of a loaded page: the root element's own height (so a page that only fills the window is not taller than its
 * content), or the body's scroll height when that is more.
 * @param doc - The frame's document.
 */
export function contentHeight(doc: Document): number {
  const root = doc.documentElement.getBoundingClientRect().height;
  const body = doc.body ? doc.body.scrollHeight : 0;
  return Math.ceil(Math.max(root, body));
}

interface Props {
  canvasId: string;
  board: CanvasBoard;
  /** Called once with the measured height. */
  onFit: (height: number) => void;
}

/**
 * A hidden copy of a board's page at the board's width that measures how tall the page is, so a board made with
 * `fit` (or "Fit height to content") gets the height of its content whatever the zoom of the plane.
 * @param props.canvasId - The canvas.
 * @param props.board - The board to measure; it needs HTML content.
 * @param props.onFit - Told the height once the page (and its fonts) have loaded.
 */
export function FitProbe({ canvasId, board, onFit }: Props) {
  if (board.kind !== 'html' || !board.content) return null;
  return (
    <iframe
      title={`Measuring ${board.name}`}
      aria-hidden="true"
      tabIndex={-1}
      src={boardFileUrl(canvasId, board.id, board.content.rev, board.content.entry)}
      data-testid="fit-probe"
      style={{
        position: 'fixed',
        left: -100000,
        top: 0,
        width: board.w,
        height: board.h,
        border: 0,
        opacity: 0,
        pointerEvents: 'none',
      }}
      onLoad={(e) => {
        const frame = e.currentTarget;
        const measure = () => {
          try {
            const doc = frame.contentDocument;
            if (doc) onFit(contentHeight(doc));
          } catch {
            /* a page we cannot read stays as it is */
          }
        };
        const fonts = frame.contentDocument?.fonts;
        const ready = fonts ? fonts.ready.catch(() => undefined) : Promise.resolve();
        void ready.then(() => window.setTimeout(measure, 400));
      }}
    />
  );
}
