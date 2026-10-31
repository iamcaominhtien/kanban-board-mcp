import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { sketchDownloadUrl, sketchPngUrl } from '../../api/sketches';
import { SketchIcon } from './SketchIcon';
import styles from './Sketch.module.css';

interface Props {
  sketch: { id: string; title: string; version?: number };
  onClose: () => void;
}

/**
 * A drawing shown large, for everyone who can see it (editing is not offered here).
 * @param props.sketch - Which drawing.
 * @param props.onClose - Called on Close or Esc.
 */
export function SketchViewer({ sketch, onClose }: Props) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [onClose]);
  return createPortal(
    <div
      className={styles.viewer}
      role="dialog"
      aria-modal="true"
      aria-label={sketch.title}
      data-testid="sketch-viewer"
      data-sketch-layer
    >
      <div className={styles.viewerBar}>
        <SketchIcon name="sketch" size={18} /> <span>{sketch.title}</span>
        <span className={styles.spacer} />
        <a className={styles.btn} href={sketchDownloadUrl(sketch.id, 'png')} download>
          <SketchIcon name="download" size={15} /> Download PNG
        </a>
        <button type="button" className={styles.btn} onClick={onClose} autoFocus>
          Close
        </button>
      </div>
      <div className={styles.viewerBody} onClick={onClose}>
        <img
          className={styles.viewerImg}
          src={sketchPngUrl(sketch.id, sketch.version)}
          alt={sketch.title}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </div>,
    document.body,
  );
}
