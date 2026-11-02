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
import {
  browserPermission,
  requestBrowserPermission,
  sendBrowserTest,
  type BrowserPermission,
} from '../../utils/browserNotifications';
import { playNotificationSound, SOUND_NAMES, SOUNDS } from '../../utils/notificationSound';
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

/** What "Remind me if unanswered" offers, in minutes (0 = never). */
const REMIND_CHOICES = [0, 5, 10, 15, 30, 60];

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

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "9:05" → "09:05"; null when the text is not a 24 h time. */
function parseTime(text: string): string | null {
  const m = TIME_RE.exec(text.trim());
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

/** Moves a HH:MM time by a number of minutes, wrapping round the day. */
function shiftTime(value: string, minutes: number): string {
  const [h, m] = value.split(':').map(Number);
  const total = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * A 24 h time typed as text ("22:00"), as the design draws it: the browser's own time field shows 12 h and adds
 * a second clock icon. A complete time saves at once; ↑ ↓ step the hour or the minutes (where the caret is), as
 * the native field did; an unfinished value goes back to the saved one on blur.
 */
function TimeField({ value, label, onSave }: Readonly<{ value: string; label: string; onSave: (v: string) => void }>) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      type="text"
      inputMode="numeric"
      className={styles.time}
      aria-label={label}
      placeholder="HH:MM"
      maxLength={5}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const t = parseTime(e.target.value);
        if (t) onSave(t);
      }}
      onBlur={() => setDraft(parseTime(draft) ?? value)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        const base = parseTime(draft) ?? value;
        if (!TIME_RE.test(base)) return;
        e.preventDefault();
        const onHour = (e.currentTarget.selectionStart ?? 0) <= 2;
        const next = shiftTime(base, (e.key === 'ArrowUp' ? 1 : -1) * (onHour ? 60 : 1));
        setDraft(next);
        onSave(next);
      }}
    />
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

/** The line under "Desktop notifications" in a browser: what the browser allowed, and the button for the next step. */
function BrowserHint({
  permission,
  testResult,
  onAllow,
  onTest,
}: Readonly<{
  permission: BrowserPermission;
  testResult: string | null;
  onAllow: () => void;
  onTest: () => void;
}>) {
  switch (permission) {
    case 'unsupported':
      return <>This browser cannot show system notifications. The tab title still shows the count.</>;
    case 'denied':
      return (
        <>
          The browser is blocking notifications for this site. Allow them in the site settings of the address bar, then{' '}
          <button type="button" className={styles.linkBtn} onClick={onTest}>
            send a test
          </button>
          .{testResult && <> {testResult}</>}
        </>
      );
    case 'default':
      return (
        <>
          Your browser has not been asked yet.{' '}
          <button type="button" className={styles.linkBtn} onClick={onAllow}>
            Allow in this browser
          </button>
          {testResult && <> {testResult}</>}
        </>
      );
    default:
      return (
        <>
          Allowed in this browser, even when this tab is in the background.{' '}
          <button type="button" className={styles.linkBtn} onClick={onTest}>
            Send a test
          </button>
          {testResult && <> {testResult}</>}
        </>
      );
  }
}

/** The Notifications page of App settings. */
export function NotificationsSettings() {
  const q = useNotificationSettings();
  const patch = usePatchNotificationSettings();
  const unmute = useUnmute();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [browser, setBrowser] = useState<BrowserPermission>(() => browserPermission());
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

  /** The browser asks once, from this button, never on first load (design J). */
  async function allowInBrowser() {
    setTestResult(null);
    setBrowser(await requestBrowserPermission());
  }

  async function sendBrowserNotice() {
    setTestResult(null);
    const r = await sendBrowserTest({ on: !!s?.sound, name: s?.soundName ?? 'chime' });
    setBrowser(browserPermission());
    setTestResult(r.ok ? 'Sent. Look for it on your screen.' : (r.reason ?? 'The test could not be sent.'));
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
                <BrowserHint
                  permission={browser}
                  testResult={testResult}
                  onAllow={allowInBrowser}
                  onTest={sendBrowserNotice}
                />
              )
            }
            control={
              inApp || browser !== 'unsupported' ? (
                // a browser that blocks notifications cannot be asked to turn it on, but a saved "on" can still go off
                <Switch
                  on={desktopOn}
                  disabled={!inApp && browser === 'denied' && !desktopOn}
                  label="Desktop notifications"
                  onChange={(v) => save({ desktopOn: v })}
                />
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
                <TimeField
                  label="Quiet hours start"
                  value={s.quiet.start}
                  onSave={(v) => save({ quiet: { start: v } })}
                />
                <span>&ndash;</span>
                <TimeField label="Quiet hours end" value={s.quiet.end} onSave={(v) => save({ quiet: { end: v } })} />
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
            s.sound
              ? 'On. A Needs you plays this, in the desktop app and in the browser; information never does.'
              : 'Off. When on, only Needs you events make a sound.'
          }
          control={
            <>
              <div className={styles.input}>
                <select
                  aria-label="Which sound"
                  value={s.soundName}
                  disabled={!s.sound}
                  onChange={(e) => {
                    save({ soundName: e.target.value });
                    void playNotificationSound(e.target.value);
                  }}
                >
                  {SOUND_NAMES.map((name) => (
                    <option key={name} value={name}>
                      {SOUNDS[name].label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className={styles.btn}
                disabled={!s.sound}
                onClick={() => void playNotificationSound(s.soundName)}
              >
                Play
              </button>
              <Switch on={s.sound} label="Sound" onChange={(v) => save({ sound: v })} />
            </>
          }
        />
        <Setting
          id="notif-remind"
          name="Remind me if unanswered"
          hint={
            s.remindAfterMin > 0
              ? `A Needs you nobody has opened after ${s.remindAfterMin} min notifies once more, with the sound. Never in quiet hours.`
              : 'Off. A Needs you notifies once, when it arrives.'
          }
          control={
            <div className={styles.input}>
              <select
                aria-label="Remind me if unanswered"
                value={s.remindAfterMin}
                onChange={(e) => save({ remindAfterMin: Number(e.target.value) })}
              >
                {(REMIND_CHOICES.includes(s.remindAfterMin)
                  ? REMIND_CHOICES
                  : [...REMIND_CHOICES, s.remindAfterMin].sort((a, b) => a - b)
                ).map((m) => (
                  <option key={m} value={m}>
                    {m === 0 ? 'Never' : `After ${m} min`}
                  </option>
                ))}
              </select>
            </div>
          }
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
            <TimeField label="Day card time" value={s.dayCard.time} onSave={(v) => save({ dayCard: { time: v } })} />
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
