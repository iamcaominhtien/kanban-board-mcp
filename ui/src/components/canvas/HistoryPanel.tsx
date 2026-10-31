import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  canvasDownloadUrl,
  canvasFailure,
  canvasKeys,
  compareVersions,
  fetchVersion,
  nameVersion,
  restoreVersion,
  sourceDiff,
  useCanvasVersions,
  type CanvasBoard,
  type CanvasVersion,
  type CompareRow,
} from '../../api/canvases';
import { absoluteTime, actorName, relativeTime } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { BoardFrame } from './BoardFrame';
import { CanvasIcon } from './CanvasIcon';
import { CanvasStatic } from './CanvasStatic';
import { useWidth } from './useWidth';
import styles from './Canvas.module.css';

interface Props {
  canvasId: string;
  canEdit: boolean;
  onClose: () => void;
  /** Called after a restore, so the editor reloads. */
  onRestored: () => void;
}

const REASON: Record<string, string> = {
  done: 'Done',
  proposal: 'Accepted a proposal',
  auto: 'Saved in Docs',
  restore: 'Restored',
  create: 'Created',
  named: 'Named',
};

/**
 * History: every Done, every accepted AI proposal and every change in a Docs page (grouped every 10 minutes) makes a
 * version of the whole canvas. A version can be named, looked at, compared with the one before, and restored
 * (restoring makes a new version; nothing is lost).
 * @param props - The canvas and what to do after a restore.
 */
export function HistoryPanel({ canvasId, canEdit, onClose, onRestored }: Props) {
  const q = useCanvasVersions(canvasId);
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<CanvasVersion | null>(null);
  const [compare, setCompare] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const versions = useMemo(() => q.data ?? [], [q.data]);
  useEffect(() => {
    if (selected == null && versions.length) setSelected(versions[0].version);
  }, [selected, versions]);
  useEffect(() => {
    if (selected == null) return;
    let off = false;
    fetchVersion(canvasId, selected)
      .then((v) => !off && setDetail(v))
      .catch(() => !off && setDetail(null));
    return () => {
      off = true;
    };
  }, [canvasId, selected]);
  const { ref, width } = useWidth<HTMLDivElement>(340);
  const refresh = () => void qc.invalidateQueries({ queryKey: canvasKeys.versions(canvasId) });

  const restore = async () => {
    if (selected == null) return;
    setBusy(true);
    try {
      const out = await restoreVersion(canvasId, selected);
      toast.success('Restored', `Version ${selected} is now version ${out.version}. Nothing is lost.`);
      refresh();
      onRestored();
    } catch (e) {
      toast.error('Could not restore', canvasFailure(e).message);
    } finally {
      setBusy(false);
    }
  };
  const rename = async () => {
    if (selected == null) return;
    const name = window.prompt('Name this version', versions.find((v) => v.version === selected)?.name ?? '');
    if (name == null) return;
    try {
      await nameVersion(canvasId, selected, name.trim() || null);
      refresh();
    } catch (e) {
      toast.error('Could not name it', canvasFailure(e).message);
    }
  };

  return (
    <>
      <aside
        className={`${styles.root} ${styles.drawer}`}
        role="dialog"
        aria-label="History"
        data-testid="canvas-history"
      >
        <div className={styles.drawerHead}>
          <CanvasIcon name="history" size={16} /> History
          <span className={styles.spacer} />
          <button type="button" className={styles.iconBtn} aria-label="Close" onClick={onClose}>
            <CanvasIcon name="close" size={14} />
          </button>
        </div>
        <div className={styles.hint} style={{ padding: '8px 14px' }}>
          Every Done, every accepted AI proposal and every change in a Docs page (grouped every 10 minutes) makes a
          version of the whole canvas.
        </div>
        <div className={styles.sideBody}>
          {versions.map((v) => (
            <button
              key={v.version}
              type="button"
              className={`${styles.version} ${selected === v.version ? styles.versionOn : ''}`}
              onClick={() => setSelected(v.version)}
              data-testid="canvas-version"
            >
              <span className={styles.versionName}>
                Version {v.version}
                {v.name && (
                  <span className={styles.chip} style={{ background: '#f1f8f3', color: '#1f5a31' }}>
                    {v.name}
                  </span>
                )}
              </span>
              <span className={styles.hint} title={absoluteTime(v.createdAt)}>
                {relativeTime(v.createdAt)} · {actorName(v.author)}
                {REASON[v.reason] && v.reason !== 'done' ? `, ${REASON[v.reason].toLowerCase()}` : ''}
              </span>
              <span style={{ display: 'block', fontSize: 13 }}>{v.summary || v.note}</span>
            </button>
          ))}
        </div>
        {detail && (
          <div style={{ borderTop: '1px solid #e3e8e5', padding: 12 }}>
            <div ref={ref}>
              {detail.doc && <CanvasStatic canvasId={canvasId} doc={detail.doc} width={width} maxHeight={170} />}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {canEdit && versions[0]?.version !== selected && (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={busy}
                  onClick={() => void restore()}
                  data-testid="canvas-restore"
                >
                  Restore this version
                </button>
              )}
              {canEdit && (
                <button type="button" className={styles.btn} onClick={() => void rename()}>
                  Name…
                </button>
              )}
              {selected != null && selected > 1 && (
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => setCompare(selected)}
                  data-testid="canvas-compare"
                >
                  Compare with the one before
                </button>
              )}
              {selected != null && (
                <a
                  className={styles.btn}
                  href={canvasDownloadUrl(canvasId, undefined, selected)}
                  download
                  style={{ textDecoration: 'none' }}
                >
                  <CanvasIcon name="download" size={14} /> ZIP
                </a>
              )}
            </div>
            <div className={styles.hint} style={{ marginTop: 6 }}>
              Restoring makes a new version; nothing is lost.
            </div>
          </div>
        )}
      </aside>
      {compare != null && <ComparePane canvasId={canvasId} b={compare} onClose={() => setCompare(null)} />}
    </>
  );
}

function ComparePane({ canvasId, b, onClose }: { canvasId: string; b: number; onClose: () => void }) {
  const [rows, setRows] = useState<CompareRow[] | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [diff, setDiff] = useState<{ path: string; diff: string }[] | null>(null);
  const a = b - 1;
  useEffect(() => {
    let off = false;
    compareVersions(canvasId, a, b)
      .then((r) => !off && setRows(r.boards))
      .catch(() => !off && setRows([]));
    return () => {
      off = true;
    };
  }, [canvasId, a, b]);
  const { ref, width } = useWidth<HTMLDivElement>(420);
  const changedFirst = [...(rows ?? [])].sort((x, y) => Number(y.state !== 'same') - Number(x.state !== 'same'));
  const show = changedFirst.find((r) => r.boardId === pick) ?? changedFirst[0];
  useEffect(() => {
    setDiff(null);
  }, [show?.boardId]);
  const side = (bd: CanvasBoard | null, label: string, ver: number) => {
    const scale = bd ? Math.min(1, (width / 2 - 24) / bd.w) : 1;
    return (
      <div className={styles.comparePane}>
        <div className={styles.comparePaneHead}>
          {label} · version {ver}
        </div>
        {bd ? (
          <div style={{ padding: 8, overflow: 'hidden' }}>
            <BoardFrame canvasId={canvasId} board={bd} scale={scale} live rev={bd.content?.rev} />
          </div>
        ) : (
          <div className={styles.hint} style={{ padding: 20 }}>
            Not on this version.
          </div>
        )}
      </div>
    );
  };
  return (
    <div
      className={`${styles.root} ${styles.compare}`}
      role="dialog"
      aria-label="Compare versions"
      data-testid="canvas-compare-view"
    >
      <div className={styles.header}>
        <b style={{ fontSize: 15 }}>
          Compare version {a} and version {b}
        </b>
        <span className={styles.spacer} />
        <button type="button" className={styles.btn} onClick={onClose}>
          Close
        </button>
      </div>
      <div className={styles.compareBody} ref={ref}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
          {changedFirst.map((r) => (
            <button
              key={r.boardId}
              type="button"
              className={`${styles.filter} ${show?.boardId === r.boardId ? styles.filterOn : ''}`}
              onClick={() => setPick(r.boardId)}
            >
              {r.name}{' '}
              <span
                className={`${styles.state} ${r.state === 'changed' ? styles.stateChanged : r.state === 'added' ? styles.stateAdded : r.state === 'removed' ? styles.stateRemoved : styles.stateSame}`}
              >
                {r.state[0].toUpperCase() + r.state.slice(1)}
              </span>
            </button>
          ))}
          {rows && !rows.length && <span className={styles.hint}>Nothing to compare.</span>}
        </div>
        {show && (
          <>
            <div className={styles.compareRow}>
              {side(show.a, 'Before', a)}
              {side(show.b, 'After', b)}
            </div>
            {(show.kind === 'html' || show.kind === 'empty') && show.state === 'changed' && (
              <>
                <button
                  type="button"
                  className={styles.btn}
                  onClick={() => void sourceDiff(canvasId, show.boardId, a, b).then((r) => setDiff(r.files))}
                  data-testid="canvas-source-diff-btn"
                >
                  <CanvasIcon name="code" size={14} /> Source diff
                </button>
                {diff?.map((f) => (
                  <pre key={f.path} className={styles.diffBox}>
                    {f.diff.split('\n').map((line, i) => (
                      <span
                        key={i}
                        className={
                          line.startsWith('+') && !line.startsWith('+++')
                            ? styles.diffAdd
                            : line.startsWith('-') && !line.startsWith('---')
                              ? styles.diffDel
                              : undefined
                        }
                      >
                        {line}
                        {'\n'}
                      </span>
                    ))}
                  </pre>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
