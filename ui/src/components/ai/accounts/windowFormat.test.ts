import { describe, expect, it } from 'vitest';
import type { AccountWindow } from '../../../types/aiWindows';
import {
  countdown,
  isHeld,
  planLine,
  readText,
  reopensText,
  runsText,
  usedPct,
  usedText,
  windowTone,
} from './windowFormat';

const NOW = new Date(2026, 10, 2, 12, 48).getTime();
const at = (h: number, m = 0) => new Date(2026, 10, 2, h, m).toISOString();

function account(over: Partial<AccountWindow> = {}): AccountWindow {
  return {
    key: 'a1',
    name: 'an',
    email: 'an@example.com',
    plan: 'Max 20×',
    status: 'signed_in',
    maxParallel: 2,
    running: [],
    waiting: 0,
    fiveHour: { used: 0.4, resetsAt: null, status: null },
    sevenDay: { used: null, resetsAt: null, status: null },
    heldUntil: null,
    heldReason: null,
    moveUrgent: false,
    readAt: null,
    ...over,
  };
}

describe('window formatting', () => {
  it('rounds the percent and says not known without a reading', () => {
    expect(usedText(0.924)).toBe('92% used');
    expect(usedText(null)).toBe('not known');
    expect(usedPct(1.4)).toBe(100);
    expect(usedPct(null)).toBe(0);
  });

  it('is amber from 80%, red when used up, grey when not known', () => {
    expect(windowTone(0.79)).toBe('ok');
    expect(windowTone(0.8)).toBe('warn');
    expect(windowTone(1)).toBe('full');
    expect(windowTone(null)).toBe('unknown');
  });

  it('counts down to the reset', () => {
    expect(countdown(at(14, 0), NOW)).toBe('in 1 h 12 min');
    expect(countdown(at(13, 13), NOW)).toBe('in 25 min');
    expect(countdown(at(15, 48), NOW)).toBe('in 3 h');
    expect(countdown(new Date(NOW + 51 * 3600_000).toISOString(), NOW)).toBe('in 2 d 3 h');
    expect(countdown(at(12, 0), NOW)).toBe('now');
  });

  it('reads the reopening time, and nothing when the CLI gave none', () => {
    expect(reopensText({ used: 0.9, resetsAt: at(14, 0), status: null }, NOW)).toMatch(
      /^Window reopens 14:00 · in 1 h 12 min$/,
    );
    expect(reopensText({ used: 0.9, resetsAt: null, status: null }, NOW)).toBe('');
  });

  it('labels a reading as read from Claude Code, not as an estimate', () => {
    expect(readText(at(9, 58))).toBe('Read from Claude Code at 09:58');
    expect(readText(null)).toBe('Not read yet');
  });

  it('knows when an account is held and says what waits', () => {
    const held = account({ heldUntil: at(14, 0), waiting: 2 });
    expect(isHeld(held, NOW)).toBe(true);
    expect(isHeld(account({ heldUntil: at(9, 0) }), NOW)).toBe(false);
    expect(runsText(held, NOW).waiting).toBe('2 runs held until 14:00');
    expect(runsText(account({ waiting: 1 }), NOW).waiting).toBe('1 waiting for a free slot');
    expect(runsText(account(), NOW)).toEqual({ running: 'Nothing running.', waiting: 'Room for 2 more runs' });
  });

  it('describes plan and sign-in state', () => {
    expect(planLine(account())).toBe('Max 20× · signed in');
    expect(planLine(account({ status: 'needs_sign_in' }))).toBe('Max 20× · signed out');
  });
});
