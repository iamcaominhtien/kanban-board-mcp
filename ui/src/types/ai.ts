import type { MemoryUsed } from './aiHistory';
import type { RestartEntry } from './aiResources';
import type { MemberAccountRef } from './aiAccounts';

export type AiProvider =
  'claude-code' | 'codex' | 'opencode' | 'antigravity' | 'anthropic' | 'openai' | 'gemini' | 'custom' | 'mcp-client';
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
    | 'removed'
    /** UI only: the type's runs do not start yet (Codex, opencode, Antigravity). */
    | 'not_ready';
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
  /** The CLI run limits a person turned on (PC-5): `max_turns`, `run_timeout_min`. Absent or empty: no limit. */
  cliLimits?: ('max_turns' | 'run_timeout_min')[];
  idleTimeoutMin: number;
  compactAtPct: number;
  compactAtTokens: number;
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
  /** The resource tools (RAM and CPU of the runs, restart a run) over MCP: none | view | control. */
  resourceAccess?: 'none' | 'view' | 'control';
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
  /** The AI account this member runs as; null = the login already on this computer. */
  accountId: string | null;
  accountRef: MemberAccountRef | null;
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
  /** False turns the AI helpers off for the project: no AI button, no AI in the @ list, no /ai. */
  aiEnabled: boolean;
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
  /** Days a finished AI run is kept (OPS-7); null or absent: forever. */
  runRetentionDays?: number | null;
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
  docsEditsAsk: boolean;
  allowedDomains: string[];
  keyReminderDays: number;
  pausedCancelled: number;
  pausedHeld: number;
  pausedTokensRevoked: boolean;
  /** Pause all AI chose "Let them finish", and safe mode was already on (Resume preselects it). */
  pausedLetFinish?: boolean;
  pausedSafeBefore?: boolean;
  /** Runs that started before the pause and are still going, counted live (the banner chip). */
  pausedFinishing?: number;
  /** RAM (MB) a run's CLI may use before the system restarts it; 0 = no limit. */
  runMemoryLimitMb?: number;
  /** The person's role in the project: only owners and admins resume. */
  myRole?: 'owner' | 'admin' | 'member' | 'viewer';
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
  /** What the conversation held at the run's last model call, and the model's window (tokens). */
  contextUsed?: number | null;
  contextWindow?: number | null;
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
  /** RAM of the run's CLI (MB): the highest and the last reading; restarts inside the run. */
  peakRssMb?: number | null;
  lastRssMb?: number | null;
  restarts?: RestartEntry[];
  /** The status the AI tried to move the ticket to and was not allowed to. */
  blockedMove: string | null;
  contextNotes: ContextNote[];
  /** What the board saw the last test command report. */
  tests: TestCounts | null;
  /** Steps the member's recent runs took (the median): "step 9 of ~14". */
  stepEstimate?: number | null;
  /** The board's reading of a run in trouble or stopped (design/screens/ai-operations.md, C and D). */
  diagnosis?: RunDiagnosis | null;
  /** Retries the board scheduled itself (network, crash, board fault, a fresh conversation). */
  retries?: RunRetry[];
  retryAt?: string | null;
  /** The Claude account this run spends when it is not the member's own (urgent work moved). */
  accountId?: string | null;
  /** When the run history retention removed its details (transcript, steps, prompt, logs); the rest is kept (OPS-7). */
  detailsRemovedAt?: string | null;
  /** The project memory its prompt carried (issue #274): "used 3 lessons" and which. */
  memoryUsed?: MemoryUsed | null;
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

/** What the board found out about a run in trouble, by code (or a light model), and what it allows. */
export interface RunDiagnosis {
  at: string;
  by: 'code' | 'model';
  /** foreground_server | waiting_input | mcp_stuck | busy | memory_child | unknown, or a stop kind: network | crash |
   * board_fault | compact | error */
  cause: string;
  boardFault?: boolean;
  trigger: string;
  what: string;
  means: string;
  tried: string[];
  /** stop_child | tell_ai | wait | continue_note | cancel | retry | hand_to */
  actions: string[];
  child?: { pid: number; cmd: string; cpu?: number; rssMb?: number } | null;
  lesson?: string;
  model?: { cause: string; means: string; action: string; note: string; lesson: string } | null;
  quietS?: number;
  process?: { alive: boolean; cpu: number; rssMb: number };
  confidence?: 'high' | 'medium' | 'low';
  clearedAt?: string;
  clearedWhy?: string;
}

export interface RunRetry {
  at: string;
  kind: 'network' | 'board_fault' | 'crash' | 'compact' | string;
  n: number;
  of: number;
  label: string;
  detail: string;
  delayS: number;
}
