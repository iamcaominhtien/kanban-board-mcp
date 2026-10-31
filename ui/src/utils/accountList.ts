import type { AccountCli, AccountMemberRef, AiAccount, RemoveMembersPolicy } from '../types/aiAccounts';

/** Rules behind the AI accounts tab (design/screens/ai-accounts.md, B1, B2, F): what each row, banner and dialog says. */

/** The two-letter badge of each CLI (design B1: CC, CX, OC, AG). */
export const CLI_BADGE: Record<AccountCli, { short: string; bg: string; color: string }> = {
  claude: { short: 'CC', bg: '#FBEFE6', color: '#B4571F' },
  codex: { short: 'CX', bg: '#E8F1FA', color: '#244E78' },
  opencode: { short: 'OC', bg: '#EFE8FB', color: '#5B3AA6' },
  agy: { short: 'AG', bg: '#E6F2EA', color: '#1F5A31' },
};

/** Where each CLI is installed from (mirrors guide_url in server/services/ai/providers.py). */
export const GUIDE_URL: Record<AccountCli, string> = {
  claude: 'https://docs.claude.com/en/docs/claude-code/setup',
  codex: 'https://developers.openai.com/codex/cli',
  opencode: 'https://opencode.ai/docs',
  agy: 'https://antigravity.google',
};

/** Why Add account and Sign in are off in the web build (the sentence is the tooltip). */
export const DESKTOP_ONLY = 'AI accounts need the desktop app. Signing in runs a terminal on your computer.';

export type StatusKey =
  'signed_in' | 'needs_sign_in' | 'signing_in' | 'checking' | 'cli_missing' | 'not_ready' | 'unavailable';

export interface StatusView {
  key: StatusKey;
  label: string;
  bg: string;
  color: string;
  dot: string;
  /** The line under the chip. */
  sub: string | null;
  subTone: 'hint' | 'bad' | 'warn';
}

const TONES: Record<StatusKey, Pick<StatusView, 'bg' | 'color' | 'dot'>> = {
  signed_in: { bg: '#E6F2EA', color: '#1F5A31', dot: '#2E6F40' },
  needs_sign_in: { bg: '#FDECE8', color: '#A5321E', dot: '#C4432A' },
  signing_in: { bg: '#E8F1FA', color: '#244E78', dot: '#2F6FB0' },
  checking: { bg: '#F1F3F1', color: '#5B6B60', dot: '#9AA8A0' },
  cli_missing: { bg: '#FEF3D9', color: '#7A5A06', dot: '#E8B93A' },
  not_ready: { bg: '#FEF3D9', color: '#7A5A06', dot: '#E8B93A' },
  unavailable: { bg: '#F1F3F1', color: '#5B6B60', dot: '#9AA8A0' },
};

/** "1 member", "3 members", "No members". */
export function membersCount(n: number): string {
  return n === 0 ? 'No members' : `${n} member${n === 1 ? '' : 's'}`;
}

/** Every AI member that runs as the account, in this project first. */
export function usersOf(a: AiAccount): AccountMemberRef[] {
  return [...a.membersHere, ...a.membersElsewhere];
}

/** "just now", "2 min ago", "3 h ago", "Oct 12". `nowMs` is passed so the result can be tested. */
export function agoWords(iso: string | null, nowMs: number): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** "4 minutes ago" for a sentence ("Its session expired 4 minutes ago"). */
export function longAgo(iso: string | null, nowMs: number): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (s < 3600) return unit(Math.floor(s / 60), 'minute');
  if (s < 86400) return unit(Math.floor(s / 3600), 'hour');
  return unit(Math.floor(s / 86400), 'day');
}

/** "Oct 12". */
export function addedOn(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The chip, and the line under it, for an account. `checking` is true while the CLI is being asked. */
export function statusView(a: AiAccount, checking: boolean, nowMs: number): StatusView {
  const view = (
    key: StatusKey,
    label: string,
    sub: string | null,
    subTone: StatusView['subTone'] = 'hint',
  ): StatusView => ({
    key,
    label,
    sub,
    subTone,
    ...TONES[key],
  });
  const checked = a.checkedAt ? `Checked ${agoWords(a.checkedAt, nowMs)}` : 'Not checked yet';
  const n = a.memberCount;
  if (a.unavailable) return view('unavailable', a.unavailable, null);
  if (a.status === 'cli_missing')
    return view('cli_missing', 'CLI not installed', n ? 'Its members are paused.' : null, 'warn');
  if (a.status === 'signing_in')
    return view('signing_in', 'Signing in', a.signingInBy ? `${a.signingInBy} is signing in` : null);
  if (checking) return view('checking', 'Checking', 'Checked now');
  if (a.status === 'needs_sign_in') {
    const why = a.signedOutAt ? 'Session expired.' : 'Not signed in yet.';
    return view(
      'needs_sign_in',
      'Needs sign-in',
      n ? `${why} ${n} member${n === 1 ? '' : 's'} can’t run.` : why,
      'bad',
    );
  }
  if (!a.runnable) return view('not_ready', 'Not ready', 'Runs don’t start yet for this CLI.', 'warn');
  return view('signed_in', 'Signed in', checked);
}

/** What the account is signed in with: a first line (method and plan) and a second (who, when the CLI says). */
export function signedInWith(a: AiAccount): { primary: string; secondary: string | null } {
  const plan = a.plan ? a.plan.charAt(0).toUpperCase() + a.plan.slice(1) : null;
  let method = a.method;
  if (a.cli === 'claude' && method) method = method.charAt(0).toUpperCase() + method.slice(1);
  if (a.cli === 'codex' && method && !/login/i.test(method)) method = `${method} login`;
  const primary = [method, plan].filter(Boolean).join(' · ') || (a.status === 'signed_in' ? 'Signed in' : '—');
  return { primary, secondary: a.email };
}

/** Accounts that are signed out (the banner above the list names each once). */
export function needsAttention(accounts: AiAccount[]): AiAccount[] {
  return accounts.filter((a) => a.status === 'needs_sign_in' && !a.unavailable);
}

/** "Weekend helper" / "A, B, C" / "A, B, C and 2 more": the members an account holds back. */
export function namesList(members: AccountMemberRef[], max = 3): string {
  const names = [...new Set(members.map((m) => m.name))];
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** "1 AI member (X) can’t run until someone signs in." (empty when no member uses the account). */
export function cantRunClause(a: AiAccount, tail = 'until someone signs in'): string {
  const users = usersOf(a);
  if (!users.length) return '';
  const n = new Set(users.map((u) => u.id)).size;
  return `${n} AI member${n === 1 ? '' : 's'} (${namesList(users)}) can’t run ${tail}.`;
}

/** The banner for a signed-out account (design B1). */
export function bannerText(a: AiAccount, nowMs: number): { title: string; body: string } {
  const since = a.signedOutAt
    ? `Its session expired ${longAgo(a.signedOutAt, nowMs)}.`
    : 'It has not been signed in yet.';
  const clause = cantRunClause(a);
  return {
    title: a.signedOutAt ? `${a.name} needs to sign in again` : `${a.name} needs to sign in`,
    body: `${since} ${clause || 'No AI member uses it.'}`,
  };
}

export interface AccountStats {
  total: number;
  signedIn: number;
  attention: string[];
  /** Members that use an account, counted once each. */
  using: number;
  here: number;
  elsewhere: number;
}

/** The four tiles above the list. */
export function accountStats(accounts: AiAccount[]): AccountStats {
  const here = new Set<string>();
  const elsewhere = new Set<string>();
  for (const a of accounts) {
    a.membersHere.forEach((m) => here.add(m.id));
    a.membersElsewhere.forEach((m) => elsewhere.add(m.id));
  }
  return {
    total: accounts.length,
    signedIn: accounts.filter((a) => a.status === 'signed_in').length,
    attention: needsAttention(accounts).map((a) => a.name),
    using: here.size + elsewhere.size,
    here: here.size,
    elsewhere: elsewhere.size,
  };
}

/** Why "Sign in again" is off for an account, or null. `desktop` is false in the web build. */
export function signInOffReason(a: AiAccount, desktop: boolean): string | null {
  if (!desktop) return DESKTOP_ONLY;
  if (a.unavailable) return a.unavailable;
  if (a.status === 'cli_missing') return `${a.cliLabel} was not found on this computer.`;
  if (a.status === 'signing_in') return 'Someone is signing in to this account.';
  return null;
}

export type MenuAction = 'sign_in' | 'check' | 'rename' | 'members' | 'sign_out' | 'remove';

export interface MenuItem {
  action: MenuAction;
  label: string;
  danger?: boolean;
  /** A divider is drawn above this item. */
  divider?: boolean;
  disabled: boolean;
  title?: string;
}

/** The row menu, exactly the design's items; the ones that cannot be used right now are off. */
export function menuItems(a: AiAccount, desktop: boolean): MenuItem[] {
  const off = (reason: string | null) => ({ disabled: !!reason, title: reason ?? undefined });
  const web = desktop ? null : DESKTOP_ONLY;
  const busy = a.status === 'signing_in' ? 'Someone is signing in to this account.' : null;
  return [
    { action: 'sign_in', label: 'Sign in again', ...off(signInOffReason(a, desktop)) },
    { action: 'check', label: 'Check now', ...off(web) },
    { action: 'rename', label: 'Rename', ...off(web) },
    { action: 'members', label: 'See members using it', disabled: false },
    { action: 'sign_out', label: 'Sign out', divider: true, ...off(web ?? busy) },
    { action: 'remove', label: 'Remove…', danger: true, ...off(web ?? busy) },
  ];
}

/** The accounts of the same CLI a member could move to when this one is removed. */
export function otherAccounts(a: AiAccount, all: AiAccount[]): AiAccount[] {
  return all.filter((o) => o.id !== a.id && o.cli === a.cli);
}

/** What the "Pick another account" option shows after its label: "Personal Claude (needs sign-in)". */
export function otherHint(o: AiAccount | undefined): string {
  if (!o) return 'no other account of this CLI';
  return o.status === 'needs_sign_in' ? `${o.name} (needs sign-in)` : o.name;
}

/** Whether Remove account can be pressed with this choice. */
export function removeReady(
  a: AiAccount,
  policy: RemoveMembersPolicy,
  otherId: string | null,
  all: AiAccount[],
): boolean {
  if (!usersOf(a).length) return true;
  if (policy !== 'other') return true;
  return !!otherId && otherAccounts(a, all).some((o) => o.id === otherId);
}

/** A problem with the name typed in Rename, found without asking the server; null when it can be asked. */
export function nameProblem(name: string, all: AiAccount[], selfId?: string): string | null {
  const clean = name.split(/\s+/).filter(Boolean).join(' ');
  if (!clean) return 'Give the account a name.';
  if (clean.length > 60) return 'Use at most 60 characters.';
  if (all.some((o) => o.id !== selfId && o.name.toLowerCase() === clean.toLowerCase())) {
    return 'An account with this name exists.';
  }
  return null;
}

/** CLIs that have an account but are not installed any more (the "was not found" notice names each once). */
export function missingClis(accounts: AiAccount[]): { cli: AccountCli; label: string }[] {
  const seen = new Map<AccountCli, string>();
  for (const a of accounts) if (a.status === 'cli_missing' && !seen.has(a.cli)) seen.set(a.cli, a.cliLabel);
  return [...seen].map(([cli, label]) => ({ cli, label }));
}
