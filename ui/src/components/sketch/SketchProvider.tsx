import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { relativeTime } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { deleteDraft, listDrafts, type SketchDraft } from './draftStore';
import { SketchContext, type OpenSketchRequest, type SketchApi, type SketchResult } from './SketchContext';
import { SketchIcon } from './SketchIcon';
import { SketchViewer } from './SketchViewer';
import styles from './Sketch.module.css';

// the editor (the drawing engine and all its panels) is only fetched when someone starts a drawing
const SketchEditor = lazy(() => import('./SketchEditor').then((m) => ({ default: m.SketchEditor })));

interface Open {
  request: OpenSketchRequest;
  resolve: (r: SketchResult | null) => void;
}

/**
 * Hosts the sketch editor and the large viewer for the whole app, and offers to restore a drawing that was
 * not saved when the app was closed.
 * @param props.children - The app.
 */
export function SketchProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [open, setOpen] = useState<Open | null>(null);
  const openRef = useRef<Open | null>(null);
  const [viewer, setViewer] = useState<{ id: string; title: string; version?: number } | null>(null);
  const [drafts, setDrafts] = useState<SketchDraft[]>([]);

  const openSketch = useCallback((request: OpenSketchRequest) => {
    return new Promise<SketchResult | null>((resolve) => {
      if (openRef.current) {
        resolve(null); // one editor at a time
        return;
      }
      const o = { request, resolve };
      openRef.current = o;
      setOpen(o);
    });
  }, []);

  const api = useMemo<SketchApi>(
    () => ({ openSketch, openViewer: (s) => setViewer(s), available: true }),
    [openSketch],
  );

  const refreshDrafts = useCallback(() => {
    void listDrafts().then(setDrafts);
  }, []);
  useEffect(refreshDrafts, [refreshDrafts]);

  const close = (result: SketchResult | null) => {
    const o = openRef.current;
    openRef.current = null;
    setOpen(null);
    o?.resolve(result);
    refreshDrafts();
  };

  const restore = async (d: SketchDraft) => {
    const r = await openSketch({
      ownerKind: d.ownerKind as OpenSketchRequest['ownerKind'],
      ownerId: d.ownerId,
      sketchId: d.sketchId,
      projectId: d.projectId,
      title: d.title,
      ownerLabel: d.ownerLabel,
      restoreDraft: true,
    });
    // a drawing that was new has no text to go into now: hand over its markdown
    if (r && !d.sketchId) {
      void navigator.clipboard
        ?.writeText(r.markdown)
        .then(() => toast.success('Sketch saved', `Paste ${r.markdown} where it belongs.`))
        .catch(() => toast.success('Sketch saved', r.markdown));
    }
  };

  const found = !open && drafts[0];
  return (
    <SketchContext.Provider value={api}>
      {children}
      {open && (
        <Suspense fallback={null}>
          <SketchEditor request={open.request} onClose={close} />
        </Suspense>
      )}
      {viewer && <SketchViewer sketch={viewer} onClose={() => setViewer(null)} />}
      {found && (
        <div className={styles.found} role="status" data-testid="sketch-found">
          <SketchIcon name="refresh" size={18} />
          <div style={{ flex: 1, minWidth: 200, fontSize: 13 }}>
            <b style={{ display: 'block', fontSize: 14 }}>Unsaved drawing found</b>
            You closed the app while drawing “{found.title}” {relativeTime(new Date(found.savedAt).toISOString())}.
          </div>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={() => void restore(found)}
            data-testid="sketch-found-restore"
          >
            Restore
          </button>
          <button
            type="button"
            className={styles.btn}
            onClick={() => {
              void deleteDraft(found.key).then(refreshDrafts);
            }}
          >
            Discard
          </button>
        </div>
      )}
    </SketchContext.Provider>
  );
}
