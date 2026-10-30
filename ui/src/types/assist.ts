import type { AiProvider, AiStatus } from './ai';

export type AssistScope = 'ticket' | 'project' | 'all' | 'doc' | 'idea';
export type FeatureKey = 'chat' | 'drafting' | 'split' | 'test_cases' | 'health' | 'docs' | 'sketch';

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
    /** No Board AI is chosen: Ask AI still answers with this AI member until one is. */
    fallback?: { id: string; name: string } | null;
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
  /** "Do the work": the run the message started. */
  run?: { id: string; number: number; memberId: string; memberName: string };
  /** The answer hit its length limit; Continue goes on from where it stopped. */
  cutShort?: boolean;
  /** Set once the answer was posted as a comment. */
  posted?: { commentId: string; at: string; by: string };
}

export type MessageState =
  'queued' | 'thinking' | 'streaming' | 'done' | 'stopped' | 'error' | 'rate_limited' | 'over_budget';

export interface ChatMessage {
  /** The asker's thumbs up / down on an answer, kept on the server. */
  feedback?: { thumb: 'up' | 'down'; reason: string; at: string } | null;
  id: string;
  chatId: string;
  /** `note` is a divider the server adds when a chat changes what it is about ("Now about KAN-12"). */
  role: 'user' | 'ai' | 'note';
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
  /** The thing a scoped chat is about (ticket id, page id, idea id…). */
  scopeId?: string | null;
  /** The AI member that answers; null means the Board AI. */
  memberId?: string | null;
  ticketId: string | null;
  docId: string | null;
  includeDocs: string[];
  cost: number;
  tokens: number;
  applied: boolean;
  /** Rolling summary of the older messages; `compactions` counts how often it was refreshed. */
  summary?: string;
  compactions?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatDetail extends Chat {
  messages: ChatMessage[];
  drafts: AssistDraft[];
}

export type DraftKind =
  | 'changes'
  | 'ai_members'
  | 'ticket'
  | 'description'
  | 'split'
  | 'test_cases'
  | 'doc_summary'
  | 'doc_section'
  | 'doc_links'
  | 'doc_text'
  | 'nudge'
  | 'assignee'
  | 'editor'
  | 'editor_doc'
  | 'sketch';

export interface DraftChange {
  /** The board's own kinds, or a kind that another scope adds (an idea's, for example). */
  op:
    'status' | 'priority' | 'assignee' | 'due_date' | 'estimate' | 'title' | 'comment' | 'add_criteria' | (string & {});
  ticket: string;
  from?: unknown;
  to?: unknown;
  text?: string;
  /** add_criteria: the criteria to add. */
  items?: string[];
  /** Set when the change belongs to a scope's own kind (e.g. "idea"). */
  scope?: string;
  /** idea_assumption: how much the idea depends on it. */
  impact?: 'low' | 'medium' | 'high';
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

/** One AI member the Board AI proposes (edited in the card before it is created). */
export interface ProposedMember {
  name: string;
  description: string;
  persona: string;
  template: 'developer' | 'reviewer' | 'read_only';
  ceiling: 'none' | 'backlog' | 'todo' | 'in-progress' | 'review';
  maxParallel: number;
  maxRunsPerDay: number;
  readOnlyCli: boolean;
  model: string;
  why: string;
}

export interface DraftPayload {
  input?: Record<string, unknown>;
  // ai_members
  members?: ProposedMember[];
  refusal?: string | null;
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
    created?: (string | { id: string; name: string })[];
    failed?: { name: string; message: string }[];
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
    /** One line per Docs page that may be out of date; only on the Monday digest (Docs AI). */
    docs?: string[];
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

// ---------------------------------------------------------------------------
// Chat about one thing (design/screens/ai-where-you-work.md, B)
// ---------------------------------------------------------------------------

/** What a chat is about. `kind` is a registered scope; the ticket page uses "ticket", the idea page "idea". */
export interface ChatScope {
  kind: 'ticket' | 'doc' | 'idea' | (string & {});
  id: string;
}

/** One chip of the "Reading" line: what the AI reads for this thing. */
export interface ReadingChip {
  kind: string;
  label: string;
  count?: number;
  /** Left out (a private Doc): shown struck through. */
  skipped?: boolean;
}

/** A button of the empty chat: one click sends `request`. */
export interface StartingPoint {
  label: string;
  request: string;
  /** The answer is a draft to apply (criteria, an idea note…), not just text. */
  draft?: boolean;
  /** The request is the start of a sentence: put it in the box for the person to finish instead of sending it. */
  prefill?: boolean;
}

export interface ChatScopeInfo {
  kind: string;
  id: string;
  projectId: string;
  title: string;
  reading: ReadingChip[];
  startingPoints: StartingPoint[];
  placeholder: string;
  /** "Do the work" can start a run from here (tickets). */
  work: boolean;
  /** Extra draft kinds this scope understands. */
  draftKinds: string[];
}

export interface CostEstimate {
  metered: boolean;
  usd: number | null;
  tokensIn: number;
  tokensOut: number;
}

export type AvailabilityCode =
  | 'ok'
  | 'ai_off'
  | 'viewer'
  | 'not_configured'
  | 'unavailable'
  | 'over_budget'
  | 'feature_off'
  | 'not_shared'
  | 'forbidden';

/** Whether the person may ask now, and if not why (the states of design E). */
export interface Availability {
  code: AvailabilityCode;
  message?: string;
  /** over_budget: the daily cap (not the monthly one) was reached. */
  daily?: boolean;
  member?: string;
  resets?: string;
  status?: AiStatus | null;
}

export interface ScopeMember {
  id: string;
  name: string;
  boardAi: boolean;
  provider: AiProvider;
  connection: 'local' | 'api_key' | 'inbox';
  metered: boolean;
  ready: boolean;
  statusCode: string | null;
  /** "Local runner · online". */
  status: string;
}

export interface ScopeState {
  scope: ChatScopeInfo;
  availability: Availability;
  members: ScopeMember[];
  memberId: string | null;
  estimate: CostEstimate | null;
  work: { allowed: boolean; estimate: CostEstimate | null };
  chatId: string | null;
}

/** What @mentioning an AI member in a comment would do (design C, step 2). */
export interface MentionEstimate {
  memberId: string;
  memberName: string;
  mode: 'ask' | 'work';
  available: boolean;
  reason: string | null;
  status: string | null;
  metered: boolean;
  estimate: CostEstimate;
  reads: string[];
  canEditCode: boolean;
  stopsAt: string;
}
