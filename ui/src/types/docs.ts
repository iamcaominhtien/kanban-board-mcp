export type DocsStatus = 'draft' | 'published';

export interface DocsTreeNode {
  id: string;
  parentId: string | null;
  position: number;
  title: string;
  slug: string;
  status: DocsStatus;
  version: number;
  hasDraft: boolean;
  updatedAt: string;
}

export interface DocsHeading {
  level: number;
  text: string;
  slug: string;
}

export interface DocsPathItem {
  id: string;
  title: string;
  slug: string;
}

export interface DocsDraft {
  title: string;
  markdown: string;
  baseVersion: number;
  updatedAt: string;
  author: string;
}

export interface DocsPage {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  slug: string;
  status: DocsStatus;
  version: number;
  markdown: string;
  headings: DocsHeading[];
  path: DocsPathItem[];
  createdBy: string;
  updatedBy: string;
  updatedAt: string;
  createdAt: string;
  hasUnpublishedChanges: boolean;
  draft: DocsDraft | null;
}

export interface DocsTemplate {
  id: string;
  name: string;
  description: string;
  markdown: string;
}

export interface DocsVersionSummary {
  version: number;
  title: string;
  author: string;
  note: string | null;
  createdAt: string;
  words: number;
}

export interface DocsVersionDetail {
  version: number;
  title: string;
  markdown: string;
  author: string;
  note: string | null;
  createdAt: string;
}

export interface DocsDiffWord {
  text: string;
  changed: boolean;
}

export interface DocsDiffRow {
  type: 'same' | 'add' | 'del';
  text: string;
  oldNo: number | null;
  newNo: number | null;
  words?: DocsDiffWord[];
}

export interface DocsDiff {
  from: number;
  to: number;
  rows: DocsDiffRow[];
  added: number;
  removed: number;
  sections: { heading: string; added: number; removed: number }[];
}

export interface DocsBacklinks {
  pages: { pageId: string; title: string; in: string | null; snippet: string }[];
  tickets: { ticketId: string; title: string; status: string }[];
}

export interface DocsDeletedEntry {
  id: string;
  title: string;
  projectId: string;
  deletedAt: string;
  deletedBy: string;
  pageCount: number;
  daysLeft: number;
}

export interface DocsTicketDoc {
  pageId: string;
  projectId: string;
  title: string;
  section: string | null;
  snippet: string;
  version: number;
}

export type DocsRefRequest =
  | { kind: 'page'; title: string; anchor?: string | null }
  | { kind: 'ticket'; key: string };

export interface DocsRefResult {
  kind: 'page' | 'ticket';
  status: 'ok' | 'missing' | 'section_missing' | 'in_bin' | 'ambiguous';
  pageId?: string;
  title?: string;
  slug?: string;
  path?: string;
  published?: boolean;
  anchor?: string;
  section?: string;
  key?: string;
  ticketStatus?: string;
}

/** Error body of a failed docs call (FastAPI wraps it in `detail`). */
export interface DocsErrorDetail {
  code: string;
  message: string;
  latestVersion?: number;
  latestAuthor?: string | null;
  latestAt?: string | null;
  deletedBy?: string;
  deletedAt?: string;
}
