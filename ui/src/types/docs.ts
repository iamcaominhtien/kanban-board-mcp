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
  /** Hidden from every AI (a lock in the tree) */
  aiHidden?: boolean;
  /** Read by every AI run in the project (a small icon in the tree) */
  aiGuidance?: boolean;
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
  /** Set on a draft an AI wrote: where it came from and what it could not find */
  aiSource?: DocsAiSource | null;
}

/** "Drafted with AI": the sources a draft was written from and the gaps it left. */
export interface DocsAiSource {
  kind: string;
  from?: string;
  memberId?: string;
  gaps?: string[];
  sources?: { n: number; label: string; quote?: string }[];
  accepted?: boolean;
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
  aiHidden?: boolean;
  aiGuidance?: boolean;
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
  /** The author accepted AI text in this version (History marks it; the page itself is never stamped) */
  withAi?: boolean;
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
  /** titles of the pages directly under it that were deleted with it */
  childTitles?: string[];
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
  /** docs_disabled: the caller's role, so non-admins are told to ask an admin. */
  role?: string;
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
  /** Set on an AI member's reply (Docs AI). */
  ai?: DocsCommentAi | null;
}

/** What an AI member's reply in a thread carries: its job, cost, sources and whether it can offer an edit. */
export interface DocsCommentAi {
  memberId: string;
  jobId?: string;
  cost?: number;
  sources?: { pageId: string; title: string; heading: string | null }[];
  /** The answer says something on the page is wrong or out of date: "Suggest an edit" is offered. */
  canSuggest?: boolean;
  /** `note` (paused, over budget, hidden page), `error` (couldn't answer), `proposal` (Suggest an edit made one). */
  kind?: 'note' | 'error' | 'proposal';
  code?: string;
  proposalId?: string;
  problems?: string[];
}

/** AI work going on in a thread (the "thinking" placeholder). */
export interface DocsThreadAiJob {
  id: string;
  kind: 'thread_reply' | 'suggest_edit' | 'thread_summary';
  state: 'queued' | 'running';
  memberId: string | null;
  memberName: string;
  step: string | null;
}

/** The summary of a long thread, shown above the replies (it does not resolve the thread). */
export interface DocsThreadSummary {
  text: string;
  count: number;
  cost: number;
  jobId: string;
  memberName: string;
  at: string | null;
}

/** A member in the comments payload; AI members carry their status for the @ picker while Docs AI is on. */
export interface DocsCommentMember {
  id: string;
  name: string;
  color: string;
  role: CommentRole;
  kind?: 'human' | 'ai';
  ai?: {
    status: 'ready' | 'paused' | 'over_budget' | 'unavailable';
    usable: boolean;
    note: string;
    provider: string | null;
  };
}

/** What happened to each AI member mentioned in a comment just posted. */
export interface DocsAiDelivery {
  memberId?: string;
  result: 'job' | 'notified' | 'refused' | 'not_delivered';
  jobId?: string;
  reason?: string;
  code?: string;
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
  /** Docs AI: work going on in the thread, and the latest summary. */
  aiJobs?: DocsThreadAiJob[];
  aiSummary?: DocsThreadSummary | null;
  /** Only on the response to a new comment: what happened to the AI members it mentions. */
  aiDelivery?: DocsAiDelivery[];
}

export interface DocsCommentsResult {
  threads: DocsCommentThread[];
  counts: { all: number; open: number; resolved: number; orphaned: number; page: number };
  role: CommentRole;
  me: string;
  members: DocsCommentMember[];
  /** Docs AI is on for the project (AI members can be asked in threads). */
  docsAi?: boolean;
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
  /** Null for an access request. */
  pageId: string | null;
  pageTitle: string;
  threadId: string | null;
  commentId: string | null;
  kind: 'comment' | 'reply' | 'resolved' | 'reopened' | 'access_request';
  actor: string;
  mentioned: string[];
  recipients: string[];
  snippet: string;
  createdAt: string;
}
