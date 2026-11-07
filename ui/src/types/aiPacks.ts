/** Role packs and the repository scan, as the client sees them after camelCase conversion. */

export type PackModel = 'haiku' | 'sonnet' | 'opus';
export type PackWrites = 'nothing' | 'ticket' | 'worktree' | 'tests' | 'canvas';
export type HandoverKind = 'local' | 'pr' | 'branch';

export interface Pack {
  /** "builtin:dev" for a ready-made one. */
  id: string;
  key: string;
  name: string;
  glyph: string;
  tagline: string;
  model: PackModel;
  retryModel?: PackModel | null;
  effort: string;
  depthModels?: { light: PackModel; standard: PackModel; deep: PackModel } | null;
  writes: PackWrites;
  handsIn: string;
  plugins: string[];
  mcp: string[];
  personas?: string[] | null;
  limits: { maxParallel: number; maxRunsPerDay: number };
  persona: string;
  version: number;
  builtin: boolean;
  projectId?: string | null;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

/** The fields a person can change; the rest is the pack's identity. */
export type PackDraft = Pick<
  Pack,
  | 'name'
  | 'tagline'
  | 'model'
  | 'retryModel'
  | 'effort'
  | 'writes'
  | 'handsIn'
  | 'plugins'
  | 'mcp'
  | 'limits'
  | 'persona'
> &
  Partial<Pick<Pack, 'depthModels' | 'personas' | 'glyph'>>;

export interface PackExport {
  format: 'kanban-role-pack/1';
  key: string;
  version: number;
  pack: Partial<Pack>;
}

export interface PackImportResult {
  pack: Pack;
  /** Plugin names the pack uses that this project does not have. */
  missing: string[];
}

export interface MakeMemberBody {
  name: string;
  workingDir?: string;
  accountId?: string | null;
  plays?: string;
}

export interface CatalogueEntry {
  key: string;
  name: string;
  kind: string;
  roles: string[];
  what: string;
}

export interface ScanPackage {
  path: string;
  kind: string;
  scripts?: Record<string, string> | string[];
  manager?: string;
}

/** The four commands a project keeps; test, lint and build are checks, prepare runs before a ticket starts. */
export type CommandName = 'prepare' | 'test' | 'lint' | 'build';
/** The ones a workflow's Checks step can run. */
export type CheckName = 'test' | 'lint' | 'build';

/**
 * What the board's own run of a command found. "wrong": the shell could not run it (not found, missing script);
 * "fails": it ran and the repository failed it.
 */
export type TrialStatus = 'works' | 'wrong' | 'fails' | 'timeout' | 'not_run' | 'running' | 'waiting';

export interface TrialRun {
  command: string;
  status: TrialStatus;
  ok: boolean;
  exitCode: number | null;
  seconds: number;
  tail: string[];
  /** For not_run ("prepare failed first", "empty") and wrong (a short why). */
  reason?: string | null;
}

export interface SuggestedMember {
  pack: string;
  name: string;
  plays?: string;
}

export interface Suggestion {
  commands: { test?: string | null; lint?: string | null; build?: string | null };
  prepare: string | null;
  basePort: number | null;
  team: SuggestedMember[];
  plugins: string[];
  handover: HandoverKind;
  worktrees: boolean;
  why: { commands?: string; team?: string; handover?: string };
}

export interface Scan {
  id: string;
  projectId: string;
  folder: string;
  found: {
    languages: string[];
    frameworks: string[];
    packages: ScanPackage[];
    ciCommands: string[];
    agentFiles: string[];
    monorepo: boolean;
    tests: unknown;
    ui: boolean;
    git: boolean;
    remote: string | null;
    files: number;
    docker: boolean;
    makefileTargets: string[];
    readmeLines: number;
  };
  suggested: Suggestion;
  /** The board's runs, one per command (null: not run). */
  trial: Record<CommandName, TrialRun | null>;
  /** The AI can be started: Claude Code is installed and signed in on this computer. */
  aiAvailable: boolean;
  aiUnavailableWhy: string | null;
  /** The app's own PATH, which the project's extra folders go in front of. */
  basePath: string;
  /** The latest AI or "try" job on this scan; {} before any. */
  job: ScanJob | Record<string, never>;
  /** What the AI proposed; {} before it ran. */
  proposal: Proposal | Record<string, never>;
  appliedAt: string | null;
  createdAt: string;
}

export type JobState = 'running' | 'done' | 'failed' | 'cancelled' | 'timeout';
export type JobStepState = 'done' | 'running' | 'waiting' | 'failed' | 'skipped';

export interface JobStep {
  key: string;
  label: string;
  detail: string;
  state: JobStepState;
  /** Seconds after the start at which the step began. */
  atS: number | null;
}

export interface ScanJob {
  mode: 'ai' | 'try';
  state: JobState;
  startedAt: string;
  endedAt: string | null;
  elapsedS: number;
  hint: string;
  steps: JobStep[];
  /** Newest last, trimmed to the last lines. */
  log: string[];
  error: string | null;
}

export interface ProposedCommand {
  /** "" = nothing found. */
  command: string;
  source: string;
  note: string;
}

export interface EnvFolder {
  path: string;
  by: 'ai' | 'you' | 'project';
  why?: string;
}

export interface Proposal {
  commands: Partial<Record<CommandName, ProposedCommand>>;
  envPath: EnvFolder[];
  notes: string;
}

export interface ApplyBody {
  commands: Suggestion['commands'];
  prepare: string | null;
  basePort: number | null;
  handover: HandoverKind;
  worktrees: boolean;
  team: SuggestedMember[];
  plugins: string[];
  accountId: string | null;
  /** The extra PATH folders the project's commands run with. */
  envPath: string[];
  /** Commands saved but not run as checks (out of test, lint, build). */
  checksOff: CheckName[];
}

export type CommandTexts = Record<CommandName, string>;

/** Ask the AI to read the repository and set up the commands. */
export interface AiBody {
  hint: string;
  commands?: CommandTexts;
  /** Rows the AI must not change: ones that work, or typed by the person. */
  keep?: CommandName[];
  envPath?: string[];
}

/** Have the board run the commands (prepare first when set). */
export interface TryBody {
  commands: CommandTexts;
  envPath: string[];
  /** Limits which commands run (a single row's Run). */
  only?: CommandName[];
}

export interface ApplyResult {
  created: { id: string; name: string; pack: string }[];
  skipped: { name: string; why: string }[];
  plugins: string[];
  pluginFailures: { plugin: string; why: string }[];
  settings: unknown;
}

/** The pack an AI member was made from (GET /ai/members/{id}/pack), or null when it was not made from one. */
export interface MemberPack {
  key: string;
  name?: string | null;
  /** The version the member has. */
  version: number;
  /** The pack's newest version; null when the pack is gone. */
  latest: number | null;
  outdated: boolean;
  /** A person changed the instructions the pack wrote. */
  edited?: boolean;
  /** The versions it can go back to, newest first (kept 30 days). */
  history?: { version: number; at: string; by: string | null }[];
}

/** What an update to the pack's newest version changes on the member. */
export interface MemberPackDiff extends MemberPack {
  to: number;
  changes: { field: string; label: string; before: string; after: string }[];
  /** What stays the member's own. */
  kept: string[];
}
