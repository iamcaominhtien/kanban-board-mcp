export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type Status = 'backlog' | 'todo' | 'in-progress' | 'review' | 'testing' | 'done' | 'wont_do';
export type IssueType = 'bug' | 'feature' | 'task' | 'chore';
export type RelationType = 'relates_to' | 'causes' | 'caused_by' | 'duplicates' | 'duplicated_by';

export interface TicketLink {
  id: string;
  targetId: string;
  relationType: RelationType;
}

export interface SubTask {
  id: string;
  text: string;
  done: boolean;
}

export interface Member {
  id: string;
  projectId: string;
  name: string;
  color: string;
  role?: 'viewer' | 'member' | 'admin';
  /** 'ai' for an AI member (its profile lives under /ai/members); 'ai_removed' keeps a removed one for history. */
  kind?: 'human' | 'ai' | 'ai_removed';
  createdAt: string;
}

export interface Comment {
  id: string;
  text: string;
  author: string;
  at: string; // ISO datetime
  /** Set when the text was changed after posting. */
  editedAt?: string | null;
  /** Member ids written as @[Name](member:id). */
  mentions?: string[];
  /** Who this comment notified (reporter, assignee, earlier commenters, mentions). */
  notified?: { id: string; name: string }[];
  /** Set on comments an AI member posted: its run and what the comment is. */
  ai?: AiCommentMeta;
  /** A note the board itself posted (e.g. a mention that was not delivered). */
  boardNote?: boolean;
  /** The comment this one answers; set under an AI's comment, which then asks that AI again (`asksAgain`). */
  replyTo?: string;
  asksAgain?: string;
  /** The question of this AI run that this comment answers (posted from the board's question card). */
  answerToRun?: string;
  /** The AI member this comment was posted to ask (Ask button). */
  askedAi?: string;
}

export interface AiCommentMeta {
  kind: 'answer' | 'summary' | 'failed' | 'ask_failed' | 'move_blocked' | 'comment';
  /** The comment an `ask_failed` reply is about. */
  replyTo?: string | null;
  runId: string;
  runNumber?: number;
  memberId: string;
  durationS?: number;
  metered?: boolean;
  costUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  model?: string | null;
  questionCommentId?: string | null;
  criteria?: { text: string; met: boolean | null; evidence?: string }[];
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  done: boolean;
}

export interface ActivityEntry {
  field: string;
  from: any;
  to: any;
  at: string; // ISO datetime
  /** Who made the change: 'user', 'agent', or a name. Absent on older entries. */
  actor?: string;
  /** Subject of the change, e.g. a test case code or branch name. */
  ref?: string;
  /** Set when an AI member made the change: the person it acted for and its run. */
  ai?: boolean;
  onBehalfOf?: string | null;
  runId?: string | null;
  memberId?: string | null;
  /** A person applied a Board AI draft: the AI that suggested the change. */
  suggestedBy?: string | null;
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
  note?: string | null; // legacy
  startedAt?: string | null;
  createdAt?: string;
  updatedAt?: string | null;
  assignee?: string | null;
  testDataFiles?: TestCaseFileData[];
  /** Acceptance criterion the case tests (coverage). */
  criterionId?: string | null;
  /** Board AI that suggested the case, when a person accepted its draft. */
  suggestedBy?: string | null;
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
  subTasks: SubTask[];
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
  links: TicketLink[]; // extended relationship links
  branches?: TicketBranch[];
  workspaceRetentionDays?: number | null;
  repoPath?: string | null;
  // Reopen fields
  reopenCount?: number;
  lastReopenedAt?: string | null;
  lastReopenedBy?: string | null;
  lastReopenReason?: string | null;
  reopenHistory?: ReopenHistoryEntry[];
  // Pending fields
  pending?: boolean;
  pendingReasonType?: 'ticket' | 'person' | 'party' | null;
  pendingTicketId?: string | null;
  pendingMemberId?: string | null;
  pendingParty?: string | null;
  pendingNote?: string | null;
  pendingSince?: string | null;
  pendingBy?: string | null;
  /** The idea this ticket was promoted from (Idea Space). */
  fromIdeaId?: string | null;
  /** The assumption of an idea this ticket tests. */
  testsAssumptionId?: string | null;
  completedAt?: string | null;
  completedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReopenHistoryEntry {
  id: string;
  reopenCount: number;
  actor?: string | null;
  reason?: string | null;
  fromStatus: Status;
  previousCompletedAt?: string | null;
  at: string;
  sideEffects?: string[];
}

export type PendingReasonType = 'ticket' | 'person' | 'party';

export interface WorkspaceSettings {
  id: number;
  enabled: boolean;
  rootPath: string;
  defaultRetentionDays: number | null;
}

export interface WorkspaceFile {
  /** Path relative to the ticket folder, using "/" separators. */
  name: string;
  isDir: boolean;
  size: number;
  modifiedAt: string;
}

export interface TicketWorkspaceInfo {
  enabled: boolean;
  path: string;
  exists: boolean;
  /** Effective retention in days; 0 = keep forever. */
  retentionDays: number;
  /** The ticket's own override; null = inherits the app default. */
  retentionOverride: number | null;
  /** Only closed (Done / Won't do) tickets are swept. */
  sweepEligible: boolean;
  expiresAt: string | null;
  files: WorkspaceFile[];
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
}

export interface WorkspaceFilePreview {
  binary: boolean;
  text: string;
  truncated: boolean;
  size: number;
}

export interface WorkspaceSweepResult {
  dryRun: boolean;
  removed: { ticketId: string; path: string; bytes: number }[];
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
  /** Docs on/off per project (server default true). */
  docsEnabled?: boolean;
  /** Who can edit Docs pages (server default "members"). */
  docsEditPolicy?: DocsEditPolicy;
}

export type DocsEditPolicy = 'everyone' | 'members' | 'admins';

export interface Column {
  id: Status;
  label: string;
  accentColor: string;
}

export type Theme = 'default' | 'bw';

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
