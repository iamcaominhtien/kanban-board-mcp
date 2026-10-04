export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type Status = 'backlog' | 'todo' | 'in-progress' | 'review' | 'testing' | 'done' | 'wont_do';
export type IssueType = 'bug' | 'feature' | 'task' | 'chore';
export type RelationType = 'relates_to' | 'causes' | 'caused_by' | 'duplicates' | 'duplicated_by';

export interface TicketLink {
  id: string;
  targetId: string;
  relationType: RelationType;
}

export interface Member {
  id: string;
  projectId: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface Comment {
  id: string;
  text: string;
  author: string;
  at: string; // ISO datetime
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  done: boolean;
}

export interface ActivityEntry {
  field: string;
  from: string | null;
  to: string | null;
  at: string; // ISO datetime
}

export type WorkLogRole = 'PM' | 'Developer' | 'BA' | 'Tester' | 'Designer' | 'Other';

export type DebugEntryKind = 'investigation' | 'fix_attempt' | 'root_cause' | 'blocked' | 'resolved';

export interface DebugAttachment {
  id: string;
  name: string;
  url: string;
  size?: number;
  type?: string;
}

export interface WorkLogEntry {
  id: string;
  author: string;
  role: WorkLogRole | string;
  note: string;
  at: string; // ISO datetime
  kind?: DebugEntryKind;
  pinned?: boolean;
  attachments?: DebugAttachment[];
  linkedBranch?: string | null;
  linkedTestCase?: string | null;
  updatedAt?: string | null;
}

export type DebugEntry = WorkLogEntry;

export type TestCaseStatus = 'pending' | 'running' | 'pass' | 'fail';

export interface TestCaseFileData {
  id: string;
  name: string;
  url: string;
  size?: number;
  type?: string;
}

export interface TestCase {
  id: string;
  code?: string; // e.g. "TC-1"
  title: string;
  status: TestCaseStatus;
  description?: string | null;
  expectedResult?: string | null;
  notes?: string | null;
  proof?: string | null; // legacy
  note?: string | null;  // legacy
  startedAt?: string | null;
  createdAt?: string;
  updatedAt?: string | null;
  assignee?: string | null;
  testDataFiles?: TestCaseFileData[];
}

export interface Ticket {
  id: string;
  projectId: string;
  title: string;
  description: string;
  type: IssueType;
  status: Status;
  priority: Priority;
  estimate: number | null;
  dueDate: string | null;
  startDate: string | null;
  tags: string[];
  parentId: string | null;
  comments: Comment[];
  acceptanceCriteria: AcceptanceCriterion[];
  activityLog: ActivityEntry[];
  workLog: WorkLogEntry[];
  testCases: TestCase[];
  wontDoReason: string | null;
  createdBy: string | null;
  assignee: string | null;
  blocks: string[];
  blockedBy: string[];
  blockDoneIfAcsIncomplete: boolean;
  blockDoneIfTcsIncomplete: boolean;
  links: TicketLink[];  // extended relationship links
  branches?: TicketBranch[];
  workspaceRetentionDays?: number | null;
  repoPath?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSettings {
  id: number;
  enabled: boolean;
  rootPath: string;
  defaultRetentionDays: number | null;
}

export interface WorkspaceFile {
  name: string;
  size: number;
  modifiedAt: string;
}

export interface TicketWorkspaceInfo {
  enabled: boolean;
  path: string;
  exists: boolean;
  retentionDays: number | null;
  files: WorkspaceFile[];
  fileCount: number;
  totalBytes: number;
}

export type BranchStatus = 'baseline' | 'open' | 'merged' | 'stale' | 'archived';

export interface TicketBranch {
  id: string;
  name: string;
  status: BranchStatus;
  branchFrom: string;
  prUrl?: string | null;
  commitHash?: string | null;
  linkedTicketId?: string | null;
  aheadCount?: number;
  behindCount?: number;
  /** false when a git repo is linked but this branch doesn't exist in it */
  inRepo?: boolean;
  /** true when this branch is checked out in the repo's main working tree */
  isCurrent?: boolean;
  worktreePath?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  prefix: string;
  color: string;
  ticketCounter: number;
  repoPath?: string | null;
  worktreeTemplate?: string | null;
  worktreeByDefault?: boolean;
}

export interface Column {
  id: Status;
  label: string;
  accentColor: string;
}

export type Theme = 'default' | 'bw';

// ─── Idea Board ───────────────────────────────────────────────────────────────
export type IdeaStatus = 'draft' | 'in_review' | 'approved' | 'dropped';
export type IdeaColor = 'yellow' | 'orange' | 'lime' | 'pink' | 'blue' | 'purple' | 'teal';
export type IdeaEnergy = 'seed' | 'concept' | 'hot' | 'big_bet';

export interface IdeaActivityEntry {
  id: string;
  label: string;       // e.g. "Status changed to In Review", "Description updated"
  at: string;          // ISO datetime
}

export interface IdeaMicrothought {
  id: string;
  text: string;
  at: string;          // ISO datetime
}

export type IdeaAssumptionStatus = 'untested' | 'validated' | 'invalidated';

export interface IdeaAssumption {
  id: string;
  text: string;
  status: IdeaAssumptionStatus;
}

export interface IdeaTicket {
  id: string;
  title: string;
  description: string;
  ideaStatus: IdeaStatus;
  ideaColor: IdeaColor;
  ideaEmoji: string;
  ideaEnergy?: IdeaEnergy;
  tags: string[];
  createdAt: string;
  updatedAt: string;

  // Feature 1 — Activity Trail
  activityTrail?: IdeaActivityEntry[];

  // Feature 2 — Microthoughts
  microthoughts?: IdeaMicrothought[];

  // Feature 3 — ICE Score
  iceImpact?: number;       // 1-5
  iceEffort?: number;       // 1-5
  iceConfidence?: number;   // 1-5

  // Feature 4 — Assumption Tracker
  assumptions?: IdeaAssumption[];

  // Feature 5 — Revisit Date + Staleness
  revisitDate?: string;     // ISO date string
  lastTouchedAt?: string;   // ISO datetime, auto-updated on save

  // Feature 6 — Promotion Trail
  promotedToTicketId?: string;
  promotedAt?: string;

  // Feature 7 — Problem Statement
  problemStatement?: string;
}

export interface GraphRef {
  name: string;
  type: 'head' | 'branch' | 'remote' | 'tag';
}

export interface GraphCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  refs: GraphRef[];
  lane: number;
  ticketBranches: string[];
}

export interface BranchGraphData {
  linked: boolean;
  base?: string | null;
  current?: string | null;
  branches?: string[];
  commits: GraphCommit[];
  laneCount: number;
  truncated: boolean;
}

export interface CommitFileChange {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | string;
  path: string;
  oldPath?: string | null;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface CommitDetail {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  authorEmail: string;
  date: string;
  committer: string;
  committerDate: string;
  subject: string;
  body: string;
  files: CommitFileChange[];
  fileCount: number;
  additions: number;
  deletions: number;
  filesTruncated: boolean;
}
