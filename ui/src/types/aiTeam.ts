/** The AI Team view, Now tab (GET /projects/{id}/ai/team/now; keys are camel-cased by the API client). */

export type TeamRange = 'today' | '7d' | '30d';

export type CardState = 'working' | 'waiting' | 'queued' | 'paused' | 'offline' | 'idle';

export interface RunRef {
  runId: string;
  number: number;
  ticketId: string;
  ticketTitle: string | null;
  state: string;
  mode: 'work' | 'ask';
}

export interface TeamUsage {
  runs: number;
  ok: number;
  failed: number;
  metered: boolean;
  costUsd?: number | null;
  dailyBudget?: number | null;
  tokens?: number;
  /** Set when the runner reports the cached part apart (Claude Code). */
  tokensCached?: number;
  tokensKind?: 'new_and_cached' | 'input_per_call';
}

export interface TeamCard {
  id: string;
  name: string;
  color: string;
  glyph: string | null;
  provider: string;
  providerLabel: string;
  connection: 'local' | 'api_key' | 'inbox';
  model: string | null;
  state: CardState;
  status: { code: string; label: string; detail: string | null };
  connectionUnknown: boolean;
  paused: boolean;
  /** Why this AI is paused (set while the project is paused or the AI is paused on its own). */
  pause?: {
    project: boolean;
    own: boolean;
    ownLabel: string | null;
    cancelled: { ticketId: string; step: number; at: string | null } | null;
  } | null;
  current:
    | (RunRef & {
        step: { n: number; kind: string | null; text: string } | null;
        elapsedS: number | null;
        limitMin: number | null;
        paused: boolean;
        question: { text: string; askedAt: string | null; options: unknown[] } | null;
      })
    | null;
  queued: RunRef[];
  assigned: string[];
  last: (RunRef & { summary: string | null; endedAt: string | null; agoS: number | null; usage: TeamUsage }) | null;
  usage: TeamUsage;
  spark: number[];
}

interface ItemBase {
  since: string | null;
  waitingS: number | null;
  memberId: string;
  memberName: string | null;
  ticketId?: string | null;
  ticketTitle?: string | null;
  blocks?: string | null;
  text?: string | null;
}

export type NeedsItem =
  | (ItemBase & { kind: 'question'; runId: string; options: unknown[] })
  | (ItemBase & {
      kind: 'approval';
      approvalId: string;
      runId: string | null;
      action: string;
      actionLabel: string;
      risk: string;
      alwaysAllowed: boolean;
    })
  | (ItemBase & { kind: 'offline'; label: string; ticketsWaiting: string[] })
  | (ItemBase & {
      kind: 'docs_proposal';
      pageId: string;
      pageTitle: string | null;
      pageVersion: number | null;
      proposalId: string;
      changes: number;
    });

export interface HandoffEnd {
  id: string;
  name: string;
  color: string | null;
  kind: 'ai' | 'person';
}

export interface Handoff {
  runId: string;
  at: string;
  agoS: number | null;
  kind: string;
  trigger: string;
  from: HandoffEnd;
  to: HandoffEnd;
  ticketId: string;
  ticketTitle: string | null;
  note: string | null;
}

export interface TeamNow {
  range: TeamRange;
  since: string;
  generatedAt: string;
  pausedAll: boolean;
  members: TeamCard[];
  counts: Partial<Record<CardState, number>>;
  needsYou: NeedsItem[];
  handoffs: Handoff[];
  totals: {
    runs: number;
    ok: number;
    failed: number;
    running: number;
    spentUsd: number;
    dailyCap: number | null;
    touches: number;
    autopilot: { on: boolean; delegate: string | null; graceMin: number; decided: number };
  };
  docsProposalsHeld: boolean;
}

export type TouchMark = 'by_rule' | 'needed' | 'avoidable';

export interface Touch {
  at: string;
  kind: string;
  kindLabel: string;
  who: string;
  via: 'mcp' | null;
  what: string;
  mark: TouchMark;
  why: string;
  details: string;
  memberId: string | null;
  memberName: string | null;
  ticketId: string | null;
  ticketTitle: string | null;
  ref: { type?: string; id?: string };
}

export interface SteppedIn {
  range: TeamRange;
  since: string;
  totals: {
    touches: number;
    tickets: number;
    perTicket: number | null;
    byRule: number;
    needed: number;
    avoidable: number;
    viaMcp: number;
  };
  kinds: { key: string; label: string; byRule: number; needed: number; avoidable: number; total: number }[];
  perAi: { id: string; name: string; color: string; runs: number; touches: number; per10Runs: number | null }[];
  people: string[];
  items: Touch[];
  docsProposalsHeld: boolean;
}

export interface SteppedFilters {
  mark?: TouchMark;
  memberId?: string;
  person?: string;
  via?: 'mcp';
}

export type Verdict = 'good' | 'watch' | 'fix';

export interface HealthSuggestion {
  key: string;
  severity: 'fix' | 'watch';
  title: string;
  evidence: string;
  suggestion: string;
  memberId: string | null;
  tickets: string[];
  target: { type: 'member' | 'ticket' | 'page'; id: string | null };
  button: string;
  dismiss?: string;
  /** A change to a member's instructions, saved only after the person confirms it. */
  draft?: { memberId: string; memberName: string; text: string; current: string; limit: number } | null;
}

interface MeasureBase {
  verdict: Verdict | null;
  spark: number[];
  better: 'up' | 'down';
}

export interface Health {
  range: TeamRange;
  runs: number;
  tickets: number;
  since: string;
  until: string;
  canJudge: boolean;
  tooFew: boolean;
  state: 'good' | 'watch' | 'fix' | 'unknown';
  counts: { good: number; watch: number; fix: number };
  touches: { total: number; avoidable: number };
  measures: {
    reliability: MeasureBase & { value: number | null; ok: number; total: number; delta: number | null };
    autonomy: MeasureBase & { value: number | null; clean: number; total: number; goal: number; delta: number | null };
    speed: MeasureBase & {
      medianS: number | null;
      waitingShare: number | null;
      tickets: number;
      deltaS: number | null;
    };
    quality: MeasureBase & { value: number | null; sentBack: number; handoffs: number; delta: number | null };
    cost: MeasureBase & {
      usd: number;
      perTicket: number | null;
      capShare: number | null;
      cap: number | null;
      tokensOnly: number;
      deltaUsd: number | null;
    };
  };
  perAi: {
    id: string;
    name: string;
    color: string;
    runs: number;
    okShare: number | null;
    asked: number;
    askedShare: number | null;
    touchesPer10: number | null;
    avgRunS: number | null;
    costPerTicket: number | null;
    tokens: number | null;
    sentBackTo: number;
    status: 'healthy' | 'watch' | 'fix' | 'idle';
  }[];
  suggestions: HealthSuggestion[];
  notOk: { label: string; count: number; runIds: string[]; ticketIds: string[] }[];
  notOkTotal: number;
}

/** What an active run is doing right now (queued, working, or waiting for a person). */
export interface LiveRun {
  runId: string;
  memberId: string;
  memberName: string;
  ticketId: string;
  ticketTitle: string;
  state: 'working' | 'waiting_you' | 'queued';
  mode: string;
  trigger: string;
  sender: string;
  elapsedS: number | null;
  step: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  kind: 'flow' | 'skip' | 'sent back' | 'report back';
  /** Members a skip leaves out (usually between the two). */
  skipped: string[];
  count: number;
  waitS: number | null;
  tickets: string[];
  /** A hand-off between these two is under way. */
  live: boolean;
}

export interface FlowMap {
  range: TeamRange;
  since: string;
  live: LiveRun[];
  /** Pause all AI is on: the map keeps its history and marks where each AI stands. */
  pausedAll?: boolean;
  pausedAt?: string | null;
  nodes: {
    id: string;
    name: string;
    color: string;
    tickets: number;
    avgRunS: number | null;
    asked: number;
    live: LiveRun | null;
    liveCount: number;
    pauseTag?: 'paused' | 'waiting' | 'offline' | null;
    held?: number;
  }[];
  edges: FlowEdge[];
  tickets: number;
  stats: {
    handoffs: number;
    kinds: { kind: string; count: number }[];
    sentBack: number;
    sentBackShare: number | null;
    sentBackTo: { name: string; count: number }[];
    pingPong: { ticketId: string; count: number }[];
    waitingShare: number | null;
    returned: number;
  };
  picker: {
    id: string;
    title: string;
    status: string;
    elapsedS: number | null;
    touches: number;
    bounced: number;
    costUsd: number;
    completed: boolean;
    live: LiveRun[];
  }[];
}

export interface Journey {
  ticket: { id: string; title: string; status: string; parentId?: string | null };
  empty: boolean;
  start?: string | null;
  end?: string | null;
  running?: boolean;
  live?: LiveRun[];
  lanes?: { id: string; name: string; color: string | null }[];
  bars?: {
    runId: string;
    memberId: string;
    number: number;
    state: string;
    trigger: string;
    start: string | null;
    end: string | null;
    wait: { from: string; to: string } | null;
    summary: string;
    steps: number;
    costUsd: number | null;
    tokens: number;
    endedReason: string | null;
    files: number;
    limitMin: number | null;
  }[];
  arrows?: { runId: string; at: string; from: string; to: string; kind: string }[];
  touches?: {
    at: string;
    who: string;
    via: 'mcp' | null;
    what: string;
    mark: TouchMark | 'start';
    why: string;
    details: string;
  }[];
  strip?: {
    elapsedS: number;
    workingS: number;
    waitingS: number;
    betweenS: number;
    /** Time the whole project was paused, counted apart from the others. */
    pausedS?: number;
    runs: number;
    handoffs: number;
    returned: number;
    sentBack: number;
    touches: number;
    touchesNeeded: number;
    touchesAvoidable: number;
    costUsd: number;
    completedAt: string | null;
    deliverable: {
      kind: string | null;
      label: string;
      files: number;
      summary: string;
      acceptedAt: string | null;
      pages: { id: string; title: string; version: number }[];
    };
  };
  children?: { id: string; title: string; status: string; holder: string | null; state: string | null }[];
  docs?: JourneyPage[];
  parent?: ParentRollup | null;
}

export interface JourneyPage {
  id: string;
  title: string;
  version: number;
  versions: { version: number; at: string; author: string; note: string | null; withAi: boolean }[];
  threads: { id: string; at: string; by: string; state: 'resolved' | 'open' | 'orphaned'; resolvedBy: string | null }[];
  counts: { resolved: number; open: number; orphaned: number };
  waitingProposals: number;
  needsPerson: number;
}

export interface ParentChild {
  id: string;
  title: string;
  status: string;
  deliverable: string;
  deliverableKind: string | null;
  heldBy: string | null;
  heldById: string | null;
  state: 'delivered' | 'delivered_threads' | 'waiting_you' | 'working' | 'blocked' | 'not_started';
  threadsNeed: number;
  waitingYou: number;
  proposals: number;
  blockers: string[];
  segments: {
    memberId: string;
    start: string;
    end: string;
    wait: { from: string; to: string } | null;
    state: string;
  }[];
}

export interface ParentRollup {
  lead: { id: string; name: string | null } | null;
  members: { id: string; name: string; color: string }[];
  children: ParentChild[];
  start: string | null;
  end: string;
  alert: { child: string; blocker: string; text: string } | null;
  reportBacks: number;
  tiles: {
    children: number;
    delivered: number;
    waiting: number;
    notStarted: number;
    blocked: number;
    elapsedS: number;
    waitingS: number;
    touches: number;
    touchesExpected: number;
    touchesAvoidable: number;
    costUsd: number;
  };
}

// ---------------------------------------------------------------------------
// Flow › Timeline (design/screens/ai-team-timeline.md): a sequence diagram of the team
// ---------------------------------------------------------------------------

export type TimelineRange = 'hour' | 'today' | '24h' | '7d' | 'custom';

export interface TimelineLifeline {
  id: string;
  kind: 'you' | 'autopilot' | 'ai' | 'docs';
  name: string;
  color: string | null;
  /** Header dot: working, waiting for you, queued, offline, idle or paused (AIs only). */
  state: 'working' | 'waiting' | 'queued' | 'offline' | 'idle' | 'paused' | null;
  delegate?: string | null;
  /** No event in the window: folded into the "N quiet AIs" strip on a narrow window. */
  quiet?: boolean;
}

export type RunEnd = 'ok' | 'failed' | 'timeout' | 'stopped' | 'pause_all' | 'budget' | null;

export interface TimelineBar {
  id: string;
  memberId: string;
  ticketId: string;
  number: number;
  mode: string;
  state: string;
  trigger: string;
  autopilot: boolean;
  queuedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  endKind: RunEnd;
  endedReason: string | null;
  endedBy: string | null;
  stopCode: string | null;
  steps: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number | null;
  costUsd: number;
  metered: boolean;
  summary: string;
  question: string | null;
  paused: boolean;
  heldByPause: boolean;
  model: string | null;
}

export type ArrowKind =
  | 'assign'
  | 'mention'
  | 'handoff'
  | 'report'
  | 'returned'
  | 'sent_back'
  | 'ask'
  | 'answer'
  | 'perm'
  | 'approve'
  | 'deny'
  | 'auto'
  | 'doc';

export interface TimelineArrow {
  id: string;
  at: string;
  /** Where the arrow lands: when the next lifeline started (or the same time for a message). */
  toAt: string | null;
  kind: ArrowKind;
  from: string;
  to: string;
  ticketId: string | null;
  runId: string | null;
  waitS: number | null;
  /** Times the same pair sent the work back (the ×N badge). */
  round: number;
  label: string | null;
  /** Close events between the same two lifelines grouped into one. */
  count: number;
  atLast: string;
  /** The parent ticket whose children's report backs were grouped into this arrow. */
  parentId?: string | null;
  items: { id: string; ticketId: string | null }[];
  by?: string | null;
  denied?: boolean;
  risk?: string;
  summary?: string;
}

export interface TimelineWait {
  id: string;
  memberId: string;
  ticketId: string | null;
  runId: string | null;
  kind: 'question' | 'approval';
  from: string;
  to: string | null;
  text: string;
  options?: string[];
  risk?: string;
  status?: string;
}

export interface TimelineTouch {
  id: string;
  at: string;
  ticketId: string;
  mark: TouchMark | 'start';
  what: string;
  who: string;
  via: string | null;
}

export interface TimelineDocNode {
  id: string;
  at: string;
  memberId: string;
  pageId: string;
  title: string;
  version: number;
  kind: 'version' | 'proposal';
  status: string | null;
  summary?: string;
  changes?: number;
}

export interface TimelinePause {
  from: string;
  to: string | null;
  by: string | null;
  reason: string | null;
  resumedBy: string | null;
}

export interface Timeline {
  range: TimelineRange;
  since: string;
  until: string;
  now: string;
  following: boolean;
  scope: { kind: 'team' | 'ticket'; ticketId: string | null };
  lifelines: TimelineLifeline[];
  bars: TimelineBar[];
  arrows: TimelineArrow[];
  waits: TimelineWait[];
  touches: TimelineTouch[];
  docs: TimelineDocNode[];
  pauses: TimelinePause[];
  pausedAll: boolean;
  pausedAt: string | null;
  pausedBy: string | null;
  live: LiveRun[];
  density: number[];
  truncated: boolean;
  /** Over the cap the picture groups harder before it drops anything. */
  groupedHarder?: boolean;
  lastEndedAt: string | null;
  tickets: Record<string, { title: string; status: string }>;
  autopilot: { on: boolean; delegate: string | null; graceMin: number | null };
}
