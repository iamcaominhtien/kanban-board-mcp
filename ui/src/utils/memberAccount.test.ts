import { describe, expect, it } from 'vitest';
import type { AiMember } from '../types/ai';
import type { AiAccount, MemberAccountRef } from '../types/aiAccounts';
import {
  accountCell,
  accountEvents,
  accountReady,
  accountSub,
  accountsFor,
  bannerCopy,
  blockedAccounts,
  displayStatus,
  eventCopy,
  joinNames,
  sharedHint,
  sharedProfileHint,
  sharingCount,
  typeChip,
  usesAccounts,
} from './memberAccount';

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
  checkedAt: null,
  signedOutAt: null,
  signedOutHow: null,
  signingInBy: null,
  createdAt: '2026-10-12T00:00:00Z',
  createdBy: null,
  membersHere: [],
  membersElsewhere: [],
  memberCount: 3,
  ...over,
});
const ref = (over: Partial<MemberAccountRef> = {}): MemberAccountRef => ({
  id: 'a1',
  name: 'Personal Claude',
  cli: 'claude',
  cliLabel: 'Claude Code',
  status: 'needs_sign_in',
  email: 'an.n@home.example',
  plan: 'pro',
  method: null,
  signedOutAt: '2026-10-31T10:00:00Z',
  sharedBy: 1,
  ...over,
});
const member = (over: Partial<AiMember> = {}): AiMember =>
  ({
    id: 'm1',
    name: 'Weekend helper',
    provider: 'claude-code',
    connection: 'local',
    status: { code: 'not_logged_in', label: 'CLI not logged in', detail: null },
    accountRef: ref(),
    accountId: 'a1',
    queued: 1,
    ...over,
  }) as AiMember;

describe('accounts for a member type', () => {
  it('lists only the accounts of that CLI, signed-in ones first', () => {
    const list = [
      acct({ id: 'b', name: 'B', status: 'needs_sign_in' }),
      acct({ id: 'c', name: 'Codex', cli: 'codex' }),
      acct({ id: 'a', name: 'A' }),
    ];
    expect(accountsFor(list, 'claude-code').map((a) => a.id)).toEqual(['a', 'b']);
    expect(accountsFor(list, 'codex').map((a) => a.id)).toEqual(['c']);
    expect(accountsFor(list, 'openai')).toEqual([]);
  });
  it('knows which types use accounts', () => {
    expect(usesAccounts('claude-code')).toBe(true);
    expect(usesAccounts('antigravity')).toBe(true);
    expect(usesAccounts('anthropic')).toBe(false);
  });
});

describe('the picker', () => {
  it('describes an account with who, plan and how many already use it', () => {
    expect(accountSub(acct(), true)).toBe('an.nguyen@work.example · Max · 3 members already use it');
    expect(accountSub(acct({ memberCount: 1 }), false)).toContain('1 member already use it');
  });
  it('says session expired for a signed-out account that is not the chosen one', () => {
    const out = acct({ status: 'needs_sign_in', signedOutAt: 'x', email: 'an.n@home.example', plan: 'pro' });
    expect(accountSub(out, false)).toBe('an.n@home.example · Pro · session expired');
    expect(accountSub(out, true)).toBe('an.n@home.example · Pro');
  });
  it('falls back to the method when the CLI says no plan', () => {
    expect(accountSub(acct({ email: null, plan: null, method: 'ChatGPT login', memberCount: 0 }), false)).toBe(
      'ChatGPT login',
    );
  });
  it('keeps Next off until the account works', () => {
    expect(accountReady(null)).toBe(true);
    expect(accountReady(acct())).toBe(true);
    expect(accountReady(acct({ status: 'needs_sign_in' }))).toBe(false);
    expect(accountReady(acct({ status: 'signing_in' }))).toBe(false);
    expect(accountReady(acct({ status: 'cli_missing' }))).toBe(false);
  });
  it('counts the members that will share the limit, including the one being added', () => {
    expect(sharingCount(acct(), false)).toBe(4);
    expect(sharingCount(acct(), true)).toBe(3);
    expect(sharedHint(acct(), false)?.text).toBe(
      'The 4 AI members on Work Claude draw from the same plan limit. A busy day for one can slow the others.',
    );
    expect(sharedHint(acct({ memberCount: 0 }), false)).toBeNull();
    expect(sharedHint(acct({ memberCount: 1 }), true)).toBeNull();
  });
  it('says on the profile how many members share the account', () => {
    expect(sharedProfileHint(ref({ sharedBy: 3 }))).toBe('3 members share this account and its limits');
    expect(sharedProfileHint(ref({ sharedBy: 1 }))).toBeNull();
  });
});

describe('the AI list', () => {
  it('shows the account, or the login as before, or nothing for an API key', () => {
    expect(accountCell(member({ accountRef: ref({ status: 'signed_in', plan: 'max' }) }))).toEqual({
      name: 'Personal Claude',
      sub: 'Claude Code · Max',
      warn: false,
    });
    expect(accountCell(member())).toEqual({ name: 'Personal Claude', sub: 'Needs sign-in', warn: true });
    expect(accountCell(member({ accountRef: null, accountId: null }))).toEqual({
      name: 'Login on this computer',
      sub: 'as before',
      warn: false,
    });
    expect(accountCell(member({ provider: 'opencode', accountRef: null }))?.name).toBe('Free models');
    expect(accountCell(member({ connection: 'api_key' }))).toBeNull();
  });
  it('names the account in the status of a member whose account is signed out', () => {
    expect(displayStatus(member()).label).toBe('Needs sign-in · account');
    // an old CLI login problem keeps the old words
    expect(displayStatus(member({ accountRef: null })).label).toBe('CLI not logged in');
  });
  it('shows every local type as it is: all of them run, so none is Not ready', () => {
    const idle = { code: 'idle', label: 'Idle', detail: null } as const;
    for (const provider of ['antigravity', 'codex', 'opencode', 'claude-code'] as const) {
      expect(displayStatus(member({ provider, accountRef: null, status: idle })).label).toBe('Idle');
    }
    const paused = { code: 'paused', label: 'Paused', detail: null } as const;
    expect(displayStatus(member({ provider: 'codex', accountRef: null, status: paused })).label).toBe('Paused');
  });
});

describe('the banner', () => {
  it('names a signed-out account once, however many members it hits', () => {
    const list = [
      member({ id: 'm1', name: 'Weekend helper' }),
      member({ id: 'm2', name: 'Spec writer', queued: 2 }),
      member({ id: 'm3', name: 'Other', accountRef: ref({ id: 'a2', status: 'signed_in' }) }),
      member({ id: 'm4', name: 'Plain', accountRef: null }),
    ];
    const groups = blockedAccounts(list);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.name)).toEqual(['Weekend helper', 'Spec writer']);
    expect(groups[0].queued).toBe(3);
    expect(bannerCopy(groups[0])).toEqual({
      title: '2 AI members can’t run: Personal Claude needs to sign in',
      text: 'Weekend helper and Spec writer have 3 queued runs held. They start by themselves once the account is signed in again.',
    });
  });
  it('words one member with one held run as the design does', () => {
    const [g] = blockedAccounts([member()]);
    expect(bannerCopy(g)).toEqual({
      title: '1 AI member can’t run: Personal Claude needs to sign in',
      text: 'Weekend helper has 1 queued run held. It starts by itself once the account is signed in again.',
    });
  });
  it('does not promise held runs when nothing is queued', () => {
    const [g] = blockedAccounts([member({ queued: 0 })]);
    expect(bannerCopy(g).text).toBe(
      'Weekend helper has nothing queued. New runs start by themselves once the account is signed in again.',
    );
  });
  it('joins names', () => {
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('telling the person once per account', () => {
  const state = (list: AiAccount[]) => new Map(list.map((a) => [a.id, a.status]));
  it('records the first poll without telling', () => {
    expect(accountEvents(undefined, [acct({ status: 'needs_sign_in' })], new Map())).toEqual([]);
  });
  it('tells once when an account goes from signed in to signed out', () => {
    const before = [acct()];
    const after = [acct({ status: 'needs_sign_in' })];
    const ev = accountEvents(state(before), after, new Map());
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe('signed_out');
    expect(accountEvents(state(after), after, new Map())).toEqual([]);
  });
  it('tells how many held runs restart when it is signed in again', () => {
    const before = [acct({ status: 'needs_sign_in' })];
    const ev = accountEvents(state(before), [acct()], new Map([['a1', 2]]));
    expect(ev).toEqual([{ kind: 'signed_in', account: acct(), heldRuns: 2 }]);
    expect(eventCopy(ev[0]).message).toBe('2 held runs restart by themselves.');
  });
  it('stays quiet for an account nobody uses', () => {
    const before = [acct({ status: 'needs_sign_in', memberCount: 0 })];
    expect(accountEvents(state(before), [acct({ memberCount: 0 })], new Map())).toEqual([]);
  });
  it('words the signed-out toast', () => {
    expect(eventCopy({ kind: 'signed_out', account: acct({ memberCount: 1 }) })).toEqual({
      title: 'Work Claude needs to sign in',
      message: '1 AI member can’t run until someone signs in again. Queued runs wait.',
    });
  });
});

describe('type cards', () => {
  it('shows the number of accounts, or that the CLI is missing', () => {
    expect(typeChip(2, true)?.text).toBe('2 accounts');
    expect(typeChip(1, true)?.text).toBe('1 account');
    expect(typeChip(0, true)).toBeNull();
    expect(typeChip(2, false)?.text).toBe('not installed');
  });
});
