/**
 * What the sign-in window of an AI account says (design/screens/ai-accounts.md, C2 to C4).
 *
 * The terminal is the real CLI and stays fully usable; the status bar above it is a best-effort reading of what the
 * CLI is waiting for. Everything here is pure: the server's state goes in, one sentence, its tone, the step dots and
 * the helper keys come out. The app never claims a step it cannot see: unknown output reads "Waiting for the CLI…".
 */
import type { AccountCli, SignInState } from '../types/aiAccounts';

/** How long the browser step may take before the window offers to keep waiting or start again. */
export const TIMEOUT_S = 300;
/** A CLI that exited cleanly gets this long to be seen signed in before the window calls it stopped. */
export const CONFIRM_GRACE_S = 8;

/** blue: the app or the browser is working; amber: it is the person's turn; green: done; red: something went wrong. */
export type Tone = 'blue' | 'amber' | 'green' | 'red';

export type SignInView =
  | 'starting'
  | 'waiting'
  | 'choose_method'
  | 'browser'
  | 'paste_code'
  | 'trust_folder'
  | 'confirming'
  | 'done'
  | 'rejected'
  | 'stopped'
  | 'timed_out'
  | 'duplicate'
  /** Someone else has this account's sign-in open. */
  | 'busy'
  /** The terminal could not start; the person may use their own terminal instead. */
  | 'no_terminal'
  | 'fallback'
  | 'fallback_signed';

/** A sentence with bold parts, so the component needs no markup in strings. */
export type Segments = (string | { b: string })[];

export interface StatusLine {
  tone: Tone;
  title: string;
  body: Segments;
}

export interface CliInfo {
  label: string;
  /** The command the CLI is started with. */
  command: string;
  /** Initials on the avatar. */
  initials: string;
  bg: string;
  color: string;
  /** One command that installs it, or null when it takes steps. */
  install: string | null;
  installSteps: string[];
  guideUrl: string;
}

/** Per CLI: the words and colours of its card, install help and sign-in. */
export const CLI_INFO: Record<AccountCli, CliInfo> = {
  claude: {
    label: 'Claude Code',
    command: 'claude',
    initials: 'CC',
    bg: '#FBEFE6',
    color: '#B4571F',
    install: 'npm install -g @anthropic-ai/claude-code',
    installSteps: [],
    guideUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
  },
  codex: {
    label: 'Codex',
    command: 'codex',
    initials: 'CX',
    bg: '#E8F1FA',
    color: '#244E78',
    install: 'npm install -g @openai/codex',
    installSteps: [],
    guideUrl: 'https://developers.openai.com/codex/cli',
  },
  opencode: {
    label: 'opencode',
    command: 'opencode',
    initials: 'OC',
    bg: '#EFE8FB',
    color: '#5B3AA6',
    install: 'npm install -g opencode-ai',
    installSteps: [],
    guideUrl: 'https://opencode.ai/docs',
  },
  agy: {
    label: 'Antigravity',
    command: 'agy',
    initials: 'AG',
    bg: '#E6F2EA',
    color: '#1F5A31',
    install: null,
    installSteps: [
      'Install the Antigravity command line tool from its website, so that “agy” works in a terminal.',
      'You do not need to sign in there: sign in here, in this account.',
    ],
    guideUrl: 'https://antigravity.google',
  },
};

/** The sentence under the CLI card of Antigravity on Windows (its login is shared by the Windows user). */
export const AGY_WINDOWS_NOTE =
  'On Windows its login is kept in the system credential store, which belongs to the Windows user, not to the account, so two accounts might share one login.';

/** "max" → "Max plan"; null when the CLI does not say. */
export function planLabel(plan: string | null | undefined): string | null {
  const p = (plan ?? '').trim();
  return p ? `${p.charAt(0).toUpperCase()}${p.slice(1)} plan` : null;
}

/** "an@x.example · Max plan", or the method the CLI reports ("ChatGPT login"), or null. */
export function signedInWith(a: { email: string | null; plan: string | null; method: string | null } | null) {
  if (!a) return null;
  const parts = [a.email, planLabel(a.plan) ?? a.method].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

export interface ViewInput {
  cli: AccountCli;
  /** Latest state message of the terminal socket, or null before the first one. */
  state: SignInState | null;
  /** The terminal has printed something. */
  sawOutput: boolean;
  /** Seconds since this attempt started (the browser step is timed from here). */
  waitedS: number;
  /** Seconds since the CLI exited, or null while it runs. */
  exitedForS: number | null;
  /** Extra seconds granted by "Keep waiting". */
  extendedS: number;
  /** "Add anyway" was chosen on the duplicate notice. */
  duplicateAccepted: boolean;
}

/** Which of the window's moments the terminal's state means. */
export function signInView(i: ViewInput): SignInView {
  const s = i.state;
  if (!s) return 'starting';
  if (s.signedIn) {
    if (s.duplicateOf && !i.duplicateAccepted) return 'duplicate';
    if (i.cli === 'agy' && s.running && s.phase === 'trust_folder') return 'trust_folder';
    return 'done';
  }
  if (s.ended === 'exited') {
    if (s.phase === 'error') return 'rejected';
    if (s.exitCode === 0 && i.exitedForS !== null && i.exitedForS < CONFIRM_GRACE_S) return 'confirming';
    return 'stopped';
  }
  if (s.phase === 'error') return 'rejected';
  if (i.waitedS >= TIMEOUT_S + i.extendedS) return 'timed_out';
  if (!i.sawOutput) return 'starting';
  switch (s.phase) {
    case 'choose_method':
    case 'browser':
    case 'paste_code':
      return s.phase;
    default:
      return 'waiting';
  }
}

/** Dots for the steps that apply to this CLI (Claude Code has no method menu). */
export function stepLabels(cli: AccountCli): string[] {
  return cli === 'agy' ? ['Start', 'Choose a method', 'Browser', 'Confirm'] : ['Start', 'Browser', 'Confirm'];
}

/** Index of the current dot: that one is bold, every earlier one is filled. */
export function currentStep(cli: AccountCli, view: SignInView): number {
  const last = stepLabels(cli).length - 1;
  switch (view) {
    case 'starting':
    case 'waiting':
    case 'stopped':
    case 'no_terminal':
    case 'busy':
      return 0;
    case 'choose_method':
      return cli === 'agy' ? 1 : 0;
    case 'browser':
    case 'paste_code':
    case 'rejected':
    case 'timed_out':
    case 'fallback':
      return cli === 'agy' && view !== 'fallback' ? 2 : 1;
    default:
      return last; // trust_folder, confirming, done, duplicate, fallback_signed
  }
}

export interface Dot {
  label: string;
  filled: boolean;
  current: boolean;
}

/** The step dots above the status line. */
export function stepDots(cli: AccountCli, view: SignInView): Dot[] {
  const at = currentStep(cli, view);
  return stepLabels(cli).map((label, i) => ({ label, filled: i <= at, current: i === at }));
}

/** Keys the helper row can send, and what the terminal receives for each. */
export const KEY_CODES = { up: '\x1b[A', down: '\x1b[B', enter: '\r', esc: '\x1b' } as const;
export type KeyName = keyof typeof KEY_CODES;
export const KEY_LABELS: Record<KeyName, string> = { up: '↑', down: '↓', enter: 'Enter', esc: 'Esc' };

/** The helper keys for people unused to terminal prompts, shown while the CLI asks a menu question. */
export function keyRow(view: SignInView): KeyName[] {
  if (view === 'choose_method') return ['up', 'down', 'enter', 'esc'];
  if (view === 'trust_folder') return ['up', 'down', 'enter'];
  return [];
}

/** Whether the "Paste code" button is offered. */
export function offersPaste(view: SignInView): boolean {
  return view === 'paste_code';
}

/** Whether the link buttons are offered (needs a link in the output). */
export function offersLink(view: SignInView): boolean {
  return view === 'browser';
}

/** What the person is told. `ctx` carries the account's name and what the CLI reported. */
export function statusLine(
  view: SignInView,
  ctx: {
    cli: AccountCli;
    accountName: string;
    signedIn: { email: string | null; plan: string | null; method: string | null } | null;
    exitCode?: number | null;
    duplicateOf?: string | null;
    by?: string | null;
  },
): StatusLine {
  const cmd = CLI_INFO[ctx.cli].command;
  const as = signedInWith(ctx.signedIn);
  switch (view) {
    case 'starting':
      return {
        tone: 'blue',
        title: 'Starting the CLI',
        body: ['Opening a terminal and running ', { b: cmd }, ' in the folder made for this account.'],
      };
    case 'waiting':
      return {
        tone: 'blue',
        title: 'Waiting for the CLI…',
        body: ['Follow what the CLI asks in the terminal. This window updates by itself.'],
      };
    case 'choose_method':
      return ctx.cli === 'agy'
        ? {
            tone: 'amber',
            title: 'Your turn: choose how to sign in',
            body: [
              'The CLI is asking a question. Click inside the terminal, then use the arrow keys and Enter. Choose ',
              { b: '1' },
              ' to sign in with a Google account.',
            ],
          }
        : {
            tone: 'amber',
            title: 'Your turn: answer the CLI',
            body: ['The CLI is asking a question. Click inside the terminal, then use the arrow keys and Enter.'],
          };
    case 'browser':
      return {
        tone: 'blue',
        title: 'Finish in your browser',
        body: ['A browser window should have opened. Sign in there and approve access. This window updates by itself.'],
      };
    case 'paste_code':
      return ctx.cli === 'agy'
        ? {
            tone: 'amber',
            title: 'Your turn: paste the authorization code',
            body: [
              'The browser page shows a code. Copy it, then click ',
              { b: 'Paste code' },
              ' (or paste inside the terminal).',
            ],
          }
        : {
            tone: 'amber',
            title: 'Your turn: paste the code',
            body: [
              'The browser shows a code. Copy it, then click ',
              { b: 'Paste code' },
              ' (or paste inside the terminal).',
            ],
          };
    case 'trust_folder':
      return {
        tone: 'amber',
        title: 'Signed in. One last question from the CLI',
        body: [
          'The account is already signed in; the CLI is asking whether to trust its own folder. Answer it, then click ',
          { b: 'Done' },
          '. The window never closes by itself, so it cannot cut a prompt short.',
        ],
      };
    case 'confirming':
      return {
        tone: 'blue',
        title: 'Checking the sign-in',
        body: ['Asking the CLI who it is signed in as. This takes a few seconds.'],
      };
    case 'done': {
      const who = ctx.signedIn?.email;
      const extra = planLabel(ctx.signedIn?.plan) ?? ctx.signedIn?.method;
      return {
        tone: 'green',
        title: 'Signed in',
        body: who
          ? [
              ctx.accountName,
              ' is signed in as ',
              { b: who },
              extra ? ` · ${extra}` : '',
              '. It is ready to be chosen by AI members.',
            ]
          : [ctx.accountName, ' is signed in', extra ? ` (${extra})` : '', '. It is ready to be chosen by AI members.'],
      };
    }
    case 'rejected':
      return {
        tone: 'red',
        title: 'The code was not accepted',
        body: ['It may have expired or been copied with a space. Start again to get a new one.'],
      };
    case 'stopped':
      return {
        tone: 'red',
        title: ctx.exitCode == null ? 'The CLI stopped' : `The CLI stopped (exit code ${ctx.exitCode})`,
        body: ['It ended before the account was signed in. The last lines of output are above.'],
      };
    case 'timed_out':
      return {
        tone: 'red',
        title: 'Still waiting after 5 minutes',
        body: ['The browser step did not finish. Nothing was changed. You can keep waiting or start again.'],
      };
    case 'duplicate':
      return {
        tone: 'red',
        title: 'Signed in, but already added',
        body: [
          'This account is ',
          { b: ctx.signedIn?.email ?? 'the same login' },
          ', which is already added as ',
          { b: ctx.duplicateOf ?? 'another account' },
          '. Adding it twice would share one limit. Only Claude Code reports who is signed in; for Codex, opencode and Antigravity two accounts cannot be told apart, so a duplicate is possible there.',
        ],
      };
    case 'busy':
      return {
        tone: 'blue',
        title: `Someone is signing in to ${ctx.accountName}`,
        body: [
          `${ctx.by || 'Someone'} started it on this computer. Only one sign-in per account at a time: try again when they finish or stop.`,
        ],
      };
    case 'no_terminal':
      return {
        tone: 'red',
        title: 'The terminal could not start',
        body: ['Kanban could not run ', { b: cmd }, ' in this account’s folder. Nothing was saved.'],
      };
    case 'fallback':
      return {
        tone: 'blue',
        title: 'Waiting for you to sign in in your own terminal',
        body: [
          'Run the command below in any terminal on this computer and finish the sign-in there. This window asks the CLI every few seconds and updates by itself.',
        ],
      };
    case 'fallback_signed':
      return {
        tone: 'green',
        title: 'Signed in',
        body: [
          'The CLI reports ',
          { b: as ?? 'a login' },
          '. For a CLI that may still be asking questions in your terminal (Antigravity), finish them there first, then click Done.',
        ],
      };
  }
}

/** Plain text of a sentence (tests, aria labels, clipboard). */
export function plain(segments: Segments): string {
  return segments.map((s) => (typeof s === 'string' ? s : s.b)).join('');
}

/** Whether closing now loses a sign-in the person may still want: asks "Stop signing in?" first. */
export function closingNeedsConfirm(view: SignInView): boolean {
  return !['done', 'fallback_signed', 'no_terminal', 'busy', 'stopped', 'rejected', 'duplicate'].includes(view);
}

/** The order of the add-account steps. */
export const ADD_STEPS = ['CLI', 'Name', 'Sign in'] as const;

/** What a CLI card says under its name; Antigravity on Windows explains why it is off. */
export function cardBlurb(cli: AccountCli, blurb: string, unavailable: string | null): string {
  return unavailable && cli === 'agy' ? AGY_WINDOWS_NOTE : blurb;
}
