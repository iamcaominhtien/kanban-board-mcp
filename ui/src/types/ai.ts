export type AiProvider = 'claude-code' | 'antigravity' | 'anthropic' | 'openai' | 'gemini' | 'custom' | 'mcp-client';
export type AiConnection = 'local' | 'api_key' | 'inbox';
export type PermissionMode = 'allowed' | 'approval' | 'blocked';
export type AiTemplate = 'developer' | 'reviewer' | 'read_only' | 'custom';
export type RunState =
  'queued' | 'starting' | 'running' | 'needs_input' | 'finished' | 'failed' | 'cancelled' | 'timed_out';

export interface AiStatus {
  code:
    | 'key_invalid'
    | 'not_logged_in'
    | 'runner_missing'
    | 'model_retired'
    | 'over_budget'
    | 'rate_limited'
    | 'paused_all'
    | 'paused'
    | 'running'
    | 'idle'
    | 'online'
    | 'inbox'
    | 'removing'
    | 'removed';
  label: string;
  detail: string | null;
  ticketId?: string;
}

/** A header or environment variable; secret header values never come back (only `masked`). */
export interface AiKv {
  name: string;
  value: string;
  secret?: boolean;
  masked?: string;
}

export interface AiLibraryLink {
  id: string;
  version: number;
}

export interface AiMcpServer {
  id: string;
  name: string;
  type: 'stdio' | 'http';
  command: string;
  args: string[];
  url: string;
  env: AiKv[];
  headers: AiKv[];
  enabled: boolean;
  mode: 'synced' | 'documented';
  description: string;
  library: AiLibraryLink | null;
}

export interface AiSkill {
  id: string;
  name: string;
  description: string;
  content: string;
  files: { path: string; content: string }[];
  enabled: boolean;
  mode: 'synced' | 'documented';
  library: AiLibraryLink | null;
}

export interface AiSubagent {
  id: string;
  name: string;
  description: string;
  content: string;
  model: string;
  tools: string;
  enabled: boolean;
  library: AiLibraryLink | null;
}

export interface AiHook {
  id: string;
  event: string;
  matcher: string;
  command: string;
  enabled: boolean;
}

export interface AiCustomTool {
  id: string;
  name: string;
  spec: string;
  headers: AiKv[];
  enabled: boolean;
  library: AiLibraryLink | null;
}

export interface AiRemoteMcp {
  id: string;
  name: string;
  url: string;
  headers: AiKv[];
  enabled: boolean;
  library: AiLibraryLink | null;
}

export interface AiConfig {
  instructions: string;
  userInstructions: string;
  snippets: { libraryId: string; name: string; version: number; content: string }[];
  mcpServers: AiMcpServer[];
  allowRules: string[];
  denyRules: string[];
  effort: string | null;
  extraFlags: string[];
  maxTurns: number;
  runTimeoutMin: number;
  idleTimeoutMin: number;
  compactAtPct: number;
  permissionMode: 'allowlist' | 'bypass';
  maxSteps: number;
  maxTokensPerRun: number;
  temperature: number;
  retries: number;
  retryBaseS: number;
  retryFactor: number;
  retryMaxS: number;
  context: {
    comments: boolean;
    criteria: boolean;
    subTickets: boolean;
    linkedDocs: boolean;
    commentLimit: number;
    docLimit: number;
    docTokens: number;
  };
  toolGroups: {
    read: boolean;
    update: boolean;
    comment: boolean;
    create: boolean;
    testCases: boolean;
    docsRead: boolean;
    docsWrite: boolean;
  };
  skills: AiSkill[];
  subagents: AiSubagent[];
  hooks: AiHook[];
  customTools: AiCustomTool[];
  remoteMcp: AiRemoteMcp[];
  output: { includeUsage: boolean; moveBackOnFailure: boolean; commentFormat: 'short' | 'detailed' | 'plain' };
  antigravity: { syncMcp: boolean; mcpTarget: string };
  permissionNotes: string;
}

export interface AiMember {
  id: string;
  projectId: string;
  name: string;
  color: string;
  kind: 'ai' | 'ai_removed';
  provider: AiProvider;
  providerLabel: string;
  connection: AiConnection;
  description: string;
  glyph: string;
  cliPath: string | null;
  workingDir: string | null;
  baseUrl: string | null;
  model: string | null;
  keyLast4: string | null;
  persona: string;
  maxParallel: number;
  dailyBudget: number | null;
  monthlyCap: number | null;
  maxRunsPerDay: number | null;
  template: AiTemplate;
  ceiling: string;
  permissions: Record<string, PermissionMode>;
  /** Every project of the board, and whether this AI member works there (as which linked copy). */
  projects?: { projectId: string; name: string; on: boolean; memberId: string | null; original: boolean }[];
  /** Set on a copy in another project: the AI member it was copied from. */
  linkedTo?: string | null;
  /** A permission change an admin asked for, waiting for the owner (safety H1). */
  pendingChange?: {
    by: string;
    at: string;
    diffs: { action: string; label: string; from: PermissionMode; to: PermissionMode }[];
  } | null;
  scope: 'assigned' | 'project';
  config: AiConfig;
  capabilities: Record<string, 'synced' | 'documented' | 'not_supported'>;
  paused: boolean;
  pausedAt: string | null;
  pausedReason: string | null;
  health: string;
  healthDetail: string | null;
  checkedAt: string | null;
  /** When the provider last answered this member (API-key members). */
  lastCallAt: string | null;
  /** While rate-limited: when its queued runs try again. */
  retryAt: string | null;
  cliVersion: string | null;
  account: string | null;
  isBoardAi: boolean;
  status: AiStatus;
  running: {
    runId: string;
    ticketId: string;
    ticketTitle: string | null;
    ticketStatus: string | null;
    state: RunState;
    number: number;
    startedAt: string | null;
  }[];
  /** Actions that wait for a person's approval (role template and the member's own overrides). */
  approvals: { action: string; label: string }[];
  slotsInUse: number;
  queued: number;
  assigned: { id: string; title: string; status: string }[];
  usage: {
    runsToday: number;
    scheduledRunsToday: number;
    runsLastHour: number;
    tokensInToday: number;
    tokensOutToday: number;
    costToday: number;
    costMonth: number;
    secondsToday: number;
    successRateWeek: number | null;
  };
  lastRunAt: string | null;
  lastRun: { ticketId: string; state: RunState; number: number; endedAt: string } | null;
  createdBy: string | null;
  createdAt: string;
  tokensPerDay: number | null;
  capPerRun: number | null;
  warnAt: number[];
  safeMode: boolean;
  allowExternal: boolean;
  keyRotatedAt: string | null;
  mcpLastUsedAt: string | null;
  tokenRevokedAt: string | null;
  tokenRevokedBy: string | null;
}

export interface AiSettings {
  projectId: string;
  boardAiId: string | null;
  pausedAll: boolean;
  pausedAt: string | null;
  pausedBy: string | null;
  pausedReason: string | null;
  safeMode: boolean;
  boardDailyCap: number | null;
  boardMonthlyBudget: number | null;
  maxChainDepth: number;
  runsPerTicketPerDay: number;
  approvalExpiryHours: number;
  boardTokensPerDay: number | null;
  boardMaxParallel: number;
  boardRunsPerDay: number | null;
  boardAtCap: 'pause' | 'stop' | 'ask';
  approvalOnExpiry: 'skip' | 'stop';
  approvers: { low: string; medium: string; high: string };
  delegates: { from: string; to: string; until: string | null }[];
  auditRetentionDays: number | null;
  loopCooldownS: number;
  /** Auto-trip rules (safety D6): switch, thresholds and the sentence for each. */
  autoTrip?: {
    key: string;
    label: string;
    when: string;
    then: string;
    on: boolean;
    count?: number;
    minutes: number;
    factor?: number;
  }[];
  noRepeatChain: boolean;
  allowedDomains: string[];
  notify: { event: string; label: string; urgent: boolean; inapp: boolean; desktop: boolean }[];
  digest: 'off' | 'daily' | 'weekdays';
  keyReminderDays: number;
  pausedCancelled: number;
  pausedHeld: number;
  pausedTokensRevoked: boolean;
}

export interface AiOverview {
  settings: AiSettings;
  members: AiMember[];
  summary: { runningNow: number; runsToday: number; spendToday: number; needAttention: number };
  pendingApprovals: number;
}

export interface RunStep {
  at: string;
  kind: string;
  text: string;
  detail?: string;
  /** What a command printed (masked), its exit code, and the test counts read from it. */
  output?: string;
  exitCode?: number;
  tests?: TestCounts;
}

/** Pass and fail counts of a test command or of the agent's own claim. */
export interface TestCounts {
  passed: number;
  failed: number;
  failing?: string[];
  lint?: string;
  /** The command the board read the counts from. */
  command?: string;
}

/** An edit a person made to the ticket while a run worked on it. */
export interface ContextNote {
  at: string;
  by: string;
  what: string;
  step: number;
  delivered: boolean;
}

export interface AiRun {
  id: string;
  /** Set while a tool call of the run waits for a person's approval (safety, "Needs approval" run state). */
  waitingApproval?: { approvalId: string; summary: string; since: string } | null;
  projectId: string;
  ticketId: string;
  memberId: string;
  memberName: string | null;
  number: number;
  mode: 'work' | 'ask';
  trigger: string;
  state: RunState;
  startedBy: string;
  instruction: string;
  sourceCommentId: string | null;
  replyCommentId: string | null;
  chain: string[];
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  lastOutputAt: string | null;
  elapsedS: number | null;
  endedReason: string | null;
  endedBy: string | null;
  exitCode: number | null;
  summary: string | null;
  report: {
    summary?: string;
    criteria?: { text: string; met: boolean | null; evidence?: string }[];
    tests?: TestCounts | null;
  };
  question: {
    text: string;
    options: string[];
    optionDetails?: { label: string; description: string; recommended: boolean }[];
    to: string;
    askedAt: string;
    answeredAt?: string;
    answeredBy?: string;
    reminders?: { at: string; level: number; lead?: string[] }[];
  } | null;
  answer: string | null;
  sessionId: string | null;
  steps: RunStep[];
  stepCount?: number;
  files: { path: string; added: number; removed: number; new: boolean }[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  metered: boolean;
  statusBefore: string | null;
  statusChanges: { from: string; to: string; at: string; kind?: string }[];
  model: string | null;
  waitingReason: string | null;
  queuePosition?: number;
  /** Ticket this queued run waits behind (the member's current work, or the holder of the ticket). */
  behindTicketId?: string | null;
  behindMemberId?: string | null;
  behindMemberName?: string | null;
  /** Set while this is a second AI waiting for the holder of the ticket. */
  behindRunId: string | null;
  queueAfterCurrent: boolean;
  paused: boolean;
  pausedAt: string | null;
  limitMin: number | null;
  replacesCommentId: string | null;
  feedback: { rating: 'up' | 'down'; reasons: string[]; by: string; at: string } | null;
  /** Why the run ended when it was not its own doing: budget, archive, deleted, reassigned, takeover. */
  stopCode: string | null;
  /** The status the AI tried to move the ticket to and was not allowed to. */
  blockedMove: string | null;
  contextNotes: ContextNote[];
  /** What the board saw the last test command report. */
  tests: TestCounts | null;
  /** Steps the member's recent runs took (the median): "step 9 of ~14". */
  stepEstimate?: number | null;
}

export interface AiApproval {
  id: string;
  projectId: string;
  memberId: string;
  memberName: string | null;
  runId: string | null;
  ticketId: string | null;
  action: string;
  summary: string;
  params: Record<string, unknown>;
  reason: string | null;
  risk: 'low' | 'medium' | 'high';
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'failed' | 'run_ended';
  onBehalfOf: string | null;
  /** A Docs AI proposal: the proposal and the page it changes. */
  proposalId?: string | null;
  pageId?: string | null;
  requestedAt: string;
  expiresAt: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  diff?: { field: string; label: string; from: unknown; to: unknown }[];
  targetTitle?: string | null;
  run?: { id: string; number: number; state: string; trigger: string; startedBy: string } | null;
  trigger?: { label: string; trust: 'trusted' | 'data_only' | 'untrusted'; by: string | null };
  stale?: {
    fields: {
      field: string;
      label: string;
      asked: unknown;
      now: unknown;
      setBy: string | null;
      setAt: string | null;
    }[];
  } | null;
  canDecide?: boolean;
  cannotReason?: string;
  rememberAllowed?: boolean;
}

export interface AiAuditEntry {
  id: string;
  seq: number;
  projectId: string;
  memberId: string | null;
  memberName: string;
  onBehalfOf: string | null;
  runId: string | null;
  action: string;
  target: string | null;
  result: string;
  detail: Record<string, unknown>;
  createdAt: string;
  revertedAt: string | null;
  revertedBy: string | null;
  runNumber?: number | null;
  runCost?: number | null;
  redactions?: number;
}

export interface PermissionRow {
  action: string;
  label: string;
  description: string;
  risk: string;
  templateMode: PermissionMode;
  override: PermissionMode | null;
  mode: PermissionMode;
  lockedMin: PermissionMode | null;
  source: string;
  sourceBy?: string | null;
  sourceAt?: string | null;
  ownerEnabled?: boolean;
  ceilingNote?: string | null;
}

export interface ProviderSpec {
  label: string;
  connection: AiConnection;
  binary?: string;
  models: string[];
  defaultModel: string | null;
  baseUrl?: string | null;
  install?: string;
}

export interface DetectResult {
  found: boolean;
  path: string | null;
  checked: string[];
  version: string | null;
  loggedIn: boolean | null;
  account: string | null;
  install?: string;
  /** Plain steps for a CLI that is not installed with one command (Antigravity). */
  installSteps?: string[];
  guideUrl?: string | null;
  latestVersion?: string | null;
  /** The installed version is the latest one; null when that could not be looked up. */
  upToDate?: boolean | null;
}

/** Where local runners run: the computer the board's server runs on. */
export interface RunnerInfo {
  host: string;
  /** The request comes from that same computer (the desktop app, or a browser on it). */
  local: boolean;
  appVersion: string;
  platform: string;
}
