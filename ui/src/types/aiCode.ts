/** Worktrees and the hand-over of code (design/screens/ai-operations.md, I and J). Camel-cased by the client. */
export type WorktreeState = 'active' | 'conflict' | 'kept' | 'merged' | 'removed';
export type HandoverRoute = 'auto' | 'pr' | 'local' | 'branch';

export interface WorktreeLive {
  uncommitted: string[];
  /** The untracked outputs among them (screenshots, logs, reports): they belong in the Workspace, not the branch. */
  outputs?: string[];
  sizeMb: number;
  exists: boolean;
  ahead: number;
}

export interface Worktree {
  ticketId: string;
  projectId: string;
  repo: string;
  path: string;
  branch: string;
  base: string | null;
  port: number | null;
  state: WorktreeState;
  handover: HandoverRoute | null;
  prUrl: string | null;
  prNumber: number | null;
  conflictFiles: string[];
  preparedAt: string | null;
  prepareS: number | null;
  createdAt: string;
  lastUsedAt: string | null;
  mergedAt: string | null;
  live: WorktreeLive | null;
}

export interface WorktreeList {
  worktrees: Worktree[];
  totalMb: number;
}

export interface WorktreeWithRoute extends Worktree {
  /** The route that will be used: the ticket's choice, else the project's, else the guess. */
  route: HandoverRoute;
}

export interface MergeResult {
  merged: boolean;
  conflict?: string[];
  refused?: string;
  prReady?: boolean;
  prUrl?: string;
  pushed?: boolean;
}

export interface CleanupResult {
  removed: string[];
  kept: { ticketId: string; why: string }[];
}
