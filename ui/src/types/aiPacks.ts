/** Role packs and the repository scan, as the client sees them after camelCase conversion. */

export type PackModel = 'haiku' | 'sonnet' | 'opus';
export type PackWrites = 'nothing' | 'ticket' | 'worktree' | 'tests' | 'canvas';
export type WorkflowKey = 'standard' | 'feature_ui' | 'quick_fix' | 'research' | 'docs' | 'chore';
export type HandoverKind = 'local' | 'pr' | 'branch';
export type PackPermissionMode = 'allowlist' | 'bypass';

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
  template: string;
  ceiling: string;
  writes: PackWrites;
  handsIn: string;
  allow: string[];
  plugins: string[];
  mcp: string[];
  personas?: string[] | null;
  limits: { maxParallel: number; maxRunsPerDay: number };
  persona: string;
  /** How a member made from the pack runs; unset: Bypass permissions, except Triage (the allow list). */
  permissionMode?: PackPermissionMode | null;
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
  | 'template'
  | 'ceiling'
  | 'writes'
  | 'handsIn'
  | 'allow'
  | 'plugins'
  | 'mcp'
  | 'limits'
  | 'persona'
> &
  Partial<Pick<Pack, 'depthModels' | 'personas' | 'glyph' | 'permissionMode'>>;

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

export interface TrialRun {
  command: string;
  ok: boolean;
  exitCode: number | null;
  seconds: number;
  tail: string[];
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
  workflowDefault: WorkflowKey;
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
  trial: { prepare: TrialRun | null; test: TrialRun | null };
  appliedAt: string | null;
  createdAt: string;
}

export interface ApplyBody {
  commands: Suggestion['commands'];
  prepare: string | null;
  basePort: number | null;
  workflowDefault: WorkflowKey;
  handover: HandoverKind;
  worktrees: boolean;
  team: SuggestedMember[];
  plugins: string[];
  accountId: string | null;
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
