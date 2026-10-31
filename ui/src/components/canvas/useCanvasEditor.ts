import { useCallback, useEffect, useRef, useState } from 'react';
import {
  canvasFailure,
  copyCanvas,
  fetchCanvas,
  saveCanvas,
  type BoardLock,
  type Canvas,
  type CanvasDoc,
} from '../../api/canvases';
import { cloneDoc, differingIds, mergeAfterSave, rebaseRevs } from './docMerge';
import { layoutChanges } from './planeMath';

export type SaveState = 'idle' | 'saving' | 'error' | 'offline';

/** Someone saved the same frame or note while this person was arranging. */
export interface Conflict {
  author: string;
  at?: string;
  ids: string[];
}

const SAVE_DELAY = 700;
const POLL_MS = 4000;
const draftKey = (id: string) => `kanban-canvas-draft:${id}`;

function readDraft(id: string): { baseRev: number; doc: CanvasDoc } | null {
  try {
    const raw = localStorage.getItem(draftKey(id));
    return raw ? (JSON.parse(raw) as { baseRev: number; doc: CanvasDoc }) : null;
  } catch {
    return null;
  }
}
function writeDraft(id: string, baseRev: number, doc: CanvasDoc) {
  try {
    localStorage.setItem(draftKey(id), JSON.stringify({ baseRev, doc, at: Date.now() }));
  } catch {
    /* storage unavailable or full: the draft is a convenience */
  }
}
function clearDraft(id: string) {
  try {
    localStorage.removeItem(draftKey(id));
  } catch {
    /* ignore */
  }
}

/**
 * The editor's state and how it stays in step with the server: the plane as the person has it on screen, layout
 * changes saved as they are made (merged per item), others' changes picked up while idle, undo of layout changes,
 * the "someone saved in the meantime" and "could not save" states, and a draft kept on this computer.
 * @param canvasId - The canvas to edit.
 * @param canEditHint - Whether editing is allowed (a viewer never saves).
 */
export function useCanvasEditor(canvasId: string) {
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [doc, setDocState] = useState<CanvasDoc | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading');
  const [save, setSave] = useState<SaveState>('idle');
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [locks, setLocks] = useState<BoardLock[]>([]);
  const [draftKept, setDraftKept] = useState(false);
  const [tick, setTick] = useState(0);

  const docRef = useRef<CanvasDoc | null>(null);
  const baseRef = useRef<CanvasDoc | null>(null);
  const revRef = useRef(0);
  const inflight = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const undoStack = useRef<CanvasDoc[]>([]);
  const redoStack = useRef<CanvasDoc[]>([]);
  const stopped = useRef(false); // while a conflict card is shown nothing is saved
  const canvasRef = useRef<Canvas | null>(null);

  const apply = useCallback((next: CanvasDoc) => {
    docRef.current = next;
    setDocState(next);
  }, []);

  const adopt = useCallback((c: Canvas) => {
    canvasRef.current = c;
    setCanvas(c);
    setLocks(c.locks);
    revRef.current = c.rev;
  }, []);

  // ---- load ----
  useEffect(() => {
    let off = false;
    setStatus('loading');
    fetchCanvas(canvasId)
      .then((c) => {
        if (off) return;
        adopt(c);
        baseRef.current = cloneDoc(c.doc);
        const draft = readDraft(canvasId);
        if (draft && draft.baseRev === c.rev && layoutChanges(c.doc, draft.doc).empty === false) {
          apply(draft.doc);
          setDraftKept(true);
          setTick((t) => t + 1);
        } else {
          apply(cloneDoc(c.doc));
        }
        setStatus('ready');
      })
      .catch(() => !off && setStatus('missing'));
    return () => {
      off = true;
      window.clearTimeout(timer.current);
    };
  }, [canvasId, adopt, apply]);

  const flush = useCallback(
    async (force = false) => {
      const c = canvasRef.current;
      const working = docRef.current;
      const base = baseRef.current;
      if (!c || !working || !base || inflight.current || (stopped.current && !force) || !c.canEdit) return;
      const ch = layoutChanges(base, working);
      if (ch.empty) {
        setSave('idle');
        clearDraft(canvasId);
        setDraftKept(false);
        return;
      }
      inflight.current = true;
      setSave('saving');
      const sent = cloneDoc(working);
      try {
        const out = await saveCanvas(canvasId, {
          baseRev: revRef.current,
          upsert: ch.upsert,
          remove: ch.remove,
          force,
        });
        revRef.current = out.rev;
        baseRef.current = cloneDoc(out.doc);
        const merged = mergeAfterSave(out.doc, sent, docRef.current ?? sent);
        apply(merged);
        setCanvas((cur) => (cur ? { ...cur, rev: out.rev, version: out.version, doc: out.doc } : cur));
        canvasRef.current = canvasRef.current ? { ...canvasRef.current, rev: out.rev, version: out.version } : null;
        setSave('idle');
        setFailure(null);
        setConflict(null);
        stopped.current = false;
        if (layoutChanges(baseRef.current, merged).empty) {
          clearDraft(canvasId);
          setDraftKept(false);
        } else {
          setTick((t) => t + 1); // more changed while saving
        }
      } catch (e) {
        const f = canvasFailure(e);
        if (f.code === 'canvas_conflict') {
          stopped.current = true;
          setConflict({ author: f.latestAuthor ?? 'Someone', at: f.latestAt, ids: f.conflicts ?? [] });
          setSave('idle');
        } else {
          setSave(f.code === 'offline' ? 'offline' : 'error');
          setFailure(f.message);
        }
        writeDraft(canvasId, revRef.current, docRef.current ?? sent);
        setDraftKept(true);
      } finally {
        inflight.current = false;
      }
    },
    [canvasId, apply],
  );

  // layout changes are saved as they are made
  useEffect(() => {
    if (status !== 'ready' || tick === 0) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_DELAY);
    return () => window.clearTimeout(timer.current);
  }, [tick, status, flush]);

  // retry when the connection is back, and every 10 s after a failure
  useEffect(() => {
    if (save !== 'error' && save !== 'offline') return;
    const retry = () => void flush();
    window.addEventListener('online', retry);
    const t = window.setInterval(retry, 10_000);
    return () => {
      window.removeEventListener('online', retry);
      window.clearInterval(t);
    };
  }, [save, flush]);

  // pick up what other people did while this person is not changing anything
  useEffect(() => {
    if (status !== 'ready') return;
    const t = window.setInterval(async () => {
      const working = docRef.current;
      const base = baseRef.current;
      if (!working || !base || inflight.current || stopped.current) return;
      if (!layoutChanges(base, working).empty) return;
      try {
        const c = await fetchCanvas(canvasId);
        setLocks(c.locks);
        setCanvas((cur) =>
          cur
            ? {
                ...cur,
                openComments: c.openComments,
                proposalsOpen: c.proposalsOpen,
                title: c.title,
                version: c.version,
              }
            : cur,
        );
        if (c.rev !== revRef.current) {
          const stillClean = docRef.current && baseRef.current && layoutChanges(baseRef.current, docRef.current).empty;
          if (!stillClean) return;
          revRef.current = c.rev;
          baseRef.current = cloneDoc(c.doc);
          apply(cloneDoc(c.doc));
          canvasRef.current = c;
        }
      } catch {
        /* the next tick tries again */
      }
    }, POLL_MS);
    return () => window.clearInterval(t);
  }, [canvasId, status, apply]);

  /** Change the plane. The change is saved shortly after and can be undone with Ctrl Z. */
  const mutate = useCallback(
    (fn: (d: CanvasDoc) => void, opts: { history?: boolean } = {}) => {
      const cur = docRef.current;
      if (!cur) return;
      const next = cloneDoc(cur);
      fn(next);
      if (opts.history !== false) {
        undoStack.current.push(cur);
        if (undoStack.current.length > 100) undoStack.current.shift();
        redoStack.current = [];
      }
      apply(next);
      setTick((t) => t + 1);
    },
    [apply],
  );

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev || !docRef.current) return false;
    redoStack.current.push(docRef.current);
    apply(baseRef.current ? rebaseRevs(prev, baseRef.current) : prev);
    setTick((t) => t + 1);
    return true;
  }, [apply]);
  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next || !docRef.current) return false;
    undoStack.current.push(docRef.current);
    apply(baseRef.current ? rebaseRevs(next, baseRef.current) : next);
    setTick((t) => t + 1);
    return true;
  }, [apply]);

  /** Reload from the server (after adding a frame, restoring a version, accepting a proposal). Unsaved layout is kept. */
  const reload = useCallback(async () => {
    const c = await fetchCanvas(canvasId);
    const working = docRef.current;
    const base = baseRef.current;
    const dirty = working && base && !layoutChanges(base, working).empty;
    revRef.current = c.rev;
    canvasRef.current = c;
    setCanvas(c);
    setLocks(c.locks);
    if (dirty && working && base) {
      // keep what the person changed; take the rest from the server
      const merged = mergeAfterSave(c.doc, base, working);
      baseRef.current = cloneDoc(c.doc);
      apply(merged);
      setTick((t) => t + 1);
    } else {
      baseRef.current = cloneDoc(c.doc);
      apply(cloneDoc(c.doc));
    }
    return c;
  }, [canvasId, apply]);

  /** Save now (Done) and wait for it. Resolves true when everything is on the server. */
  const saveNow = useCallback(async (): Promise<boolean> => {
    window.clearTimeout(timer.current);
    for (let i = 0; i < 20 && inflight.current; i++) await new Promise((r) => setTimeout(r, 100));
    await flush();
    const working = docRef.current;
    const base = baseRef.current;
    return !!working && !!base && layoutChanges(base, working).empty;
  }, [flush]);

  /** "Load theirs": drop this person's layout changes and take the server's plane. */
  const loadTheirs = useCallback(async () => {
    stopped.current = false;
    setConflict(null);
    clearDraft(canvasId);
    setDraftKept(false);
    undoStack.current = [];
    redoStack.current = [];
    const c = await fetchCanvas(canvasId);
    revRef.current = c.rev;
    canvasRef.current = c;
    setCanvas(c);
    baseRef.current = cloneDoc(c.doc);
    apply(cloneDoc(c.doc));
    setSave('idle');
  }, [canvasId, apply]);

  /** "Replace theirs": save this person's plane over the newer one. */
  const keepMine = useCallback(async () => {
    stopped.current = false;
    setConflict(null);
    const c = await fetchCanvas(canvasId);
    revRef.current = c.rev;
    await flush(true);
  }, [canvasId, flush]);

  /** "Save as copy": a second canvas that holds this person's plane. Returns it. */
  const saveCopy = useCallback(async (): Promise<Canvas | null> => {
    const working = docRef.current;
    const base = baseRef.current;
    if (!working || !base) return null;
    const ch = layoutChanges(base, working);
    const copy = await copyCanvas(canvasId);
    const upsert: Record<string, unknown[]> = {};
    for (const [k, items] of Object.entries(ch.upsert)) {
      upsert[k] = items.map((i) => {
        const same = copy.doc[k as 'boards'].find((x) => x.id === i.id);
        return { ...i, rev: same?.rev };
      });
    }
    await saveCanvas(copy.id, { baseRev: copy.rev, upsert: upsert as never, remove: ch.remove, force: true });
    return fetchCanvas(copy.id);
  }, [canvasId]);

  const conflictItems = useCallback(
    (serverDoc: CanvasDoc) => (docRef.current ? differingIds(docRef.current, serverDoc) : []),
    [],
  );

  return {
    canvas,
    doc,
    status,
    save,
    failure,
    conflict,
    locks,
    draftKept,
    mutate,
    undo,
    redo,
    reload,
    saveNow,
    retry: () => void flush(),
    loadTheirs,
    keepMine,
    saveCopy,
    conflictItems,
    setLocks,
    revRef,
    canUndo: () => undoStack.current.length > 0,
    discardDraft: () => {
      clearDraft(canvasId);
      setDraftKept(false);
    },
  };
}
