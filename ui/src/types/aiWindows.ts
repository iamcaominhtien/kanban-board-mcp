/** The usage window of Claude accounts (GET /ai/windows), as the client sees it after camelCase conversion. */

export type WindowStatus = string | null;

export interface UsageWindow {
  /** 0..1 of the window that is used, or null when it has not been read. */
  used: number | null;
  resetsAt: string | null;
  status: WindowStatus;
}

export interface WindowRun {
  runId: string;
  ticketId: string;
  memberId: string;
  startedAt: string | null;
}

export interface AccountWindow {
  /** An account id, or "local": the members on this computer's own Claude login. */
  key: string;
  name: string;
  email: string | null;
  plan: string | null;
  status: string;
  maxParallel: number;
  running: WindowRun[];
  /** How many runs wait on this account. */
  waiting: number;
  fiveHour: UsageWindow;
  sevenDay: UsageWindow;
  heldUntil: string | null;
  heldReason: string | null;
  moveUrgent: boolean;
  /** When Claude Code last reported the window. */
  readAt: string | null;
}

/** A Claude account that could take one more run now. */
export interface RoomAccount {
  accountId: string;
  name: string;
  email: string | null;
  plan: string | null;
  used: number | null;
  free: number;
}

export interface WindowsOverview {
  accounts: AccountWindow[];
  room: RoomAccount[];
}

export interface WindowPatch {
  maxParallel?: number;
  moveUrgent?: boolean;
}
