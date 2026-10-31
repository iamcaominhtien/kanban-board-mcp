import { describe, expect, it } from 'vitest';
import {
  CONFIRM_GRACE_S,
  TIMEOUT_S,
  closingNeedsConfirm,
  currentStep,
  keyRow,
  plain,
  planLabel,
  signInView,
  signedInWith,
  statusLine,
  stepDots,
  type ViewInput,
} from './signInCopy';
import type { SignInState } from '../types/aiAccounts';

function state(over: Partial<SignInState> = {}): SignInState {
  return {
    type: 'state',
    running: true,
    ended: null,
    exitCode: null,
    signedIn: false,
    duplicateOf: null,
    elapsed: 5,
    account: null,
    phase: 'waiting',
    url: null,
    ...over,
  };
}

function input(over: Partial<ViewInput> = {}): ViewInput {
  return {
    cli: 'claude',
    state: state(),
    sawOutput: true,
    waitedS: 5,
    exitedForS: null,
    extendedS: 0,
    duplicateAccepted: false,
    ...over,
  };
}

const ctx = { cli: 'claude' as const, accountName: 'Work Claude', signedIn: null };

describe('signInView', () => {
  it('starts before the first message and before any output', () => {
    expect(signInView(input({ state: null }))).toBe('starting');
    expect(signInView(input({ sawOutput: false }))).toBe('starting');
  });

  it('reads the phase the server saw, and says "waiting" for anything it does not know', () => {
    expect(signInView(input({ state: state({ phase: 'browser', url: 'https://x.example' }) }))).toBe('browser');
    expect(signInView(input({ state: state({ phase: 'paste_code' }) }))).toBe('paste_code');
    expect(signInView(input({ state: state({ phase: 'choose_method' }) }))).toBe('choose_method');
    expect(signInView(input({ state: state({ phase: 'waiting' }) }))).toBe('waiting');
    // a prompt only meaningful after sign-in does not claim a step before it
    expect(signInView(input({ cli: 'agy', state: state({ phase: 'trust_folder' }) }))).toBe('waiting');
  });

  it('is done only when the server says signed in, never from the screen', () => {
    expect(signInView(input({ state: state({ phase: 'paste_code', url: null }) }))).toBe('paste_code');
    expect(signInView(input({ state: state({ signedIn: true, running: false, ended: 'exited', exitCode: 0 }) }))).toBe(
      'done',
    );
  });

  it('keeps Antigravity open on its last question and lets the person press Done', () => {
    const s = state({ signedIn: true, phase: 'trust_folder' });
    expect(signInView(input({ cli: 'agy', state: s }))).toBe('trust_folder');
    expect(signInView(input({ cli: 'agy', state: state({ signedIn: true, phase: 'waiting' }) }))).toBe('done');
    expect(signInView(input({ cli: 'claude', state: s }))).toBe('done');
  });

  it('asks about a duplicate login until the person chooses to add it anyway', () => {
    const s = state({ signedIn: true, duplicateOf: 'Work Claude' });
    expect(signInView(input({ state: s }))).toBe('duplicate');
    expect(signInView(input({ state: s, duplicateAccepted: true }))).toBe('done');
  });

  it('calls a clean exit "checking" for a few seconds, then "stopped"', () => {
    const exited = state({ running: false, ended: 'exited', exitCode: 0 });
    expect(signInView(input({ state: exited, exitedForS: 1 }))).toBe('confirming');
    expect(signInView(input({ state: exited, exitedForS: CONFIRM_GRACE_S }))).toBe('stopped');
  });

  it('separates a rejected code from a CLI that stopped', () => {
    expect(signInView(input({ state: state({ phase: 'error' }) }))).toBe('rejected');
    expect(
      signInView(
        input({ state: state({ running: false, ended: 'exited', exitCode: 1, phase: 'error' }), exitedForS: 0 }),
      ),
    ).toBe('rejected');
    expect(signInView(input({ state: state({ running: false, ended: 'exited', exitCode: 1 }), exitedForS: 0 }))).toBe(
      'stopped',
    );
  });

  it('times out after five minutes of waiting, and "Keep waiting" adds five more', () => {
    expect(signInView(input({ waitedS: TIMEOUT_S - 1 }))).toBe('waiting');
    expect(signInView(input({ waitedS: TIMEOUT_S }))).toBe('timed_out');
    expect(signInView(input({ waitedS: TIMEOUT_S, extendedS: TIMEOUT_S }))).toBe('waiting');
    expect(signInView(input({ waitedS: 2 * TIMEOUT_S, extendedS: TIMEOUT_S }))).toBe('timed_out');
  });

  it('never times out a sign-in that has succeeded', () => {
    expect(signInView(input({ state: state({ signedIn: true }), waitedS: 10 * TIMEOUT_S }))).toBe('done');
  });
});

describe('step dots', () => {
  it('draws only the steps that apply: no method menu for Claude Code', () => {
    expect(stepDots('claude', 'browser').map((d) => d.label)).toEqual(['Start', 'Browser', 'Confirm']);
    expect(stepDots('agy', 'browser').map((d) => d.label)).toEqual(['Start', 'Choose a method', 'Browser', 'Confirm']);
  });

  it('fills every dot up to the current one and bolds only the current', () => {
    const dots = stepDots('claude', 'browser');
    expect(dots.map((d) => d.filled)).toEqual([true, true, false]);
    expect(dots.map((d) => d.current)).toEqual([false, true, false]);
    expect(stepDots('agy', 'trust_folder').map((d) => d.filled)).toEqual([true, true, true, true]);
  });

  it('puts each moment where the design draws it', () => {
    expect(currentStep('claude', 'starting')).toBe(0);
    expect(currentStep('claude', 'paste_code')).toBe(1);
    expect(currentStep('claude', 'confirming')).toBe(2);
    expect(currentStep('agy', 'choose_method')).toBe(1);
    expect(currentStep('agy', 'paste_code')).toBe(2);
    expect(currentStep('claude', 'fallback')).toBe(1);
    expect(currentStep('claude', 'no_terminal')).toBe(0);
    expect(currentStep('claude', 'fallback_signed')).toBe(2);
  });
});

describe('statusLine', () => {
  it('uses amber exactly when it is the person’s turn, blue while the app or browser works', () => {
    const tone = (v: Parameters<typeof statusLine>[0], cli: 'claude' | 'agy' = 'claude') =>
      statusLine(v, { ...ctx, cli }).tone;
    expect(['paste_code', 'choose_method', 'trust_folder'].map((v) => tone(v as never, 'agy'))).toEqual([
      'amber',
      'amber',
      'amber',
    ]);
    expect(['starting', 'waiting', 'browser', 'confirming', 'fallback'].map((v) => tone(v as never))).toEqual([
      'blue',
      'blue',
      'blue',
      'blue',
      'blue',
    ]);
    expect(tone('done')).toBe('green');
    expect(['rejected', 'stopped', 'timed_out', 'duplicate', 'no_terminal'].map((v) => tone(v as never))).toEqual(
      Array(5).fill('red'),
    );
  });

  it('names the command and what to press', () => {
    expect(plain(statusLine('starting', ctx).body)).toBe(
      'Opening a terminal and running claude in the folder made for this account.',
    );
    expect(statusLine('paste_code', ctx).title).toBe('Your turn: paste the code');
    expect(statusLine('paste_code', { ...ctx, cli: 'agy' }).title).toBe('Your turn: paste the authorization code');
    expect(plain(statusLine('choose_method', { ...ctx, cli: 'agy' }).body)).toContain('Choose 1 to sign in');
  });

  it('says who the CLI reports, when it does', () => {
    const signedIn = { email: 'an.nguyen@work.example', plan: 'max', method: 'subscription' };
    expect(plain(statusLine('done', { ...ctx, signedIn }).body)).toBe(
      'Work Claude is signed in as an.nguyen@work.example · Max plan. It is ready to be chosen by AI members.',
    );
    // Codex, opencode and Antigravity do not say who
    expect(
      plain(
        statusLine('done', { ...ctx, cli: 'agy', signedIn: { email: null, plan: null, method: 'Google sign-in' } })
          .body,
      ),
    ).toBe('Work Claude is signed in (Google sign-in). It is ready to be chosen by AI members.');
    expect(plain(statusLine('done', ctx).body)).toBe(
      'Work Claude is signed in. It is ready to be chosen by AI members.',
    );
  });

  it('states the exit code and the duplicate in plain words', () => {
    expect(statusLine('stopped', { ...ctx, exitCode: 1 }).title).toBe('The CLI stopped (exit code 1)');
    expect(statusLine('stopped', { ...ctx, exitCode: null }).title).toBe('The CLI stopped');
    const dup = statusLine('duplicate', {
      ...ctx,
      duplicateOf: 'Work Claude',
      signedIn: { email: 'an@x.example', plan: null, method: null },
    });
    expect(plain(dup.body)).toContain('This account is an@x.example, which is already added as Work Claude.');
  });
});

describe('helpers', () => {
  it('offers the arrow keys only while the CLI asks a menu question', () => {
    expect(keyRow('choose_method')).toEqual(['up', 'down', 'enter', 'esc']);
    expect(keyRow('trust_folder')).toEqual(['up', 'down', 'enter']);
    expect(keyRow('browser')).toEqual([]);
  });

  it('formats the plan and what is signed in', () => {
    expect(planLabel('max')).toBe('Max plan');
    expect(planLabel(null)).toBeNull();
    expect(signedInWith({ email: 'a@b.example', plan: 'pro', method: null })).toBe('a@b.example · Pro plan');
    expect(signedInWith({ email: null, plan: null, method: 'ChatGPT login' })).toBe('ChatGPT login');
    expect(signedInWith(null)).toBeNull();
  });

  it('asks before closing only while a sign-in could still be lost', () => {
    expect(closingNeedsConfirm('browser')).toBe(true);
    expect(closingNeedsConfirm('paste_code')).toBe(true);
    expect(closingNeedsConfirm('done')).toBe(false);
    expect(closingNeedsConfirm('no_terminal')).toBe(false);
  });
});
