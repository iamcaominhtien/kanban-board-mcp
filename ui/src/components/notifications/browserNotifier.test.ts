import { describe, expect, it } from 'vitest';
import type { NotificationFeed, NotificationRow } from '../../types/notifications';
import { BrowserNotifierCore, noticeFor, RATE_MS, shouldNotify } from './browserNotifier';

const row = (over: Partial<NotificationRow> = {}): NotificationRow =>
  ({
    id: 'r1',
    kind: 'question',
    needs: true,
    desktop: true,
    done: false,
    read: false,
    gone: false,
    snoozed: false,
    cleared: false,
    title: 'Dev An asks a question',
    body: 'Cursor or offset?',
    ticketId: 'KAN-215',
    lastEventId: 11,
    actions: [],
    ...over,
  }) as NotificationRow;

const feed = (items: NotificationRow[], over: Partial<NotificationFeed> = {}): NotificationFeed => ({
  head: 20,
  cursorTooOld: false,
  items,
  resolved: [],
  sound: true,
  soundName: 'chime',
  ...over,
});

function harness(ctx = { focused: false, quiet: false }) {
  let t = 1_000_000;
  const timers: { fn: () => void; at: number }[] = [];
  const shown: { title: string; body: string; needs: boolean; sound: { on: boolean; name: string } }[] = [];
  const closed: unknown[] = [];
  const state = { ctx };
  const core = new BrowserNotifierCore<{ n: number }>({
    now: () => t,
    setTimer: (fn, ms) => {
      timers.push({ fn, at: t + ms });
      return timers.length - 1;
    },
    clearTimer: () => undefined,
    show: (notice, sound) => {
      shown.push({ title: notice.title, body: notice.body, needs: notice.needs, sound });
      return { n: shown.length };
    },
    close: (h) => closed.push(h),
    context: () => state.ctx,
  });
  return {
    core,
    shown,
    closed,
    state,
    advance(ms: number) {
      t += ms;
      for (const timer of timers.splice(0)) {
        if (timer.at <= t) timer.fn();
        else timers.push(timer);
      }
    },
  };
}

describe('shouldNotify', () => {
  it('lets a Needs you with its desktop switch on through', () => {
    expect(shouldNotify(row(), { focused: false, quiet: false })).toBe(true);
  });

  it.each([
    ['desktop off', { desktop: false }],
    ['done', { done: true }],
    ['read', { read: true }],
    ['gone', { gone: true }],
    ['snoozed', { snoozed: true }],
    ['cleared', { cleared: true }],
  ])('not a row that is %s', (_name, over) => {
    expect(shouldNotify(row(over), { focused: false, quiet: false })).toBe(false);
  });

  it('not while a tab is being looked at, and not in quiet hours', () => {
    expect(shouldNotify(row(), { focused: true, quiet: false })).toBe(false);
    expect(shouldNotify(row(), { focused: false, quiet: true })).toBe(false);
  });
});

describe('noticeFor', () => {
  it('names the ticket unless the words already do', () => {
    expect(noticeFor([row()]).body).toBe('KAN-215 · Cursor or offset?');
    expect(noticeFor([row({ body: 'KAN-215 needs a choice' })]).body).toBe('KAN-215 needs a choice');
  });

  it('says a reminder is one', () => {
    expect(noticeFor([row({ reminded: true })]).title).toBe('Still waiting: Dev An asks a question');
  });

  it('groups several rows into one notice that opens the list', () => {
    const n = noticeFor([
      row({ id: 'a', title: 'A' }),
      row({ id: 'b', title: 'B' }),
      row({ id: 'c', title: 'C' }),
      row({ id: 'd', title: 'D' }),
    ]);
    expect(n.title).toBe('4 things need you');
    expect(n.body).toBe('A · B · C and 1 more');
    expect(n.open).toEqual({ group: true, ids: ['a', 'b', 'c', 'd'], needs: true });
  });
});

describe('BrowserNotifierCore', () => {
  it('shows a notice at once with the sound the feed carries', () => {
    const h = harness();
    h.core.applyFeed(feed([row()], { soundName: 'bell' }));
    expect(h.shown).toHaveLength(1);
    expect(h.shown[0].sound).toEqual({ on: true, name: 'bell' });
  });

  it('tells a row once per event, and again when it moves on (a reminder)', () => {
    const h = harness();
    h.core.applyFeed(feed([row()]));
    h.core.applyFeed(feed([row()]));
    expect(h.shown).toHaveLength(1);
    h.advance(RATE_MS + 1);
    h.core.applyFeed(feed([row({ lastEventId: 14, reminded: true })]));
    expect(h.shown).toHaveLength(2);
    expect(h.shown[1].title).toMatch(/^Still waiting/);
  });

  it('sends at most one every 20 seconds and groups what waited', () => {
    const h = harness();
    h.core.applyFeed(feed([row({ id: 'a', title: 'A' })]));
    h.core.applyFeed(feed([row({ id: 'b', title: 'B' }), row({ id: 'c', title: 'C' })]));
    expect(h.shown).toHaveLength(1);
    h.advance(RATE_MS);
    expect(h.shown).toHaveLength(2);
    expect(h.shown[1].title).toBe('2 things need you');
  });

  it('says nothing while a tab is being looked at, but remembers it told the row', () => {
    const h = harness({ focused: true, quiet: false });
    h.core.applyFeed(feed([row()]));
    expect(h.shown).toHaveLength(0);
    h.state.ctx = { focused: false, quiet: false };
    h.core.applyFeed(feed([row()]));
    expect(h.shown).toHaveLength(0); // the toast already told it; the reminder will remind
  });

  it('says nothing in quiet hours', () => {
    const h = harness();
    h.core.applyFeed(feed([row()], { quiet: true }));
    expect(h.shown).toHaveLength(0);
  });

  it('withdraws the notice when its row is resolved or read', () => {
    const h = harness();
    h.core.applyFeed(feed([row()]));
    h.core.applyFeed(feed([], { resolved: ['r1'] }));
    expect(h.closed).toHaveLength(1);
    h.advance(RATE_MS + 1);
    h.core.applyFeed(feed([row({ id: 'r2', lastEventId: 30 })]));
    h.core.applyFeed(feed([row({ id: 'r2', lastEventId: 31, read: true })]));
    expect(h.closed).toHaveLength(2);
  });

  it('closes a grouped notice only when all its rows are closed', () => {
    const h = harness();
    h.core.applyFeed(feed([row({ id: 'a' })]));
    h.advance(1000);
    h.core.applyFeed(feed([row({ id: 'b' }), row({ id: 'c' })]));
    h.advance(RATE_MS);
    expect(h.shown).toHaveLength(2);
    h.core.withdraw('b');
    expect(h.closed).toHaveLength(0);
    h.core.withdraw('c');
    expect(h.closed).toHaveLength(1);
  });

  it('forgets a pending row that was resolved before the window ended', () => {
    const h = harness();
    h.core.applyFeed(feed([row({ id: 'a' })]));
    h.core.applyFeed(feed([row({ id: 'b' })]));
    h.core.withdraw('b');
    h.advance(RATE_MS);
    expect(h.shown).toHaveLength(1);
  });

  it('passes the sound setting off to the notice', () => {
    const h = harness();
    h.core.applyFeed(feed([row()], { sound: false }));
    expect(h.shown[0].sound.on).toBe(false);
  });

  it('stop() drops what waited', () => {
    const h = harness();
    h.core.applyFeed(feed([row({ id: 'a' })]));
    h.core.applyFeed(feed([row({ id: 'b' })]));
    h.core.stop();
    h.advance(RATE_MS * 2);
    expect(h.shown).toHaveLength(1);
  });
});
