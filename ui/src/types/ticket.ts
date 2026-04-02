export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type Status = 'backlog' | 'todo' | 'in-progress' | 'done';
export type IssueType = 'bug' | 'feature' | 'task' | 'chore';

export interface Comment {
  id: string;
  text: string;
  createdAt: string;
}

export interface SubTask {
  id: string;
  text: string;
  completed: boolean;
}

export interface ActivityEntry {
  id: string;
  action: string;
  timestamp: string;
}

export interface WorkLogEntry {
  id: string;
  author: string;
  role: 'PM' | 'Developer' | 'BA' | 'Tester' | 'Designer' | 'Other';
  note: string;
  loggedAt: string;
}

export type TestCaseStatus = 'todo' | 'pass' | 'fail';

export interface TestCase {
  id: string;
  title: string;
  status: TestCaseStatus;
  proof: string;
  note: string;
  createdAt: string;
}

export interface Ticket {
  id: string;
  title: string;
  description: string;
  type: IssueType;
  status: Status;
  priority: Priority;
  tags: string[];
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
  comments: Comment[];
  subTasks: SubTask[];
  estimate: number | null;
  activityLog: ActivityEntry[];
  workLog?: WorkLogEntry[];
  testCases?: TestCase[];
}

export interface Column {
  id: Status;
  label: string;
  accentColor: string;
}
