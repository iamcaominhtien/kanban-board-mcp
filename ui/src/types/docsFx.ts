// Types for the Docs search / import / notification features (camelCased response shapes, see the Docs v2 contract).

export type DocsSearchScope = 'space' | 'all' | 'tickets';
export type DocsSearchMode = 'headings';
export type DocsSearchSort = 'relevance' | 'edited_at';

export interface DocsSearchMatch {
  section: string;
  slug: string;
  /** HTML-escaped except for `<mark>` around hits. */
  snippet: string;
}

export interface DocsSearchPage {
  pageId: string;
  projectId: string;
  projectName: string;
  title: string;
  path: string[];
  status: 'draft' | 'published';
  version: number;
  updatedAt: string;
  updatedBy: string;
  matches: DocsSearchMatch[];
  /** Optional extras the full results page shows when the server sends them. */
  tickets?: { ticketId: string; status: string }[];
  mentions?: number;
}

export interface DocsSearchTicket {
  ticketId: string;
  title: string;
  status: string;
  snippet?: string;
  assignee?: string | null;
}

export interface DocsSearchFacets {
  authors?: { name: string; count: number }[];
  under?: { pageId: string; title: string; count: number }[];
  edited?: Partial<Record<'any' | 'day' | 'week' | 'month', number>>;
  status?: Partial<Record<'published' | 'draft', number>>;
  [key: string]: unknown;
}

export interface DocsSearchResponse {
  total: number;
  tookMs: number;
  pages: DocsSearchPage[];
  tickets: DocsSearchTicket[];
  suggestion: string | null;
  facets?: DocsSearchFacets;
  /** Total number of matching places (sections), when the server reports it. */
  matchCount?: number;
}

export interface DocsSearchParams {
  q: string;
  scope?: DocsSearchScope;
  mode?: DocsSearchMode;
  pageId?: string | null;
  limit?: number;
  offset?: number;
  author?: string[];
  editedSince?: string | null;
  underPage?: string | null;
  hasTickets?: boolean;
  status?: string[];
  sort?: DocsSearchSort;
}

// ─── Import ───────────────────────────────────────────────────────────────────

export type DocsImportConflict = 'copy' | 'skip';

export interface DocsImportDryFile {
  path: string;
  pagePath: string[] | null;
  title: string | null;
  status: 'ok' | 'warning' | 'error';
  linksResolved: number;
  linksUnresolved: string[];
  message: string | null;
}

export interface DocsImportDryRun {
  files: DocsImportDryFile[];
  pages: number;
  linksResolved: number;
  linksUnresolvedTotal: number;
  skipped: number;
  bytes: number;
}

export interface DocsImportResult {
  created: { path: string; pageId: string; title: string }[];
  failed: { path: string; message: string }[];
}

/** A file picked/dropped for import with its relative path (folder structure). */
export interface DocsImportEntry {
  file: File;
  path: string;
}

// ─── Notifications ────────────────────────────────────────────────────────────

export interface DocsPublishedEvent {
  type: 'docs_published';
  projectId: string;
  pageId: string;
  title: string;
  version: number;
  author: string;
  note?: string | null;
}
