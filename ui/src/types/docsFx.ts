// Types for the Docs search / import / notification features (camelCased response shapes, see the Docs v2 contract).

export type DocsSearchScope = 'space' | 'all' | 'tickets';
export type DocsSearchMode = 'headings';
export type DocsSearchSort = 'relevance' | 'edited_at';

export interface DocsSearchMatch {
  section: string;
  slug: string;
  /** HTML-escaped except for `<mark>` around hits. */
  snippet: string;
  /** The top-level block of a rich page the match sits in: a result opens the page at it. */
  blockId?: string | null;
  /** What that block is: `heading`, `text`, `table`, `image`, `code`, `callout`, `list`, `quote`… */
  kind?: string | null;
  /** A picture or video matched by its words: `caption`, `alt` (its description) or `title`. */
  field?: 'caption' | 'alt' | 'title' | null;
  /** A table match: its row, from 1 (the header row counted), and the row's cells. */
  row?: number | null;
  cells?: string[] | null;
  /** With `cards=true`: what the block's result card shows (RichDocsLinks B 7). */
  card?: DocsSearchCard | null;
}

/** What a search result card shows of a picture, video, table, code block, file or diagram. */
export interface DocsSearchCard {
  /** The block's name and what it is ("Limits", "Table · 3 columns, 4 rows"). */
  label?: string | null;
  detail?: string | null;
  src?: string | null;
  alt?: string | null;
  caption?: string | null;
  title?: string | null;
  poster?: string | null;
  description?: string | null;
  language?: string | null;
  filename?: string | null;
  /** Code: the first line that matched and the next, numbered from 1. */
  lines?: { n: number; text: string }[];
  name?: string | null;
  size?: number | null;
  mime?: string | null;
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

/** The search page's Type filter: what a match sits in. */
export type DocsMatchType = 'page' | 'image' | 'table' | 'file' | 'code' | 'diagram';

export interface DocsSearchFacets {
  authors?: { name: string; count: number }[];
  under?: { pageId: string; title: string; count: number }[];
  edited?: Partial<Record<'any' | 'day' | 'week' | 'month', number>>;
  status?: { name: string; count: number }[];
  /** Pages per type of match (`facets=kinds`): `page`, `image`, `table`, `file`, `code`, `diagram`. */
  kinds?: { name: DocsMatchType; count: number }[];
  /** Pages that may be outdated (`facets=outdated`). */
  outdated?: number;
  /** Results per project, largest first (`facets=projects`, scope all). */
  projects?: { projectId: string; name: string; count: number }[];
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
  /** Only matches of these types (the Type filter). */
  kinds?: DocsMatchType[];
  /** Count pages per type of match (`facets.kinds`). */
  kindFacets?: boolean;
  /** Count the pages that may be outdated (`facets.outdated`). */
  outdatedFacet?: boolean;
  /** Count the results per project (`facets.projects`). */
  projectFacets?: boolean;
  /** Give the matches of pictures, tables, code, files and diagrams their card (`card`). */
  cards?: boolean;
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
