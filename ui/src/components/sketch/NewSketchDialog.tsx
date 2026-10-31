import { useState } from 'react';
import { SketchIcon } from './SketchIcon';
import styles from './Sketch.module.css';

/** The page sizes offered. Wide is the default. */
export const PAGE_SIZES = [
  { id: 'small', name: 'Small', w: 600, h: 400 },
  { id: 'wide', name: 'Wide', w: 840, h: 500 },
  { id: 'square', name: 'Square', w: 800, h: 800 },
] as const;

interface Props {
  onStart: (size: { w: number; h: number; background: 'white' | 'clear' }) => void;
  onCancel: () => void;
}

/**
 * The "New sketch" dialog: a page size and a background.
 * @param props.onStart - Called with the chosen size and background.
 * @param props.onCancel - Called when the person backs out.
 */
export function NewSketchDialog({ onStart, onCancel }: Props) {
  const [size, setSize] = useState<(typeof PAGE_SIZES)[number]['id']>('wide');
  const [background, setBackground] = useState<'white' | 'clear'>('white');
  const chosen = PAGE_SIZES.find((s) => s.id === size) ?? PAGE_SIZES[1];

  return (
    <div className={styles.cover}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="New sketch" data-testid="sketch-new">
        <div className={styles.dialogTitle}>New sketch</div>
        <div className={styles.sizeRow} role="radiogroup" aria-label="Size">
          {PAGE_SIZES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={size === s.id}
              className={`${styles.sizeCard} ${size === s.id ? styles.sizeCardOn : ''}`}
              onClick={() => setSize(s.id)}
              data-testid={`sketch-size-${s.id}`}
            >
              <span
                className={styles.sizeThumb}
                style={{ aspectRatio: `${s.w} / ${s.h}`, width: s.id === 'square' ? 40 : 60 }}
              />
              <b>{s.name}</b>
              <span className={styles.sizeDims}>
                {s.w} × {s.h}
              </span>
            </button>
          ))}
        </div>
        <div className={styles.bgRow} role="radiogroup" aria-label="Background">
          <span>Background</span>
          {(['white', 'clear'] as const).map((b) => (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={background === b}
              className={`${styles.pill} ${background === b ? styles.pillOn : ''}`}
              onClick={() => setBackground(b)}
              data-testid={`sketch-bg-${b}`}
            >
              {b === 'white' ? 'White' : 'Clear'}
            </button>
          ))}
        </div>
        <div className={styles.dialogRow}>
          <button type="button" className={styles.btn} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            autoFocus
            onClick={() => onStart({ w: chosen.w, h: chosen.h, background })}
            data-testid="sketch-start"
          >
            <SketchIcon name="sketch" size={15} /> Start drawing
          </button>
        </div>
      </div>
    </div>
  );
}
