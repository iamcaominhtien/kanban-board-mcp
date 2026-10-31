/** AI accounts: separate logins of one AI CLI that AI members can share (design/screens/ai-accounts.md). */

export type AccountCli = 'claude' | 'codex' | 'opencode' | 'agy';

/** signing_in comes from the open sign-in window; checking and not_ready are drawn by the UI, never stored. */
export type AccountStatus = 'signed_in' | 'needs_sign_in' | 'cli_missing' | 'signing_in';

export interface AccountMemberRef {
  id: string;
  name: string;
  projectId: string;
}

export interface AiAccount {
  id: string;
  name: string;
  cli: AccountCli;
  cliLabel: string;
  /** The AI member type this account serves (claude-code, codex, opencode, antigravity). */
  provider: string;
  status: AccountStatus;
  statusDetail: string | null;
  /** Only Claude Code says who is signed in. */
  email: string | null;
  plan: string | null;
  /** Subscription, ChatGPT login, Google sign-in, ... */
  method: string | null;
  folder: string;
  /** Runs of members on this account start today (false would show "Not ready"; all four CLIs run now). */
  runnable: boolean;
  /** Why an account of this CLI cannot be made here ("Not available on Windows"), else null. */
  unavailable: string | null;
  checkedAt: string | null;
  signedOutAt: string | null;
  signedOutHow: 'run' | 'check' | null;
  /** Who has the sign-in window open right now. */
  signingInBy: string | null;
  createdAt: string;
  createdBy: string | null;
  membersHere: AccountMemberRef[];
  membersElsewhere: AccountMemberRef[];
  memberCount: number;
}

/** One CLI an account can be made for (step 1 of Add an AI account). */
export interface AccountCliCard {
  cli: AccountCli;
  label: string;
  blurb: string;
  provider: string;
  found: boolean;
  runnable: boolean;
  unavailable: string | null;
}

export interface AccountsOverview {
  accounts: AiAccount[];
  clis: AccountCliCard[];
  platform: string;
  /** This computer can open a pseudo-terminal for the sign-in window. */
  terminal: boolean;
}

/** The account an AI member runs as (in AiMember.accountRef). */
export interface MemberAccountRef {
  id: string;
  name: string;
  cli: AccountCli;
  cliLabel: string;
  status: AccountStatus;
  email: string | null;
  plan: string | null;
  method: string | null;
  signedOutAt: string | null;
  /** How many AI members share the account (and its limits). */
  sharedBy: number;
}

/** A login the CLI already has on this computer (what members use when no account is chosen). */
export interface ComputerLogin {
  cli: AccountCli;
  label: string;
  signedInWith: string | null;
}

export type SignInPhase = 'waiting' | 'choose_method' | 'browser' | 'paste_code' | 'trust_folder' | 'error';

/** What the sign-in window shows besides the terminal (the "state" message of the terminal socket). */
export interface SignInState {
  type: 'state';
  running: boolean;
  /** exited | cancelled | done once the terminal is closed. */
  ended: 'exited' | 'cancelled' | 'done' | null;
  exitCode: number | null;
  signedIn: boolean;
  /** Claude Code only: name of the account that already has this same login. */
  duplicateOf: string | null;
  /** Seconds since the sign-in started. */
  elapsed: number;
  account: AiAccount | null;
  phase: SignInPhase;
  /** The last link the CLI printed. */
  url: string | null;
}

export type SignInStart =
  | { mode: 'terminal' }
  /** No pseudo-terminal: the command to run in the person's own terminal; the window polls the account. */
  | { mode: 'fallback'; reason: string; command: string };

export type TerminalMessage = { type: 'out'; data: string } | SignInState;

export type RemoveMembersPolicy = 'login' | 'other' | 'none';
