import type { DocsDeletedEntry, DocsPage } from './docs';

export interface DocsPageStats {
  words: number;
  linkedTickets: number;
  inboundLinks: number;
}

/** `GET /docs/pages/{id}/rename-preview?title=` */
export interface RenamePreview {
  affectedPages: { pageId: string; title: string; count: number; space?: string; path?: string[] }[];
  total: number;
}

/** `GET /docs/pages/{id}/delete-preview` */
export interface DeletePreview {
  pages: { id: string; title: string; role: 'this' | 'child' }[];
  linkingPages: number;
  /** The pages that link here (most links first, at most 5) and how many links each holds. */
  linking?: { pageId: string; title: string; parent: string | null; count: number }[];
  /** Tickets that mention or are linked to these pages. */
  linkingTickets?: number;
}

export type RenamedPage = DocsPage & { rewritten?: number };

export interface BacklinkPageRow {
  pageId: string;
  title: string;
  in: string | null;
  snippet: string;
  context?: string | null;
  /** The sentence around the reference, cut to ~120 characters, with the `[[reference]]` kept for a chip. */
  excerpt?: string | null;
  /** Section of this page the reference points at (as written), if any. */
  targetAnchor?: string | null;
  origin?: string;
  anchor?: string | null;
  section?: string | null;
  space?: string | null;
}

export interface BacklinkTicketRow {
  ticketId: string;
  title: string;
  status: string;
  origin?: TicketDocOrigin | string;
  /** Which test case, for origin 'test_case' (e.g. TC-3). */
  detail?: string;
  context?: string | null;
  excerpt?: string | null;
  targetAnchor?: string | null;
  snippet?: string | null;
  author?: string | null;
}

export interface BacklinksEx {
  pages: BacklinkPageRow[];
  tickets: BacklinkTicketRow[];
}

export type RecycleEntry = DocsDeletedEntry & {
  parentTitle?: string | null;
  parentDeleted?: boolean;
};

export type TicketDocOrigin =
  'description' | 'comment' | 'acceptance_criterion' | 'test_case' | 'debug_note' | 'page' | 'manual';

export interface TicketDocRow {
  pageId: string;
  projectId: string;
  title: string;
  path?: string[];
  section?: string | null;
  snippet?: string;
  origin?: TicketDocOrigin;
  /** Test case code (TC-3) when origin is test_case. */
  detail?: string;
  version?: number;
  /** `canvas`: the row is a canvas shown in the ticket (the layers icon); `canvasId` opens it. */
  kind?: 'canvas';
  canvasId?: string;
}

export interface DocsSuggestItem {
  kind: 'page' | 'section';
  pageId: string;
  title: string;
  /** Page title for a section hit. */
  pageTitle: string;
  path: string[];
  slug?: string;
}
