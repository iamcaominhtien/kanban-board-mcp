import type { JSONContent } from '@tiptap/core';

export type DocsStatus = 'draft' | 'published';

/**
 * How a page's text is stored: `rich` is the TipTap JSON of Rich Docs format 1 (server/contract/richdoc), `md` the
 * Markdown of before (a page not converted yet, or one whose conversion failed).
 */
export type DocsFormat = 'rich' | 'md';

/** Where the conversion of a Markdown page to the rich format stands (`null`: nothing to convert). */
export type DocsConvertState = 'waiting' | 'working' | 'done' | 'failed';

/** A rich page: a TipTap JSON document (`{type: 'doc', content: [...]}`) with a `blockId` on every block. */
export type RichDoc = JSONContent;

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
  /** `canvas` pages open the Canvas editor instead of the text editor (the layers icon in the tree) */
  kind?: 'page' | 'canvas';
  /** Where the page's conversion to the rich format stands (null or missing: nothing to convert). */
  convertState?: DocsConvertState | null;
  /** The page's `book` setting: a book holds its chapters (its child pages). */
  book?: { isBook?: boolean; numberChapters?: boolean } | null;
  /** The page's `status` setting (`outdated`, `in-review`…), when it has one. */
  pageStatus?: string | null;
  /** The address of the page's cover picture, when it has one. */
  cover?: string | null;
  /** AI suggestions waiting on the page (the tree's ✦ marker). */
  suggestions?: number;
  /** The page's `icon` setting: an emoji, `icon:<name>` or an uploaded picture (`/uploads/...`). */
  icon?: string | null;
  /** Who made the page and who edited it last, when the server sends them ("My pages"). */
  createdBy?: string | null;
  updatedBy?: string | null;
  /** The page's `notForAi` setting, when the server sends it (Settings › Docs counts them). */
  notForAi?: boolean;
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
  /** The plain-Markdown projection of `content` (a rich draft), or the draft itself (an `md` one). */
  markdown: string;
  /** `rich` when `content` holds the draft (missing on a server or a saved copy from before Rich Docs: `md`). */
  format?: DocsFormat;
  /** The draft as rich JSON; null when `format` is `md`. */
  content?: RichDoc | null;
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
  /** `canvas` pages open the Canvas editor instead of the text editor */
  kind?: 'page' | 'canvas';
  projectId: string;
  parentId: string | null;
  title: string;
  slug: string;
  /** The share link's path from the current titles (`architecture/api`, AC-4); null when another page has the same. */
  slugPath?: string | null;
  status: DocsStatus;
  version: number;
  /** The plain-Markdown projection of `content` (a rich page), or the page itself (an `md` one). */
  markdown: string;
  /** `rich` when `content` holds the published page (missing on a server or a saved copy from before Rich Docs). */
  format?: DocsFormat;
  /** The published page as rich JSON; null when `format` is `md`. */
  content?: RichDoc | null;
  /** Page settings (server/contract/richdoc/page-settings.json); a missing key is its default. */
  settings?: Record<string, unknown>;
  /** The conversion to the rich format: waiting / working (not editable yet), done, failed (kept read-only). */
  convertState?: DocsConvertState | null;
  /** Why the conversion failed, when `convertState` is `failed`. */
  convertError?: string | null;
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
  /** The author accepted AI text in this version (History marks it; the page itself is never stamped) */
  withAi?: boolean;
}

export interface DocsVersionDetail {
  version: number;
  title: string;
  markdown: string;
  /** `rich` for a version saved in the rich format; versions from before it stay `md` (content null). */
  format?: DocsFormat;
  content?: RichDoc | null;
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

/** A reference to resolve; `bySlug` (from a Markdown link) also matches a page's slug, the slug of its title, or its id. */
export type DocsRefRequest =
  { kind: 'page'; title: string; anchor?: string | null; bySlug?: boolean } | { kind: 'ticket'; key: string };

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
  /** The block it is on (rich pages): an image, a table or an embed can be commented on as a whole. */
  blockId?: string | null;
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
  /** `note` (the team is paused), `error` (couldn't answer). */
  /** `sent`: the board's line that the thread was sent to an AI on a ticket (not a comment of the person's). */
  kind?: 'note' | 'error' | 'sent' | 'ticket';
  /** `ticket`/`sent`: the ticket whose conversation the AI answers from. */
  ticketId?: string;
  code?: string;
  problems?: string[];
}

/** AI work going on in a thread (the "thinking" placeholder). */
export interface DocsThreadAiJob {
  id: string;
  kind: 'thread_reply' | 'thread_summary';
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
    status: 'ready' | 'paused' | 'unavailable';
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
  /** The block it is in (rich pages; sent as `block_id`). */
  blockId?: string;
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
