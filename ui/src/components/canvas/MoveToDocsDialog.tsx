import { useEffect, useState } from 'react';
import { client } from '../../api/client';
import styles from './Canvas.module.css';

interface TreeRow {
  id: string;
  parentId: string | null;
  title: string;
}
interface Props {
  projectId: string;
  defaultName: string;
  busy?: boolean;
  error?: string | null;
  onMove: (r: { name: string; parentId: string | null }) => void;
  onCancel: () => void;
}

/**
 * "Move to Docs": give an inline canvas its own page. It keeps its boards, comments and history, and the text it came
 * from keeps showing it.
 * @param props.projectId - The project whose Docs space receives the page.
 * @param props.defaultName - Suggested page name.
 * @param props.busy - Moving.
 * @param props.error - Why the last try failed.
 * @param props.onMove - Called with the page name and the folder.
 * @param props.onCancel - Called when the person backs out.
 */
export function MoveToDocsDialog({ projectId, defaultName, busy, error, onMove, onCancel }: Props) {
  const [name, setName] = useState(defaultName);
  const [parentId, setParentId] = useState<string>('');
  const [tree, setTree] = useState<TreeRow[]>([]);
  useEffect(() => {
    let off = false;
    client
      .get<TreeRow[]>(`/projects/${projectId}/docs/tree`)
      .then((r) => !off && setTree(r.data))
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [projectId]);
  const depth = (row: TreeRow): number => {
    let d = 0;
    let cur: TreeRow | undefined = row;
    while (cur?.parentId && d < 8) {
      cur = tree.find((t) => t.id === cur?.parentId);
      d++;
    }
    return d;
  };
  return (
    <div className={`${styles.scrim} ${styles.root}`} data-canvas-layer onClick={onCancel}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Move to Docs"
        onClick={(e) => e.stopPropagation()}
        data-testid="canvas-move-docs"
      >
        <div className={styles.dialogHead}>Move to Docs</div>
        <div className={styles.dialogBody}>
          <label>
            <span className={styles.fieldLabel}>Page name</span>
            <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label>
            <span className={styles.fieldLabel}>Folder</span>
            <select className={styles.input} value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">Top level</option>
              {tree.map((t) => (
                <option key={t.id} value={t.id}>
                  {' '.repeat(depth(t))}
                  {t.title}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.hint}>
            The canvas moves with its boards, comments and history. The text it came from keeps showing it, and so does
            any other text that embeds it. It also shows under Linked docs.
          </div>
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
            disabled={busy || !name.trim()}
            onClick={() => onMove({ name: name.trim(), parentId: parentId || null })}
          >
            {busy ? 'Moving…' : 'Move to Docs'}
          </button>
        </div>
      </div>
    </div>
  );
}
