export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type Status = 'backlog' | 'todo' | 'in-progress' | 'done' | 'wont_do';
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

export interface WorkLogEntry {
  id: string;
  author: string;
  role: WorkLogRole;
  note: string;
  at: string; // ISO datetime
}

export type TestCaseStatus = 'pending' | 'pass' | 'fail';

export interface TestCase {
  id: string;
  title: string;
  status: TestCaseStatus;
  proof: string | null;
  note: string | null;
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
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  prefix: string;
  color: string;
  ticketCounter: number;
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
}
