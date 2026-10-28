import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { diagramSvgUrl, type Diagram } from '../../api/diagrams';
import { DiagramIcon } from './DiagramIcon';
import { DiagramMenu } from './DiagramMenu';
import styles from './Diagrams.module.css';

const MIN = 0.1;
const MAX = 8;

interface Props {
  diagram: Pick<Diagram, 'id' | 'label' | 'version'>;
  /** Pinned version to show (a Docs history view). */
  version?: number;
  onClose: () => void;
}

/**
 * Full-size viewer: scroll to zoom, drag to pan, Esc to close.
 * @param props.diagram - The diagram to show.
 * @param props.version - Pinned version; latest by default.
 * @param props.onClose - Called when the viewer closes.
 */
export function DiagramViewer({ diagram, version, onClose }: Props) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const shown = version ?? diagram.version;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(MAX, z * 1.2));
      else if (e.key === '-') setZoom((z) => Math.max(MIN, z / 1.2));
      else if (e.key === '0') {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // a non-passive wheel listener so the page behind does not scroll while zooming
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setZoom((z) => Math.min(MAX, Math.max(MIN, z * Math.exp(-e.deltaY * 0.0015))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function down(e: RPointerEvent) {
    drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: RPointerEvent) {
    const d = drag.current;
    if (d) setPan({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y });
  }
  function up() {
    drag.current = null;
    setDragging(false);
  }

  return createPortal(
    <div className={styles.viewer} role="dialog" aria-modal="true" aria-label={`${diagram.label}, full size`}>
      <div className={styles.viewerBar}>
        <span className={styles.chip}>
          <DiagramIcon name="drawio" size={13} /> draw.io
        </span>
        <span>{diagram.label}</span>
        <span style={{ flex: 1 }} />
        <div className={styles.zoomGroup}>
          <button
            type="button"
            className={styles.tbBtn}
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(MIN, z / 1.2))}
          >
            <DiagramIcon name="minus" />
          </button>
          <span className={styles.zoomLabel} aria-live="polite">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            className={styles.tbBtn}
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(MAX, z * 1.2))}
          >
            <DiagramIcon name="plus" />
          </button>
          <button
            type="button"
            className={styles.tbBtn}
            aria-label="Reset zoom"
            title="Reset (0)"
            onClick={() => {
              setZoom(1);
              setPan({ x: 0, y: 0 });
            }}
          >
            <DiagramIcon name="fit" />
          </button>
        </div>
        <div className={styles.zoomGroup}>
          <button
            type="button"
            className={styles.tbBtn}
            aria-label="Download"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            <DiagramIcon name="download" />
          </button>
          <button type="button" className={styles.tbBtn} aria-label="Close" onClick={onClose}>
            <DiagramIcon name="close" />
          </button>
        </div>
        {menu && (
          <DiagramMenu
            id={diagram.id}
            label={diagram.label}
            version={version}
            className={`${styles.menu} ${styles.viewerMenu}`}
            onDone={() => setMenu(false)}
          />
        )}
      </div>
      <div
        ref={canvas}
        className={`${styles.canvas} ${dragging ? styles.canvasDragging : ''}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        data-testid="diagram-canvas"
      >
        <div
          className={styles.canvasInner}
          style={{ transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          <img src={diagramSvgUrl(diagram.id, shown)} alt={diagram.label} draggable={false} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
