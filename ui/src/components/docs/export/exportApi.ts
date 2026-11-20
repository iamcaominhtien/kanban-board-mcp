/**
 * The export endpoints (`/projects/{id}/docs/exports`, `/docs/exports/{id}`): start, follow, cancel, remove, list
 * and download. Downloads go through the app's client (its headers, its origin) and are saved from a blob.
 */

import { useQuery } from '@tanstack/react-query';
import { client } from '../../../api/client';
import { resolveOrigin } from '../../../api/resolveOrigin';
import type { ExportBody, ExportFormat, ExportScope } from './exportModel';

/** Where an export stands. */
export type ExportState = 'running' | 'ready' | 'failed' | 'cancelled' | 'expired';

/** An export as the server lists it. */
export interface ExportRow {
  id: string;
  projectId: string;
  pageId: string | null;
  scope: ExportScope;
  format: ExportFormat;
  state: ExportState;
  /** What it is doing now (running) or where it stopped (failed). */
  step: string | null;
  fileName: string | null;
  /** Bytes, once ready. */
  size: number | null;
  error: string | null;
  createdBy: string;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  /** The download address while the file is kept; null otherwise. */
  download: string | null;
}

export const exportKeys = {
  history: (projectId: string) => ['docs', 'exports', projectId] as const,
};

/** The options and the book travel with their own key names (`pageSize`, `coverImage`). */
const RAW = { rawKeys: ['options', 'book'] } as const;

/**
 * Starts an export; it runs in the background.
 * @param projectId - The project.
 * @param body - What to export and how.
 * @returns The export, `running`.
 * @throws The request's error: 409 `export_running`, 413 `export_too_big` (`size`, `limit`), 422 `empty_page` or
 *   `bad_export`.
 */
export async function startExport(projectId: string, body: ExportBody): Promise<ExportRow> {
  const row = (await client.post<ExportRow>(`/projects/${projectId}/docs/exports`, body, RAW)).data;
  rememberRequest(row.id, body);
  return row;
}

/** One export as it stands now. */
export async function fetchExport(id: string): Promise<ExportRow> {
  return (await client.get<ExportRow>(`/docs/exports/${id}`)).data;
}

/** Cancels a running export ("Cancel export", "Stop"). */
export async function cancelExport(id: string): Promise<ExportRow> {
  return (await client.post<ExportRow>(`/docs/exports/${id}/cancel`)).data;
}

/** Removes an export and its file ("Delete the file"; the pages are not touched). */
export async function deleteExport(id: string): Promise<void> {
  await client.delete(`/docs/exports/${id}`);
}

/**
 * The caller's last 20 exports in a project.
 * @param projectId - The project.
 * @param enabled - Fetch only while the history is shown.
 */
export function useExportHistory(projectId: string, enabled = true) {
  return useQuery({
    queryKey: exportKeys.history(projectId),
    queryFn: async () => (await client.get<ExportRow[]>(`/projects/${projectId}/docs/exports`)).data,
    enabled: enabled && !!projectId,
    refetchInterval: (q) => (q.state.data?.some((r) => r.state === 'running') ? 3000 : false),
  });
}

/** The file of a ready export, fetched with the app's headers. */
async function fileOf(row: Pick<ExportRow, 'id' | 'download'>): Promise<Blob> {
  const url = row.download ?? `/docs/exports/${row.id}/download`;
  return (await client.get<Blob>(url, { responseType: 'blob', keepKeys: true })).data;
}

/**
 * Saves a blob as a file, the way a download link would.
 * @param blob - The bytes.
 * @param name - The file name offered to the browser.
 */
export function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Downloads a ready export. */
export async function downloadExport(row: Pick<ExportRow, 'id' | 'download' | 'fileName'>): Promise<void> {
  saveBlob(await fileOf(row), row.fileName || 'export');
}

/** Opens a ready PDF or HTML export in a new tab. */
export async function openExportFile(row: Pick<ExportRow, 'id' | 'download' | 'format'>): Promise<void> {
  const blob = await fileOf(row);
  const type = row.format === 'pdf' ? 'application/pdf' : 'text/html';
  const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type }));
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The full address of an export's file ("Copy link"). */
export function exportLink(row: Pick<ExportRow, 'id' | 'download'>): string {
  return `${resolveOrigin()}${row.download ?? `/docs/exports/${row.id}/download`}`;
}

const REQUESTS_KEY = 'docsExportRequests';

function readRequests(): Record<string, ExportBody> {
  try {
    return JSON.parse(localStorage.getItem(REQUESTS_KEY) || '{}') as Record<string, ExportBody>;
  } catch {
    return {};
  }
}

/** Keeps what an export asked for, so "Export again with the same options" can send it again (the last 20). */
function rememberRequest(id: string, body: ExportBody): void {
  try {
    const all = readRequests();
    all[id] = body;
    const ids = Object.keys(all);
    for (const old of ids.slice(0, Math.max(0, ids.length - 20))) delete all[old];
    localStorage.setItem(REQUESTS_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked */
  }
}

/** What an export asked for, when this device started it; null otherwise. */
export function requestOf(id: string): ExportBody | null {
  return readRequests()[id] ?? null;
}
