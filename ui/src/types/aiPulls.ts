export interface PullComment {
  id: string;
  author: string;
  body: string;
  path: string | null;
  line: number | null;
  /** The board gave this comment to the ticket's team as a new run (the run's id). */
  handledAt?: string | null;
  runId?: string | null;
  /** How it reached the team: `new_run`, or into a run that was already working. */
  delivered?: string | null;
}

export interface PullRed {
  check: string;
  url: string | null;
  at: string | null;
  /** False: the same check is red on the base branch too, so it is not this ticket's failure. */
  blamed: boolean;
  /** Whether the base branch is red on the same check could not be found out. */
  baseUnknown?: boolean;
  base: string | null;
  handledAt: string | null;
  runId: string | null;
  delivered?: string | null;
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
