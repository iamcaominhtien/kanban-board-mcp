import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  addBoard,
  addThread,
  canvasDownloadUrl,
  canvasFailure,
  canvasKeys,
  canvasMarkdown,
  duplicateBoard,
  importFiles,
  replaceBoard,
  useCanvasProposals,
  useCanvasThreads,
  type AiJob,
  type CanvasBoard,
  type CanvasNote,
  type CanvasThread,
  type NoteColor,
} from '../../api/canvases';
import { useToast } from '../Toast';
import { useDiagrams } from '../diagrams/DiagramsContext';
import { useSketch } from '../sketch/SketchContext';
import { AskAiPanel, ProposalReview, type WorkingJob } from './CanvasAi';
import { BoardFrame } from './BoardFrame';
import { CanvasIcon } from './CanvasIcon';
import { useCanvas, type CanvasResult, type OpenCanvasRequest } from './CanvasContext';
import { NOTE_BG } from './CanvasStatic';
import { CommentsPanel } from './CommentsPanel';
import { BoardMenu, BoardsPanel, KeysList, blockedLine, blockedTotal } from './EditorParts';
import { HistoryPanel } from './HistoryPanel';
import { MoveToDocsDialog } from './MoveToDocsDialog';
import { SourceEditor } from './SourceEditor';
import { boardToPng, printBoards } from './exportBoard';
import { newId } from './ids';
import { importSketchFile } from './sketchImport';
import {
  ZOOM_MAX,
  ZOOM_MIN,
  arrowLine,
  boundsOf,
  fitView,
  intersects,
  isSnapshot,
  orderedBoards,
  rectFrom,
  resizeRect,
  snapMove,
  stepBoard,
  toPlane,
  zoomAt,
  type Guide,
  type Handle,
  type Rect,
  type View,
} from './planeMath';
import { useCanvasEditor } from './useCanvasEditor';
import { useSize } from './useWidth';
import styles from './Canvas.module.css';

type Tool = 'select' | 'hand' | 'board' | 'note' | 'arrow' | 'label' | 'comment';
const TOOLS: { id: Tool; key: string; label: string; icon: string; hint: string }[] = [
  { id: 'select', key: 'V', label: 'Select', icon: 'select', hint: 'Move, resize, multi-select' },
  { id: 'hand', key: 'H', label: 'Hand', icon: 'hand', hint: 'Pan the plane (or hold Space)' },
  { id: 'board', key: 'B', label: 'Board', icon: 'board', hint: 'Add a board: file, Sketch, Diagram or empty' },
  { id: 'note', key: 'N', label: 'Note', icon: 'note', hint: 'A sticky note; colour from 6' },
  { id: 'arrow', key: 'A', label: 'Arrow', icon: 'arrow', hint: 'Join two boards or notes' },
  { id: 'label', key: 'T', label: 'Label', icon: 'text', hint: 'A heading or caption on the plane' },
  { id: 'comment', key: 'C', label: 'Comment', icon: 'comment', hint: 'Click a board or the plane to pin a comment' },
];
const COLORS: NoteColor[] = ['yellow', 'green', 'blue', 'pink', 'purple', 'grey'];
const viewKey = (c: string, p: string) => `kanban-canvas-view:${c}:${p}`;

function readView(c: string, p: string): View | null {
  try {
    const raw = localStorage.getItem(viewKey(c, p));
    return raw ? (JSON.parse(raw) as View) : null;
  } catch {
    return null;
  }
}

interface Props {
  canvasId: string;
  request: OpenCanvasRequest;
  /** `overlay` is the full window over the page; `page` is a canvas that is a Docs page (no Done, saves as it goes). */
  variant?: 'overlay' | 'page';
  me: string;
  onClose: (result: CanvasResult | null) => void;
}

// A board's picture does not change while it is dragged or the plane is zoomed, so it is not redrawn
const MemoFrame = memo(
  BoardFrame,
  (a, b) =>
    a.canvasId === b.canvasId &&
    a.live === b.live &&
    a.scale === b.scale &&
    a.reloadKey === b.reloadKey &&
    a.board.id === b.board.id &&
    a.board.w === b.board.w &&
    a.board.h === b.board.h &&
    a.board.kind === b.board.kind &&
    a.board.ref === b.board.ref &&
    a.board.content?.rev === b.board.content?.rev,
);

interface Drag {
  kind: 'pan' | 'move' | 'resize' | 'marquee';
  start: { x: number; y: number }; // plane
  startScreen: { x: number; y: number };
  startView: View;
  items?: { id: string; list: 'boards' | 'notes' | 'labels'; x: number; y: number; w: number; h: number }[];
  handle?: Handle;
  id?: string;
  moved: boolean;
  additive?: boolean;
}

/**
 * The canvas editor: the plane with boards, notes, arrows and labels; a page-tab bar; a tool bar; zoom, fit and map;
 * the Boards and Comments panels; board locks and the source editor; history; Ask AI and proposals; presenting.
 * Everything is reachable from the keyboard (press ? for the list).
 * @param props.canvasId - The canvas.
 * @param props.request - Where it was opened from, and what to select.
 * @param props.variant - Full window, or inside a Docs page.
 * @param props.me - Who is editing.
 * @param props.onClose - Called with the canvas when Done, or null when closed without one.
 */
export function CanvasEditor({ canvasId, request, variant = 'overlay', me, onClose }: Props) {
  const ed = useCanvasEditor(canvasId);
  const { doc, canvas } = ed;
  const api = useCanvas();
  const toast = useToast();
  const qc = useQueryClient();
  const sketchApi = useSketch();
  const diagrams = useDiagrams();
  const isPage = variant === 'page';
  const canEdit = !!canvas?.canEdit;
  const { ref: planeRef, size: win } = useSize<HTMLDivElement>();

  const [pageId, setPageId] = useState<string | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [tool, setTool] = useState<Tool>('select');
  const [sel, setSel] = useState<string[]>(request.boardId ? [request.boardId] : []);
  const [hover, setHover] = useState<string | null>(null);
  const [side, setSide] = useState<'boards' | 'comments' | null>(null);
  const [showMap, setShowMap] = useState(true);
  const [focus, setFocus] = useState(false);
  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [rubber, setRubber] = useState<{ from: string; to: { x: number; y: number } } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [addMenu, setAddMenu] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  const [blockedFor, setBlockedFor] = useState<string | null>(null);
  const [editNote, setEditNote] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState<string | null>(null);
  const [editTab, setEditTab] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [askFor, setAskFor] = useState<string[] | null>(null);
  const [askText, setAskText] = useState('');
  const [proposals, setProposals] = useState(false);
  const [jobs, setJobs] = useState<WorkingJob[]>([]);
  const [pinDraft, setPinDraft] = useState<{
    boardId: string | null;
    x: number;
    y: number;
    sx: number;
    sy: number;
  } | null>(null);
  const [pinText, setPinText] = useState('');
  const [selThread, setSelThread] = useState<string | null>(null);
  const [keys, setKeys] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [moveDocs, setMoveDocs] = useState(false);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const noteColor = useRef<NoteColor>('yellow');
  const drag = useRef<Drag | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceFor = useRef<string | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pageRef = useRef<string | null>(null);
  pageRef.current = pageId;
  const started = useRef(false);

  const ready = ed.status === 'ready';
  const threadsQ = useCanvasThreads(canvasId, ready);
  const proposalsQ = useCanvasProposals(canvasId, ready);
  const threads: CanvasThread[] = useMemo(() => threadsQ.data ?? [], [threadsQ.data]);
  const openProposals = (proposalsQ.data ?? []).filter((p) => p.status === 'open');

  // first load: pick the page tab, restore its view, select the asked board
  useEffect(() => {
    if (!doc || started.current) return;
    started.current = true;
    const target = request.boardId ? doc.boards.find((b) => b.id === request.boardId) : undefined;
    const first = target?.page ?? doc.pages[0]?.id ?? null;
    setPageId(first);
    setTitle(canvas?.title ?? '');
    if (request.openAi && target) setAskFor([target.id]);
  }, [doc, canvas?.title, request.boardId, request.openAi]);
  useEffect(() => {
    if (canvas && !title) setTitle(canvas.title);
  }, [canvas, title]);

  const pageBoards = useMemo(() => (doc && pageId ? doc.boards.filter((b) => b.page === pageId) : []), [doc, pageId]);
  const pageNotes = useMemo(() => (doc && pageId ? doc.notes.filter((n) => n.page === pageId) : []), [doc, pageId]);
  const pageLabels = useMemo(() => (doc && pageId ? doc.labels.filter((n) => n.page === pageId) : []), [doc, pageId]);
  const pageArrows = useMemo(() => (doc && pageId ? doc.arrows.filter((n) => n.page === pageId) : []), [doc, pageId]);
  const ordered = useMemo(() => (doc && pageId ? orderedBoards(doc, pageId) : []), [doc, pageId]);
  const boardById = useCallback((id: string) => doc?.boards.find((b) => b.id === id), [doc]);

  const rectOf = useCallback(
    (id: string): Rect | null => {
      const x = doc?.boards.find((b) => b.id === id) ?? doc?.notes.find((n) => n.id === id);
      return x ? { x: x.x, y: x.y, w: x.w, h: x.h } : null;
    },
    [doc],
  );

  // ---- the view of a page tab is remembered for each person ----
  const fit = useCallback(
    (ids?: string[]) => {
      const rects = ids?.length
        ? ids.map(rectOf).filter((r): r is Rect => !!r)
        : [
            ...pageBoards.map((b) => ({ x: b.x, y: b.y - 22, w: b.w, h: b.h + 22 })),
            ...pageNotes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
            ...pageLabels.map((l) => ({
              x: l.x,
              y: l.y,
              w: Math.max(80, l.text.length * l.size * 0.6),
              h: l.size * 1.4,
            })),
          ];
      setView(fitView(boundsOf(rects), win, 60, ids?.length ? ZOOM_MAX : 1));
    },
    [pageBoards, pageNotes, pageLabels, rectOf, win],
  );
  const lastPage = useRef<string | null>(null);
  const measured = win.w >= 200 && win.h >= 100;
  useEffect(() => {
    if (!pageId || !doc || !measured) return;
    if (lastPage.current && lastPage.current !== pageId) {
      try {
        localStorage.setItem(viewKey(canvasId, lastPage.current), JSON.stringify(viewRef.current));
      } catch {
        /* ignore */
      }
    }
    if (lastPage.current !== pageId) {
      lastPage.current = pageId;
      const saved = readView(canvasId, pageId);
      if (saved) setView(saved);
      else if (request.boardId && boardById(request.boardId)?.page === pageId) fit([request.boardId]);
      else fit();
    }
  }, [pageId, doc, measured, canvasId, fit, request.boardId, boardById]);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!pageRef.current) return;
      try {
        localStorage.setItem(viewKey(canvasId, pageRef.current), JSON.stringify(viewRef.current));
      } catch {
        /* ignore */
      }
    }, 400);
    return () => window.clearTimeout(t);
  }, [view, canvasId]);
  const lockOf = useCallback((id: string) => ed.locks.find((l) => l.boardId === id), [ed.locks]);
  const jobOf = useCallback((id: string) => jobs.find((j) => j.boardIds.includes(id)), [jobs]);
  const commentsByBoard = useMemo(() => {
    const out: Record<string, number> = {};
    for (const t of threads) if (t.status === 'open' && t.boardId) out[t.boardId] = (out[t.boardId] ?? 0) + 1;
    return out;
  }, [threads]);
  const openOnPage = threads.filter((t) => t.status === 'open').length;

  // ---- helpers for changes ----
  const patchBoard = (id: string, fn: (b: CanvasBoard) => void) =>
    ed.mutate((d) => {
      const b = d.boards.find((x) => x.id === id);
      if (b) fn(b);
    });
  const reload = useCallback(async () => {
    await ed.reload();
    void qc.invalidateQueries({ queryKey: canvasKeys.one(canvasId) });
    void qc.invalidateQueries({ queryKey: canvasKeys.versions(canvasId) });
    setReloadKey((k) => k + 1);
  }, [ed, qc, canvasId]);
  const fail = (title: string, e: unknown) => toast.error(title, canvasFailure(e).message);

  const doAddBoard = async (kind: CanvasBoard['kind'], opts: { ref?: string; name?: string; files?: File[] } = {}) => {
    setBusy(true);
    try {
      const out = await addBoard(
        canvasId,
        { kind, page: pageId ?? undefined, ref: opts.ref, name: opts.name },
        opts.files?.map((f) => ({ file: f, path: f.name })),
      );
      await reload();
      setSel([out.board.id]);
      requestAnimationFrame(() => fit([out.board.id]));
      return out.board;
    } catch (e) {
      fail('Could not add the board', e);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const ownerKindForSketch = canvas?.ownerKind === 'page' ? 'doc' : (canvas?.ownerKind ?? 'doc');
  const addSketch = async () => {
    if (!canvas) return;
    const r = await sketchApi.openSketch({
      ownerKind: ownerKindForSketch as 'doc' | 'ticket' | 'idea' | 'comment',
      ownerId: canvas.ownerId,
      projectId: canvas.projectId ?? undefined,
      title: 'Sketch',
      ownerLabel: canvas.title,
    });
    if (r) await doAddBoard('sketch', { ref: r.id, name: r.title });
  };
  const addDiagram = () => {
    if (!canvas?.projectId || !diagrams) return;
    diagrams.openEditor({
      projectId: canvas.projectId,
      label: 'Diagram',
      saveTo: canvas.title,
      itemKind: ownerKindForSketch === 'ticket' ? 'ticket' : ownerKindForSketch === 'comment' ? 'comment' : 'doc',
      itemId: canvas.ownerId,
      onSaved: (d) => void doAddBoard('diagram', { ref: d.id, name: d.label }),
    });
  };

  const importDropped = async (files: File[]) => {
    if (!canEdit || !files.length) return;
    const html: File[] = [];
    for (const f of files) {
      const n = f.name.toLowerCase();
      if (n.endsWith('.drawio') && diagrams && canvas?.projectId) {
        await diagrams.importFile(
          {
            projectId: canvas.projectId,
            saveTo: canvas.title,
            itemKind: 'doc',
            itemId: canvas.ownerId,
            onSaved: (d) => void doAddBoard('diagram', { ref: d.id, name: d.label }),
          },
          f,
        );
      } else if (n.endsWith('.sketch') || n.endsWith('.sketch.json')) {
        try {
          const s = await importSketchFile(f, {
            ownerKind: ownerKindForSketch as 'doc',
            ownerId: canvas?.ownerId ?? '',
            projectId: canvas?.projectId ?? undefined,
          });
          await doAddBoard('sketch', { ref: s.id, name: s.title });
        } catch (e) {
          toast.error('Could not import the sketch', e instanceof Error ? e.message : canvasFailure(e).message);
        }
      } else html.push(f);
    }
    if (!html.length) return;
    setBusy(true);
    try {
      const out = await importFiles(canvasId, html, pageId ?? undefined);
      await reload();
      if (out.boards.length) {
        setSel(out.boards.map((b) => b.id));
        requestAnimationFrame(() => fit(out.boards.map((b) => b.id)));
      }
      for (const f of out.failed) toast.error(`“${f.name}” could not become a board`, f.message);
    } catch (e) {
      fail('Could not add the files', e);
    } finally {
      setBusy(false);
    }
  };

  // ---- pointer ----
  const local = (e: { clientX: number; clientY: number }) => {
    const r = planeRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const hitOf = (target: HTMLElement) => {
    const el = target.closest('[data-item]') as HTMLElement | null;
    return el ? { id: el.dataset.item as string, kind: el.dataset.kind as string } : null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-ui]')) return;
    if (editNote || editLabel) return;
    planeRef.current?.focus({ preventScroll: true });
    setMenuFor(null);
    setAddMenu(false);
    setExportMenu(false);
    setBlockedFor(null);
    const s = local(e);
    const p = toPlane(view, s);
    const base = { start: p, startScreen: s, startView: view, moved: false };
    if (e.button === 1 || tool === 'hand' || space) {
      drag.current = { kind: 'pan', ...base };
      setPanning(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const hit = hitOf(t);
    const handleEl = t.closest('[data-handle]') as HTMLElement | null;
    if (handleEl && canEdit) {
      const id = handleEl.dataset.board as string;
      const b = boardById(id);
      if (b) {
        ed.mutate(() => undefined);
        drag.current = {
          kind: 'resize',
          ...base,
          id,
          handle: handleEl.dataset.handle as Handle,
          items: [{ id, list: 'boards', x: b.x, y: b.y, w: b.w, h: b.h }],
        };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }
      return;
    }
    if (tool === 'note' && canEdit) {
      const id = newId('n');
      ed.mutate((d) => {
        d.notes.push({
          id,
          page: pageId as string,
          x: Math.round(p.x - 80),
          y: Math.round(p.y - 50),
          w: 160,
          h: 100,
          text: '',
          color: noteColor.current,
          by: '',
          rev: undefined as unknown as number,
        });
      });
      // the field opens after the click has finished: the browser focuses the plane on mouse down and would close it
      window.setTimeout(() => setEditNote(id), 0);
      setSel([id]);
      setTool('select');
      return;
    }
    if (tool === 'label' && canEdit) {
      const id = newId('t');
      ed.mutate((d) => {
        d.labels.push({
          id,
          page: pageId as string,
          x: Math.round(p.x),
          y: Math.round(p.y),
          text: 'Label',
          size: 20,
          rev: undefined as unknown as number,
        });
      });
      window.setTimeout(() => setEditLabel(id), 0);
      setSel([id]);
      setTool('select');
      return;
    }
    if (tool === 'arrow' && canEdit) {
      if (hit && (hit.kind === 'board' || hit.kind === 'note')) {
        if (!rubber) setRubber({ from: hit.id, to: p });
        else if (rubber.from !== hit.id) {
          const from = rubber.from;
          ed.mutate((d) => {
            d.arrows.push({
              id: newId('a'),
              page: pageId as string,
              from,
              to: hit.id,
              label: '',
              rev: undefined as unknown as number,
            });
          });
          setRubber(null);
          setTool('select');
        }
      } else setRubber(null);
      return;
    }
    if (tool === 'comment') {
      if (!canvas || canvas.role === 'viewer') return;
      const b = hit?.kind === 'board' ? boardById(hit.id) : undefined;
      setPinText('');
      setPinDraft(
        b
          ? {
              boardId: b.id,
              x: Math.min(1, Math.max(0, (p.x - b.x) / b.w)),
              y: Math.min(1, Math.max(0, (p.y - b.y) / b.h)),
              sx: s.x,
              sy: s.y,
            }
          : { boardId: null, x: p.x, y: p.y, sx: s.x, sy: s.y },
      );
      return;
    }
    // select
    if (hit && canEdit) {
      const additive = e.shiftKey;
      let next = sel;
      if (additive) next = sel.includes(hit.id) ? sel.filter((i) => i !== hit.id) : [...sel, hit.id];
      else if (!sel.includes(hit.id)) next = [hit.id];
      setSel(next);
      if (next.includes(hit.id) && hit.kind !== 'arrow') {
        const items = next
          .map((id) => {
            const b = boardById(id);
            if (b) return { id, list: 'boards' as const, x: b.x, y: b.y, w: b.w, h: b.h };
            const n = doc?.notes.find((x) => x.id === id);
            if (n) return { id, list: 'notes' as const, x: n.x, y: n.y, w: n.w, h: n.h };
            const l = doc?.labels.find((x) => x.id === id);
            if (l)
              return {
                id,
                list: 'labels' as const,
                x: l.x,
                y: l.y,
                w: Math.max(80, l.text.length * l.size * 0.6),
                h: l.size * 1.4,
              };
            return null;
          })
          .filter((x): x is NonNullable<typeof x> => !!x);
        drag.current = { kind: 'move', ...base, items };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      }
      return;
    }
    if (hit) {
      setSel([hit.id]);
      return;
    }
    // empty plane: a box selects, a drag with no key pans nothing
    if (!e.shiftKey) setSel([]);
    drag.current = { kind: 'marquee', ...base, additive: e.shiftKey };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = local(e);
    const d = drag.current;
    const z = view.zoom;
    if (!d) {
      const t = e.target as HTMLElement;
      const hit = hitOf(t);
      const tools = (t.closest('[data-tools-for]') as HTMLElement | null)?.dataset.toolsFor;
      setHover(hit?.kind === 'board' ? hit.id : (tools ?? null));
      if (rubber) setRubber({ ...rubber, to: toPlane(view, s) });
      return;
    }
    const p = toPlane(view, s);
    if (d.kind === 'pan') {
      setView({
        zoom: d.startView.zoom,
        x: d.startView.x - (s.x - d.startScreen.x) / d.startView.zoom,
        y: d.startView.y - (s.y - d.startScreen.y) / d.startView.zoom,
      });
      d.moved = true;
      return;
    }
    if (!d.moved && Math.hypot(s.x - d.startScreen.x, s.y - d.startScreen.y) < 3) return;
    if (!d.moved) {
      d.moved = true;
      if (d.kind !== 'marquee') ed.mutate(() => undefined); // one undo step for the whole drag
    }
    if (d.kind === 'move' && d.items) {
      const dx = p.x - d.start.x;
      const dy = p.y - d.start.y;
      const union = boundsOf(d.items.map((i) => ({ x: i.x + dx, y: i.y + dy, w: i.w, h: i.h })));
      const others = [...pageBoards, ...pageNotes]
        .filter((o) => !d.items?.some((i) => i.id === o.id))
        .map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h }));
      const snap = union && !e.altKey ? snapMove(union, others, 8, z) : { dx: 0, dy: 0, guides: [] as Guide[] };
      setGuides(snap.guides);
      ed.mutate(
        (doc2) => {
          for (const i of d.items ?? []) {
            const target = doc2[i.list].find((x) => x.id === i.id);
            if (target) {
              target.x = Math.round(i.x + dx + snap.dx);
              target.y = Math.round(i.y + dy + snap.dy);
            }
          }
        },
        { history: false },
      );
    } else if (d.kind === 'resize' && d.items && d.handle && d.id) {
      const i = d.items[0];
      const r = resizeRect(
        { x: i.x, y: i.y, w: i.w, h: i.h },
        d.handle,
        p.x - d.start.x,
        p.y - d.start.y,
        undefined,
        undefined,
        e.shiftKey,
      );
      patchBoardQuiet(d.id, r);
    } else if (d.kind === 'marquee') {
      const box = rectFrom(d.start, p);
      setMarquee(box);
      const hit = [...pageBoards, ...pageNotes]
        .filter((o) => intersects(box, { x: o.x, y: o.y, w: o.w, h: o.h }))
        .map((o) => o.id);
      setSel(d.additive ? Array.from(new Set([...sel, ...hit])) : hit);
    }
  };
  const patchBoardQuiet = (id: string, r: Rect) =>
    ed.mutate(
      (d) => {
        const b = d.boards.find((x) => x.id === id);
        if (b) {
          b.x = Math.round(r.x);
          b.y = Math.round(r.y);
          b.w = Math.round(r.w);
          b.h = Math.round(r.h);
        }
      },
      { history: false },
    );
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    setPanning(false);
    setGuides([]);
    setMarquee(null);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (d?.kind === 'marquee' && !d.moved && !d.additive) setSel([]);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const s = local(e);
    if (e.ctrlKey || e.metaKey) setView((v) => zoomAt(v, Math.exp(-e.deltaY * 0.0022), s));
    else
      setView((v) => ({
        ...v,
        x: v.x + (e.shiftKey ? e.deltaY : e.deltaX) / v.zoom,
        y: v.y + (e.shiftKey ? 0 : e.deltaY) / v.zoom,
      }));
  };
  // the wheel must be able to cancel the browser's own zoom and scroll, which a React handler (passive) cannot
  const wheelRef = useRef(onWheel);
  wheelRef.current = onWheel;
  useEffect(() => {
    const el = planeRef.current;
    if (!el) return;
    const fn = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener('wheel', fn, { passive: false });
    return () => el.removeEventListener('wheel', fn);
  }, [planeRef, ed.status]);
  const zoomBy = (f: number) => setView((v) => zoomAt(v, f, { x: win.w / 2, y: win.h / 2 }));

  // ---- actions on boards ----
  const selectedBoards = sel.map(boardById).filter((b): b is CanvasBoard => !!b);
  const oneBoard = selectedBoards.length === 1 ? selectedBoards[0] : null;
  const editBoard = (id: string) => {
    const b = boardById(id);
    if (!b || !canEdit) return;
    if (b.kind === 'html' || b.kind === 'empty') setSource(id);
    else if (b.kind === 'sketch' && b.ref && canvas) {
      void sketchApi
        .openSketch({
          ownerKind: ownerKindForSketch as 'doc',
          ownerId: canvas.ownerId,
          sketchId: b.ref,
          projectId: canvas.projectId ?? undefined,
          title: b.name,
        })
        .then(() => setReloadKey((k) => k + 1));
    } else if (b.kind === 'diagram' && b.ref && canvas?.projectId && diagrams) {
      diagrams.openEditor({
        projectId: canvas.projectId,
        diagramId: b.ref,
        saveTo: canvas.title,
        onSaved: () => setReloadKey((k) => k + 1),
      });
    } else if (b.kind === 'image' && b.content && canvas) {
      // "Draw on it": the picture opens in Sketch on a locked layer and the marked-up copy becomes a board of its own
      void sketchApi
        .openSketch({
          ownerKind: ownerKindForSketch as 'doc',
          ownerId: canvas.ownerId,
          projectId: canvas.projectId ?? undefined,
          baseImageUrl: `/uploads/canvases/${canvas.id}/boards/${b.id}/r${b.content.rev}/${b.content.entry}`,
          title: `${b.name} (marked up)`,
        })
        .then((r) => (r ? doAddBoard('sketch', { ref: r.id, name: r.title }) : null));
    }
  };
  const removeSelection = () => {
    if (!canEdit || !sel.length) return;
    const ids = new Set(sel);
    if ([...ids].some((i) => ed.locks.some((l) => l.boardId === i && l.holder !== me))) {
      toast.error('A board is being edited', 'Someone is editing it. Try again when they finish.');
      return;
    }
    ed.mutate((d) => {
      d.boards = d.boards.filter((b) => !ids.has(b.id));
      d.notes = d.notes.filter((n) => !ids.has(n.id));
      d.labels = d.labels.filter((l) => !ids.has(l.id));
      d.arrows = d.arrows.filter((a) => !ids.has(a.id) && !ids.has(a.from) && !ids.has(a.to));
    });
    setSel([]);
  };
  const duplicateSelected = async () => {
    if (!canEdit) return;
    for (const b of selectedBoards) {
      try {
        const out = await duplicateBoard(canvasId, b.id);
        await reload();
        setSel([out.board.id]);
      } catch (e) {
        fail('Could not duplicate', e);
      }
    }
  };
  const nudge = (dx: number, dy: number) => {
    if (!canEdit || !sel.length) return;
    ed.mutate((d) => {
      for (const list of ['boards', 'notes', 'labels'] as const)
        for (const i of d[list])
          if (sel.includes(i.id)) {
            i.x += dx;
            i.y += dy;
          }
    });
  };
  const copy = (text: string) =>
    void navigator.clipboard?.writeText(text).then(() => toast.success('Link copied', text));
  const startAsk = (ids?: string[]) => {
    const target = ids ?? sel.filter((i) => boardById(i));
    if (!canvas?.projectId || !canEdit) return;
    if (!target.length) {
      toast.info('Select a board first', 'Ask AI works on the boards you select.');
      return;
    }
    setAskFor(target);
  };
  const present = () => {
    if (!canvas) return;
    api.present({ id: canvas.id, boardId: oneBoard?.id ?? sel[0], pageId: pageId ?? undefined });
  };
  const done = async () => {
    setBusy(true);
    const ok = await ed.saveNow();
    if (!ok) {
      setBusy(false);
      toast.error(
        'Not everything is saved yet',
        ed.conflict ? 'Resolve the conflict first.' : 'Try again when the connection is back.',
      );
      return;
    }
    try {
      const { saveCanvas } = await import('../../api/canvases');
      if (canEdit)
        await saveCanvas(canvasId, {
          baseRev: ed.revRef.current,
          checkpoint: true,
          title: title.trim() && title.trim() !== canvas?.title ? title.trim() : undefined,
        });
      ed.discardDraft();
      const c = await ed.reload();
      void qc.invalidateQueries({ queryKey: canvasKeys.one(canvasId) });
      void qc.invalidateQueries({ queryKey: canvasKeys.versions(canvasId) });
      onClose({ id: c.id, title: c.title, markdown: canvasMarkdown(c), canvas: c });
    } catch (e) {
      fail('Could not finish', e);
    } finally {
      setBusy(false);
    }
  };
  const close = async () => {
    if (!isPage) await ed.saveNow();
    void qc.invalidateQueries({ queryKey: canvasKeys.one(canvasId) });
    if (canvas) onClose({ id: canvas.id, title: canvas.title, markdown: canvasMarkdown(canvas), canvas });
    else onClose(null);
  };
  const saveCopyOfCanvas = async () => {
    try {
      const c = await ed.saveCopy();
      if (!c) return;
      toast.success('Saved a copy', `“${c.title}” — its markdown is copied.`);
      void navigator.clipboard?.writeText(canvasMarkdown(c));
      await ed.loadTheirs();
    } catch (e) {
      fail('Could not save a copy', e);
    }
  };

  // ---- keyboard ----
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable=true]')) return;
      // another canvas layer (the source editor, a dialog) is on top: its keys are its own
      if (Array.from(document.querySelectorAll('[data-canvas-layer]')).some((el) => el !== rootRef.current)) return;
      if (document.querySelector('[data-sketch-layer], [data-diagram-layer]')) return;
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (key === ' ') {
        e.preventDefault();
        setSpace(true);
        return;
      }
      if (mod && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) ed.redo();
        else ed.undo();
        return;
      }
      if (mod && key === 'y') {
        e.preventDefault();
        ed.redo();
        return;
      }
      if (mod && key === 'j') {
        e.preventDefault();
        startAsk();
        return;
      }
      if (mod && key === 'd') {
        e.preventDefault();
        void duplicateSelected();
        return;
      }
      if (mod && (key === '=' || key === '+')) {
        e.preventDefault();
        zoomBy(1.25);
        return;
      }
      if (mod && key === '-') {
        e.preventDefault();
        zoomBy(0.8);
        return;
      }
      if (mod && key === '0') {
        e.preventDefault();
        fit();
        return;
      }
      if (mod) return;
      if (key === 'escape') {
        if (keys) setKeys(false);
        else if (pinDraft) setPinDraft(null);
        else if (rubber) setRubber(null);
        else if (tool !== 'select') setTool('select');
        else if (menuFor || addMenu || exportMenu) {
          setMenuFor(null);
          setAddMenu(false);
          setExportMenu(false);
        } else if (focus) setFocus(false);
        else if (sel.length) setSel([]);
        else if (!isPage) void close();
        return;
      }
      if (key === '?') return setKeys(true);
      if (key === 'v') return setTool('select');
      if (key === 'h') return setTool('hand');
      if (key === 'b' && canEdit) return setAddMenu((v) => !v);
      if (key === 'n' && canEdit) return setTool('note');
      if (key === 'a' && canEdit) return setTool('arrow');
      if (key === 't' && canEdit) return setTool('label');
      if (key === 'c' && canvas?.role !== 'viewer') return setTool('comment');
      if (key === 'm') return setShowMap((v) => !v);
      if (key === 'f') return setFocus((v) => !v);
      if (key === 'p') return present();
      if (key === 'e' && oneBoard) return editBoard(oneBoard.id);
      if (key === 'enter' && oneBoard) return editBoard(oneBoard.id);
      if (key === '0') return fit();
      if (key === '1' && oneBoard)
        return setView({
          zoom: 1,
          x: oneBoard.x + oneBoard.w / 2 - win.w / 2,
          y: oneBoard.y + oneBoard.h / 2 - win.h / 2,
        });
      if (key === '2' && sel.length) return fit(sel);
      if (key === 'tab') {
        e.preventDefault();
        const next = stepBoard(ordered, oneBoard?.id ?? null, e.shiftKey ? -1 : 1);
        if (next) {
          setSel([next.id]);
          fit([next.id]);
        }
        return;
      }
      if (key === 'delete' || key === 'backspace') {
        e.preventDefault();
        removeSelection();
        return;
      }
      const step = e.shiftKey ? 50 : 10;
      if (key === 'arrowleft') return (e.preventDefault(), nudge(-step, 0));
      if (key === 'arrowright') return (e.preventDefault(), nudge(step, 0));
      if (key === 'arrowup') return (e.preventDefault(), nudge(0, -step));
      if (key === 'arrowdown') return (e.preventDefault(), nudge(0, step));
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpace(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
    // the handler reads current state on every key, so it is bound again on every render
  });

  // ---- AI jobs ----
  const jobFinished = (jobId: string, job: AiJob) => {
    setJobs((js) => js.filter((j) => j.jobId !== jobId));
    void qc.invalidateQueries({ queryKey: canvasKeys.proposals(canvasId) });
    if (job.state === 'finished') {
      toast.success('A proposal is ready', job.result.note || 'Look at before and after, then accept or reject.');
      setProposals(true);
    } else toast.error('The AI could not prepare a proposal', job.error.message || 'Try again.');
  };

  // ---- rendering ----
  const z = view.zoom;
  const live = !isSnapshot(z);
  const sx = (x: number) => (x - view.x) * z;
  const sy = (y: number) => (y - view.y) * z;
  // the dots keep a calm spacing on screen: when zoomed far out, every other (or every fourth) dot is dropped
  let dot = 20 * z;
  while (dot < 10) dot *= 2;
  const bg = { backgroundSize: `${dot}px ${dot}px`, backgroundPosition: `${-view.x * z}px ${-view.y * z}px` };

  if (ed.status === 'loading' || !doc || !canvas) {
    return createPortal(
      <div
        className={`${styles.root} ${isPage ? styles.pageHost : styles.layer}`}
        data-canvas-layer
        data-testid="canvas-editor-loading"
      >
        <div style={{ margin: 'auto', color: '#5b6b60' }}>
          {ed.status === 'missing'
            ? 'Canvas not found. It was deleted, or you do not have access.'
            : 'Loading the canvas…'}
        </div>
        {ed.status === 'missing' && (
          <button type="button" className={styles.btn} onClick={() => onClose(null)} style={{ margin: '0 auto 40px' }}>
            Close
          </button>
        )}
      </div>,
      isPage ? (document.getElementById('canvas-page-host') ?? document.body) : document.body,
    );
  }

  const minimapBox = boundsOf([
    ...pageBoards.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
    ...pageNotes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })),
  ]);
  const mk = minimapBox ? Math.min(124 / (minimapBox.w + 400), 74 / (minimapBox.h + 400)) : 1;
  const mm = (x: number, y: number) => ({
    left: 8 + (x - (minimapBox?.x ?? 0) + 200) * mk,
    top: 8 + (y - (minimapBox?.y ?? 0) + 200) * mk,
  });
  const empty = !pageBoards.length && !pageNotes.length && !pageLabels.length;
  const waitingJob = (id: string) => openProposals.find((p) => p.changes.some((c) => c.boardId === id && c.waitingFor));
  const noteFor = (n: CanvasNote) => ({ left: n.x, top: n.y, width: n.w, height: n.h, background: NOTE_BG[n.color] });

  const content = (
    <div
      ref={rootRef}
      className={`${styles.root} ${isPage ? styles.pageHost : styles.layer}`}
      role="dialog"
      aria-modal={!isPage}
      aria-label={`Canvas ${canvas.title}`}
      data-testid="canvas-editor"
      data-canvas-editor
      data-canvas-layer={isPage ? undefined : ''}
    >
      {!focus && (
        <div className={styles.header}>
          <span className={styles.chip}>
            <CanvasIcon name="canvas" size={12} /> CANVAS
          </span>
          {canEdit ? (
            <input
              className={styles.title}
              value={title}
              aria-label="Canvas name"
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                const t = title.trim();
                if (t && t !== canvas.title)
                  void import('../../api/canvases')
                    .then((m) => m.saveCanvas(canvasId, { baseRev: ed.revRef.current, title: t }))
                    .then(() => reload());
              }}
              data-testid="canvas-title"
            />
          ) : (
            <b className={styles.title}>{canvas.title}</b>
          )}
          <span className={styles.hint} style={{ whiteSpace: 'nowrap' }}>
            {request.ownerLabel
              ? `in ${request.ownerLabel}`
              : canvas.ownerKind === 'page'
                ? 'in Docs'
                : `in ${canvas.ownerKind} ${canvas.ownerId.slice(0, 12)}`}
          </span>
          <span className={styles.spacer} />
          {ed.save === 'saving' && <span className={styles.hint}>Saving…</span>}
          {ed.draftKept && ed.save !== 'saving' && (
            <span className={styles.hint} data-testid="canvas-draft-kept">
              Draft kept on this computer
            </span>
          )}
          {canEdit && canvas.projectId && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnAi}`}
              onClick={() => startAsk()}
              title="Ask AI about the selected boards (Ctrl J)"
              data-testid="canvas-ask-ai"
            >
              <CanvasIcon name="spark" size={14} /> AI
            </button>
          )}
          {openProposals.length > 0 && (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm} ${styles.btnAi}`}
              onClick={() => setProposals(true)}
              data-testid="canvas-open-proposals"
            >
              {openProposals.length} proposal{openProposals.length === 1 ? '' : 's'}
            </button>
          )}
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm} ${side === 'comments' ? styles.btnOn : ''}`}
            onClick={() => setSide(side === 'comments' ? null : 'comments')}
            data-testid="canvas-comments-btn"
          >
            <CanvasIcon name="comment" size={14} /> Comments{' '}
            {openOnPage > 0 && <span className={styles.count}>{openOnPage}</span>}
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm}`}
            onClick={() => setHistory(true)}
            data-testid="canvas-history-btn"
          >
            <CanvasIcon name="history" size={14} /> History
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSm}`}
            onClick={present}
            data-testid="canvas-present-btn"
          >
            <CanvasIcon name="present" size={14} /> Present
          </button>
          <span style={{ position: 'relative' }}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => setExportMenu((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={exportMenu}
              data-testid="canvas-download-btn"
            >
              <CanvasIcon name="download" size={14} />
            </button>
            {exportMenu && (
              <div className={styles.menu} role="menu" data-ui style={{ right: 0, top: 34, width: 260 }}>
                <div className={styles.menuHead}>Download</div>
                <a
                  className={styles.menuItem}
                  role="menuitem"
                  href={canvasDownloadUrl(canvasId)}
                  download
                  style={{ textDecoration: 'none' }}
                  onClick={() => setExportMenu(false)}
                >
                  <CanvasIcon name="file" size={14} /> All boards <small>ZIP with HTML and images</small>
                </a>
                {oneBoard && (
                  <a
                    className={styles.menuItem}
                    role="menuitem"
                    href={canvasDownloadUrl(canvasId, oneBoard.id)}
                    download
                    style={{ textDecoration: 'none' }}
                    onClick={() => setExportMenu(false)}
                  >
                    <CanvasIcon name="frame" size={14} /> This board <small>files</small>
                  </a>
                )}
                {oneBoard && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      setExportMenu(false);
                      void boardToPng(canvasId, oneBoard, 2)
                        .then((blob) => {
                          const a = document.createElement('a');
                          a.href = URL.createObjectURL(blob);
                          a.download = `${oneBoard.name}.png`;
                          a.click();
                          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
                        })
                        .catch((e: unknown) =>
                          toast.error('Could not make the picture', e instanceof Error ? e.message : ''),
                        );
                    }}
                  >
                    <CanvasIcon name="image" size={14} /> Board as image <small>PNG, 2x</small>
                  </button>
                )}
                <a
                  className={styles.menuItem}
                  role="menuitem"
                  href={`${new URL(canvasDownloadUrl(canvasId)).origin}/canvases/${canvasId}/overview.png${pageId ? `?page=${pageId}` : ''}`}
                  download={`${canvas.title}.png`}
                  style={{ textDecoration: 'none' }}
                  onClick={() => setExportMenu(false)}
                >
                  <CanvasIcon name="grid" size={14} /> Overview as image <small>PNG of this page tab</small>
                </a>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => {
                    setExportMenu(false);
                    if (!printBoards(canvasId, canvas.title, ordered))
                      toast.error('Allow pop-ups to print', 'The print page opens in a new tab.');
                  }}
                >
                  <CanvasIcon name="file" size={14} /> PDF <small>One board per page</small>
                </button>
                <div className={styles.menuSep} />
                <div className={styles.menuHead}>Copy link</div>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => {
                    setExportMenu(false);
                    copy(canvasMarkdown(canvas));
                  }}
                >
                  <CanvasIcon name="link" size={14} /> To this canvas
                </button>
                {oneBoard && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      setExportMenu(false);
                      copy(canvasMarkdown(canvas, oneBoard.id));
                    }}
                  >
                    <CanvasIcon name="link" size={14} /> To this board <small>Opens at the board</small>
                  </button>
                )}
                {canEdit && canvas.projectId && !canvas.pageId && (
                  <>
                    <div className={styles.menuSep} />
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.menuItem}
                      onClick={() => {
                        setExportMenu(false);
                        setMoveDocs(true);
                      }}
                      data-testid="canvas-move-docs-btn"
                    >
                      <CanvasIcon name="file" size={14} /> Move to Docs…
                    </button>
                  </>
                )}
              </div>
            )}
          </span>
          {canEdit && !isPage && (
            <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={() => void saveCopyOfCanvas()}>
              Save a copy
            </button>
          )}
          {isPage ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSm}`}
              onClick={() => copy(canvasMarkdown(canvas))}
            >
              Share
            </button>
          ) : (
            <>
              <button
                type="button"
                className={`${styles.iconBtn}`}
                aria-label="Keys"
                title="Keys (?)"
                onClick={() => setKeys(true)}
              >
                <CanvasIcon name="keyboard" size={16} />
              </button>
              {canEdit ? (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
                  disabled={busy}
                  onClick={() => void done()}
                  data-testid="canvas-done"
                >
                  Done
                </button>
              ) : (
                <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={() => void close()}>
                  Close
                </button>
              )}
            </>
          )}
        </div>
      )}
      {!focus && (
        <div className={styles.tabs} role="tablist" aria-label="Pages">
          {doc.pages.map((p) => (
            <span key={p.id} style={{ display: 'inline-flex' }}>
              {editTab === p.id ? (
                <input
                  className={styles.tabInput}
                  defaultValue={p.name}
                  autoFocus
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    setEditTab(null);
                    if (name && name !== p.name)
                      ed.mutate((d) => {
                        const x = d.pages.find((q) => q.id === p.id);
                        if (x) x.name = name;
                      });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditTab(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  aria-selected={p.id === pageId}
                  className={`${styles.tab} ${p.id === pageId ? styles.tabOn : ''}`}
                  onClick={() => setPageId(p.id)}
                  onDoubleClick={() => canEdit && setEditTab(p.id)}
                  data-testid="canvas-tab"
                >
                  {p.name}
                </button>
              )}
            </span>
          ))}
          {canEdit && doc.pages.length < canvas.limits.pages && (
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Add a page tab"
              onClick={() => {
                const id = newId('p');
                ed.mutate((d) => {
                  d.pages.push({ id, name: `Page ${d.pages.length + 1}`, rev: undefined as unknown as number });
                });
                setPageId(id);
              }}
              data-testid="canvas-add-tab"
            >
              <CanvasIcon name="plus" size={14} />
            </button>
          )}
          {canEdit && doc.pages.length > 1 && pageId && (
            <button
              type="button"
              className={styles.iconBtn}
              aria-label="Delete this page tab"
              title="Delete this page tab and what is on it"
              onClick={() => {
                if (
                  !window.confirm(
                    `Delete the page tab “${doc.pages.find((p) => p.id === pageId)?.name}” and everything on it?`,
                  )
                )
                  return;
                const id = pageId;
                const other = doc.pages.find((p) => p.id !== id)?.id ?? null;
                ed.mutate((d) => {
                  d.pages = d.pages.filter((p) => p.id !== id);
                  d.boards = d.boards.filter((b) => b.page !== id);
                  d.notes = d.notes.filter((b) => b.page !== id);
                  d.labels = d.labels.filter((b) => b.page !== id);
                  d.arrows = d.arrows.filter((b) => b.page !== id);
                });
                setPageId(other);
              }}
            >
              <CanvasIcon name="trash" size={14} />
            </button>
          )}
          <span className={styles.spacer} />
          <span className={styles.hint}>
            {pageBoards.length} board{pageBoards.length === 1 ? '' : 's'}
          </span>
        </div>
      )}
      <div className={styles.body}>
        <div className={styles.stageWrap}>
          <div
            ref={planeRef}
            className={`${styles.plane} ${tool === 'hand' || space ? (panning ? styles.planeGrab : styles.planeHand) : tool !== 'select' ? styles.planeCross : ''}`}
            style={bg}
            tabIndex={0}
            data-testid="canvas-plane"
            data-zoom={z.toFixed(3)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => !drag.current && setHover(null)}
            onDoubleClick={(e) => {
              const hit = hitOf(e.target as HTMLElement);
              if (!hit || !canEdit) return;
              if (hit.kind === 'note') setEditNote(hit.id);
              else if (hit.kind === 'label') setEditLabel(hit.id);
              else if (hit.kind === 'board') editBoard(hit.id);
              else if (hit.kind === 'arrow') {
                const a = doc.arrows.find((x) => x.id === hit.id);
                const label = window.prompt('Arrow label', a?.label ?? '');
                if (label != null)
                  ed.mutate((d) => {
                    const x = d.arrows.find((q) => q.id === hit.id);
                    if (x) x.label = label.slice(0, 120);
                  });
              }
            }}
            onDragOver={(e) => {
              if (canEdit && Array.from(e.dataTransfer.types).includes('Files')) {
                e.preventDefault();
                setDropping(true);
              }
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={(e) => {
              if (!canEdit) return;
              e.preventDefault();
              setDropping(false);
              void importDropped(Array.from(e.dataTransfer.files));
            }}
          >
            <div
              className={styles.world}
              style={{ transform: `translate(${-view.x * z}px, ${-view.y * z}px) scale(${z})` }}
            >
              <svg
                width="1"
                height="1"
                style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id="cv-arrow"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0L10 5L0 10Z" fill="#3a4a3e" />
                  </marker>
                </defs>
                {pageArrows.map((a) => {
                  const from = rectOf(a.from);
                  const to = rectOf(a.to);
                  if (!from || !to) return null;
                  const l = arrowLine(from, to);
                  const on = sel.includes(a.id);
                  return (
                    <g key={a.id}>
                      <line
                        x1={l.x1}
                        y1={l.y1}
                        x2={l.x2}
                        y2={l.y2}
                        stroke={on ? '#2f6fb0' : '#3a4a3e'}
                        strokeWidth={2 / z}
                        markerEnd="url(#cv-arrow)"
                      />
                      <line
                        x1={l.x1}
                        y1={l.y1}
                        x2={l.x2}
                        y2={l.y2}
                        stroke="transparent"
                        strokeWidth={14 / z}
                        style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                        data-item={a.id}
                        data-kind="arrow"
                      />
                    </g>
                  );
                })}
                {rubber &&
                  (() => {
                    const from = rectOf(rubber.from);
                    if (!from) return null;
                    const l = arrowLine(from, { x: rubber.to.x, y: rubber.to.y, w: 0, h: 0 });
                    return (
                      <line
                        x1={l.x1}
                        y1={l.y1}
                        x2={l.x2}
                        y2={l.y2}
                        stroke="#2f6fb0"
                        strokeWidth={2 / z}
                        strokeDasharray={`${6 / z} ${4 / z}`}
                      />
                    );
                  })()}
              </svg>
              {pageBoards.map((b) => (
                <div key={b.id} className={styles.board} style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
                  <div
                    className={styles.boardBody}
                    style={{ borderWidth: 1 / z, boxShadow: 'none' }}
                    data-item={b.id}
                    data-kind="board"
                    data-testid="canvas-board"
                  >
                    <MemoFrame canvasId={canvasId} board={b} scale={1} live={live} reloadKey={reloadKey} />
                  </div>
                </div>
              ))}
              {pageNotes.map((n) => (
                <div
                  key={n.id}
                  className={`${styles.note} ${sel.includes(n.id) ? styles.noteSel : ''}`}
                  style={noteFor(n)}
                  data-item={n.id}
                  data-kind="note"
                  data-testid="canvas-note"
                >
                  {editNote === n.id ? (
                    <textarea
                      className={styles.noteEdit}
                      defaultValue={n.text}
                      autoFocus
                      data-ui
                      aria-label="Note text"
                      onBlur={(e) => {
                        const text = e.target.value;
                        setEditNote(null);
                        if (!text.trim()) ed.mutate((d) => void (d.notes = d.notes.filter((q) => q.id !== n.id)));
                        else if (text !== n.text)
                          ed.mutate((d) => {
                            const x = d.notes.find((q) => q.id === n.id);
                            if (x) x.text = text;
                          });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur();
                      }}
                    />
                  ) : (
                    n.text
                  )}
                  <span className={styles.noteBy}>{n.by || 'U'}</span>
                </div>
              ))}
              {pageLabels.map((l) => (
                <div
                  key={l.id}
                  className={styles.label}
                  style={{
                    left: l.x,
                    top: l.y,
                    fontSize: l.size,
                    outline: sel.includes(l.id) ? '2px solid #2f6fb0' : undefined,
                    outlineOffset: 2,
                  }}
                  data-item={l.id}
                  data-kind="label"
                  data-testid="canvas-label"
                >
                  {editLabel === l.id ? (
                    <input
                      className={styles.labelEdit}
                      defaultValue={l.text}
                      autoFocus
                      data-ui
                      aria-label="Label text"
                      style={{ fontSize: 'inherit', width: Math.max(80, l.text.length * l.size * 0.65) }}
                      onBlur={(e) => {
                        const text = e.target.value;
                        setEditLabel(null);
                        if (!text.trim()) ed.mutate((d) => void (d.labels = d.labels.filter((q) => q.id !== l.id)));
                        else if (text !== l.text)
                          ed.mutate((d) => {
                            const x = d.labels.find((q) => q.id === l.id);
                            if (x) x.text = text;
                          });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
                      }}
                    />
                  ) : (
                    l.text
                  )}
                </div>
              ))}
            </div>
            {/* chrome in screen space: names, ribbons, handles, tools and pins keep their size at any zoom */}
            <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
              {guides.map((g, i) =>
                g.axis === 'x' ? (
                  <div key={i} className={styles.guide} style={{ left: sx(g.at), top: 0, bottom: 0, width: 1 }} />
                ) : (
                  <div key={i} className={styles.guide} style={{ top: sy(g.at), left: 0, right: 0, height: 1 }} />
                ),
              )}
              {marquee && (
                <div
                  className={styles.marquee}
                  style={{ left: sx(marquee.x), top: sy(marquee.y), width: marquee.w * z, height: marquee.h * z }}
                />
              )}
              {pageBoards.map((b) => {
                const selected = sel.includes(b.id);
                const lock = lockOf(b.id);
                const lockedByOther = !!lock && lock.holder !== me;
                const job = jobOf(b.id);
                const waits = waitingJob(b.id);
                const blocked = blockedTotal(b.content?.blocked);
                const showTools = (hover === b.id || (selected && sel.length === 1)) && !drag.current;
                const bw = b.w * z;
                const bh = b.h * z;
                return (
                  <div
                    key={b.id}
                    className={`${styles.board} ${selected ? styles.boardSel : ''}`}
                    style={{ left: sx(b.x), top: sy(b.y), width: bw, height: bh, pointerEvents: 'none' }}
                  >
                    <div
                      className={`${styles.boardLabel} ${selected ? styles.boardLabelSel : ''}`}
                      style={{ top: -19, pointerEvents: 'auto', cursor: 'move' }}
                      data-item={b.id}
                      data-kind="board"
                    >
                      {renaming === b.id ? (
                        <input
                          autoFocus
                          data-ui
                          className={styles.labelEdit}
                          defaultValue={b.name}
                          aria-label="Board name"
                          onBlur={(e) => {
                            setRenaming(null);
                            const n = e.target.value.trim();
                            if (n && n !== b.name) patchBoard(b.id, (x) => void (x.name = n));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur();
                          }}
                        />
                      ) : (
                        b.name
                      )}
                      <span>
                        {Math.round(b.w)} x {Math.round(b.h)}
                      </span>
                    </div>
                    {side === 'boards' && (
                      <span className={styles.orderBadge} data-testid="canvas-order-badge">
                        {ordered.findIndex((o) => o.id === b.id) + 1}
                      </span>
                    )}
                    {(lockedByOther || job || waits) && (
                      <div
                        className={`${styles.ribbon} ${job || waits ? styles.ribbonAi : styles.ribbonLock}`}
                        style={{ height: 20 }}
                        data-testid={job ? 'canvas-ai-ribbon' : 'canvas-lock-ribbon'}
                      >
                        <CanvasIcon name={job || waits ? 'spark' : 'lock'} size={11} />
                        {job
                          ? `${job.who === 'AI' ? 'AI' : job.who} is working`
                          : waits
                            ? `${waits.author} is waiting for ${b.name}`
                            : `${lock?.holder} is editing`}
                      </div>
                    )}
                    {selected && canEdit && (
                      <>
                        {(['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'] as Handle[]).map((h) => (
                          <span
                            key={h}
                            className={styles.handle}
                            data-handle={h}
                            data-board={b.id}
                            style={{
                              pointerEvents: 'auto',
                              left: h.includes('w') ? -4 : h.includes('e') ? bw - 4 : bw / 2 - 4,
                              top: h.includes('n') ? -4 : h.includes('s') ? bh - 4 : bh / 2 - 4,
                              cursor: `${h}-resize`,
                            }}
                          />
                        ))}
                      </>
                    )}
                    {blocked > 0 && (
                      <>
                        <button
                          type="button"
                          className={styles.blockedChip}
                          style={{ pointerEvents: 'auto' }}
                          data-ui
                          onClick={() => setBlockedFor(blockedFor === b.id ? null : b.id)}
                          data-testid="canvas-blocked-chip"
                        >
                          <CanvasIcon name="warning" size={11} /> {blocked} blocked
                        </button>
                        {blockedFor === b.id && (
                          <div
                            className={styles.blockedList}
                            style={{ pointerEvents: 'auto' }}
                            data-ui
                            data-testid="canvas-blocked-list"
                          >
                            <b>
                              {blocked} blocked on {b.name}
                            </b>
                            <ul style={{ margin: '4px 0 6px', paddingLeft: 16 }}>
                              {b.content?.blocked.map((x, i) => (
                                <li key={i}>{blockedLine(x)}</li>
                              ))}
                            </ul>
                            <span className={styles.hint}>
                              Boards run without scripts and without outside requests, as in Preview. The chip lists
                              what was left out, so a missing font or chart is explained.
                            </span>
                          </div>
                        )}
                      </>
                    )}
                    {showTools && (
                      <div
                        className={styles.boardTools}
                        style={{ top: -48, pointerEvents: 'auto', display: 'block' }}
                        data-tools-for={b.id}
                        data-ui
                      >
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 1,
                            padding: 2,
                            borderRadius: 9,
                            background: '#fff',
                            border: '1px solid #d5ded8',
                            boxShadow: '0 6px 16px rgba(30,42,34,.16)',
                            position: 'relative',
                          }}
                        >
                          <button
                            type="button"
                            className={styles.tbBtn}
                            onClick={() => api.openViewer({ id: canvasId, boardId: b.id, pageId: pageId ?? undefined })}
                            data-testid="canvas-board-open"
                          >
                            <CanvasIcon name="eye" size={14} /> Open
                          </button>
                          {canEdit &&
                            (b.kind === 'html' ||
                              b.kind === 'empty' ||
                              b.kind === 'sketch' ||
                              b.kind === 'diagram') && (
                              <button
                                type="button"
                                className={styles.tbBtn}
                                disabled={lockedByOther}
                                title={lockedByOther ? `${lock?.holder} is editing` : 'Edit (takes the lock for html)'}
                                onClick={() => editBoard(b.id)}
                                data-testid="canvas-board-edit"
                              >
                                <CanvasIcon name="edit" size={14} /> Edit
                              </button>
                            )}
                          {canEdit && canvas.projectId && (b.kind === 'html' || b.kind === 'empty') && (
                            <button
                              type="button"
                              className={styles.tbBtn}
                              onClick={() => startAsk([b.id])}
                              data-testid="canvas-board-ask"
                            >
                              <CanvasIcon name="spark" size={14} /> Ask AI
                            </button>
                          )}
                          {canvas.role !== 'viewer' && (
                            <button
                              type="button"
                              className={styles.tbBtn}
                              onClick={() => {
                                setPinText('');
                                setPinDraft({
                                  boardId: b.id,
                                  x: 0.5,
                                  y: 0.5,
                                  sx: sx(b.x) + bw / 2,
                                  sy: sy(b.y) + bh / 2,
                                });
                              }}
                            >
                              <CanvasIcon name="comment" size={14} /> Comment
                            </button>
                          )}
                          <button
                            type="button"
                            className={styles.tbBtn}
                            aria-label="Board menu"
                            aria-haspopup="menu"
                            onClick={() => setMenuFor(menuFor === b.id ? null : b.id)}
                            data-testid="canvas-board-menu-btn"
                          >
                            <CanvasIcon name="more" size={14} />
                          </button>
                          {menuFor === b.id && (
                            <BoardMenu
                              board={b}
                              canEdit={canEdit}
                              aiAvailable={!!canvas.projectId}
                              onEdit={() => {
                                setMenuFor(null);
                                editBoard(b.id);
                              }}
                              onAskAi={() => {
                                setMenuFor(null);
                                startAsk([b.id]);
                              }}
                              onRename={() => {
                                setMenuFor(null);
                                setRenaming(b.id);
                              }}
                              onSize={(w, h) => {
                                setMenuFor(null);
                                patchBoard(b.id, (x) => {
                                  x.w = w;
                                  x.h = h;
                                });
                              }}
                              onCustom={() => {
                                setMenuFor(null);
                                const w = Number(window.prompt('Width (320 to 1920)', String(Math.round(b.w))));
                                const h = Number(window.prompt('Height', String(Math.round(b.h))));
                                if (w >= 320 && w <= 1920 && h >= 120)
                                  patchBoard(b.id, (x) => {
                                    x.w = w;
                                    x.h = h;
                                  });
                              }}
                              onDuplicate={() => {
                                setMenuFor(null);
                                setSel([b.id]);
                                void duplicateSelected();
                              }}
                              onReplace={() => {
                                setMenuFor(null);
                                replaceFor.current = b.id;
                                replaceInput.current?.click();
                              }}
                              onDownload={() => {
                                setMenuFor(null);
                                window.location.assign(canvasDownloadUrl(canvasId, b.id));
                              }}
                              onImage={() => {
                                setMenuFor(null);
                                void boardToPng(canvasId, b, 2)
                                  .then((blob) => navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]))
                                  .then(() => toast.success('Copied', `${b.name} is on the clipboard as a picture.`))
                                  .catch((e: unknown) =>
                                    toast.error('Could not copy the picture', e instanceof Error ? e.message : ''),
                                  );
                              }}
                              onCopyLink={() => {
                                setMenuFor(null);
                                copy(canvasMarkdown(canvas, b.id));
                              }}
                              onDelete={() => {
                                setMenuFor(null);
                                setSel([b.id]);
                                removeSelection();
                              }}
                            />
                          )}
                        </span>
                      </div>
                    )}
                    {threads
                      .filter((t) => t.boardId === b.id)
                      .map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className={`${styles.pin} ${selThread === t.id ? styles.pinOn : ''} ${t.status === 'resolved' ? styles.pinResolved : t.byAi ? styles.pinAi : ''}`}
                          style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%`, pointerEvents: 'auto' }}
                          data-ui
                          onClick={() => {
                            setSelThread(t.id);
                            setSide('comments');
                          }}
                          aria-label={`Comment ${t.number}`}
                          data-testid="canvas-pin"
                        >
                          {t.number}
                        </button>
                      ))}
                  </div>
                );
              })}
              {threads
                .filter((t) => !t.boardId && (t.page === pageId || !t.page))
                .map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`${styles.pin} ${selThread === t.id ? styles.pinOn : ''} ${t.status === 'resolved' ? styles.pinResolved : ''}`}
                    style={{ left: sx(t.x), top: sy(t.y), pointerEvents: 'auto' }}
                    data-ui
                    onClick={() => {
                      setSelThread(t.id);
                      setSide('comments');
                    }}
                    aria-label={`Comment ${t.number}`}
                  >
                    {t.number}
                  </button>
                ))}
              {sel.length === 1 &&
                canEdit &&
                (() => {
                  const n = pageNotes.find((x) => x.id === sel[0]);
                  const l = pageLabels.find((x) => x.id === sel[0]);
                  if (n)
                    return (
                      <div
                        className={styles.menu}
                        style={{
                          left: sx(n.x),
                          top: sy(n.y) - 44,
                          minWidth: 0,
                          display: 'flex',
                          gap: 6,
                          pointerEvents: 'auto',
                          padding: 6,
                        }}
                        data-ui
                      >
                        {COLORS.map((c) => (
                          <button
                            key={c}
                            type="button"
                            aria-label={`Note colour ${c}`}
                            onClick={() => {
                              noteColor.current = c;
                              ed.mutate((d) => void (d.notes.find((q) => q.id === n.id)!.color = c));
                            }}
                            style={{
                              width: 20,
                              height: 20,
                              borderRadius: '50%',
                              border: n.color === c ? '2px solid #1e2a22' : '1px solid #c7d2cb',
                              background: NOTE_BG[c],
                              cursor: 'pointer',
                              padding: 0,
                            }}
                          />
                        ))}
                      </div>
                    );
                  if (l)
                    return (
                      <div
                        className={styles.menu}
                        style={{
                          left: sx(l.x),
                          top: sy(l.y) - 44,
                          minWidth: 0,
                          display: 'flex',
                          gap: 4,
                          pointerEvents: 'auto',
                          padding: 4,
                        }}
                        data-ui
                      >
                        {[14, 20, 32, 48].map((s) => (
                          <button
                            key={s}
                            type="button"
                            className={styles.tbBtn}
                            aria-pressed={l.size === s}
                            onClick={() => ed.mutate((d) => void (d.labels.find((q) => q.id === l.id)!.size = s))}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    );
                  return null;
                })()}
            </div>
            {dropping && (
              <div className={styles.dropVeil} data-testid="canvas-drop-veil">
                <div>
                  Drop files to make boards
                  <div style={{ fontWeight: 400, fontSize: 13 }}>
                    HTML files, images, .sketch and .drawio files, or a ZIP of a built page. Each file becomes a board,
                    placed to the right of the last one.
                  </div>
                </div>
              </div>
            )}
            {empty && !busy && (
              <div className={styles.empty} data-ui data-testid="canvas-empty">
                <div className={styles.emptyTitle}>Add your first board</div>
                <div className={styles.hint}>Boards hold a page you made, a picture, a Sketch or a Diagram.</div>
                {canEdit ? (
                  <div className={styles.emptyActions}>
                    <button type="button" className={styles.btn} onClick={() => fileInput.current?.click()}>
                      <CanvasIcon name="upload" size={14} /> From files
                    </button>
                    <button type="button" className={styles.btn} onClick={() => void doAddBoard('empty')}>
                      <CanvasIcon name="frame" size={14} /> Empty board
                    </button>
                    {canvas.projectId && (
                      <button
                        type="button"
                        className={`${styles.btn} ${styles.btnAi}`}
                        onClick={() => void doAddBoard('empty').then((b) => b && setAskFor([b.id]))}
                      >
                        <CanvasIcon name="spark" size={14} /> Ask AI
                      </button>
                    )}
                  </div>
                ) : (
                  <div className={styles.hint} style={{ marginTop: 8 }}>
                    You can look, but not edit this canvas.
                  </div>
                )}
              </div>
            )}
          </div>
          {ed.conflict && (
            <div className={`${styles.banner} ${styles.bannerWarn}`} role="alert" data-testid="canvas-conflict">
              <CanvasIcon name="warning" size={18} />
              <div>
                <span className={styles.bannerTitle}>{ed.conflict.author} saved a newer version</span>
                Your changes to the layout are kept. Save yours as a copy of the canvas, or load theirs.
                <div className={styles.hint}>
                  Layout moves are merged by item, so this only shows when the same board or note was changed by both.
                </div>
                <div className={styles.bannerActions}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
                    onClick={() => void saveCopyOfCanvas()}
                  >
                    Save as copy
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnSm}`}
                    onClick={() => void ed.loadTheirs()}
                    data-testid="canvas-load-theirs"
                  >
                    Load theirs
                  </button>
                  <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={() => void ed.keepMine()}>
                    Replace theirs
                  </button>
                </div>
              </div>
            </div>
          )}
          {!ed.conflict && (ed.save === 'error' || ed.save === 'offline') && (
            <div className={`${styles.banner} ${styles.bannerErr}`} role="alert" data-testid="canvas-save-failed">
              <CanvasIcon name="warning" size={18} />
              <div>
                <span className={styles.bannerTitle}>Could not save</span>
                Your canvas is kept as a draft on this computer. It saves again when the connection is back.
                {ed.failure && <div className={styles.hint}>{ed.failure}</div>}
                <div className={styles.bannerActions}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
                    onClick={ed.retry}
                  >
                    Try again
                  </button>
                </div>
              </div>
            </div>
          )}
          {!canEdit && (
            <div
              className={styles.hint}
              style={{
                position: 'absolute',
                left: 14,
                top: 12,
                zIndex: 20,
                background: '#fff',
                padding: '4px 10px',
                borderRadius: 8,
                border: '1px solid #e3e8e5',
              }}
              data-testid="canvas-view-only"
            >
              View only
            </div>
          )}
          {!focus && showMap && minimapBox && (
            <div
              className={styles.minimap}
              data-ui
              data-testid="canvas-minimap"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const px = (e.clientX - r.left - 8) / mk + (minimapBox?.x ?? 0) - 200;
                const py = (e.clientY - r.top - 8) / mk + (minimapBox?.y ?? 0) - 200;
                setView((v) => ({ ...v, x: px - win.w / 2 / v.zoom, y: py - win.h / 2 / v.zoom }));
              }}
            >
              {pageBoards.map((b) => (
                <span
                  key={b.id}
                  className={styles.minimapItem}
                  style={{ ...mm(b.x, b.y), width: Math.max(3, b.w * mk), height: Math.max(3, b.h * mk) }}
                />
              ))}
              {pageNotes.map((n) => (
                <span
                  key={n.id}
                  className={styles.minimapItem}
                  style={{
                    ...mm(n.x, n.y),
                    width: Math.max(2, n.w * mk),
                    height: Math.max(2, n.h * mk),
                    background: '#e8b93a',
                  }}
                />
              ))}
              <span
                className={styles.minimapBox}
                style={{ ...mm(view.x, view.y), width: (win.w / z) * mk, height: (win.h / z) * mk }}
              />
            </div>
          )}
          {!focus && (
            <div className={styles.zoomBox} data-ui>
              <button
                type="button"
                className={styles.zoomBtn}
                aria-label="Zoom out"
                onClick={() => zoomBy(0.8)}
                disabled={z <= ZOOM_MIN}
              >
                <CanvasIcon name="zoomOut" size={15} />
              </button>
              <span className={styles.zoomVal} data-testid="canvas-zoom">
                {Math.round(z * 100)}%
              </span>
              <button
                type="button"
                className={styles.zoomBtn}
                aria-label="Zoom in"
                onClick={() => zoomBy(1.25)}
                disabled={z >= ZOOM_MAX}
              >
                <CanvasIcon name="zoomIn" size={15} />
              </button>
              <span style={{ width: 1, height: 18, background: '#e3e8e5' }} />
              <button type="button" className={styles.zoomBtn} onClick={() => fit()} data-testid="canvas-fit">
                Fit
              </button>
              <button
                type="button"
                className={styles.zoomBtn}
                aria-label="Map"
                aria-pressed={showMap}
                onClick={() => setShowMap((v) => !v)}
                title="Map (M)"
              >
                <CanvasIcon name="map" size={15} />
              </button>
            </div>
          )}
          <div className={styles.toolbarBottom} data-ui role="toolbar" aria-label="Tools" data-testid="canvas-tools">
            {TOOLS.filter((t) => canEdit || t.id === 'select' || t.id === 'hand' || t.id === 'comment').map((t, i) => (
              <span key={t.id} style={{ display: 'contents' }}>
                {(i === 2 || t.id === 'comment') && <span className={styles.toolSep} />}
                <span style={{ position: 'relative', display: 'inline-flex' }}>
                  <button
                    type="button"
                    className={`${styles.tool} ${tool === t.id || (t.id === 'board' && addMenu) ? styles.toolOn : ''}`}
                    title={`${t.label} (${t.key}) — ${t.hint}`}
                    aria-label={t.label}
                    aria-pressed={tool === t.id}
                    onClick={() => {
                      if (t.id === 'board') setAddMenu((v) => !v);
                      else {
                        setTool(t.id);
                        setRubber(null);
                      }
                    }}
                    data-testid={`canvas-tool-${t.id}`}
                  >
                    <CanvasIcon name={t.icon} size={17} />
                  </button>
                  {t.id === 'board' && addMenu && (
                    <div className={styles.menu} role="menu" style={{ bottom: 40, left: -60 }} data-ui>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.menuItem}
                        onClick={() => {
                          setAddMenu(false);
                          fileInput.current?.click();
                        }}
                        data-testid="canvas-add-file"
                      >
                        <CanvasIcon name="upload" size={14} /> HTML or picture file…
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.menuItem}
                        onClick={() => {
                          setAddMenu(false);
                          void addSketch();
                        }}
                        disabled={!sketchApi.available}
                      >
                        <CanvasIcon name="sketch" size={14} /> Sketch…
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.menuItem}
                        onClick={() => {
                          setAddMenu(false);
                          addDiagram();
                        }}
                        disabled={!diagrams || !canvas.projectId}
                      >
                        <CanvasIcon name="diagram" size={14} /> Diagram…
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.menuItem}
                        onClick={() => {
                          setAddMenu(false);
                          void doAddBoard('empty');
                        }}
                        data-testid="canvas-add-empty"
                      >
                        <CanvasIcon name="frame" size={14} /> Empty board
                      </button>
                    </div>
                  )}
                </span>
              </span>
            ))}
          </div>
          {askFor && canvas && (
            <AskAiPanel
              canvasId={canvasId}
              boards={askFor.map(boardById).filter((b): b is CanvasBoard => !!b)}
              initialPrompt={askText}
              onClose={() => {
                setAskFor(null);
                setAskText('');
              }}
              onStarted={(j) => setJobs((js) => [...js, j])}
              onFinished={jobFinished}
            />
          )}
          {pinDraft && (
            <div
              className={styles.popover}
              style={{
                left: Math.min(Math.max(8, pinDraft.sx), Math.max(8, win.w - 316)),
                top: Math.min(Math.max(8, pinDraft.sy + 8), Math.max(8, win.h - 170)),
              }}
              data-ui
              data-testid="canvas-pin-draft"
            >
              <textarea
                className={styles.input}
                rows={3}
                autoFocus
                value={pinText}
                onChange={(e) => setPinText(e.target.value)}
                placeholder="Is the button label long enough for Vietnamese?"
                aria-label="Comment"
              />
              <div className={styles.hint} style={{ margin: '4px 0 8px' }}>
                Type @ to mention a person or an AI member. Click a board to pin at that spot (it moves with the board),
                or click the plane for a pin that stays put. Esc leaves the tool.
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" className={`${styles.btn} ${styles.btnSm}`} onClick={() => setPinDraft(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnSm} ${styles.btnPrimary}`}
                  disabled={!pinText.trim()}
                  data-testid="canvas-pin-post"
                  onClick={() => {
                    const d = pinDraft;
                    void addThread(canvasId, {
                      body: pinText.trim(),
                      boardId: d.boardId,
                      x: d.x,
                      y: d.y,
                      page: d.boardId ? undefined : pageId,
                    })
                      .then((t) => {
                        setPinDraft(null);
                        setTool('select');
                        setSelThread(t.id);
                        setSide('comments');
                        void qc.invalidateQueries({ queryKey: canvasKeys.threads(canvasId) });
                      })
                      .catch((e: unknown) => fail('Could not comment', e));
                  }}
                >
                  Comment
                </button>
              </div>
            </div>
          )}
          {history && (
            <HistoryPanel
              canvasId={canvasId}
              canEdit={canEdit}
              onClose={() => setHistory(false)}
              onRestored={() => void reload()}
            />
          )}
          {proposals && openProposals.length > 0 && (
            <ProposalReview
              canvasId={canvasId}
              canDecide={canEdit}
              onAccepted={() => void reload()}
              onClose={() => setProposals(false)}
            />
          )}
        </div>
        {!focus && (
          <div className={styles.side} hidden={!side}>
            <div className={styles.sideTabs} role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={side === 'boards'}
                className={`${styles.sideTab} ${side === 'boards' ? styles.sideTabOn : ''}`}
                onClick={() => setSide('boards')}
                data-testid="canvas-tab-boards"
              >
                Boards
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={side === 'comments'}
                className={`${styles.sideTab} ${side === 'comments' ? styles.sideTabOn : ''}`}
                onClick={() => setSide('comments')}
                data-testid="canvas-tab-comments"
              >
                Comments {openOnPage > 0 && <span className={styles.count}>{openOnPage}</span>}
              </button>
              <span className={styles.spacer} />
              <button
                type="button"
                className={styles.iconBtn}
                aria-label="Close panel"
                onClick={() => setSide(null)}
                style={{ alignSelf: 'center' }}
              >
                <CanvasIcon name="close" size={14} />
              </button>
            </div>
            <div className={styles.sideBody}>
              {side === 'boards' && (
                <BoardsPanel
                  canvasId={canvasId}
                  boards={ordered}
                  selected={sel}
                  comments={commentsByBoard}
                  canEdit={canEdit}
                  onSelect={(id) => {
                    setSel([id]);
                    fit([id]);
                  }}
                  onReorder={(ids) =>
                    ed.mutate((d) => {
                      ids.forEach((id, i) => {
                        const b = d.boards.find((x) => x.id === id);
                        if (b) b.order = i;
                      });
                    })
                  }
                />
              )}
              {side === 'comments' && (
                <CommentsPanel
                  canvasId={canvasId}
                  title={canvas.title}
                  threads={threads}
                  boards={doc.boards}
                  boardId={oneBoard?.id ?? null}
                  selectedThread={selThread}
                  onSelectThread={(id) => {
                    setSelThread(id);
                    const t = threads.find((x) => x.id === id);
                    if (t?.boardId) {
                      const b = boardById(t.boardId);
                      if (b) {
                        if (b.page !== pageId) setPageId(b.page);
                        setSel([b.id]);
                        fit([b.id]);
                      }
                    }
                  }}
                  canComment={canvas.role !== 'viewer'}
                  me={me}
                  aiAvailable={!!canvas.projectId}
                  onProposeStarted={(jobId) => {
                    const t = threads.find((x) => x.id === selThread);
                    setJobs((js) => [...js, { jobId, boardIds: t?.boardId ? [t.boardId] : [], who: 'AI' }]);
                    const poll = async () => {
                      const { fetchAiJob } = await import('../../api/canvases');
                      for (let i = 0; i < 120; i++) {
                        await new Promise((r) => setTimeout(r, 1500));
                        const job = await fetchAiJob(jobId).catch(() => null);
                        if (job && ['finished', 'failed', 'cancelled'].includes(job.state))
                          return jobFinished(jobId, job);
                      }
                    };
                    void poll();
                  }}
                />
              )}
            </div>
          </div>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        hidden
        multiple
        accept=".html,.htm,.zip,.png,.jpg,.jpeg,.gif,.webp,.svg,.drawio,.sketch,.json"
        data-testid="canvas-file-input"
        onChange={(e) => {
          const f = Array.from(e.target.files ?? []);
          e.target.value = '';
          void importDropped(f);
        }}
      />
      <input
        ref={replaceInput}
        type="file"
        hidden
        multiple
        accept=".html,.htm,.zip,.css,.png,.jpg,.jpeg,.gif,.webp,.svg"
        onChange={(e) => {
          const f = Array.from(e.target.files ?? []);
          e.target.value = '';
          const id = replaceFor.current;
          if (!id || !f.length) return;
          void replaceBoard(canvasId, id, f)
            .then(() => reload())
            .catch((err: unknown) => fail('Could not replace the content', err));
        }}
      />
      {source && boardById(source) && (
        <SourceEditor
          canvasId={canvasId}
          canvasTitle={canvas.title}
          board={boardById(source)!}
          lockIdleSeconds={canvas.limits.lockIdleSeconds}
          onClose={() => setSource(null)}
          onSaved={() => {
            setSource(null);
            void reload();
            toast.success('Saved to canvas');
          }}
          onNewBoard={() => void reload()}
        />
      )}
      {keys && <KeysList onClose={() => setKeys(false)} />}
      {moveDocs && canvas.projectId && (
        <MoveToDocsDialog
          projectId={canvas.projectId}
          defaultName={canvas.title}
          busy={moveBusy}
          error={moveError}
          onCancel={() => setMoveDocs(false)}
          onMove={(r) => {
            setMoveBusy(true);
            setMoveError(null);
            void import('../../api/canvases')
              .then((m) => m.moveToDocs(canvasId, { title: r.name, parentId: r.parentId }))
              .then(() => {
                setMoveDocs(false);
                toast.success('Moved to Docs', 'The text it came from keeps showing it.');
                return reload();
              })
              .catch((e: unknown) => setMoveError(canvasFailure(e).message))
              .finally(() => setMoveBusy(false));
          }}
        />
      )}
    </div>
  );
  return isPage ? content : createPortal(content, document.body);
}
