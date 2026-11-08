import type { MemberAccountRef } from './aiAccounts';
import type { RestartEntry } from './aiResources';

/** AI v2: Claude Code only. A "team" is the assignee of a ticket; its lead runs the ticket, its roles are subagents. */
export type AiProvider = 'claude-code';
export type PermissionMode = 'bypass' | 'auto';
export type RunState =
  'queued' | 'starting' | 'running' | 'needs_input' | 'finished' | 'failed' | 'cancelled' | 'timed_out';

export const ACTIVE_STATES: RunState[] = ['queued', 'starting', 'running', 'needs_input'];

export interface AiStatus {
  code: 'not_logged_in' | 'runner_missing' | 'rate_limited' | 'paused_all' | 'paused' | 'running' | 'idle' | 'removed';
  label: string;
  detail: string | null;
  ticketId?: string;
}

/** One role of a team: a subagent of the lead. `tools` null = every tool the run has. */
export interface AiTeamRole {
  key: string;
  name: string | null;
  description: string | null;
  prompt: string | null;
  model: string | null;
  effort: string | null;
  tools: string[] | null;
  writes: string | null;
}

/** What a person changed on a role of the pack; `off` drops the role. Sent as `config.roles`. */
export interface RoleOverride {
  key: string;
  model?: string | null;
  effort?: string | null;
  prompt?: string;
  off?: boolean;
}

/** A ready-made team: which roles it brings. */
export interface TeamPack {
  key: string;
  name: string;
  description: string;
  roles: string[];
}

export interface AiTeamConfig {
  mcpServers: unknown[];
  skills: unknown[];
  plugins: unknown[];
  hooks: unknown[];
  disallowedTools: string[];
  /** The role overrides a person made on top of the pack. */
  roles?: RoleOverride[];
  [key: string]: unknown;
}

export interface TeamRunning {
  runId: string;
  ticketId: string;
  ticketTitle: string | null;
  ticketStatus: string | null;
  state: RunState;
  number: number;
  startedAt: string | null;
}

export interface AiTeam {
  id: string;
  projectId: string;
  name: string;
  color: string;
  kind: 'ai' | 'ai_removed';
  provider: AiProvider;
  description: string;
  cliPath: string | null;
  workingDir: string | null;
  model: string | null;
  effort: string | null;
  persona: string;
  packKey: string;
  packName: string | null;
  roles: AiTeamRole[];
  config: AiTeamConfig;
  permissionMode: PermissionMode;
  maxParallel: number;
  dailyBudget: number | null;
  monthlyCap: number | null;
  maxRunsPerDay: number | null;
  tokensPerDay: number | null;
  capPerRun: number | null;
  scope: 'assigned' | 'project';
  paused: boolean;
  pausedAt: string | null;
  pausedReason: string | null;
  health: string;
  healthDetail: string | null;
  checkedAt: string | null;
  mcpLastUsedAt: string | null;
  accountId: string | null;
  accountRef: MemberAccountRef | null;
  status: AiStatus;
  running: TeamRunning[];
  slotsInUse: number;
  queued: number;
  assigned: { id: string; title: string; status: string }[];
  usage: { runsToday: number; costToday: number; tokensToday: number };
  lastRun: { ticketId: string; state: RunState; number: number; endedAt: string } | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface AiSettings {
  projectId: string;
  pausedAll: boolean;
  pausedAt: string | null;
  pausedReason: string | null;
  boardDailyCap: number | null;
  boardMonthlyBudget: number | null;
  boardTokensPerDay: number | null;
  boardMaxParallel: number;
  boardRunsPerDay: number | null;
  boardAtCap: 'pause' | 'stop';
  /** RAM (MB) a run's CLI may use before the system restarts it; 0 = no limit. */
  runMemoryLimitMb: number;
  auditRetentionDays: number | null;
  permissionMode: PermissionMode;
  denyList: string[];
  lessonsMode: 'auto' | 'review';
  lessonsMax: number;
  ops: Record<string, unknown>;
}

export interface AiOverview {
  projectId: string;
  pausedAll: boolean;
  pausedReason: string | null;
  teams: {
    id: string;
    name: string;
    color: string;
    status: AiStatus;
    slotsInUse: number;
    queued: number;
    health: string;
  }[];
  /** Runs of the project by state (keys camel-cased: `needsInput`). */
  runs: Record<string, number>;
  active: { runId: string; ticketId: string | null; memberId: string; state: RunState }[];
}

/** What a board card knows of the newest run of a ticket (`GET /projects/{id}/ai/board`). */
export interface BoardRun {
  ticketId: string;
  runId: string;
  memberId: string;
  state: RunState;
  number: number;
  startedAt: string | null;
  endedAt: string | null;
  lastOutputAt: string | null;
  stepsCount: number;
  summary: string | null;
  question: RunQuestion | null;
}

export type StepKind =
  | 'tool'
  | 'edit'
  | 'create'
  | 'read'
  | 'command'
  | 'search'
  | 'skill'
  | 'subagent'
  | 'board'
  | 'text'
  | 'hook'
  | 'rate_limited'
  | 'start'
  | 'end'
  | 'error'
  | 'message'
  | 'plan'
  | 'report'
  | 'compact'
  | 'question'
  | 'memory';

/** Pass and fail counts of a test command or of the agent's own claim. */
export interface TestCounts {
  passed: number;
  failed: number;
  failing?: string[];
  lint?: string;
  /** The command the board read the counts from. */
  command?: string;
}

export interface StepDetail {
  path?: string;
  added?: number;
  removed?: number;
  command?: string;
  exitCode?: number;
  tests?: TestCounts;
  [key: string]: unknown;
}

/** One row of a run: what the lead (agentId null) or one of its subagents did. */
export interface RunStep {
  id?: number;
  runId?: string;
  seq: number;
  at: string;
  /** The `toolId` of the lead's `subagent` step this step belongs to; null = the lead itself. */
  agentId: string | null;
  kind: StepKind | string;
  tool: string | null;
  title: string;
  detail: StepDetail;
  hasOutput: boolean;
  parentToolId: string | null;
  toolId: string | null;
  /** Only on `GET .../steps/{seq}/output`. */
  output?: string | null;
}

/** A subagent of a run (the role it plays). `id` is the `toolId` of the lead's `subagent` step. */
export interface RunAgent {
  id: string;
  runId: string;
  agentType: string;
  claudeId: string | null;
  startedAt: string;
  endedAt: string | null;
  stepsCount: number;
  lastText: string | null;
  /** Its stretches of work, oldest first: one more each time the lead woke it again; the last has no end while it works. */
  spans?: { start: string; end: string | null }[];
}

/** A closed conversation of a team on a ticket: title and summary of what its lead was asked and did. */
export interface AiSessionHistory {
  id: string;
  ticketId: string;
  memberId: string;
  title: string;
  summary: string;
  sessionIds: string[];
  runIds: string[];
  startedAt: string | null;
  endedAt: string;
  createdBy: string;
  /** The model that wrote the summary, or "digest" when no AI could be asked. */
  summarisedBy: string;
}

export interface RunQuestion {
  text: string;
  options: string[];
  optionDetails?: { label: string; description: string; recommended: boolean }[];
  to?: string;
  askedAt?: string;
  answeredAt?: string;
  answeredBy?: string;
}

export interface RunReport {
  status?: string;
  summary?: string;
  branch?: string | null;
  prUrl?: string | null;
  openItems?: string[];
  lessons?: string[];
  asks?: string[];
  tests?: TestCounts | null;
  criteria?: { text: string; met: boolean | null; evidence?: string }[];
}

/** A run as the lists return it: no steps (`stepsCount` says how many there are). */
export interface AiRun {
  id: string;
  projectId: string;
  kind: 'team' | 'assistant' | 'schedule';
  ticketId: string | null;
  target: string | null;
  memberId: string;
  number: number;
  mode: 'work' | 'ask';
  trigger: string;
  state: RunState;
  startedBy: string;
  instruction: string;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  lastOutputAt: string | null;
  endedReason: string | null;
  endedBy: string | null;
  exitCode: number | null;
  summary: string | null;
  report: RunReport;
  question: RunQuestion | null;
  answer: string | null;
  sessionId: string | null;
  sessionName: string | null;
  files: { path: string; added: number; removed: number; new?: boolean }[];
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  contextUsed: number | null;
  contextWindow: number | null;
  pid: number | null;
  model: string | null;
  effort: string | null;
  paused: boolean;
  stopCode: string | null;
  peakRssMb: number | null;
  lastRssMb: number | null;
  /** The CLI started again inside this run (the system, over the RAM limit; or a person). */
  restarts?: RestartEntry[];
  diagnosis: RunDiagnosis | null;
  retries: RunRetry[];
  accountId: string | null;
  stepsCount: number;
  /** The lead's process is up with its input open: a message reaches it at once. */
  live: boolean;
  waitingReason: string | null;
}

/** `GET /ai/runs/{id}`: the run, its subagents and the newest steps (more are fetched by page). */
export interface AiRunFull extends AiRun {
  agents: RunAgent[];
  steps: RunStep[];
}

export interface RunMessage {
  id: string;
  direction: 'in' | 'out';
  peer: string;
  text: string;
  at: string;
  deliveredAt: string | null;
}

/** `GET /projects/{id}/ai/live`: the newest steps of the active runs. */
export interface AiLive {
  runs: AiRun[];
  steps: (RunStep & { ticketId: string | null; memberId: string })[];
}

/** SSE `ai.step` (keys camel-cased). */
export interface AiStepEvent {
  type: 'ai.step';
  runId: string;
  state: RunState;
  stepsCount: number;
  lastOutputAt: string | null;
  steps: RunStep[];
  truncated: boolean;
  agents?: RunAgent[];
  fields?: Partial<AiRun>;
}

export interface AiRunEvent {
  type: 'ai.run';
  run: AiRun;
}

export interface AiMessageEvent {
  type: 'ai.message';
  runId: string;
  peer?: string;
  text?: string;
}

export interface AiLesson {
  id: string;
  text: string;
  state: 'proposed' | 'kept' | 'dropped';
  tokens: number;
  sourceTicketId: string | null;
  sourceRunId: string | null;
  proposedBy: string | null;
  keptBy: string | null;
  uses: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

/** What the board found out about a run in trouble, by code (or a light model), and what it allows. */
export interface RunDiagnosis {
  at: string;
  by: 'code' | 'model';
  cause: string;
  boardFault?: boolean;
  trigger: string;
  what: string;
  means: string;
  tried: string[];
  actions: string[];
  child?: { pid: number; cmd: string; cpu?: number; rssMb?: number } | null;
  lesson?: string;
  quietS?: number;
  process?: { alive: boolean; cpu: number; rssMb: number };
  confidence?: 'high' | 'medium' | 'low';
  clearedAt?: string;
  clearedWhy?: string;
}

export interface RunRetry {
  at: string;
  kind: string;
  n: number;
  of: number;
  label: string;
  detail: string;
  delayS: number;
}

/** Where local runners run: the computer the board's server runs on. */
export interface RunnerInfo {
  host: string;
  local: boolean;
  appVersion: string;
  platform: string;
}

/** Where a lead or a role is working now (`GET .../ai/team/activity`). */
export interface ActivityNow {
  runId: string;
  ticketId: string | null;
  ticketTitle: string | null;
  number: number;
  since: string | null;
  /** The newest thing it did (a tool call, an edit, a command), or null before its first step. */
  step: { title: string; kind: string; at: string } | null;
  stepsCount?: number;
  state?: RunState;
  contextUsed?: number | null;
  contextWindow?: number | null;
}

export interface ActivityLast {
  runId: string;
  ticketId: string | null;
  ticketTitle: string | null;
  number: number;
  at: string;
  stepsCount?: number;
  state?: RunState;
  /** The first line of what the role said last. */
  text?: string | null;
}

/** What the lead, or one role of a team, does now, did last, and how much it worked today. Never money. */
export interface RoleActivity {
  /** `key` is the role key; the lead has none. */
  key?: string;
  working: ActivityNow | null;
  lastWorked: ActivityLast | null;
  stepsToday: number;
  runsToday: number;
}

export interface TeamActivity {
  teamId: string;
  day: string;
  lead: RoleActivity;
  roles: (RoleActivity & { key: string })[];
}

export interface RecentRun {
  runId: string;
  ticketId: string | null;
  ticketTitle: string | null;
  memberId: string;
  number: number;
  state: RunState;
  endedAt: string;
  stepsCount: number;
  /** The first line of its report. */
  line: string;
}

export interface RecentNote {
  id: string;
  runId: string;
  ticketId: string | null;
  ticketTitle: string | null;
  memberId: string;
  direction: 'in' | 'out';
  peer: string;
  text: string;
  at: string;
}

export interface AiRecent {
  runs: RecentRun[];
  notes: RecentNote[];
}
