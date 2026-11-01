import { useEffect, useState, type MouseEvent, type Ref } from 'react';
import type { Project } from '../../types';
import type { NotificationRow as Row } from '../../types/notifications';
import {
  Icon,
  avatarColors,
  groupActors,
  initialsOf,
  relTime,
  rowTime,
  snoozeChoices,
  snoozeText,
  visualOf,
  type IconName,
} from './notificationUi';
import styles from './NotificationRow.module.css';

/** What a row can ask for: an action id with the facts it needs (an answer text, a snooze time, an item's ticket). */
export type RowActionHandler = (
  row: Row,
  actionId: string,
  extra?: { text?: string; until?: string | null; ticketId?: string | null; label?: string },
) => void | Promise<void>;

const ACTION_ICONS: Record<string, IconName> = {
  answer: 'reply',
  reply: 'reply',
  retry: 'retry',
  approve: 'tick',
  sign_in: 'plug',
};
const LIST_LIMIT = 20;
const STEP = 4;

function Avatar({ name, small }: { name: string; small?: boolean }) {
  const c = avatarColors(name);
  return (
    <span
      title={name}
      className={`${styles.avatar} ${small ? styles.avatarSmall : ''}`}
      style={{ background: c.bg, color: c.fg, borderColor: c.border }}
    >
      {initialsOf(name)}
    </span>
  );
}

function TicketChip({ id, onClick }: { id: string; onClick?: () => void }) {
  // without a click handler (a gone row, a line inside a group) it is only a label
  if (!onClick)
    return (
      <span className={styles.chipTicket}>
        <span className={styles.dotSmall} />
        {id}
      </span>
    );
  return (
    <button type="button" className={styles.chipTicket} onClick={onClick} title={`Open ${id}`}>
      <span className={styles.dotSmall} />
      {id}
    </button>
  );
}

/**
 * One notification (design D1): unread dot, kind icon, one line, detail, chips, waiting time and the actions it
 * offers. Hovering adds Snooze and Mute beside the other buttons; a grouped row lists its items; a row whose target
 * is gone offers only Dismiss.
 */
export function NotificationRow({
  row,
  projects,
  onAction,
  selected,
  rowRef,
  now,
  onPage,
  focused,
}: {
  row: Row;
  projects?: Map<string, Project>;
  onAction: RowActionHandler;
  selected?: boolean;
  rowRef?: Ref<HTMLDivElement>;
  now?: number;
  /** On the All notifications page "Open the list" lists the items here instead of leaving for the page. */
  onPage?: boolean;
  /** The page was opened for this row (from the panel's "Open the list"): start expanded and scroll to it. */
  focused?: boolean;
}) {
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [expanded, setExpanded] = useState(!!focused);
  const [shown, setShown] = useState(focused ? row.items.length || STEP : STEP);
  const [projMenu, setProjMenu] = useState(false);
  const [moreMenu, setMoreMenu] = useState(false);
  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    setShown(row.items.length || STEP);
    document.querySelector(`[data-row-id="${row.id}"]`)?.scrollIntoView?.({ block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, row.id]);

  const v = visualOf(row.kind);
  const project = row.projectId ? projects?.get(row.projectId) : undefined;
  const open = row.needs && !row.done && !row.gone;
  const unread = !row.read && !row.done;
  const actors = row.count > 1 ? groupActors(row) : [];
  const grouped = !row.needs && row.count > 1;
  const huge = grouped && row.count > LIST_LIMIT;
  const faded = row.done || row.snoozed || (row.read && !row.needs) || row.gone;
  const pageTitle = typeof row.data.pageTitle === 'string' ? row.data.pageTitle : null;
  const options = Array.isArray(row.data.options)
    ? (row.data.options as unknown[]).filter((o) => typeof o === 'string')
    : [];

  const fire = async (id: string, extra?: Parameters<RowActionHandler>[2]) => {
    setBusy(true);
    try {
      await onAction(row, id, extra);
    } finally {
      setBusy(false);
    }
  };

  const clickable = !row.needs && !row.gone && !grouped && !row.done && !row.snoozed;
  const onBodyClick = (e: MouseEvent) => {
    if (!clickable) return;
    if ((e.target as HTMLElement).closest('button, a, textarea, input')) return;
    void fire('open');
  };

  const body = row.gone
    ? (row.goneReason ?? row.body)
    : row.snoozed && row.snoozedUntil
      ? snoozeText(row.snoozedUntil, now)
      : row.body;

  const toggleList = () => {
    if (!expanded && huge) setShown(row.items.length || STEP);
    setExpanded((e) => !e);
  };
  const actionsShown = row.gone ? row.actions.filter((a) => a.id === 'dismiss') : row.actions;
  // A row whose only buttons are the hover ones (an update) keeps no empty line for them: they float at its corner
  const onlyHover =
    !row.snoozed &&
    !grouped &&
    actionsShown.filter((a) => a.id !== 'expand' && !(a.id === 'open' && !row.needs)).length === 0;

  const visible = row.items.slice(0, expanded ? shown : 0);
  const rest = row.items.length - shown;

  return (
    <div
      ref={rowRef}
      data-row-id={row.id}
      data-unread={unread ? 'true' : undefined}
      className={`${styles.row} ${open ? styles.needsOpen : ''} ${faded ? styles.faded : ''} ${
        clickable ? styles.clickable : ''
      } ${selected ? styles.selected : ''}`}
      onClick={onBodyClick}
      onKeyDown={(e) => {
        // Enter or Space on the focused row opens it, as a click does (J/K and Enter in the list do the same)
        if (clickable && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          void fire('open');
        }
      }}
    >
      {unread ? (
        <span className={`${styles.dot} ${row.needs ? styles.dotNeeds : styles.dotUpdate}`} aria-label="Unread" />
      ) : (
        <span className={styles.dotSpacer} />
      )}
      {actors.length > 0 ? (
        <span className={styles.avatars}>
          {actors.slice(0, 4).map((a) => (
            <span key={a} className={styles.avatarWrap}>
              <Avatar name={a} />
            </span>
          ))}
        </span>
      ) : (
        <span className={styles.icon} style={{ background: v.bg, color: v.fg }}>
          <Icon name={v.icon} size={16} stroke={2} color={v.fg} />
        </span>
      )}
      <div className={styles.main}>
        <div className={styles.head}>
          <div className={`${styles.title} ${unread || open ? '' : styles.titleQuiet}`}>{row.title}</div>
          <span className={styles.time}>{relTime(rowTime(row), now)}</span>
        </div>
        {body && <div className={styles.body}>{body}</div>}
        <div className={styles.chips}>
          {row.memberName && actors.length === 0 && (
            <span className={`${styles.chip} ${styles.chipAi}`}>{row.memberName}</span>
          )}
          {row.kind === 'account_signed_out' && Number(row.data?.members) > 0 && (
            <span className={`${styles.chip} ${styles.chipAi}`}>{`${Number(row.data?.members)} members`}</span>
          )}
          {row.ticketId && !grouped && (
            <TicketChip id={row.ticketId} onClick={row.gone ? undefined : () => void fire('open_ticket')} />
          )}
          {pageTitle &&
            (row.gone ? (
              <span className={styles.chipPage}>
                <Icon name="doc" size={11} />
                {pageTitle}
              </span>
            ) : (
              <button type="button" className={styles.chipPage} onClick={() => void fire('open')}>
                <Icon name="doc" size={11} />
                {pageTitle}
              </button>
            ))}
          {project && (
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <button
                type="button"
                className={`${styles.chip} ${styles.chipProject}`}
                aria-haspopup="menu"
                aria-expanded={projMenu}
                title={`${project.name} — mute`}
                onClick={() => setProjMenu((m) => !m)}
              >
                <span className={styles.projectDot} style={{ background: project.color }} />
                {project.name}
              </button>
              {projMenu && (
                <div className={styles.menu} role="menu" style={{ top: 24 }}>
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={() => {
                      setProjMenu(false);
                      void fire('mute_project', { label: project.name });
                    }}
                  >
                    Mute {project.name}
                  </button>
                </div>
              )}
            </span>
          )}
        </div>
        {row.done && row.doneText && (
          <div style={{ marginTop: 6 }}>
            <span className={`${styles.chip} ${styles.chipDone}`}>
              <span className={styles.dotSmall} style={{ background: '#2e6f40' }} />
              Done — {row.doneText.charAt(0).toLowerCase() + row.doneText.slice(1)}
            </span>
          </div>
        )}

        {answering && (
          <div className={styles.answer}>
            {options.length > 0 && (
              <div className={styles.options}>
                {options.map((o) => (
                  <button
                    key={String(o)}
                    type="button"
                    className={styles.btn}
                    disabled={busy}
                    onClick={() => void fire('answer', { text: String(o) })}
                  >
                    {String(o)}
                  </button>
                ))}
              </div>
            )}
            <textarea
              className={styles.answerInput}
              autoFocus
              value={answer}
              placeholder="Type your answer…"
              aria-label="Your answer"
              onChange={(e) => setAnswer(e.target.value)}
            />
            <div className={styles.actions} style={{ marginTop: 0 }}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={busy || !answer.trim()}
                onClick={() => void fire('answer', { text: answer.trim() })}
              >
                Send answer
              </button>
              <button type="button" className={styles.btn} onClick={() => setAnswering(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {expanded && visible.length > 0 && (
          <div className={styles.items}>
            {visible.map((it) => (
              <div key={it.eventId} className={styles.item}>
                {it.actor && <Avatar name={it.actor} small />}
                <span className={styles.itemText}>
                  {row.kind === 'ai_finished' && it.actor ? (
                    <>
                      <b>{it.actor}</b> finished{' '}
                    </>
                  ) : (
                    <>{it.title} </>
                  )}
                  {it.ticketId && <TicketChip id={it.ticketId} />}
                </span>
                <span className={styles.itemTime}>{relTime(it.at, now)}</span>
                {it.ticketId && (
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => void fire('open_item', { ticketId: it.ticketId })}
                  >
                    Open
                  </button>
                )}
              </div>
            ))}
            {row.count > row.items.length && (
              <div className={styles.itemMore}>
                Showing the last {row.items.length} of {row.count}.
              </div>
            )}
            {rest > 0 && (
              <div className={styles.itemMore}>
                <button type="button" className={styles.linkBtn} onClick={() => setShown((n) => n + STEP)}>
                  <Icon name="down" size={12} /> Show {Math.min(STEP, rest)} more
                </button>
              </div>
            )}
          </div>
        )}

        <div className={`${styles.actions} ${onlyHover ? styles.actionsFloating : ''}`}>
          {row.snoozed ? (
            <button type="button" className={styles.btn} disabled={busy} onClick={() => void fire('unsnooze')}>
              Bring back now
            </button>
          ) : (
            <>
              {grouped &&
                (huge ? (
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => (onPage ? toggleList() : void fire('open_list'))}
                  >
                    {onPage && expanded ? 'Hide the list' : 'Open the list'}
                  </button>
                ) : (
                  <button type="button" className={styles.btn} onClick={toggleList}>
                    <Icon name="down" size={12} />
                    {expanded ? 'Hide' : `Show all ${row.count}`}
                  </button>
                ))}
              {actionsShown
                .filter((a) => a.id !== 'expand' && !(a.id === 'open' && !row.needs))
                .map((a, i) => {
                  const icon = ACTION_ICONS[a.id];
                  return (
                    <button
                      key={a.id}
                      type="button"
                      disabled={busy}
                      className={`${styles.btn} ${i === 0 && row.needs ? styles.btnPrimary : ''}`}
                      onClick={() => (a.id === 'answer' ? setAnswering((x) => !x) : void fire(a.id))}
                    >
                      {icon && <Icon name={icon} />}
                      {a.label}
                    </button>
                  );
                })}
              {open && (
                <>
                  <span style={{ position: 'relative', display: 'inline-flex' }} className={styles.hoverOnly}>
                    <button
                      type="button"
                      className={styles.btn}
                      aria-haspopup="menu"
                      aria-expanded={menu}
                      aria-label="Snooze"
                      title="Snooze"
                      onClick={() => setMenu((m) => !m)}
                    >
                      <Icon name="clock" />
                      <span className={styles.hoverLabel}>Snooze</span>
                    </button>
                    {menu && (
                      <div className={styles.menu} role="menu">
                        {snoozeChoices().map((c) => (
                          <button
                            key={c.label}
                            type="button"
                            role="menuitem"
                            className={styles.menuItem}
                            onClick={() => {
                              setMenu(false);
                              void fire('snooze', { until: c.until });
                            }}
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                  {row.ticketId && (
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.hoverOnly}`}
                      aria-label="Mute this ticket"
                      title="Mute this ticket"
                      onClick={() => void fire('mute')}
                    >
                      <Icon name="mute" />
                      <span className={styles.hoverLabel}>Mute this ticket</span>
                    </button>
                  )}
                </>
              )}
              {!row.gone && (
                <span style={{ position: 'relative', display: 'inline-flex' }} className={styles.hoverOnly}>
                  <button
                    type="button"
                    className={styles.btn}
                    aria-haspopup="menu"
                    aria-expanded={moreMenu}
                    aria-label="More"
                    title="More"
                    onClick={() => setMoreMenu((m) => !m)}
                  >
                    <Icon name="more" />
                  </button>
                  {moreMenu && (
                    <div className={styles.menu} role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.menuItem}
                        onClick={() => {
                          setMoreMenu(false);
                          void fire('mute_kind');
                        }}
                      >
                        Turn this kind off
                      </button>
                    </div>
                  )}
                </span>
              )}
            </>
          )}
        </div>
      </div>
      {!row.needs && !row.cleared && !row.snoozed && (
        <button
          type="button"
          className={styles.clearX}
          aria-label="Clear"
          title="Clear"
          onClick={() => void fire('clear')}
        >
          <Icon name="x" size={13} />
        </button>
      )}
    </div>
  );
}
