export interface EvalSuite {
  key: string;
  name: string;
  tasks: number;
  runnable: boolean;
}

export interface MarkDetail {
  task: string;
  score: number;
  notes: string | null;
  model: string | null;
  costUsd: number | null;
}

export interface Mark {
  id: string;
  suite: string;
  memberId: string | null;
  model: string | null;
  state: 'running' | 'done';
  score: number | null;
  details: MarkDetail[];
  createdAt: string;
  endedAt: string | null;
}
