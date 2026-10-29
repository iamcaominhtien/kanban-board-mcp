import type { AiProvider, AiStatus } from './ai';

export type AssistScope = 'ticket' | 'project' | 'all' | 'doc';
export type FeatureKey = 'chat' | 'drafting' | 'split' | 'test_cases' | 'health' | 'docs';

export interface AssistFeature {
  key: FeatureKey;
  label: string;
  description: string;
  on: boolean;
  costMonth: number;
}

export interface HealthConfig {
  time: string;
  days: number[];
  stuckDays: number;
  wipLimit: number;
  maxInsights: number;
  returnIfWorse: boolean;
  weekend: boolean;
  badgeToast: boolean;
  offerDraft: boolean;
}

export interface AssistState {
  boardAi: {
    state: 'ready' | 'not_configured' | 'unavailable';
    id: string | null;
    name: string | null;
    provider: AiProvider | null;
    providerLabel: string | null;
    connection: 'local' | 'api_key' | 'inbox' | null;
    metered: boolean;
    status: AiStatus | null;
  };
  features: AssistFeature[];
  language: string;
  tone: 'neutral' | 'friendly' | 'concise';
  styleGuide: string;
  styleGuideMax: number;
  dataScope: { projectId: string; name: string; shared: boolean; docs: number; sharedDocs: number }[];
  excludedDocs: { id: string; title: string; projectId: string }[];
  monthlyCap: number | null;
  perRequestCap: number | null;
  overCap: 'pause' | 'warn';
  usedMonth: number;
  resets: string;
  health: HealthConfig;
  sent: Record<string, boolean>;
  unseenInsights: number;
  lastCheck: string | null;
  ticketCount: number;
  overBudget: boolean;
}

export interface AssistErrorBody {
  detail: string;
  code: string;
  [key: string]: unknown;
}

export interface ContextSummary {
  label: string;
  tickets: number;
  docs: number;
  comments: number;
  items: { kind: 'ticket' | 'doc'; id: string; title: string }[];
  truncated: { sent: number; total: number; dropped: string[]; note: string } | null;
  injections: { source: string; ticketId?: string; docId?: string; author?: string; quote: string }[];
  privateSkipped: { id: string; title: string }[];
  tokens: number;
  scope?: AssistScope;
}

export type MessageState =
  'queued' | 'thinking' | 'streaming' | 'done' | 'stopped' | 'error' | 'rate_limited' | 'over_budget';

export interface ChatMessage {
  /** The asker's thumbs up / down on an answer, kept on the server. */
  feedback?: { thumb: 'up' | 'down'; reason: string; at: string } | null;
  id: string;
  chatId: string;
  role: 'user' | 'ai';
  text: string;
  state: MessageState;
  steps: { text: string; at: string }[];
  context: Partial<ContextSummary>;
  actions: { label: string; request: string }[];
  draftId: string | null;
  draft?: AssistDraft | null;
  error: {
    code?: string;
    message?: string;
    status?: number;
    provider?: string;
    problems?: string[];
    [k: string]: unknown;
  };
  retryAt: string | null;
  memberId: string | null;
  model: string | null;
  cost: number;
  tokensIn: number;
  tokensOut: number;
  metered: boolean;
  createdAt: string;
  finishedAt: string | null;
  elapsedS?: number;
}

export interface Chat {
  id: string;
  projectId: string;
  owner: string;
  title: string;
  scope: AssistScope;
  ticketId: string | null;
  docId: string | null;
  includeDocs: string[];
  cost: number;
  tokens: number;
  applied: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatDetail extends Chat {
  messages: ChatMessage[];
  drafts: AssistDraft[];
}

export type DraftKind =
  | 'changes'
  | 'ticket'
  | 'description'
  | 'split'
  | 'test_cases'
  | 'doc_summary'
  | 'doc_section'
  | 'doc_links'
  | 'doc_text'
  | 'nudge'
  | 'assignee';

export interface DraftChange {
  op: 'status' | 'priority' | 'assignee' | 'due_date' | 'estimate' | 'title' | 'comment';
  ticket: string;
  from?: unknown;
  to?: unknown;
  text?: string;
  fromName?: string | null;
  toName?: string | null;
}

export interface SimilarTicket {
  id: string;
  title: string;
  status: string;
  statusLabel: string;
  match: number;
  why: string[];
}

export interface AssigneeSuggestion {
  memberId: string;
  name: string;
  color: string;
  kind: 'human' | 'ai';
  provider?: AiProvider;
  score: number;
  reasons: string;
  best?: boolean;
  open?: number;
}

export interface DraftField<T = unknown> {
  value: T;
  note: string;
  new?: string[];
}

export interface SplitItem {
  n: number;
  title: string;
  estimate: number | null;
  estimateError: string | null;
  blockedBy: number[];
  description: string;
  selected: boolean;
}

export interface CaseItem {
  n: number;
  title: string;
  steps: string[];
  expected: string;
  criterionId: string | null;
  criterionIndex: number | null;
  selected: boolean;
}

export interface CoverageRow {
  index: number;
  id: string;
  text: string;
  cases: string[];
}

export interface Hunk {
  id: string;
  removed: string[];
  added: string[];
  note: string;
}

export interface DraftPayload {
  input?: Record<string, unknown>;
  // changes
  changes?: DraftChange[];
  problems?: string[];
  intro?: string;
  // ticket
  fields?: Record<string, DraftField>;
  errors?: Record<string, { message: string; raw: unknown }>;
  similar?: SimilarTicket[];
  assignee?: AssigneeSuggestion[];
  reads?: string;
  counts?: { tags: number; members: number; tickets: number };
  partial?: { missing: string[]; cap: number | null; continueCost: number; metered: boolean };
  // description
  old?: string;
  new?: string;
  segments?: ({ keep: string[] } | { hunk: string })[];
  hunks?: Hunk[];
  context?: ContextSummary;
  // split
  parent?: { id: string; title: string; estimate: number | null };
  items?: SplitItem[];
  criteria?: number;
  // test cases
  cases?: CaseItem[];
  coverage?: CoverageRow[];
  covered?: number;
  total?: number;
  uncovered?: number;
  fromDescription?: boolean;
  existing?: { code: string; title: string; criterionId: string | null; assignee: string | null }[];
  // docs
  text?: string;
  heading?: string;
  title?: string;
  sections?: number;
  ticket?: { id: string; title: string };
  links?: {
    n: number;
    phrase: string;
    kind: 'doc' | 'ticket';
    target: string;
    anchor: string | null;
    ref: string;
    title?: string;
  }[];
  action?: string;
  selected?: string;
}

export interface AssistDraft {
  id: string;
  projectId: string;
  kind: DraftKind;
  owner: string;
  memberId: string | null;
  memberName: string;
  ticketId: string | null;
  docId: string | null;
  chatMessageId: string | null;
  insightId: string | null;
  status: 'pending' | 'open' | 'applied' | 'discarded' | 'expired' | 'undone' | 'failed' | 'cancelled';
  payload: DraftPayload;
  result: {
    error?: { code: string; message: string; retryAfter?: number | null };
    count?: number;
    applied?: { i: number; op: string; ticket: string }[];
    errors?: { i: number; ticket: string; message: string }[];
    created?: string[];
    ticketId?: string;
    undo?: { by: string; at: string; undone: number; skipped: string[] };
    [k: string]: unknown;
  };
  raw: string;
  cost: number;
  tokens: number;
  createdAt: string;
  expiresAt: string | null;
  appliedAt: string | null;
  appliedBy: string | null;
  conflicts?: { ticket: string; message: string }[];
  viewer?: boolean;
  lead?: string | null;
}

export interface Insight {
  id: string;
  projectId: string;
  kind: 'stuck' | 'wip' | 'chain' | 'unassigned' | 'at_risk' | 'priority';
  ticketId: string | null;
  title: string;
  detail: string;
  data: { action?: string; chip?: string; chain?: string[]; tickets?: string[]; [k: string]: unknown };
  score: number;
  state: 'open' | 'snoozed' | 'dismissed' | 'acted' | 'resolved';
  snoozedUntil: string | null;
  seen: boolean;
  draftId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HealthPanel {
  digest: {
    id: string;
    day: string;
    createdAt: string;
    cost: number;
    tokens: number;
    done: string[];
    inProgress: string[];
    blocked: string[];
    text: string;
    tickets: number;
  } | null;
  needsAction: Insight[];
  snoozed: Insight[];
  dismissed: Insight[];
  unseen: number;
  drafts: AssistDraft[];
  schedule: HealthConfig;
  boardAi: string | null;
  enabled: boolean;
}

export interface InsightChip {
  ticketId: string;
  label: string;
  why: string;
  insightId: string;
  kind: Insight['kind'];
}
