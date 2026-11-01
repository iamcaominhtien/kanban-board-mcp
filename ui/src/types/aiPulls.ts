export interface PullComment {
  id: string;
  author: string;
  body: string;
  path: string | null;
  line: number | null;
}

export interface PullRed {
  check: string;
  url: string | null;
  at: string | null;
  /** False: the same check is red on the base branch too, so nobody is sent back. */
  blamed: boolean;
  base: string | null;
  handledAt: string | null;
  runId: string | null;
}

export interface Pull {
  ticketId: string;
  number: number;
  url: string;
  branch: string;
  state: 'open' | 'closed';
  ci: 'green' | 'red' | 'pending' | 'none' | null;
  red: PullRed | null;
  pendingComments: PullComment[];
  checkedAt: string | null;
  lastError: string | null;
}
