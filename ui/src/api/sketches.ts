import { useQuery } from '@tanstack/react-query';
import { client } from './client';
import { resolveOrigin } from './resolveOrigin';

export type SketchOwnerKind = 'idea' | 'ticket' | 'doc' | 'comment';

/** A saved sketch as the API returns it (the PNG and the editable source are separate downloads). */
export interface Sketch {
  id: string;
  projectId: string | null;
  ownerKind: SketchOwnerKind;
  ownerId: string;
  title: string;
  width: number;
  height: number;
  layerCount: number;
  version: number;
  pngBytes: number;
  sourceBytes: number;
  /** Stable paths in the uploads folder; they always hold the latest version. */
  pngUrl: string;
  sourceUrl: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  deletedAt: string | null;
  role: 'viewer' | 'member' | 'admin';
  canEdit: boolean;
}

/** What a failed sketch call says: the server's `{code, message}` or a generic message. */
export interface SketchFailure {
  code: string;
  message: string;
  status: number;
  latestVersion?: number;
  latestAuthor?: string;
  latestAt?: string;
}

/**
 * Read the server's sketch error out of an Axios error.
 * @param err - The thrown value.
 */
export function sketchFailure(err: unknown): SketchFailure {
  const e = err as {
    response?: { status?: number; data?: { detail?: unknown } };
    message?: string;
  };
  const detail = e?.response?.data?.detail;
  const status = e?.response?.status ?? 0;
  if (detail && typeof detail === 'object') {
    const d = detail as Record<string, unknown>;
    return {
      code: String(d.code ?? 'error'),
      message: String(d.message ?? 'Something went wrong'),
      status,
      // error bodies are not run through the snake→camel converter, so read the API's own names
      latestVersion: d.latest_version as number | undefined,
      latestAuthor: d.latest_author as string | undefined,
      latestAt: d.latest_at as string | undefined,
    };
  }
  return { code: status ? 'error' : 'offline', message: e?.message || 'Could not reach the server', status };
}

/**
 * Address of a sketch's picture (what a page shows). The version only busts the browser cache.
 * @param id - Sketch id.
 * @param version - Version to show.
 */
export function sketchPngUrl(id: string, version?: number): string {
  return `${resolveOrigin()}/sketches/${id}/png${version ? `?v=${version}` : ''}`;
}

/**
 * Address that downloads a sketch's picture or editable source.
 * @param id - Sketch id.
 * @param kind - `png` or `source`.
 */
export function sketchDownloadUrl(id: string, kind: 'png' | 'source'): string {
  return `${resolveOrigin()}/sketches/${id}/${kind}?download=true`;
}

/**
 * The markdown that places a sketch on a page: an image whose address is `sketch:<id>`.
 * @param s - The sketch (id and title).
 */
export function sketchMarkdown(s: { id: string; title: string }): string {
  return `![${s.title.replace(/[[\]\n]+/g, ' ').trim() || 'Sketch'}](sketch:${s.id})`;
}

export const sketchKeys = {
  one: (id: string) => ['sketch', id] as const,
};

/**
 * Query a sketch's details (no files).
 * @param id - Sketch id; disabled while empty.
 */
export function useSketchMeta(id: string) {
  return useQuery({
    queryKey: sketchKeys.one(id),
    queryFn: async () => (await client.get<Sketch>(`/sketches/${id}`)).data,
    enabled: !!id,
    retry: false,
    staleTime: 10_000,
  });
}

/**
 * Read a sketch's details (not through the cache: the editor needs the version as it is now).
 * @param id - Sketch id.
 */
export async function fetchSketch(id: string): Promise<Sketch> {
  return (await client.get<Sketch>(`/sketches/${id}`)).data;
}

/**
 * Fetch a sketch's editable source text for the editor.
 * @param id - Sketch id.
 */
export async function fetchSketchSource(id: string): Promise<string> {
  const res = await client.get<string>(`/sketches/${id}/source`, {
    responseType: 'text',
    transformResponse: (data: string) => data,
  });
  return res.data;
}

/** The files and details of one save. */
export interface SketchFiles {
  png: Blob;
  source: string;
  title: string;
}

function formOf(files: Partial<SketchFiles>): FormData {
  const f = new FormData();
  if (files.png) f.append('png', files.png, 'drawing.png');
  if (files.source != null) {
    f.append('source', new Blob([files.source], { type: 'application/json' }), 'drawing.sketch.json');
  }
  if (files.title != null) f.append('title', files.title);
  return f;
}

/**
 * Save a new sketch.
 * @param owner - Who owns it, and the project when the owner does not say.
 * @param files - The picture, the editable source and the title.
 */
export async function createSketch(
  owner: { ownerKind: SketchOwnerKind; ownerId: string; projectId?: string },
  files: SketchFiles,
): Promise<Sketch> {
  const f = formOf(files);
  f.append('owner_kind', owner.ownerKind);
  f.append('owner_id', owner.ownerId);
  if (owner.projectId) f.append('project_id', owner.projectId);
  return (await client.post<Sketch>('/sketches', f)).data;
}

/**
 * Save a new version of a sketch.
 * @param id - Sketch id.
 * @param baseVersion - The version the edit started from.
 * @param files - The picture, the editable source and the title.
 * @param force - Replace a newer version ("Replace theirs").
 */
export async function updateSketch(
  id: string,
  baseVersion: number,
  files: SketchFiles,
  force = false,
): Promise<Sketch> {
  const f = formOf(files);
  f.append('base_version', String(baseVersion));
  if (force) f.append('force', 'true');
  return (await client.put<Sketch>(`/sketches/${id}`, f)).data;
}

/**
 * Save the editor's state as a second sketch, leaving the first alone.
 * @param id - The sketch it started from.
 * @param files - The picture, the editable source and the title.
 */
export async function copySketch(id: string, files: SketchFiles): Promise<Sketch> {
  return (await client.post<Sketch>(`/sketches/${id}/copy`, formOf(files))).data;
}
