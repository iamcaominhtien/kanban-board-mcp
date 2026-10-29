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
  /** autosaves since the draft was started */
  saves: number;
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

export type DocsRefRequest = { kind: 'page'; title: string; anchor?: string | null } | { kind: 'ticket'; key: string };

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
  /** Set when status is in_bin. */
  deletedAt?: string | null;
  deletedBy?: string | null;
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

export type CommentRole = 'viewer' | 'member' | 'admin';

export interface DocsAnchor {
  quote: string | null;
  prefix: string;
  suffix: string;
  section: string | null;
  state: 'attached' | 'orphaned';
  pos: number | null;
}

export interface DocsCommentItem {
  id: string;
  threadId: string;
  author: string;
  body: string;
  mentions: { id: string; name: string }[];
  createdAt: string;
  editedAt: string | null;
  canEdit: boolean;
  canDelete: boolean;
}

export interface DocsCommentThread {
  id: string;
  pageId: string;
  kind: 'inline' | 'page';
  status: 'open' | 'resolved';
  /** Number shown on the highlight; only open, attached inline threads have one. */
  number: number | null;
  anchor: DocsAnchor | null;
  createdBy: string;
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  unread: boolean;
  comments: DocsCommentItem[];
  canReply: boolean;
  canResolve: boolean;
}

export interface DocsCommentsResult {
  threads: DocsCommentThread[];
  counts: { all: number; open: number; resolved: number; orphaned: number; page: number };
  role: CommentRole;
  me: string;
  members: { id: string; name: string; color: string; role: CommentRole }[];
}

/** The selected text a comment is attached to. */
export interface CommentAnchorInput {
  quote: string;
  prefix: string;
  suffix: string;
  section: string | null;
}

export interface DocsCommentEvent {
  id: string;
  pageId: string;
  pageTitle: string;
  threadId: string | null;
  commentId: string | null;
  kind: 'comment' | 'reply' | 'resolved' | 'reopened';
  actor: string;
  mentioned: string[];
  recipients: string[];
  snippet: string;
  createdAt: string;
}
