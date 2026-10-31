import type { AiMember, AiProvider, AiStatus } from '../types/ai';
import type { AccountCli, AccountStatus, AiAccount, MemberAccountRef } from '../types/aiAccounts';

/** The AI member types that start a CLI which has accounts (design/screens/ai-accounts.md, D). */
export const ACCOUNT_PROVIDERS: AiProvider[] = ['claude-code', 'codex', 'opencode', 'antigravity'];

/** The account CLI a member type uses. */
export const CLI_OF_PROVIDER: Partial<Record<AiProvider, AccountCli>> = {
  'claude-code': 'claude',
  codex: 'codex',
  opencode: 'opencode',
  antigravity: 'agy',
};

/** Whether a member type can use an AI account at all. */
export const usesAccounts = (provider: AiProvider): boolean => provider in CLI_OF_PROVIDER;

/** Types whose runs do not start yet; their members are made and given an account but carry a "Not ready" chip.
 * None today: Claude Code, Codex, opencode and Antigravity all run. */
const NOT_READY: AiProvider[] = [];
/** Whether runs of this member type do not start yet. */
export const runsNotReady = (provider: AiProvider): boolean => NOT_READY.includes(provider);

/** The accounts a member of this type can pick, signed-in ones first, then by name. */
export function accountsFor(accounts: AiAccount[], provider: AiProvider): AiAccount[] {
  const cli = CLI_OF_PROVIDER[provider];
  const rank = (a: AiAccount) => (a.status === 'signed_in' ? 0 : 1);
  return accounts.filter((a) => a.cli === cli).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "Max" for a plan the CLI reports, else the sign-in method, else nothing. */
export function planOrMethod(a: { plan: string | null; method: string | null }): string | null {
  return a.plan ? cap(a.plan) : (a.method ?? null);
}

/** "3 members already use it". */
export function usersText(n: number): string {
  return `${n} member${n === 1 ? '' : 's'} already use it`;
}

/**
 * The grey line under an account in the picker: who it is, the plan, how many members use it and, when it is
 * signed out and not the chosen one, that the session expired.
 */
export function accountSub(a: AiAccount, selected: boolean): string {
  const parts: (string | null)[] = [a.email, planOrMethod(a)];
  if (a.memberCount > 0 && a.status === 'signed_in') parts.push(usersText(a.memberCount));
  if (a.status === 'needs_sign_in' && !selected && a.signedOutAt) parts.push('session expired');
  if (a.status === 'cli_missing') parts.push('CLI not installed');
  return parts.filter(Boolean).join(' · ');
}

/** Look of the status chip of an account: label, background, text and dot colour. */
export interface ChipLook {
  label: string;
  bg: string;
  color: string;
  dot: string | null;
}
const CHIPS: Record<AccountStatus, ChipLook> = {
  signed_in: { label: 'Signed in', bg: '#E6F2EA', color: '#1F5A31', dot: '#2E6F40' },
  needs_sign_in: { label: 'Needs sign-in', bg: '#FDECE8', color: '#A5321E', dot: '#C4432A' },
  signing_in: { label: 'Signing in', bg: '#E8F1FA', color: '#244E78', dot: '#2F6FB0' },
  cli_missing: { label: 'CLI not installed', bg: '#FEF3D9', color: '#7A5A06', dot: '#B4791E' },
};
/** The chip for an account status. */
export const accountChip = (status: AccountStatus): ChipLook => CHIPS[status];

/** The picker cannot go on while the chosen account is not ready to run. */
export function accountReady(a: Pick<AiAccount, 'status'> | null | undefined): boolean {
  return !a || a.status === 'signed_in';
}

/**
 * How many AI members will draw from the account's limit once this one is on it (design D2: "The 4 AI members on
 * Work Claude…" next to "3 members already use it"). `alreadyOn` is true when the member being edited is one of them.
 */
export function sharingCount(a: Pick<AiAccount, 'memberCount'>, alreadyOn: boolean): number {
  return a.memberCount + (alreadyOn ? 0 : 1);
}

/** The shared-limit hint, or null while the account is used by nobody else. */
export function sharedHint(
  a: Pick<AiAccount, 'name' | 'memberCount'>,
  alreadyOn: boolean,
): { title: string; text: string } | null {
  const n = sharingCount(a, alreadyOn);
  if (n < 2) return null;
  return {
    title: 'Shared accounts share one limit',
    text: `The ${n} AI members on ${a.name} draw from the same plan limit. A busy day for one can slow the others.`,
  };
}

/** The same warning on a member's profile: "3 members share this account and its limits". */
export function sharedProfileHint(ref: MemberAccountRef): string | null {
  return ref.sharedBy > 1 ? `${ref.sharedBy} members share this account and its limits` : null;
}

/** What the Account column of the AI list shows for a member: the line, and the grey line under it. */
export function accountCell(m: AiMember): { name: string; sub: string; warn: boolean } | null {
  if (m.connection !== 'local') return null;
  const ref = m.accountRef;
  if (ref) {
    if (ref.status === 'needs_sign_in') return { name: ref.name, sub: 'Needs sign-in', warn: true };
    if (ref.status === 'cli_missing') return { name: ref.name, sub: 'CLI not installed', warn: true };
    const detail = planOrMethod(ref);
    return { name: ref.name, sub: [ref.cliLabel, detail].filter(Boolean).join(' · '), warn: false };
  }
  if (m.provider === 'opencode') return { name: 'Free models', sub: 'no account', warn: false };
  return { name: 'Login on this computer', sub: 'as before', warn: false };
}

/**
 * The status to show for a member: the account's sign-in problem says so ("Needs sign-in · account"), and a type
 * whose runs do not start yet says "Not ready" unless something more blocking applies.
 */
export function displayStatus(m: AiMember): AiStatus {
  const st = m.status;
  if (st.code === 'not_logged_in' && m.accountRef?.status === 'needs_sign_in') {
    return { ...st, label: 'Needs sign-in · account', detail: `The account ${m.accountRef.name} is signed out` };
  }
  if (runsNotReady(m.provider) && (st.code === 'idle' || st.code === 'online')) {
    return { code: 'not_ready', label: 'Not ready', detail: 'Runs don’t start yet for this CLI.' };
  }
  return st;
}

/** Members held by one signed-out account, for the banner above the AI list. */
export interface BlockedAccount {
  account: MemberAccountRef;
  members: AiMember[];
  /** Queued runs held until the account is signed in again. */
  queued: number;
}

/** One entry per signed-out account that has members in this list, however many members it hits. */
export function blockedAccounts(members: AiMember[]): BlockedAccount[] {
  const byId = new Map<string, BlockedAccount>();
  for (const m of members) {
    const ref = m.accountRef;
    if (!ref || ref.status !== 'needs_sign_in') continue;
    const slot = byId.get(ref.id) ?? { account: ref, members: [], queued: 0 };
    slot.members.push(m);
    slot.queued += m.queued;
    byId.set(ref.id, slot);
  }
  return [...byId.values()];
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Banner above the AI list for one signed-out account (design E1). */
export function bannerCopy(b: BlockedAccount): { title: string; text: string } {
  const n = b.members.length;
  const names = joinNames(b.members.map((m) => m.name));
  const held = b.queued
    ? `${n === 1 ? 'has' : 'have'} ${b.queued} queued run${b.queued === 1 ? '' : 's'} held. ${b.queued === 1 ? 'It starts by itself' : 'They start by themselves'} once the account is signed in again.`
    : `${n === 1 ? 'has' : 'have'} nothing queued. New runs start by themselves once the account is signed in again.`;
  return {
    title: `${n} AI member${n === 1 ? '' : 's'} can’t run: ${b.account.name} needs to sign in`,
    text: `${names} ${held}`,
  };
}

/** A change in an account worth telling the person about, once per account (not once per member). */
export type AccountEvent =
  { kind: 'signed_out'; account: AiAccount } | { kind: 'signed_in'; account: AiAccount; heldRuns: number };

/**
 * Compare two polls of the account list. The first poll (`prev` undefined) only records, so opening the app never
 * replays old news. `held` is the number of queued runs on each account while it was signed out.
 */
export function accountEvents(
  prev: Map<string, AccountStatus> | undefined,
  next: AiAccount[],
  held: Map<string, number>,
): AccountEvent[] {
  if (!prev) return [];
  const out: AccountEvent[] = [];
  for (const a of next) {
    const before = prev.get(a.id);
    if (!before) continue;
    if (before === 'signed_in' && a.status === 'needs_sign_in') out.push({ kind: 'signed_out', account: a });
    // A sign-in window that ends signed in is its own confirmation; this tells about the members that were held
    if (before === 'needs_sign_in' && a.status === 'signed_in' && a.memberCount > 0)
      out.push({ kind: 'signed_in', account: a, heldRuns: held.get(a.id) ?? 0 });
  }
  return out;
}

/** Toast text for an event. */
export function eventCopy(e: AccountEvent): { title: string; message: string } {
  if (e.kind === 'signed_out')
    return {
      title: `${e.account.name} needs to sign in`,
      message:
        e.account.memberCount > 0
          ? `${e.account.memberCount} AI member${e.account.memberCount === 1 ? '' : 's'} can’t run until someone signs in again. Queued runs wait.`
          : 'Its session expired.',
    };
  return {
    title: `${e.account.name} is signed in again`,
    message:
      e.heldRuns > 0
        ? `${e.heldRuns} held run${e.heldRuns === 1 ? '' : 's'} restart${e.heldRuns === 1 ? 's' : ''} by themselves.`
        : `${e.account.memberCount} AI member${e.account.memberCount === 1 ? ' is' : 's are'} back.`,
  };
}

/** The two cards of a type in step 1 get a small chip: how many accounts it has, or that the CLI is missing. */
export function typeChip(accountCount: number, found: boolean | undefined): { text: string; tone: 'grey' } | null {
  if (found === false) return { text: 'not installed', tone: 'grey' };
  if (accountCount > 0) return { text: `${accountCount} account${accountCount === 1 ? '' : 's'}`, tone: 'grey' };
  return null;
}
