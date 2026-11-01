import { useEffect, useState, type ReactNode } from 'react';
import {
  useNotificationSettings,
  usePatchNotificationSettings,
  useUnmute,
  type EventSetting,
  type MutedItem,
  type NotificationSettings,
  type NotificationSettingsPatch,
} from '../../api/notificationSettings';
import styles from './NotificationsSettings.module.css';

/** Settings › Notifications (design/screens/notifications.md, L and M). */

interface DesktopStatus {
  supported: boolean;
  permission: 'granted' | 'denied' | 'default';
}

interface DesktopBridge {
  status?: () => Promise<DesktopStatus> | DesktopStatus;
  test?: () => Promise<{ ok: boolean; reason?: string }>;
  openSystemSettings?: () => unknown;
}

const desktopBridge = (): DesktopBridge | undefined =>
  (window as unknown as { electronAPI?: { notifications?: DesktopBridge } }).electronAPI?.notifications;

/** What the fourth column says about a kind. */
const KIND_NOTE: Record<string, string> = {
  run_stopped_memory: 'From Resources',
  budget: 'Exists today',
  ai_finished: 'Grouped',
  page_published: 'Spaces you follow',
};

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const RETENTION_CHOICES = [30, 90, 180, 365];

function Lock() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#5B6B60"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function Switch({
  on,
  onChange,
  label,
  disabled,
}: Readonly<{
  on: boolean;
  onChange?: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}>) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`${styles.switch} ${on ? styles.switchOn : ''}`}
      onClick={() => onChange?.(!on)}
    >
      <span className={styles.knob} />
    </button>
  );
}

function Setting({
  name,
  hint,
  control,
  id,
}: Readonly<{ name: string; hint: ReactNode; control?: ReactNode; id?: string }>) {
  return (
    <div className={styles.setting} data-setting={id}>
      <div className={styles.settingText}>
        <div className={styles.settingName}>{name}</div>
        <div className={styles.hint}>{hint}</div>
      </div>
      {control}
    </div>
  );
}

function ClockIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#5B6B60"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#5B6B60"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
    </svg>
  );
}

/** "Weekdays at 18:00." */
function dayCardHint(d: NotificationSettings['dayCard']): string {
  const days = [...d.days].sort((a, b) => a - b);
  let when: string;
  if (days.length === 0) when = 'Never';
  else if (days.length === 7) when = 'Every day';
  else if (days.join() === '0,1,2,3,4') when = 'Weekdays';
  else when = days.map((i) => DAY_NAMES[i]).join(', ');
  return days.length === 0 ? 'Not sent.' : `${when} at ${d.time}.`;
}

function mutedText(m: MutedItem): string {
  const at = new Date(m.createdAt);
  const date = Number.isNaN(at.getTime()) ? '' : at.toLocaleDateString([], { day: 'numeric', month: 'short' });
  if (m.level === 'mentions') return date ? `only mentions and questions since ${date}` : 'only mentions and questions';
  if (m.until) {
    return `muted until ${new Date(m.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return date ? `muted on ${date}` : 'muted';
}

const withoutDay = (days: number[], i: number) => days.filter((d) => d !== i);
const withDay = (days: number[], i: number) => [...days, i].sort((a, b) => a - b);

function computerHint(status: DesktopStatus | null): string {
  if (status?.permission === 'default') return 'Your computer has not been asked yet. ';
  if (status?.supported === false) return 'Not available on this computer. ';
  return 'Allowed for this computer. ';
}

/** The Notifications page of App settings. */
export function NotificationsSettings() {
  const q = useNotificationSettings();
  const patch = usePatchNotificationSettings();
  const unmute = useUnmute();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const bridge = desktopBridge();
  const inApp = !!bridge;

  useEffect(() => {
    let live = true;
    if (!bridge?.status) return;
    Promise.resolve(bridge.status())
      .then((s) => live && setStatus(s))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // the bridge is a fixed object of the window
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = q.data;

  function save(p: NotificationSettingsPatch) {
    setError(null);
    patch.mutate(p, { onError: (e) => setError(e instanceof Error ? e.message : 'Could not save.') });
  }

  async function sendTest() {
    setTestResult(null);
    try {
      const r = await bridge?.test?.();
      setTestResult(r?.ok ? 'Sent. Look for it on your screen.' : (r?.reason ?? 'The test could not be sent.'));
    } catch {
      setTestResult('The test could not be sent.');
    }
    try {
      const next = await bridge?.status?.();
      if (next) setStatus(next);
    } catch {
      /* keep what was shown */
    }
  }

  if (q.isLoading) return <div className={styles.hint}>Loading…</div>;
  if (!s) return <div className={styles.error}>Could not load the notification settings.</div>;

  const needs = s.events.filter((e) => e.needs);
  const info = s.events.filter((e) => !e.needs);
  const denied = inApp && status?.permission === 'denied';
  const desktopOn = s.desktopOn;
  const retentionChoices = RETENTION_CHOICES.includes(s.retentionDays)
    ? RETENTION_CHOICES
    : [...RETENTION_CHOICES, s.retentionDays].sort((a, b) => a - b);

  const row = (e: EventSetting) => (
    <div key={e.kind} className={styles.row} data-testid={`event-${e.kind}`}>
      <span>{e.label}</span>
      <span className={styles.center}>
        {e.inappLocked ? (
          <span className={styles.locked} title="Always on: nothing else would tell you">
            <Switch on label={`${e.label}: in app (always on)`} disabled />
            <Lock />
          </span>
        ) : (
          <Switch
            on={e.inapp}
            label={`${e.label}: in app`}
            onChange={(v) => save({ events: [{ kind: e.kind, inapp: v }] })}
          />
        )}
      </span>
      <span className={styles.center}>
        <Switch
          on={e.desktop}
          label={`${e.label}: desktop`}
          onChange={(v) => save({ events: [{ kind: e.kind, desktop: v }] })}
        />
      </span>
      <span className={styles.note}>{KIND_NOTE[e.kind] ?? (e.kind === 'day_card' ? s.dayCard.time : '')}</span>
    </div>
  );

  return (
    <div className={styles.root} data-testid="notifications-settings">
      {error && (
        <div className={styles.error} role="alert">
          {error}
        </div>
      )}

      <div className={styles.table} data-setting="notif-events">
        <div className={styles.head}>
          <span>Event</span>
          <span className={styles.center}>In app</span>
          <span className={styles.center}>Desktop</span>
          <span />
        </div>
        <div className={styles.group}>Needs you &mdash; may interrupt</div>
        {needs.map(row)}
        <div className={styles.group}>For information &mdash; never interrupts</div>
        {info.map(row)}
        <div className={styles.lockNote}>
          <span className={styles.lockIcon}>
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#5B6B60"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
          </span>
          <div>
            <b>In app stays on for everything that needs you.</b> The switch is shown locked: an AI waiting on an answer
            with no row and no count would wait for ever. Only its desktop notification can be switched off.
          </div>
        </div>
      </div>

      <div className={styles.rows}>
        {denied ? (
          <div className={styles.refused} data-setting="notif-desktop" role="alert">
            <span className={styles.refusedIcon}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5M12 8h.01" />
              </svg>
            </span>
            <div className={styles.refusedBody}>
              <span className={styles.refusedTitle}>Your computer is blocking notifications</span>
              <span className={styles.refusedText}>
                Kanban Board may not show them. The panel and the count still work. Allow them in System Settings
                &rsaquo; Notifications.
              </span>
              <div className={styles.refusedActions}>
                <button type="button" className={styles.btn} onClick={() => bridge?.openSystemSettings?.()}>
                  Open System Settings
                </button>
                <button type="button" className={styles.btn} onClick={sendTest}>
                  Send a test
                </button>
              </div>
              {testResult && <span className={styles.refusedText}>{testResult}</span>}
            </div>
          </div>
        ) : (
          <Setting
            id="notif-desktop"
            name="Desktop notifications"
            hint={
              inApp ? (
                <>
                  {computerHint(status)}
                  <button type="button" className={styles.linkBtn} onClick={sendTest}>
                    Send a test
                  </button>
                  {testResult && <> {testResult}</>}
                </>
              ) : (
                'In the web version the tab title shows the count; desktop notifications need the desktop app.'
              )
            }
            control={
              inApp ? (
                <Switch on={desktopOn} label="Desktop notifications" onChange={(v) => save({ desktopOn: v })} />
              ) : undefined
            }
          />
        )}
        <Setting
          id="notif-quiet"
          name="Quiet hours"
          hint="Nothing interrupts between these times; the panel still fills."
          control={
            <>
              <div className={styles.input}>
                <ClockIcon />
                <input
                  type="time"
                  aria-label="Quiet hours start"
                  value={s.quiet.start}
                  onChange={(e) => e.target.value && save({ quiet: { start: e.target.value } })}
                />
                <span>&ndash;</span>
                <input
                  type="time"
                  aria-label="Quiet hours end"
                  value={s.quiet.end}
                  onChange={(e) => e.target.value && save({ quiet: { end: e.target.value } })}
                />
              </div>
              <Switch on={s.quiet.on} label="Quiet hours" onChange={(v) => save({ quiet: { on: v } })} />
            </>
          }
        />
        <Setting
          id="notif-dnd"
          name="Follow the system Do not disturb"
          hint="When your computer is quiet, so is this app."
          control={<Switch on={s.dnd} label="Follow the system Do not disturb" onChange={(v) => save({ dnd: v })} />}
        />
        <Setting
          id="notif-sound"
          name="Sound"
          hint={
            s.sound ? 'On. Only Needs you events make a sound.' : 'Off. When on, only Needs you events make a sound.'
          }
          control={<Switch on={s.sound} label="Sound" onChange={(v) => save({ sound: v })} />}
        />
        <div className={styles.setting} data-setting="notif-daycard" style={{ alignItems: 'flex-start' }}>
          <div className={styles.settingText}>
            <div className={styles.settingName}>The day card</div>
            <div className={styles.hint}>{dayCardHint(s.dayCard)}</div>
            <fieldset className={styles.days} aria-label="Days of the day card">
              {DAY_NAMES.map((name, i) => {
                const on = s.dayCard.days.includes(i);
                return (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={on}
                    className={`${styles.day} ${on ? styles.dayOn : ''}`}
                    onClick={() =>
                      save({ dayCard: { days: on ? withoutDay(s.dayCard.days, i) : withDay(s.dayCard.days, i) } })
                    }
                  >
                    {name}
                  </button>
                );
              })}
            </fieldset>
          </div>
          <div className={styles.input}>
            <SunIcon />
            <input
              type="time"
              aria-label="Day card time"
              value={s.dayCard.time}
              onChange={(e) => e.target.value && save({ dayCard: { time: e.target.value } })}
            />
          </div>
        </div>
        <Setting
          id="notif-retention"
          name="Keep notifications for"
          hint={
            s.retentionEditable === false
              ? 'Then they are deleted, for everyone. Only an owner or an admin can change this.'
              : 'Then they are deleted. The audit log keeps its own record.'
          }
          control={
            <div className={styles.input}>
              <select
                aria-label="Keep notifications for"
                disabled={s.retentionEditable === false}
                value={s.retentionDays}
                onChange={(e) => save({ retentionDays: Number(e.target.value) })}
              >
                {retentionChoices.map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </div>
          }
        />
      </div>

      <div className={styles.card}>
        <div className={styles.cardTitle}>What a switch off actually does</div>
        <ul className={styles.list}>
          <li>
            <b>In app off</b>: no row in the panel and nothing in the count. The event is still <b>recorded</b> and
            still appears on the All notifications page and in the day card.
          </li>
          <li>
            <b>Desktop off</b>: no notification from the operating system. Nothing else changes.
          </li>
          <li>
            <b>Both off</b>: it still happened, and you can still find it.
          </li>
          <li>
            <b>Muting</b> a ticket, page or project works the same way: quiet, not erased.
          </li>
          <li>
            The one thing that is never quiet is a <b>Needs you</b> item addressed to you: its <b>In app</b> switch is
            locked on, and muting a ticket or a project cannot hide it either. Nothing else would move it.
          </li>
        </ul>
      </div>

      <div className={styles.card} data-setting="notif-muted" data-testid="muted-list">
        <div className={styles.cardTitle}>Muted ({s.muted.length})</div>
        <ul className={styles.list}>
          {s.muted.map((m) => (
            <li key={m.id}>
              <b>{m.label || m.scopeId}</b> &mdash; {mutedText(m)} &middot;{' '}
              <button
                type="button"
                className={styles.linkBtn}
                disabled={unmute.isPending}
                onClick={() => unmute.mutate(m.id)}
              >
                Unmute
              </button>
            </li>
          ))}
          <li>Everything you mute from a row or a ticket shows here, so nothing stays off by accident.</li>
        </ul>
      </div>
    </div>
  );
}
