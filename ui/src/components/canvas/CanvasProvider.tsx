import { Suspense, lazy, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  addBoard,
  askAi,
  canvasFailure,
  canvasKeys,
  createCanvas,
  importFiles,
  type CanvasOwnerKind,
} from '../../api/canvases';
import { useToast } from '../Toast';
import {
  CanvasContext,
  type CanvasApi,
  type CanvasResult,
  type OpenCanvasRequest,
  type ViewCanvasRequest,
} from './CanvasContext';
import { CanvasViewer } from './CanvasViewer';
import { NewCanvasDialog, type StartWith } from './NewCanvasDialog';

// the editor (the plane and all its panels) is only fetched when someone opens a canvas
const CanvasEditor = lazy(() => import('./CanvasEditor').then((m) => ({ default: m.CanvasEditor })));

interface Open {
  request: OpenCanvasRequest;
  canvasId: string;
  resolve: (r: CanvasResult | null) => void;
}
interface Pending {
  request: OpenCanvasRequest;
  resolve: (r: CanvasResult | null) => void;
}

/** The person using the app (as the board knows them). */
export function currentActor(): string {
  try {
    return localStorage.getItem('kanbanActor') || 'user';
  } catch {
    return 'user';
  }
}

/** Where a canvas belongs, in words: "Ticket KAN-142, description". */
function savedIn(kind: CanvasOwnerKind, label?: string, id?: string): string {
  const what = { ticket: 'Ticket', comment: 'Comment on', doc: 'Docs page', idea: 'Idea', page: 'Docs page' }[kind];
  return `${what} ${label || id || ''}`.trim();
}

/**
 * Hosts the canvas editor, the large view, Present and the "New canvas" dialog for the whole app. A phone opens a
 * canvas read only, one board at a time.
 * @param props.children - The app.
 */
export function CanvasProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState<Open | null>(null);
  const openRef = useRef<Open | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [view, setView] = useState<{ request: ViewCanvasRequest; mode: 'view' | 'present' } | null>(null);

  const start = useCallback(
    (request: OpenCanvasRequest, canvasId: string, resolve: (r: CanvasResult | null) => void) => {
      if (window.matchMedia?.('(max-width: 760px)').matches) {
        // a phone opens a canvas read only
        setView({ request: { id: canvasId, boardId: request.boardId }, mode: 'view' });
        resolve(null);
        return;
      }
      const o = { request, canvasId, resolve };
      openRef.current = o;
      setOpen(o);
    },
    [],
  );

  const openCanvas = useCallback(
    (request: OpenCanvasRequest) =>
      new Promise<CanvasResult | null>((resolve) => {
        if (openRef.current || pending) {
          resolve(null); // one editor at a time
          return;
        }
        if (request.canvasId) start(request, request.canvasId, resolve);
        else if (request.blank) {
          void createCanvas({
            ownerKind: request.ownerKind,
            ownerId: request.ownerId,
            title: request.title || 'Canvas',
            projectId: request.projectId,
          })
            .then((c) => {
              void qc.invalidateQueries({ queryKey: canvasKeys.one(c.id) });
              start(request, c.id, resolve);
            })
            .catch((e: unknown) => {
              toast.error('Could not create the canvas', canvasFailure(e).message);
              resolve(null);
            });
        } else setPending({ request, resolve });
      }),
    [pending, qc, start, toast],
  );

  const api = useMemo<CanvasApi>(
    () => ({
      openCanvas,
      openViewer: (request) => setView({ request, mode: 'view' }),
      present: (request) => setView({ request, mode: 'present' }),
      available: true,
    }),
    [openCanvas],
  );

  const create = async (r: { name: string; start: StartWith; files: File[]; prompt: string }) => {
    if (!pending) return;
    setCreating(true);
    setCreateError(null);
    const { request, resolve } = pending;
    try {
      const c = await createCanvas({
        ownerKind: request.ownerKind,
        ownerId: request.ownerId,
        title: r.name,
        projectId: request.projectId,
        start: r.start === 'files' ? 'none' : 'blank',
      });
      if (r.start === 'files') {
        const out = await importFiles(c.id, r.files);
        for (const f of out.failed) toast.error(`“${f.name}” could not become a board`, f.message);
        if (!out.boards.length) {
          setCreateError('None of the files could become a board. Use HTML files, pictures, or a ZIP of a built page.');
          setCreating(false);
          return;
        }
      }
      let boardId: string | undefined = request.boardId;
      if (r.start === 'ai') {
        // the blank board is what the AI fills in: ask it to build the screens as a proposal
        const first = c.doc.boards[0];
        boardId = first?.id;
        if (first) {
          await addBoard(c.id, { kind: 'html', name: first.name, page: first.page }, [
            {
              file: new Blob(['<!doctype html><title>New screen</title><h1>New screen</h1>'], { type: 'text/html' }),
              path: 'index.html',
            },
          ]).catch(() => undefined);
          await askAi(c.id, { boardIds: [first.id], request: r.prompt }).catch((e: unknown) =>
            toast.info('Ask AI later', canvasFailure(e).message),
          );
        }
      }
      void qc.invalidateQueries({ queryKey: canvasKeys.one(c.id) });
      setPending(null);
      start({ ...request, boardId, openAi: false }, c.id, resolve);
    } catch (e) {
      setCreateError(canvasFailure(e).message);
    } finally {
      setCreating(false);
    }
  };

  const close = (result: CanvasResult | null) => {
    const o = openRef.current;
    openRef.current = null;
    setOpen(null);
    if (o) void qc.invalidateQueries({ queryKey: canvasKeys.one(o.canvasId) });
    o?.resolve(result);
  };

  return (
    <CanvasContext.Provider value={api}>
      {children}
      {pending &&
        createPortal(
          <NewCanvasDialog
            savedIn={savedIn(pending.request.ownerKind, pending.request.ownerLabel, pending.request.ownerId)}
            defaultName={pending.request.title}
            busy={creating}
            error={createError}
            aiAvailable={!!pending.request.projectId || pending.request.ownerKind !== 'idea'}
            onCancel={() => {
              pending.resolve(null);
              setPending(null);
              setCreateError(null);
            }}
            onCreate={(r) => void create(r)}
          />,
          document.body,
        )}
      {open && (
        <Suspense fallback={null}>
          <CanvasEditor canvasId={open.canvasId} request={open.request} me={currentActor()} onClose={close} />
        </Suspense>
      )}
      {view && (
        <CanvasViewer
          request={view.request}
          mode={view.mode}
          me={currentActor()}
          onClose={() => setView(null)}
          onEdit={(id, boardId) => {
            setView(null);
            void openCanvas({ ownerKind: 'doc', ownerId: '', canvasId: id, boardId });
          }}
        />
      )}
    </CanvasContext.Provider>
  );
}
