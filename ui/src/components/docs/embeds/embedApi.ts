/**
 * What the Docs embeds read from the server (design "Embeds and attachments"): the project's Docs settings (upload
 * limits, scripts in HTML embeds, the sites that may be embedded), uploads to the project (`POST
 * /projects/{id}/docs/uploads`, with progress and the server's refusals mapped to what the card says), the preview
 * of a link (`/docs/link-preview`) and of a file (`/docs/file-preview`).
 */

import { useQuery } from '@tanstack/react-query';
import { client } from '../../../api/client';

/** The project's Docs settings, as far as embeds use them (`GET /projects/{id}/docs/settings`). */
export interface DocsSpaceSettings {
  uploads?: { imageMb?: number; videoMb?: number; fileMb?: number };
  /** `ask`: a reader presses "Run it" first; `off`: scripts in HTML embeds never run. */
  scriptsInEmbeds?: 'ask' | 'off';
  /** The hosts whose links may be shown inside a page (a player), e.g. `youtube.com`. */
  embedSites?: string[];
}

/** What an upload is for: it picks the limit and the types the server accepts. */
export type UploadKind = 'image' | 'video' | 'file';

/** The limits (MB) the design sets when the project has none. */
export const DEFAULT_LIMITS_MB: Record<UploadKind, number> = { image: 10, video: 200, file: 100 };

/** The query key of the project's Docs settings (shared with the block layer's image limit). */
export const spaceSettingsKey = (projectId: string) => ['docs', 'space-settings', projectId] as const;

/**
 * The project's Docs settings; `data` stays undefined while unknown (no project, loading, or the call failed).
 * @param projectId - The project; empty switches the query off.
 */
export function useDocsSpaceSettings(projectId: string | null | undefined) {
  return useQuery({
    queryKey: spaceSettingsKey(projectId ?? ''),
    queryFn: async () => (await client.get<DocsSpaceSettings>(`/projects/${projectId}/docs/settings`)).data,
    enabled: !!projectId,
    staleTime: 60_000,
    retry: false,
  });
}

/** The upload limit in MB for `kind`, from the settings (the design's default when unset). */
export function uploadLimitMb(settings: DocsSpaceSettings | undefined, kind: UploadKind): number {
  const v = settings?.uploads?.[`${kind}Mb` as const];
  return typeof v === 'number' && v > 0 ? v : DEFAULT_LIMITS_MB[kind];
}

/** A stored upload, as `POST /projects/{id}/docs/uploads` answers. */
export interface DocsUpload {
  /** `/uploads/<stored name>`. */
  src: string;
  name: string;
  size: number;
  mime: string;
  kind: UploadKind;
}

/** Options of {@link uploadDocsFile}. */
export interface UploadOptions {
  signal?: AbortSignal;
  /** Called with the bytes sent so far and the total. */
  onProgress?: (loaded: number, total: number) => void;
}

/**
 * Sends a file to the project's Docs uploads (scanned for viruses by the server before it is kept).
 * @param projectId - The project the file belongs to.
 * @param file - The file.
 * @param kind - What it is for (`image`, `video` or `file`): the server checks the limit and type for it.
 * @returns The stored upload.
 * @throws The request's error; {@link uploadProblem} says what it means.
 */
export async function uploadDocsFile(
  projectId: string,
  file: File,
  kind: UploadKind,
  opts: UploadOptions = {},
): Promise<DocsUpload> {
  const form = new FormData();
  // the kind first, so the server applies its limit while it reads the file
  form.append('kind', kind);
  form.append('file', file);
  const res = await client.post<DocsUpload>(`/projects/${projectId}/docs/uploads`, form, {
    signal: opts.signal,
    onUploadProgress: (e) => opts.onProgress?.(e.loaded, e.total ?? file.size),
  });
  return res.data;
}

/** Why an upload did not end on the page, in the words of the file card (frames 45-47, 74). */
export interface UploadProblem {
  code: 'too_large' | 'type_not_allowed' | 'virus_found' | 'scan_failed' | 'failed';
  /** One or two words ("Too large", "Blocked", "Not added"). */
  title: string;
  /** The sentence under it. */
  text: string;
  /** The limit in MB (too large). */
  limitMb?: number;
}

const WHAT: Record<UploadKind, string> = { image: 'An image', video: 'A video', file: 'A file' };

/** "A file can be 100 MB at most." */
export function limitSentence(kind: UploadKind, limitMb: number): string {
  return `${WHAT[kind]} can be ${limitMb} MB at most.`;
}

/**
 * What a failed upload means for the person who sent it.
 * @param err - What {@link uploadDocsFile} threw.
 * @param kind - What the file was for.
 * @param limitMb - The limit the page knows, used when the server does not say.
 */
export function uploadProblem(err: unknown, kind: UploadKind, limitMb: number): UploadProblem {
  const e = err as { response?: { status?: number; data?: { detail?: unknown } } };
  const status = e?.response?.status;
  const raw = e?.response?.data?.detail;
  const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const code = typeof d.code === 'string' ? d.code : '';
  const message = typeof d.message === 'string' ? d.message : '';
  if (status === 413 || code === 'too_large') {
    const lim = Number(d.limit_mb ?? d.limitMb);
    const mb = Number.isFinite(lim) && lim > 0 ? lim : limitMb;
    return { code: 'too_large', title: 'Too large', text: `Too large. ${limitSentence(kind, mb)}`, limitMb: mb };
  }
  if (status === 415 || code === 'type_not_allowed') {
    return {
      code: 'type_not_allowed',
      title: 'Blocked',
      text: `Blocked. ${message || 'Programs and scripts (.exe, .bat, .sh, .js and similar) cannot be attached.'}`,
    };
  }
  if (code === 'virus_found') {
    return {
      code: 'virus_found',
      title: 'Not added',
      text: 'Not added. The scan found a virus in this file. Nothing was uploaded.',
    };
  }
  if (status === 503 || code === 'scan_failed') {
    return {
      code: 'scan_failed',
      title: 'Not added',
      text: message || 'The virus scan could not run, so the file was not added. Try again later.',
    };
  }
  return { code: 'failed', title: 'Upload failed', text: 'The file did not reach the server. Try again.' };
}

/** What `/docs/link-preview` says about a link (keys camelCased by the client). */
export interface LinkPreview {
  url: string;
  title?: string | null;
  description?: string | null;
  image?: string | null;
  site?: string | null;
  /** The site is on the project's list of sites that may be embedded. */
  embeddable?: boolean;
  /** `video` when the link is a player (YouTube, Vimeo, Loom). */
  kind?: 'video' | 'link';
  embedUrl?: string | null;
  provider?: string | null;
  /** Set when the link could not be read: `refused` (not a public web address) or `could_not_read`. */
  error?: 'refused' | 'could_not_read' | string;
}

/**
 * Reads a link's title, picture and whether it can be embedded.
 * @param url - The address.
 * @param projectId - The project whose embeddable sites apply.
 */
export async function fetchLinkPreview(url: string, projectId?: string | null): Promise<LinkPreview> {
  const params: Record<string, string> = { url };
  if (projectId) params.project_id = projectId;
  return (await client.get<LinkPreview>('/docs/link-preview', { params })).data;
}

/**
 * The preview of a link, read once per address.
 * @param url - The address; empty switches the query off.
 * @param projectId - The project whose embeddable sites apply.
 */
export function useLinkPreview(url: string | null | undefined, projectId?: string | null) {
  return useQuery({
    queryKey: ['docs', 'link-preview', projectId ?? '', url ?? ''],
    queryFn: () => fetchLinkPreview(url ?? '', projectId),
    enabled: !!url,
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** One sheet of a spreadsheet preview: its first rows and how many it has. */
export interface SheetPreview {
  name: string;
  rows: string[][];
  totalRows: number;
}

/** What `/docs/file-preview` answers. */
export type FilePreviewData =
  | { kind: 'pdf' }
  | { kind: 'word'; blocks: { type: 'heading' | 'paragraph'; level?: number; text: string }[] }
  | { kind: 'sheet'; sheets: SheetPreview[] }
  | { kind: 'none'; reason?: string };

/** The relative `/uploads/...` path of a stored file, or null for any other address. */
export function uploadPath(src: string): string | null {
  const at = src.indexOf('/uploads/');
  if (at < 0) return null;
  // a full address of this board, or the path itself
  return at === 0 || /^https?:\/\/[^/]+\/uploads\//.test(src) ? src.slice(at) : null;
}

/**
 * The inline preview of a stored file (PDF, Word, Excel, CSV).
 * @param src - The file's address; only `/uploads/...` files have one.
 * @param enabled - False while the preview is folded.
 */
export function useFilePreview(src: string, enabled: boolean) {
  const path = uploadPath(src);
  return useQuery({
    queryKey: ['docs', 'file-preview', path ?? ''],
    queryFn: async () => (await client.get<FilePreviewData>('/docs/file-preview', { params: { src: path } })).data,
    enabled: enabled && !!path,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** True when `url`'s host is `site` or one of its subdomains. */
function onSite(host: string, site: string): boolean {
  const s = site.toLowerCase().replace(/^www\./, '');
  return host === s || host.endsWith(`.${s}`);
}

/**
 * Whether a link's site may be shown inside a page (the project's list; the design's list when unknown).
 * @param url - The link.
 * @param sites - `embedSites` of the Docs settings.
 */
export function siteAllowed(url: string, sites: string[] | undefined): boolean {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }
  const list = sites ?? ['youtube.com', 'youtu.be', 'vimeo.com', 'loom.com'];
  return list.some((s) => typeof s === 'string' && onSite(host, s));
}
