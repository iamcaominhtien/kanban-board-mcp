import { useRef, useState } from 'react';
import { CanvasIcon } from './CanvasIcon';
import styles from './Canvas.module.css';

export type StartWith = 'blank' | 'files';

interface Props {
  /** "Ticket KAN-142, description" - where the canvas will belong. */
  savedIn: string;
  defaultName?: string;
  busy?: boolean;
  error?: string | null;
  onCreate: (r: { name: string; start: StartWith; files: File[] }) => void;
  onCancel: () => void;
}

/**
 * The "New canvas" dialog: a name, where it is saved, and what it starts with (one empty frame, HTML or picture files,
 * or screens described to the AI).
 * @param props.savedIn - Where it belongs (read only).
 * @param props.defaultName - Suggested name.
 * @param props.busy - Creating.
 * @param props.error - Why the last try failed.
 * @param props.onCreate - Called with the choices.
 * @param props.onCancel - Called when the person backs out.
 */
export function NewCanvasDialog({ savedIn, defaultName = '', busy, error, onCreate, onCancel }: Props) {
  const [name, setName] = useState(defaultName);
  const [start, setStart] = useState<StartWith>('blank');
  const [files, setFiles] = useState<File[]>([]);
  const pick = useRef<HTMLInputElement>(null);
  const ready = name.trim().length > 0 && (start !== 'files' || files.length > 0);
  const submit = () => {
    if (ready && !busy) onCreate({ name: name.trim(), start, files });
  };
  return (
    <div
      className={`${styles.scrim} ${styles.root}`}
      data-canvas-layer
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
        if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') submit();
      }}
    >
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="New canvas" data-testid="canvas-new">
        <div className={styles.dialogHead}>New canvas</div>
        <div className={styles.dialogBody}>
          <label>
            <span className={styles.fieldLabel}>Name</span>
            <input
              className={styles.input}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Login redesign"
              autoFocus
              data-testid="canvas-new-name"
            />
          </label>
          <div>
            <span className={styles.fieldLabel}>Saved in</span>
            <div className={styles.input} style={{ background: '#f1f3f1', color: '#5b6b60' }}>
              {savedIn}
            </div>
            <div className={styles.hint} style={{ marginTop: 4 }}>
              The canvas belongs to the place you started from, like a sketch.
            </div>
          </div>
          <div>
            <span className={styles.fieldLabel}>Start with</span>
            <div className={styles.options} role="radiogroup" aria-label="Start with">
              {(
                [
                  ['blank', 'Blank', 'One empty frame', 'frame'],
                  ['files', 'From files', 'HTML or images', 'upload'],
                ] as [StartWith, string, string, string][]
              ).map(([id, label, sub, icon]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={start === id}
                  className={`${styles.option} ${start === id ? styles.optionOn : ''}`}
                  onClick={() => {
                    setStart(id);
                    if (id === 'files' && !files.length) pick.current?.click();
                  }}
                  data-testid={`canvas-start-${id}`}
                >
                  <CanvasIcon name={icon} size={18} />
                  {label}
                  <small>{sub}</small>
                </button>
              ))}
            </div>
          </div>
          {start === 'files' && (
            <div className={styles.hint}>
              {files.length
                ? `${files.length} file${files.length === 1 ? '' : 's'}: ${files.map((f) => f.name).join(', ')}`
                : 'Choose HTML files, pictures or a ZIP of a built page.'}{' '}
              <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={() => pick.current?.click()}>
                Choose files
              </button>
            </div>
          )}
          <input
            ref={pick}
            type="file"
            multiple
            hidden
            accept=".html,.htm,.zip,.png,.jpg,.jpeg,.gif,.webp,.svg"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            data-testid="canvas-new-files"
          />
          {error && (
            <div role="alert" style={{ color: '#a93822', fontSize: 13 }}>
              {error}
            </div>
          )}
        </div>
        <div className={styles.dialogFoot}>
          <button type="button" className={styles.btn} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={!ready || busy}
            onClick={submit}
            data-testid="canvas-new-create"
          >
            {busy ? 'Creating…' : 'Create canvas'}
          </button>
        </div>
      </div>
    </div>
  );
}
