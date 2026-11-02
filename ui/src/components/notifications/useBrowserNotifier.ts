import { useCallback, useEffect, useRef } from 'react';
import type { NotificationFeed } from '../../types/notifications';
import { playNotificationSound } from '../../utils/notificationSound';
import { BrowserNotifierCore, type Notice, type NoticeOpen } from './browserNotifier';
import { inElectron } from './notificationUi';

/**
 * System notifications from a browser tab (#270, design J): the Web Notifications API, for the board running in a
 * background tab. Only one tab sends: the tabs queue for a Web Lock and the one that holds it is the notifier; the
 * others tell it over a BroadcastChannel whether they are being looked at, because a tab in front already toasts.
 * Not in the desktop app, whose main process owns the notices.
 */

const LOCK = 'kanban-board-notifier';
const CHANNEL = 'kanban-board-notifier';
const HEARTBEAT_MS = 4000;
const PEER_FRESH_MS = 10_000;

const tabId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function lookingAtThisTab(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/** Whether this browser can notify and the person allowed it. */
export function mayNotifyFromBrowser(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted' && !inElectron();
}

/**
 * Returns the function to call with every feed after the first: it shows a system notice for what needs the person
 * when this tab is the notifier and no tab is being looked at. `onOpen` gets what a click on a notice asks for.
 */
export function useBrowserNotifier(onOpen: (open: NoticeOpen) => void): (feed: NotificationFeed) => void {
  const open = useRef(onOpen);
  open.current = onOpen;
  const leader = useRef(false);
  const peers = useRef(new Map<string, { focused: boolean; at: number }>());
  const core = useRef<BrowserNotifierCore<Notification> | null>(null);

  useEffect(() => {
    if (typeof Notification === 'undefined' || inElectron()) return;
    const id = tabId();
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
    const someoneElseLooking = () => {
      const fresh = Date.now() - PEER_FRESH_MS;
      return [...peers.current.values()].some((p) => p.focused && p.at >= fresh);
    };

    core.current = new BrowserNotifierCore<Notification>({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      context: () => ({ focused: lookingAtThisTab() || someoneElseLooking(), quiet: false }),
      show: (notice, sound) => showNotice(notice, sound, open, core.current),
      close: (n) => {
        try {
          n.close();
        } catch {
          /* already gone */
        }
      },
    });

    const say = () => channel?.postMessage({ id, focused: lookingAtThisTab() });
    const onMessage = (e: MessageEvent) => {
      const m = e.data as { id?: string; focused?: boolean } | null;
      if (m?.id && m.id !== id) peers.current.set(m.id, { focused: Boolean(m.focused), at: Date.now() });
    };
    channel?.addEventListener('message', onMessage);
    const heartbeat = setInterval(() => {
      if (lookingAtThisTab()) say();
    }, HEARTBEAT_MS);
    const tell = () => say();
    window.addEventListener('focus', tell);
    window.addEventListener('blur', tell);
    document.addEventListener('visibilitychange', tell);
    window.addEventListener('pagehide', tell);
    say();

    // The tabs queue for the lock; the one that holds it notifies. It is released when this tab closes.
    let release: (() => void) | null = null;
    const abort = new AbortController();
    if (navigator.locks?.request) {
      navigator.locks
        .request(LOCK, { signal: abort.signal }, () => {
          leader.current = true;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        })
        .catch(() => undefined); // aborted while waiting
    } else {
      leader.current = true; // no Web Locks: better two notices than none
    }

    return () => {
      leader.current = false;
      abort.abort();
      release?.();
      clearInterval(heartbeat);
      window.removeEventListener('focus', tell);
      window.removeEventListener('blur', tell);
      document.removeEventListener('visibilitychange', tell);
      window.removeEventListener('pagehide', tell);
      channel?.removeEventListener('message', onMessage);
      channel?.postMessage({ id, focused: false });
      channel?.close();
      core.current?.stop();
      core.current = null;
    };
  }, []);

  return useCallback((feed: NotificationFeed) => {
    if (!leader.current || !mayNotifyFromBrowser()) return;
    core.current?.applyFeed(feed);
  }, []);
}

/** Shows one system notice; returns the Notification so it can be withdrawn, or null when the browser refused. */
function showNotice(
  notice: Notice,
  sound: { on: boolean; name: string },
  open: { current: (o: NoticeOpen) => void },
  core: BrowserNotifierCore<Notification> | null,
): Notification | null {
  try {
    // Needs you makes our own sound; if the browser would not let the page make sound (nobody clicked on it yet), the
    // system's own stands in. With the sound switched off, and for information, the notice is silent.
    const n = new Notification(notice.title, {
      body: notice.body,
      tag: notice.tag,
      icon: '/logo.svg',
      requireInteraction: notice.needs,
      silent: !(sound.on && notice.needs) || audioWillPlay(),
    });
    if (sound.on && notice.needs) void playNotificationSound(sound.name);
    n.onclick = () => {
      window.focus();
      n.close();
      core?.forget(n);
      open.current(notice.open);
    };
    n.onclose = () => core?.forget(n);
    return n;
  } catch {
    return null;
  }
}

/** Whether the page has been used enough for the browser to let it play a sound. */
function audioWillPlay(): boolean {
  return Boolean(navigator.userActivation?.hasBeenActive);
}
