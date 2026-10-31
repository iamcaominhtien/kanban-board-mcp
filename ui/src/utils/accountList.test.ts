import { describe, expect, it } from 'vitest';
import type { AiAccount } from '../types/aiAccounts';
import {
  accountStats,
  addedOn,
  agoWords,
  bannerText,
  cantRunClause,
  longAgo,
  membersCount,
  menuItems,
  missingClis,
  nameProblem,
  namesList,
  needsAttention,
  otherAccounts,
  otherHint,
  removeReady,
  signInOffReason,
  signedInWith,
  statusView,
  DESKTOP_ONLY,
} from './accountList';

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

const acct = (over: Partial<AiAccount> = {}): AiAccount => ({
  id: 'a1',
  name: 'Work Claude',
  cli: 'claude',
  cliLabel: 'Claude Code',
  provider: 'claude-code',
  status: 'signed_in',
  statusDetail: null,
  email: 'an.nguyen@work.example',
  plan: 'max',
  method: 'subscription',
  folder: '/x',
  runnable: true,
  unavailable: null,
  checkedAt: iso(120),
  signedOutAt: null,
  signedOutHow: null,
  signingInBy: null,
  createdAt: '2026-10-12T12:00:00Z',
  createdBy: 'user',
  membersHere: [],
  membersElsewhere: [],
  memberCount: 0,
  ...over,
});
const ref = (id: string, name: string, projectId = 'p1') => ({ id, name, projectId });

describe('status chip', () => {
  it('says Signed in and when it was checked', () => {
    const v = statusView(acct(), false, NOW);
    expect([v.label, v.sub]).toEqual(['Signed in', 'Checked 2 min ago']);
  });
  it('says Needs sign-in and how many members cannot run', () => {
    const v = statusView(
      acct({
        status: 'needs_sign_in',
        signedOutAt: iso(240),
        memberCount: 1,
        membersHere: [ref('m', 'Weekend helper')],
      }),
      false,
      NOW,
    );
    expect([v.label, v.sub, v.subTone]).toEqual(['Needs sign-in', 'Session expired. 1 member can’t run.', 'bad']);
  });
  it('does not claim a session expired for an account that was never signed in', () => {
    expect(statusView(acct({ status: 'needs_sign_in' }), false, NOW).sub).toBe('Not signed in yet.');
  });
  it('is Not ready for a signed-in account whose CLI cannot run yet, but Needs sign-in wins when signed out', () => {
    expect(statusView(acct({ cli: 'agy', runnable: false }), false, NOW).label).toBe('Not ready');
    expect(statusView(acct({ cli: 'agy', runnable: false, status: 'needs_sign_in' }), false, NOW).label).toBe(
      'Needs sign-in',
    );
  });
  it('shows Signing in (blue) while a window is open, and Checking while the CLI is asked', () => {
    const v = statusView(acct({ status: 'signing_in', signingInBy: 'An Nguyen' }), true, NOW);
    expect([v.label, v.color]).toEqual(['Signing in', '#244E78']);
    expect(statusView(acct(), true, NOW).label).toBe('Checking');
  });
  it('shows CLI not installed, and the platform reason when the CLI cannot be used here', () => {
    expect(statusView(acct({ status: 'cli_missing' }), false, NOW).label).toBe('CLI not installed');
    expect(statusView(acct({ cli: 'agy', unavailable: 'Not available on Windows' }), false, NOW).label).toBe(
      'Not available on Windows',
    );
  });
});

describe('what the account is signed in with', () => {
  it('shows method, plan and email for Claude Code', () => {
    expect(signedInWith(acct())).toEqual({ primary: 'Subscription · Max', secondary: 'an.nguyen@work.example' });
  });
  it('shows only the method for the CLIs that do not say who', () => {
    expect(signedInWith(acct({ cli: 'codex', method: 'ChatGPT', plan: null, email: null }))).toEqual({
      primary: 'ChatGPT login',
      secondary: null,
    });
    expect(signedInWith(acct({ cli: 'agy', method: 'Google sign-in', plan: null, email: null })).primary).toBe(
      'Google sign-in',
    );
  });
});

describe('banner and counts', () => {
  const out = acct({
    status: 'needs_sign_in',
    signedOutAt: iso(240),
    membersHere: [ref('m9', 'Weekend helper')],
    memberCount: 1,
  });
  it('names the account once and who is held back', () => {
    expect(bannerText(out, NOW)).toEqual({
      title: 'Work Claude needs to sign in again',
      body: 'Its session expired 4 minutes ago. 1 AI member (Weekend helper) can’t run until someone signs in.',
    });
  });
  it('says so when nobody uses it', () => {
    expect(bannerText(acct({ status: 'needs_sign_in' }), NOW).body).toBe(
      'It has not been signed in yet. No AI member uses it.',
    );
  });
  it('counts members once, however many accounts they appear in, and lists the long ones short', () => {
    const many = [ref('1', 'A'), ref('2', 'B'), ref('3', 'C'), ref('4', 'D'), ref('5', 'E')];
    expect(namesList(many)).toBe('A, B, C and 2 more');
    expect(cantRunClause(acct({ membersHere: many.slice(0, 2) }), 'until you choose one')).toBe(
      '2 AI members (A, B) can’t run until you choose one.',
    );
    expect(cantRunClause(acct())).toBe('');
  });
  it('sums the four tiles', () => {
    const stats = accountStats([
      acct({ membersHere: [ref('m1', 'A'), ref('m2', 'B')], membersElsewhere: [ref('m3', 'C', 'p2')] }),
      out,
      acct({ id: 'a3', status: 'signed_in' }),
    ]);
    expect(stats).toMatchObject({ total: 3, signedIn: 2, attention: ['Work Claude'], using: 4, here: 3, elsewhere: 1 });
    expect(needsAttention([out]).map((a) => a.id)).toEqual(['a1']);
  });
  it('words members and times', () => {
    expect([membersCount(0), membersCount(1), membersCount(3)]).toEqual(['No members', '1 member', '3 members']);
    expect([agoWords(iso(10), NOW), agoWords(iso(600), NOW), agoWords(iso(7200), NOW)]).toEqual([
      'just now',
      '10 min ago',
      '2 h ago',
    ]);
    expect([longAgo(iso(60), NOW), longAgo(iso(7200), NOW), longAgo(iso(86400 * 3), NOW)]).toEqual([
      '1 minute ago',
      '2 hours ago',
      '3 days ago',
    ]);
    expect(addedOn(new Date(2026, 9, 12, 12).toISOString())).toBe('Oct 12');
  });
});

describe('what can be done', () => {
  it('turns Sign in off with the reason', () => {
    expect(signInOffReason(acct(), true)).toBeNull();
    expect(signInOffReason(acct(), false)).toBe(DESKTOP_ONLY);
    expect(signInOffReason(acct({ status: 'signing_in' }), true)).toMatch(/Someone is signing in/);
    expect(signInOffReason(acct({ status: 'cli_missing' }), true)).toMatch(/not found/);
    expect(signInOffReason(acct({ cli: 'agy', unavailable: 'Not available on Windows' }), true)).toBe(
      'Not available on Windows',
    );
  });
  it('keeps the design’s menu, with Remove last and in red', () => {
    const items = menuItems(acct(), true);
    expect(items.map((i) => i.label)).toEqual([
      'Sign in again',
      'Check now',
      'Rename',
      'See members using it',
      'Sign out',
      'Remove…',
    ]);
    expect(items.find((i) => i.action === 'sign_out')?.divider).toBe(true);
    expect(items[5].danger).toBe(true);
    expect(items.every((i) => !i.disabled)).toBe(true);
  });
  it('is read only in the web build except for seeing the members', () => {
    const items = menuItems(acct(), false);
    expect(items.filter((i) => !i.disabled).map((i) => i.action)).toEqual(['members']);
  });
  it('only offers accounts of the same CLI to move members to', () => {
    const a = acct();
    const all = [
      a,
      acct({ id: 'b', name: 'Personal Claude', status: 'needs_sign_in' }),
      acct({ id: 'c', cli: 'codex' }),
    ];
    expect(otherAccounts(a, all).map((o) => o.id)).toEqual(['b']);
    expect(otherHint(all[1])).toBe('Personal Claude (needs sign-in)');
    expect(otherHint(undefined)).toBe('no other account of this CLI');
  });
  it('needs another account picked before Remove can move members there', () => {
    const a = acct({ membersHere: [ref('m', 'A')], memberCount: 1 });
    const b = acct({ id: 'b', name: 'B' });
    expect(removeReady(a, 'login', null, [a, b])).toBe(true);
    expect(removeReady(a, 'none', null, [a, b])).toBe(true);
    expect(removeReady(a, 'other', null, [a, b])).toBe(false);
    expect(removeReady(a, 'other', 'b', [a, b])).toBe(true);
    expect(removeReady(a, 'other', 'zzz', [a, b])).toBe(false);
    expect(removeReady(acct(), 'other', null, [])).toBe(true); // nobody to move
  });
});

describe('names', () => {
  const all = [acct(), acct({ id: 'b', name: 'Personal Claude' })];
  it('refuses an empty, long or taken name', () => {
    expect(nameProblem('  ', all)).toBe('Give the account a name.');
    expect(nameProblem('x'.repeat(61), all)).toBe('Use at most 60 characters.');
    expect(nameProblem('work   claude', all)).toBe('An account with this name exists.');
  });
  it('lets an account keep its own name', () => {
    expect(nameProblem('Work Claude', all, 'a1')).toBeNull();
    expect(nameProblem('Other', all, 'a1')).toBeNull();
  });
});

describe('CLI not found', () => {
  it('names each missing CLI once', () => {
    const list = [acct({ status: 'cli_missing' }), acct({ id: 'b', status: 'cli_missing' }), acct({ id: 'c' })];
    expect(missingClis(list)).toEqual([{ cli: 'claude', label: 'Claude Code' }]);
  });
});
