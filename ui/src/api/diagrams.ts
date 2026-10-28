import { useQuery } from '@tanstack/react-query';
import { client } from './client';
import { resolveOrigin } from './resolveOrigin';

/** A saved draw.io diagram as the API returns it (the `.drawio` source only comes with `source=true`). */
export interface Diagram {
  id: string;
  projectId: string;
  label: string;
  summary: string;
  suggestedSummary?: string;
  itemKind: 'ticket' | 'comment' | 'doc' | null;
  itemId: string | null;
  version: number;
  shownVersion: number;
  empty: boolean;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  deletedAt: string | null;
  sizeBytes: number;
  role: 'viewer' | 'member' | 'admin';
  canEdit: boolean;
  source?: string;
}

export interface DiagramSettings {
  mode: 'self-hosted' | 'public';
  url: string;
  effectiveUrl: string;
  defaultSelfHostedUrl: string;
  publicUrl: string;
  sendsDrawingsToThirdParty: boolean;
}

export interface DiagramPayload {
  label: string;
  source: string;
  svg: string;
  summary?: string;
  itemKind?: 'ticket' | 'comment' | 'doc';
  itemId?: string;
}

/** What a failed diagram call says: the server's `{code, message}` or a generic message. */
export interface DiagramFailure {
  code: string;
  message: string;
  status: number;
  latestVersion?: number;
  latestAuthor?: string;
  latestAt?: string;
  sizeBytes?: number;
  limitBytes?: number;
}

/**
 * Read the server's diagram error out of an Axios error.
 * @param err - The thrown value.
 */
export function diagramFailure(err: unknown): DiagramFailure {
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
      sizeBytes: d.size_bytes as number | undefined,
      limitBytes: d.limit_bytes as number | undefined,
    };
  }
  return { code: status ? 'error' : 'offline', message: e?.message || 'Could not reach the server', status };
}

/**
 * URL of a diagram's SVG preview (what the page shows).
 * @param id - Diagram id.
 * @param version - Version to show; the cache key too.
 */
export function diagramSvgUrl(id: string, version?: number): string {
  return `${resolveOrigin()}/diagrams/${id}/svg${version ? `?version=${version}` : ''}`;
}

/**
 * URL that downloads a diagram as `.drawio` or `.svg`.
 * @param id - Diagram id.
 * @param format - File format.
 * @param version - Version to download; latest by default.
 */
export function diagramDownloadUrl(id: string, format: 'drawio' | 'svg', version?: number): string {
  return `${resolveOrigin()}/diagrams/${id}/download?format=${format}${version ? `&version=${version}` : ''}`;
}

/**
 * The markdown line that places a diagram on a page.
 * @param d - The diagram (id and label).
 */
export function diagramMarkdown(d: { id: string; label: string }): string {
  return `[${d.label.replace(/[[\]\n]+/g, ' ').trim() || 'Diagram'}](diagram:${d.id})`;
}

export const diagramKeys = {
  one: (id: string, version?: number) => ['diagram', id, version ?? 'latest'] as const,
  settings: ['diagram-settings'] as const,
};

/**
 * Query a diagram's details (no source).
 * @param id - Diagram id; disabled while empty.
 * @param version - Pinned version to show (a Docs history view).
 */
export function useDiagram(id: string, version?: number) {
  return useQuery({
    queryKey: diagramKeys.one(id, version),
    queryFn: async () =>
      (await client.get<Diagram>(`/diagrams/${id}`, { params: version ? { version } : undefined })).data,
    enabled: !!id,
    retry: false,
    staleTime: 10_000,
  });
}

/** Query where the draw.io editor runs. */
export function useDiagramSettings() {
  return useQuery({
    queryKey: diagramKeys.settings,
    queryFn: async () => (await client.get<DiagramSettings>('/diagrams/settings')).data,
    staleTime: 60_000,
  });
}

/**
 * Fetch a diagram with its `.drawio` source for the editor.
 * @param id - Diagram id.
 * @param version - Version to load; latest by default.
 */
export async function fetchDiagramWithSource(id: string, version?: number): Promise<Diagram> {
  return (await client.get<Diagram>(`/diagrams/${id}`, { params: { source: true, ...(version ? { version } : {}) } }))
    .data;
}

/**
 * Save a new diagram.
 * @param projectId - Project it belongs to.
 * @param body - Label, source, SVG preview and optional summary / item.
 */
export async function createDiagram(projectId: string, body: DiagramPayload): Promise<Diagram> {
  return (await client.post<Diagram>(`/projects/${projectId}/diagrams`, body)).data;
}

/**
 * Save a new version of a diagram.
 * @param id - Diagram id.
 * @param body - The new content plus the version the edit started from.
 */
export async function updateDiagram(
  id: string,
  body: { baseVersion: number; source: string; svg: string; label?: string; summary?: string },
): Promise<Diagram> {
  return (await client.put<Diagram>(`/diagrams/${id}`, body)).data;
}

/**
 * Save where the draw.io editor runs (admin only).
 * @param body - `self-hosted` with an address, or `public`.
 */
export async function saveDiagramSettings(body: { mode: string; url: string }): Promise<DiagramSettings> {
  return (await client.put<DiagramSettings>('/diagrams/settings', body)).data;
}
