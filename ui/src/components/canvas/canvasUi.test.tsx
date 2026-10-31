// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Canvas, CanvasBoard, CanvasDoc, CanvasProposal } from '../../api/canvases';
import { ToastProvider } from '../Toast';
import { BoardFrame, FRAME_SANDBOX } from './BoardFrame';
import { CanvasContext, type CanvasApi } from './CanvasContext';
import { CanvasEmbed } from './CanvasEmbed';
import { CanvasEditor } from './CanvasEditor';
import { ProposalReview } from './CanvasAi';
import { SourceEditor } from './SourceEditor';

// ---- a canvas of two boards, served by a fake API ----
const board = (id: string, name: string, x: number, extra: Partial<CanvasBoard> = {}): CanvasBoard => ({
  id,
  page: 'p_1',
  name,
  kind: 'html',
  x,
  y: 0,
  w: 1280,
  h: 800,
  order: 0,
  ref: null,
  rev: 2,
  content: {
    rev: 2,
    entry: 'index.html',
    files: [{ path: 'index.html', bytes: 90 }],
    bytes: 90,
    blocked: [],
    blockedTotal: 0,
    skipped: [],
    title: name,
  },
  ...extra,
});
const DOC: CanvasDoc = {
  format: 'kanban-canvas',
  version: 1,
  pages: [{ id: 'p_1', name: 'Page 1', rev: 1 }],
  boards: [board('b_aaaaaaaa', 'Sign in', 0), board('b_bbbbbbbb', 'Sign in: phone', 1400)],
  notes: [],
  arrows: [],
  labels: [],
};
const CANVAS: Canvas = {
  id: 'cv_12345678',
  projectId: 'proj',
  ownerKind: 'ticket',
  ownerId: 'KAN-1',
  pageId: null,
  title: 'Login redesign',
  rev: 5,
  version: 3,
  boardCount: 2,
  totalBytes: 180,
  createdBy: 'user',
  createdAt: '2026-10-31T10:00:00+00:00',
  updatedBy: 'Hoa Mai',
  updatedAt: '2026-10-31T11:00:00+00:00',
  deletedAt: null,
  role: 'member',
  canEdit: true,
  markdown: '![Login redesign](canvas:cv_12345678)',
  limits: {
    boards: 60,
    boardBytes: 5242880,
    canvasBytes: 52428800,
    pages: 10,
    lockIdleSeconds: 600,
    minWidth: 320,
    maxWidth: 1920,
  },
  doc: DOC,
  locks: [],
  openComments: 0,
  proposalsOpen: 0,
};

type Handler = (url: string, ...rest: unknown[]) => unknown;
const calls: { method: string; url: string; body?: unknown }[] = [];
let handlers: Record<string, Handler> = {};
const reply = (data: unknown) => Promise.resolve({ data, status: 200 });
const reject = (status: number, detail: Record<string, unknown>) =>
  Promise.reject({ response: { status, data: { detail } } });

vi.mock('../../api/client', () => ({
  client: {
    get: (url: string, ...rest: unknown[]) => run('GET', url, undefined, rest),
    post: (url: string, body?: unknown, ...rest: unknown[]) => run('POST', url, body, rest),
    patch: (url: string, body?: unknown, ...rest: unknown[]) => run('PATCH', url, body, rest),
    put: (url: string, body?: unknown, ...rest: unknown[]) => run('PUT', url, body, rest),
    delete: (url: string, ...rest: unknown[]) => run('DELETE', url, undefined, rest),
  },
}));
function run(method: string, url: string, body: unknown, rest: unknown[]) {
  calls.push({ method, url, body });
  const h = handlers[`${method} ${url}`] ?? handlers[`${method} *`];
  if (h) return h(url, body, ...rest);
  if (method === 'GET' && url === '/canvases/cv_12345678') return reply(CANVAS);
  if (method === 'GET' && url.endsWith('/threads')) return reply([]);
  if (method === 'GET' && url.endsWith('/proposals')) return reply([]);
  return reply({});
}

function wrap(children: ReactNode, api?: Partial<CanvasApi>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const canvasApi: CanvasApi = {
    openCanvas: vi.fn(() => Promise.resolve(null)),
    openViewer: vi.fn(),
    present: vi.fn(),
    available: true,
    ...api,
  };
  return (
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <CanvasContext.Provider value={canvasApi}>{children}</CanvasContext.Provider>
      </ToastProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  calls.length = 0;
  handlers = {};
  localStorage.clear();
  // jsdom has no layout: give every box a size so the plane has a window to fit into
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 1000,
    bottom: 700,
    width: 1000,
    height: 700,
    toJSON: () => ({}),
  });
  Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()), write: vi.fn() } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---- the card in a text ----

test('the embed shows the boards, the footer and the hover actions', async () => {
  const api: Partial<CanvasApi> = { openViewer: vi.fn() };
  render(wrap(<CanvasEmbed id="cv_12345678" label="Login redesign" />, api));
  await screen.findByTestId('canvas-embed');
  expect(await screen.findByText('Login redesign')).toBeTruthy();
  expect(screen.getByText('2 frames')).toBeTruthy();
  expect(screen.getByText(/Edited by Hoa Mai/)).toBeTruthy();
  // the actions of a diagram: Edit, Download, View full size and Copy link
  const toolbar = screen.getByRole('toolbar', { name: 'Canvas actions' });
  expect(toolbar.textContent).toContain('Edit');
  expect(toolbar.textContent).toContain('Download');
  expect((screen.getByTestId('canvas-download') as HTMLAnchorElement).href).toContain('/canvases/cv_12345678/download');
  fireEvent.click(screen.getByTestId('canvas-view'));
  expect(api.openViewer).toHaveBeenCalledWith({ id: 'cv_12345678', boardId: undefined, pageId: undefined });
  fireEvent.click(screen.getByTestId('canvas-copy-link'));
  await waitFor(() =>
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('![Login redesign](canvas:cv_12345678)'),
  );
});

test('the embed hides Edit for people who cannot edit and says when the canvas or one board is gone', async () => {
  handlers['GET /canvases/cv_12345678'] = () => reply({ ...CANVAS, canEdit: false, role: 'viewer' });
  const view = render(wrap(<CanvasEmbed id="cv_12345678" label="Login redesign" />));
  await screen.findByTestId('canvas-embed');
  expect(screen.queryByTestId('canvas-edit')).toBeNull();
  expect(screen.getByTestId('canvas-view')).toBeTruthy();
  view.unmount();
  handlers['GET /canvases/cv_12345678'] = () => reply(CANVAS);
  render(wrap(<CanvasEmbed id="cv_12345678" label="Login redesign" boardId="b_deadbeef" />));
  expect(await screen.findByTestId('canvas-board-missing')).toBeTruthy();
  cleanup();
  handlers['GET /canvases/cv_12345678'] = () => reject(404, { code: 'canvas_not_found', message: 'gone' });
  render(wrap(<CanvasEmbed id="cv_12345678" label="Login redesign" />));
  const missing = await screen.findByTestId('canvas-missing');
  expect(missing.textContent).toContain('Canvas not found');
  expect(missing.textContent).toContain('“Login redesign”');
});

// ---- the editor ----

test('the editor loads the canvas, and a layout change is saved merged per item', async () => {
  handlers['PATCH /canvases/cv_12345678'] = (_u, body) =>
    reply({
      rev: 6,
      version: 3,
      saved: 1,
      doc: { ...DOC, boards: [{ ...DOC.boards[0], x: 10, rev: 6 }, DOC.boards[1]] },
      echo: body,
    });
  render(
    wrap(
      <CanvasEditor
        canvasId="cv_12345678"
        request={{ ownerKind: 'ticket', ownerId: 'KAN-1' }}
        me="user"
        onClose={() => undefined}
      />,
    ),
  );
  await screen.findByTestId('canvas-editor');
  await waitFor(() => expect(screen.getAllByTestId('canvas-board')).toHaveLength(2));
  expect(screen.getByDisplayValue('Login redesign')).toBeTruthy();
  // Tab selects the first board, an arrow key nudges it by 10
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const plane = screen.getByTestId('canvas-plane');
  plane.focus();
  fireEvent.keyDown(plane, { key: 'Tab' });
  fireEvent.keyDown(plane, { key: 'ArrowRight' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  const save = calls.find((c) => c.method === 'PATCH');
  expect(save).toBeTruthy();
  const body = save?.body as {
    baseRev: number;
    upsert: { boards: { id: string; x: number; rev: number }[] };
    remove: string[];
  };
  // only the board that moved is sent, with the revision the editor saw it at (the per-item merge)
  expect(body.baseRev).toBe(5);
  expect(body.upsert.boards).toHaveLength(1);
  expect(body.upsert.boards[0]).toMatchObject({ id: 'b_aaaaaaaa', x: 10, rev: 2 });
  expect(body.remove).toEqual([]);
});

test('a view only person gets no tools to change anything', async () => {
  handlers['GET /canvases/cv_12345678'] = () => reply({ ...CANVAS, canEdit: false, role: 'viewer' });
  render(
    wrap(
      <CanvasEditor
        canvasId="cv_12345678"
        request={{ ownerKind: 'ticket', ownerId: 'KAN-1' }}
        me="user"
        onClose={() => undefined}
      />,
    ),
  );
  await screen.findByTestId('canvas-view-only');
  expect(screen.queryByTestId('canvas-done')).toBeNull();
  expect(screen.queryByTestId('canvas-ask-ai')).toBeNull();
  expect(screen.queryByTestId('canvas-tool-note')).toBeNull();
  expect(screen.getByTestId('canvas-tool-comment')).toBeTruthy(); // they can comment where they can comment on the page
});

test('"someone saved in the meantime": the same item changed by both shows the card, and Load theirs takes the server plane', async () => {
  handlers['PATCH /canvases/cv_12345678'] = () =>
    reject(409, {
      code: 'canvas_conflict',
      message: 'Hoa Mai saved',
      latest_author: 'Hoa Mai',
      latest_rev: 7,
      conflicts: ['b_aaaaaaaa'],
    });
  render(
    wrap(
      <CanvasEditor
        canvasId="cv_12345678"
        request={{ ownerKind: 'ticket', ownerId: 'KAN-1' }}
        me="user"
        onClose={() => undefined}
      />,
    ),
  );
  await screen.findByTestId('canvas-editor');
  await waitFor(() => expect(screen.getAllByTestId('canvas-board')).toHaveLength(2));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const plane = screen.getByTestId('canvas-plane');
  plane.focus();
  fireEvent.keyDown(plane, { key: 'Tab' });
  fireEvent.keyDown(plane, { key: 'ArrowDown' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  const card = await screen.findByTestId('canvas-conflict');
  expect(card.textContent).toContain('Hoa Mai saved a newer version');
  expect(card.textContent).toContain('Save as copy');
  expect(card.textContent).toContain('Load theirs');
  const gets = () => calls.filter((c) => c.method === 'GET' && c.url === '/canvases/cv_12345678').length;
  const before = gets();
  fireEvent.click(screen.getByTestId('canvas-load-theirs'));
  await waitFor(() => expect(screen.queryByTestId('canvas-conflict')).toBeNull());
  expect(gets()).toBeGreaterThan(before);
});

test('when saving fails the canvas is kept as a draft on this computer', async () => {
  handlers['PATCH /canvases/cv_12345678'] = () => Promise.reject(new Error('Network Error'));
  render(
    wrap(
      <CanvasEditor
        canvasId="cv_12345678"
        request={{ ownerKind: 'ticket', ownerId: 'KAN-1' }}
        me="user"
        onClose={() => undefined}
      />,
    ),
  );
  await screen.findByTestId('canvas-editor');
  await waitFor(() => expect(screen.getAllByTestId('canvas-board')).toHaveLength(2));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const plane = screen.getByTestId('canvas-plane');
  plane.focus();
  fireEvent.keyDown(plane, { key: 'Tab' });
  fireEvent.keyDown(plane, { key: 'ArrowLeft' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  const card = await screen.findByTestId('canvas-save-failed');
  expect(card.textContent).toContain('Could not save');
  expect(card.textContent).toContain('kept as a draft on this computer');
  expect(localStorage.getItem('kanban-canvas-draft:cv_12345678')).toContain('b_aaaaaaaa');
  expect(screen.getByTestId('canvas-draft-kept')).toBeTruthy();
});

test('a board somebody else is editing has a blue ribbon and its Edit is off', async () => {
  handlers['GET /canvases/cv_12345678'] = () =>
    reply({
      ...CANVAS,
      locks: [
        {
          boardId: 'b_aaaaaaaa',
          holder: 'An Nguyen',
          since: '',
          startedSecondsAgo: 360,
          idleSeconds: 5,
          expiresIn: 595,
          warn: false,
        },
      ],
    });
  render(
    wrap(
      <CanvasEditor
        canvasId="cv_12345678"
        request={{ ownerKind: 'ticket', ownerId: 'KAN-1', boardId: 'b_aaaaaaaa' }}
        me="user"
        onClose={() => undefined}
      />,
    ),
  );
  const ribbon = await screen.findByTestId('canvas-lock-ribbon');
  expect(ribbon.textContent).toContain('An Nguyen is editing');
  const edit = await screen.findByTestId('canvas-board-edit');
  expect((edit as HTMLButtonElement).disabled).toBe(true);
});

test('the source editor says who is editing when the lock is taken, and does not start', async () => {
  handlers['POST /canvases/cv_12345678/boards/b_aaaaaaaa/lock'] = () =>
    reject(423, {
      code: 'board_locked',
      message: 'An Nguyen is editing Sign in.',
      holder: 'An Nguyen',
      since: '2026-10-31T10:00:00+00:00',
    });
  render(
    wrap(
      <SourceEditor
        canvasId="cv_12345678"
        canvasTitle="Login redesign"
        board={DOC.boards[0]}
        onClose={() => undefined}
        onSaved={() => undefined}
      />,
    ),
  );
  const card = await screen.findByTestId('canvas-source-blocked');
  expect(card.textContent).toContain('An Nguyen is editing Sign in');
  expect(card.textContent).toContain('still look, comment and move');
  expect(screen.queryByTestId('canvas-source-text')).toBeNull();
});

test('the source editor takes the lock, previews in a locked frame and saves with the revision it started from', async () => {
  handlers['POST /canvases/cv_12345678/boards/b_aaaaaaaa/lock'] = () => reply({ holder: 'user' });
  handlers['GET /canvases/cv_12345678/boards/b_aaaaaaaa/source'] = () =>
    reply({
      boardId: 'b_aaaaaaaa',
      rev: 2,
      entry: 'index.html',
      files: [
        { path: 'index.html', text: '<h1>Sign in</h1><script>alert(1)</script><img src="https://t.example/p.gif">' },
      ],
    });
  handlers['PUT /canvases/cv_12345678/boards/b_aaaaaaaa/content'] = () => reply({ board: DOC.boards[0], rev: 7 });
  const saved = vi.fn();
  render(
    wrap(
      <SourceEditor
        canvasId="cv_12345678"
        canvasTitle="Login redesign"
        board={DOC.boards[0]}
        onClose={() => undefined}
        onSaved={saved}
      />,
    ),
  );
  const text = (await screen.findByTestId('canvas-source-text')) as HTMLTextAreaElement;
  await waitFor(() => expect(text.value).toContain('<h1>Sign in</h1>'));
  expect(screen.getByTestId('canvas-locked-for-you')).toBeTruthy();
  // the preview is the Preview's locked frame: no scripts (empty sandbox), a policy that blocks every outside request
  const frame = screen.getByTestId('canvas-source-preview') as HTMLIFrameElement;
  expect(frame.getAttribute('sandbox')).toBe('');
  const doc = frame.getAttribute('srcdoc') ?? '';
  expect(doc).not.toMatch(/<script/i);
  expect(doc).toContain("default-src 'none'");
  expect(doc).not.toContain('t.example');
  fireEvent.change(text, { target: { value: '<h1>Sign in again</h1>' } });
  fireEvent.click(screen.getByTestId('canvas-source-save'));
  await waitFor(() => expect(saved).toHaveBeenCalled());
  const put = calls.find((c) => c.method === 'PUT');
  expect(put?.body).toMatchObject({
    files: [{ path: 'index.html', text: '<h1>Sign in again</h1>' }],
    baseContentRev: 2,
    release: true,
  });
});

// ---- boards never run a script or reach outside ----

test('a board is drawn in a frame with an empty sandbox, served by the API, never from a data address', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true } as Response)),
  );
  const { container } = render(<BoardFrame canvasId="cv_12345678" board={DOC.boards[0]} scale={0.5} live />);
  const frame = await waitFor(() => {
    const f = container.querySelector('iframe');
    expect(f).toBeTruthy();
    return f as HTMLIFrameElement;
  });
  expect(FRAME_SANDBOX).toBe(''); // no allow-scripts, allow-same-origin, allow-forms, allow-popups, allow-top-navigation
  expect(frame.getAttribute('sandbox')).toBe('');
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(frame.getAttribute('src')).toMatch(/\/canvases\/cv_12345678\/boards\/b_aaaaaaaa\/r\/2\/index\.html$/);
  expect(frame.getAttribute('srcdoc')).toBeNull();
  vi.unstubAllGlobals();
});

test('below 40% zoom a board is a picture, not a frame', () => {
  const { container } = render(<BoardFrame canvasId="cv_12345678" board={DOC.boards[0]} scale={0.2} live={false} />);
  expect(container.querySelector('iframe')).toBeNull();
  expect(container.querySelector('img')?.getAttribute('src')).toContain('/boards/b_aaaaaaaa/snapshot.png');
});

// ---- the AI proposal ----

const PROPOSAL = (over: Partial<CanvasProposal['changes'][number]> = {}): CanvasProposal => ({
  id: 'cp_0123456789',
  canvasId: 'cv_12345678',
  author: 'Designer AI',
  memberId: 'm1',
  request: 'Move the error under the field',
  note: 'The error moves under the password field.',
  status: 'open',
  version: null,
  nextVersion: 4,
  createdAt: '2026-10-31T11:00:00+00:00',
  decidedBy: null,
  decidedAt: null,
  changes: [
    {
      boardId: 'b_aaaaaaaa',
      name: 'Sign in',
      baseRev: 2,
      status: 'open',
      entry: 'index.html',
      files: [{ path: 'index.html', bytes: 10 }],
      lines: 4,
      blocked: [],
      waitingFor: null,
      exists: true,
      before: [{ path: 'index.html', text: '<p>a</p>' }],
      after: [{ path: 'index.html', text: '<p>b</p>' }],
      entryUrlAfter: '/canvases/cv_12345678/proposals/cp_0123456789/b_aaaaaaaa/index.html',
      ...over,
    },
    {
      boardId: 'b_bbbbbbbb',
      name: 'Sign in: phone',
      baseRev: 2,
      status: 'open',
      entry: 'index.html',
      files: [{ path: 'index.html', bytes: 10 }],
      lines: 3,
      blocked: [],
      waitingFor: null,
      exists: true,
      before: [{ path: 'index.html', text: '<p>a</p>' }],
      after: [{ path: 'index.html', text: '<p>c</p>' }],
      entryUrlAfter: '/canvases/cv_12345678/proposals/cp_0123456789/b_bbbbbbbb/index.html',
    },
  ],
});

test('a proposal shows before and after and is accepted for all boards in one call', async () => {
  handlers['GET /canvases/cv_12345678/proposals'] = () => reply([PROPOSAL()]);
  handlers['POST /canvases/cv_12345678/proposals/cp_0123456789/decide'] = () =>
    reply({ ...PROPOSAL(), status: 'accepted', version: 4 });
  const accepted = vi.fn();
  const closed = vi.fn();
  render(wrap(<ProposalReview canvasId="cv_12345678" canDecide onAccepted={accepted} onClose={closed} />));
  const card = await screen.findByTestId('canvas-proposal');
  expect(card.textContent).toContain('Designer AI proposes a change to 2 boards');
  expect(card.textContent).toContain('Version 4 · nothing is saved yet');
  expect(screen.getAllByTestId('canvas-change')).toHaveLength(2);
  // before and after are locked frames too
  const frames = card.querySelectorAll('iframe');
  expect(frames.length).toBe(4);
  frames.forEach((f) => expect(f.getAttribute('sandbox')).toBe(''));
  fireEvent.click(screen.getByTestId('canvas-proposal-accept-all'));
  await waitFor(() => expect(accepted).toHaveBeenCalled());
  expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/decide'))?.body).toMatchObject({ accept: 'all' });
  expect(closed).toHaveBeenCalled();
});

test('a proposal can be rejected, and a board somebody is editing makes it wait: AI never takes the lock', async () => {
  handlers['GET /canvases/cv_12345678/proposals'] = () => reply([PROPOSAL()]);
  handlers['POST /canvases/cv_12345678/proposals/cp_0123456789/decide'] = () =>
    reply({ ...PROPOSAL(), status: 'rejected' });
  render(
    wrap(<ProposalReview canvasId="cv_12345678" canDecide onAccepted={() => undefined} onClose={() => undefined} />),
  );
  await screen.findByTestId('canvas-proposal');
  fireEvent.click(screen.getByTestId('canvas-proposal-reject'));
  await waitFor(() => expect(calls.some((c) => c.url.endsWith('/decide'))).toBe(true));
  expect(calls.find((c) => c.url.endsWith('/decide'))?.body).toMatchObject({ accept: [], reject: 'all' });
  cleanup();
  handlers['GET /canvases/cv_12345678/proposals'] = () => reply([PROPOSAL({ waitingFor: 'An Nguyen' })]);
  render(
    wrap(<ProposalReview canvasId="cv_12345678" canDecide onAccepted={() => undefined} onClose={() => undefined} />),
  );
  const waiting = await screen.findByTestId('canvas-ai-waiting');
  expect(waiting.textContent).toContain('An Nguyen is editing it');
  expect(waiting.textContent).toContain('never take a lock');
  expect((screen.getByTestId('canvas-proposal-accept-all') as HTMLButtonElement).disabled).toBe(true);
});

test('only people who can edit decide a proposal', async () => {
  handlers['GET /canvases/cv_12345678/proposals'] = () => reply([PROPOSAL()]);
  render(
    wrap(
      <ProposalReview
        canvasId="cv_12345678"
        canDecide={false}
        onAccepted={() => undefined}
        onClose={() => undefined}
      />,
    ),
  );
  await screen.findByTestId('canvas-proposal');
  expect(screen.queryByTestId('canvas-proposal-accept-all')).toBeNull();
});
