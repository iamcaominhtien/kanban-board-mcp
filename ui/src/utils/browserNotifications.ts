import { playNotificationSound } from './notificationSound';

/** The Web Notifications API of the browser: what Settings › Notifications asks and tests (#270). */

export type BrowserPermission = 'granted' | 'denied' | 'default' | 'unsupported';

export const BROWSER_TEST_TITLE = 'Kanban Board — Test notification';

/** Whether this page can show a system notification, and whether the person allowed it. */
export function browserPermission(): BrowserPermission {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission;
}

/** Asks the browser for permission; only ever from a click in Settings, never on first load. */
export async function requestBrowserPermission(): Promise<BrowserPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    // old Safari takes a callback and returns nothing
    const result = await new Promise<NotificationPermission>((resolve) => {
      const maybe = Notification.requestPermission(resolve);
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, () => resolve(Notification.permission));
    });
    return result;
  } catch {
    return Notification.permission;
  }
}

/**
 * Shows the test notification now (past the 20 s limit and quiet hours) with the chosen sound.
 * Resolves with what happened, as a sentence for the page.
 */
export async function sendBrowserTest(sound: { on: boolean; name: string }): Promise<{ ok: boolean; reason?: string }> {
  const permission = browserPermission();
  if (permission === 'unsupported') return { ok: false, reason: 'This browser cannot show system notifications.' };
  if (permission === 'denied') {
    return {
      ok: false,
      reason: 'The browser is blocking notifications for this site. Allow them in its site settings.',
    };
  }
  if (permission === 'default') {
    const asked = await requestBrowserPermission();
    if (asked !== 'granted') return { ok: false, reason: 'Notifications were not allowed.' };
  }
  const played = sound.on ? await playNotificationSound(sound.name) : false;
  try {
    const n = new Notification(BROWSER_TEST_TITLE, {
      body: 'Notifications from Kanban Board will look like this.',
      tag: 'kanban-test',
      // our own sound already rang; if it could not, the system one stands in
      silent: sound.on ? played : true,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'The browser refused the notification.' };
  }
}
