import { useQuery } from '@tanstack/react-query';
import { client } from './client';
import { resolveOrigin } from './resolveOrigin';

export type CanvasOwnerKind = 'idea' | 'ticket' | 'doc' | 'comment' | 'page';
export type BoardKind = 'html' | 'image' | 'sketch' | 'diagram' | 'empty';
export type NoteColor = 'yellow' | 'green' | 'blue' | 'pink' | 'purple' | 'grey';

/** Add a board: files (HTML page, picture), a Sketch or Diagram (ref), or empty. */
/** Save layout changes, merged per item (409 canvas_conflict names the items both people changed). */
/** Create a canvas for a ticket, comment, Docs page or idea. */
/** Make a board of each file (HTML, pictures, ZIP of a built page). */
/** Docs › New page › Canvas: a Docs page of kind canvas with its canvas. */
/** What a cleaning left out of a board: `{kind: script|handler|active|request, count, host?}`. */
export interface BlockedItem {
  kind: 'script' | 'handler' | 'active' | 'request';
  count: number;
  host?: string;
}

/** The saved content of an HTML or image board (a folder of files, one revision of it). */
export interface BoardContent {
  rev: number;
  entry: string;
  files: { path: string; bytes: number }[];
  bytes: number;
  blocked: BlockedItem[];
  blockedTotal: number;
  skipped: string[];
  title: string;
}

export interface CanvasPage {
  id: string;
  name: string;
  rev: number;
  order?: number;
}
export interface CanvasBoard {
  id: string;
  page: string;
  name: string;
  kind: BoardKind;
  x: number;
  y: number;
  w: number;
  h: number;
  order: number;
  ref: string | null;
  content: BoardContent | null;
  rev: number;
  createdBy?: string;
}
export interface CanvasNote {
  id: string;
  page: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: NoteColor;
  by: string;
  rev: number;
}
export interface CanvasArrow {
  id: string;
  page: string;
  from: string;
  to: string;
  label: string;
  rev: number;
}
export interface CanvasLabel {
  id: string;
  page: string;
  x: number;
  y: number;
  text: string;
  size: number;
  rev: number;
}
/** The canvas file: page tabs, boards, notes, arrows and labels. */
export interface CanvasDoc {
  format: 'kanban-canvas';
  version: number;
  pages: CanvasPage[];
  boards: CanvasBoard[];
  notes: CanvasNote[];
  arrows: CanvasArrow[];
  labels: CanvasLabel[];
}

export interface BoardLock {
  boardId: string;
  holder: string;
  since: string;
  startedSecondsAgo: number;
  idleSeconds: number;
  expiresIn: number;
  warn: boolean;
}

export interface CanvasSummary {
  id: string;
  projectId: string | null;
  ownerKind: CanvasOwnerKind;
  ownerId: string;
  pageId: string | null;
  title: string;
  rev: number;
  version: number;
  boardCount: number;
  totalBytes: number;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  deletedAt: string | null;
  role: 'viewer' | 'member' | 'admin';
  canEdit: boolean;
  markdown: string;
  limits: {
    boards: number;
    boardBytes: number;
    canvasBytes: number;
    pages: number;
    lockIdleSeconds: number;
    minWidth: number;
    maxWidth: number;
  };
}
export interface Canvas extends CanvasSummary {
  doc: CanvasDoc;
  locks: BoardLock[];
  openComments: number;
  proposalsOpen: number;
}

export interface CanvasComment {
  id: string;
  threadId: string;
  author: string;
  body: string;
  mentions: string[];
  ai: { member?: string; canPropose?: boolean } | null;
  isAi: boolean;
  createdAt: string;
  editedAt: string | null;
}
export interface CanvasThread {
  id: string;
  canvasId: string;
  number: number;
  boardId: string | null;
  x: number;
  y: number;
  page: string | null;
  status: 'open' | 'resolved';
  createdBy: string;
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  comments: CanvasComment[];
  byAi: boolean;
}

export interface CanvasVersion {
  version: number;
  name: string | null;
  reason: string;
  author: string;
  note: string | null;
  summary: string;
  changes: {
    added: string[];
    removed: string[];
    changed: string[];
    layout: boolean;
    notes: boolean;
    arrows: boolean;
    labels: boolean;
    pages: boolean;
  };
  createdAt: string;
  doc?: CanvasDoc;
}
export interface CompareRow {
  boardId: string;
  name: string;
  state: 'same' | 'changed' | 'added' | 'removed';
  kind: BoardKind;
  a: CanvasBoard | null;
  b: CanvasBoard | null;
}

export interface ProposalChange {
  boardId: string;
  name: string;
  baseRev: number | null;
  status: 'open' | 'accepted' | 'rejected' | 'stale';
  entry: string;
  files: { path: string; bytes: number }[];
  lines: number;
  blocked: BlockedItem[];
  waitingFor: string | null;
  exists: boolean;
  before?: { path: string; text: string }[];
  after?: { path: string; text: string }[];
  entryUrlBefore?: string | null;
  entryUrlAfter?: string;
}
export interface CanvasProposal {
  id: string;
  canvasId: string;
  author: string;
  memberId: string | null;
  request: string;
  note: string;
  status: 'open' | 'accepted' | 'rejected' | 'partly';
  version: number | null;
  changes: ProposalChange[];
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  nextVersion: number;
}

/** What a failed canvas call says: the server's `{code, message}` or a generic message. */
export interface CanvasFailure {
  code: string;
  message: string;
  status: number;
  latestRev?: number;
  latestAuthor?: string;
  latestAt?: string;
  conflicts?: string[];
  holder?: string;
  since?: string;
  boardId?: string;
  sizeBytes?: number;
  limitBytes?: number;
}

/**
 * Read the server's canvas error out of an Axios error.
 * @param err - The thrown value.
 */
export function canvasFailure(err: unknown): CanvasFailure {
  const e = err as { response?: { status?: number; data?: { detail?: unknown } }; message?: string };
  const detail = e?.response?.data?.detail;
  const status = e?.response?.status ?? 0;
  if (detail && typeof detail === 'object') {
    const d = detail as Record<string, unknown>;
    return {
      code: String(d.code ?? 'error'),
      message: String(d.message ?? 'Something went wrong'),
      status,
      // error bodies are not run through the snake→camel converter
      latestRev: d.latest_rev as number | undefined,
      latestAuthor: d.latest_author as string | undefined,
      latestAt: d.latest_at as string | undefined,
      conflicts: d.conflicts as string[] | undefined,
      holder: d.holder as string | undefined,
      since: d.since as string | undefined,
      boardId: d.board_id as string | undefined,
      sizeBytes: d.size_bytes as number | undefined,
      limitBytes: d.limit_bytes as number | undefined,
    };
  }
  return { code: status ? 'error' : 'offline', message: e?.message || 'Could not reach the server', status };
}

/**
 * The markdown that places a canvas (or one board, or a page tab) in a text.
 * @param c - Id and title.
 * @param fragment - `b_…` for one board or `p_…` for a page tab.
 */
export function canvasMarkdown(c: { id: string; title: string }, fragment?: string): string {
  return `![${c.title.replace(/[[\]\n]+/g, ' ').trim() || 'Canvas'}](canvas:${c.id}${fragment ? `#${fragment}` : ''})`;
}

/** Address of a file of a board at one revision. Served with a policy that lets it draw and nothing else. */
export function boardFileUrl(canvasId: string, boardId: string, rev: number, path: string): string {
  return `${resolveOrigin()}/canvases/${canvasId}/boards/${boardId}/r/${rev}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
/** Address of a wireframe picture of an HTML or empty board (what is drawn below 40% zoom). */
export function boardSnapshotUrl(canvasId: string, boardId: string, rev?: number): string {
  return `${resolveOrigin()}/canvases/${canvasId}/boards/${boardId}/snapshot.png${rev ? `?rev=${rev}` : ''}`;
}
/** Address of the overview picture of a canvas (what an export writes in its place). */
export function canvasOverviewUrl(canvasId: string, page?: string, rev?: number): string {
  const q = [page ? `page=${page}` : '', rev ? `v=${rev}` : ''].filter(Boolean).join('&');
  return `${resolveOrigin()}/canvases/${canvasId}/overview.png${q ? `?${q}` : ''}`;
}
/** Address that downloads a ZIP of all boards, or of one board. */
export function canvasDownloadUrl(canvasId: string, boardId?: string, version?: number): string {
  const q = [boardId ? `board_id=${boardId}` : '', version ? `version=${version}` : ''].filter(Boolean).join('&');
  return `${resolveOrigin()}/canvases/${canvasId}/download${q ? `?${q}` : ''}`;
}
/** Address of a picture the board shows: an uploaded picture, a Sketch's PNG or a Diagram's SVG. */
export function boardPictureUrl(canvasId: string, b: CanvasBoard): string | null {
  if (b.kind === 'image' && b.content) return boardFileUrl(canvasId, b.id, b.content.rev, b.content.entry);
  if (b.kind === 'sketch' && b.ref) return `${resolveOrigin()}/sketches/${b.ref}/png`;
  if (b.kind === 'diagram' && b.ref) return `${resolveOrigin()}/diagrams/${b.ref}/svg`;
  return null;
}

export const canvasKeys = {
  one: (id: string) => ['canvas', id] as const,
  threads: (id: string) => ['canvas', id, 'threads'] as const,
  versions: (id: string) => ['canvas', id, 'versions'] as const,
  proposals: (id: string) => ['canvas', id, 'proposals'] as const,
};

/**
 * Query a canvas with its file (embeds, the viewer and the editor all read this).
 * @param id - Canvas id; disabled while empty.
 */
export function useCanvas(id: string) {
  return useQuery({
    queryKey: canvasKeys.one(id),
    queryFn: async () => (await client.get<Canvas>(`/canvases/${id}`)).data,
    enabled: !!id,
    retry: false,
    staleTime: 5_000,
  });
}
/**
 * Query a canvas's comment threads.
 * @param id - Canvas id.
 * @param enabled - Whether to fetch.
 */
export function useCanvasThreads(id: string, enabled = true) {
  return useQuery({
    queryKey: canvasKeys.threads(id),
    queryFn: async () => (await client.get<CanvasThread[]>(`/canvases/${id}/threads`)).data,
    enabled: !!id && enabled,
    staleTime: 5_000,
  });
}
/**
 * Query a canvas's open AI proposals (before and after).
 * @param id - Canvas id.
 * @param enabled - Whether to fetch.
 */
export function useCanvasProposals(id: string, enabled = true) {
  return useQuery({
    queryKey: canvasKeys.proposals(id),
    queryFn: async () => (await client.get<CanvasProposal[]>(`/canvases/${id}/proposals`)).data,
    enabled: !!id && enabled,
    staleTime: 3_000,
  });
}
/**
 * Query a canvas's versions, newest first.
 * @param id - Canvas id.
 * @param enabled - Whether to fetch.
 */
export function useCanvasVersions(id: string, enabled = true) {
  return useQuery({
    queryKey: canvasKeys.versions(id),
    queryFn: async () => (await client.get<CanvasVersion[]>(`/canvases/${id}/versions`)).data,
    enabled: !!id && enabled,
    staleTime: 3_000,
  });
}

// --- calls ---------------------------------------------------------------------------------------------

/** Create a canvas for a ticket, comment, Docs page or idea. */
export async function createCanvas(body: {
  ownerKind: CanvasOwnerKind;
  ownerId: string;
  title?: string;
  projectId?: string;
  start?: 'blank' | 'none';
  size?: string;
}): Promise<Canvas> {
  return (await client.post<Canvas>('/canvases', body)).data;
}
/** Docs › New page › Canvas. */
export async function createCanvasPage(body: { projectId: string; title: string; parentId?: string | null }) {
  return (
    await client.post<{ page: { id: string; title: string; slug: string }; canvas: Canvas }>('/canvases/pages', body)
  ).data;
}
/** Read a canvas with its file (not through the cache: the editor needs it as it is now). */
export async function fetchCanvas(id: string): Promise<Canvas> {
  return (await client.get<Canvas>(`/canvases/${id}`)).data;
}

/** The changes a layout save carries: items by list, ids to remove, and what to do with the version. */
export interface SaveBody {
  baseRev: number;
  upsert?: Partial<Record<'pages' | 'boards' | 'notes' | 'arrows' | 'labels', Record<string, unknown>[]>>;
  remove?: string[];
  title?: string;
  force?: boolean;
  checkpoint?: boolean;
  name?: string;
  note?: string;
}
/** Save layout changes, merged per item (409 `canvas_conflict` names the items both people changed). */
export async function saveCanvas(id: string, body: SaveBody) {
  return (await client.patch<{ rev: number; version: number; doc: CanvasDoc; saved: number }>(`/canvases/${id}`, body))
    .data;
}
/** Unlink a canvas (kept, restorable). */
export async function deleteCanvas(id: string) {
  return (await client.delete(`/canvases/${id}`)).data;
}
/** Save a copy: a second canvas with the same boards, notes and arrows. */
export async function copyCanvas(id: string, title?: string): Promise<Canvas> {
  return (await client.post<Canvas>(`/canvases/${id}/copy`, undefined, { params: title ? { title } : undefined })).data;
}
/** Give an inline canvas its own Docs page; the text it came from keeps showing it. */
export async function moveToDocs(id: string, body: { title?: string; parentId?: string | null }) {
  return (
    await client.post<{ page: { id: string; title: string }; canvas: Canvas }>(`/canvases/${id}/move-to-docs`, body)
  ).data;
}

/** Add a board: files (HTML page, picture), a Sketch or Diagram (`ref`), or empty. */
export async function addBoard(
  id: string,
  b: {
    kind: BoardKind;
    name?: string;
    page?: string;
    ref?: string;
    size?: string;
    entry?: string;
    x?: number;
    y?: number;
  },
  files?: { file: File | Blob; path?: string }[],
) {
  const f = new FormData();
  f.append('kind', b.kind);
  for (const [k, v] of Object.entries(b)) if (k !== 'kind' && v != null) f.append(k, String(v));
  for (const x of files ?? []) {
    f.append('files', x.file, (x.file as File).name || x.path || 'file');
    f.append('paths', x.path ?? (x.file as File).name ?? '');
  }
  return (await client.post<{ board: CanvasBoard; rev: number }>(`/canvases/${id}/boards`, f)).data;
}
/** Make a board of each file (HTML, pictures, ZIP of a built page). */
export async function importFiles(id: string, files: File[], page?: string) {
  const f = new FormData();
  for (const file of files) f.append('files', file, file.name);
  if (page) f.append('page', page);
  return (
    await client.post<{
      boards: CanvasBoard[];
      failed: { name: string; message: string; code: string }[];
      rev: number;
    }>(`/canvases/${id}/import`, f)
  ).data;
}
/** Replace the content of a board with uploaded files. */
export async function replaceBoard(id: string, boardId: string, files: File[]) {
  const f = new FormData();
  for (const file of files) f.append('files', file, file.name);
  return (await client.post<{ board: CanvasBoard; rev: number }>(`/canvases/${id}/boards/${boardId}/replace`, f)).data;
}
/** Copy a board next to the original. */
export async function duplicateBoard(id: string, boardId: string) {
  return (await client.post<{ board: CanvasBoard; rev: number }>(`/canvases/${id}/boards/${boardId}/duplicate`)).data;
}
/** Take the lock on a board so its content can be changed (423 if somebody else has it). */
export async function lockBoard(id: string, boardId: string) {
  return (await client.post<BoardLock>(`/canvases/${id}/boards/${boardId}/lock`)).data;
}
/** Show you are still editing a board; alive is false when the lock was lost. */
export async function heartbeatBoard(id: string, boardId: string) {
  return (await client.post<{ alive: boolean; lock: BoardLock | null }>(`/canvases/${id}/boards/${boardId}/heartbeat`))
    .data;
}
/** Let go of the lock on a board. */
export async function unlockBoard(id: string, boardId: string) {
  return (await client.delete(`/canvases/${id}/boards/${boardId}/lock`)).data;
}
/** The text files of an HTML board, for the source editor. */
export async function fetchBoardSource(id: string, boardId: string) {
  return (
    await client.get<{ boardId: string; rev: number | null; entry: string; files: { path: string; text: string }[] }>(
      `/canvases/${id}/boards/${boardId}/source`,
    )
  ).data;
}
/** Save a board's source (the person editing holds the lock). */
export async function saveBoardContent(
  id: string,
  boardId: string,
  body: { files: { path: string; text: string }[]; entry?: string; baseContentRev?: number | null; release?: boolean },
) {
  return (await client.put<{ board: CanvasBoard; rev: number }>(`/canvases/${id}/boards/${boardId}/content`, body))
    .data;
}

// versions
/** One version with the canvas file as it was. */
export async function fetchVersion(id: string, n: number): Promise<CanvasVersion> {
  return (await client.get<CanvasVersion>(`/canvases/${id}/versions/${n}`)).data;
}
/** Make a (named) version of the canvas as it is now. */
export async function makeVersion(id: string, body: { name?: string; note?: string }) {
  return (await client.post<CanvasVersion>(`/canvases/${id}/versions`, body)).data;
}
/** Name or unname a version. */
export async function nameVersion(id: string, n: number, name: string | null) {
  return (await client.patch<CanvasVersion>(`/canvases/${id}/versions/${n}`, { name })).data;
}
/** Restore a version; this makes a new version, nothing is lost. */
export async function restoreVersion(id: string, n: number): Promise<Canvas> {
  return (await client.post<Canvas>(`/canvases/${id}/versions/${n}/restore`)).data;
}
/** Two versions board by board. */
export async function compareVersions(id: string, a: number, b: number) {
  return (
    await client.get<{ a: number; b: number; boards: CompareRow[] }>(`/canvases/${id}/compare`, { params: { a, b } })
  ).data;
}
/** Line diff of a board's source between two versions. */
export async function sourceDiff(id: string, boardId: string, a: number, b: number) {
  return (
    await client.get<{ files: { path: string; diff: string }[] }>(`/canvases/${id}/boards/${boardId}/source-diff`, {
      params: { a, b },
    })
  ).data;
}

// comments
/** Pin a comment to a board (0 to 1 inside it) or to the plane. */
export async function addThread(
  id: string,
  body: { body: string; boardId?: string | null; x?: number; y?: number; page?: string | null },
) {
  return (await client.post<CanvasThread>(`/canvases/${id}/threads`, body)).data;
}
/** Reply in a comment thread. */
export async function replyThread(threadId: string, body: string) {
  return (await client.post<CanvasThread>(`/canvases/threads/${threadId}/replies`, { body })).data;
}
/** Resolve or reopen a thread. */
export async function setThreadStatus(threadId: string, status: 'resolved' | 'open') {
  return (
    await client.post<CanvasThread>(`/canvases/threads/${threadId}/${status === 'resolved' ? 'resolve' : 'reopen'}`)
  ).data;
}
/** Delete your own comment (the opening one removes the thread). */
export async function deleteComment(commentId: string) {
  return (await client.delete(`/canvases/comments/${commentId}`)).data;
}

// AI
/** Accept and/or reject the boards of an AI proposal. */
export async function decideProposal(
  id: string,
  proposalId: string,
  body: { accept?: string[] | 'all'; reject?: string[] | 'rest' | 'all' },
) {
  return (await client.post<CanvasProposal>(`/canvases/${id}/proposals/${proposalId}/decide`, body)).data;
}
export interface AiJob {
  id: string;
  state: 'queued' | 'running' | 'finished' | 'failed' | 'cancelled';
  result: { proposalId?: string; note?: string; boards?: string[]; cost?: number; metered?: boolean };
  error: { code?: string; message?: string };
}
/** Ask an AI member to prepare a proposal for some boards. */
export async function askAi(id: string, body: { boardIds: string[]; request: string; memberId?: string }) {
  return (await client.post<AiJob>(`/canvases/${id}/ai/ask`, body)).data;
}
/** Start the same job from an AI comment ("Propose a fix"). */
export async function proposeFixFromThread(threadId: string) {
  return (await client.post<AiJob>(`/canvases/threads/${threadId}/propose`)).data;
}
/** Read an AI job (to see when a proposal is ready). */
export async function fetchAiJob(jobId: string) {
  return (await client.get<AiJob>(`/docs/ai/jobs/${jobId}`)).data;
}
