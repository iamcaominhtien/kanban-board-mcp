import { useEffect, useRef, useState, type MouseEvent, type Ref } from 'react';
import type { Project } from '../../types';
import type { NotificationRow as Row } from '../../types/notifications';
import { ContinueNoteDialog } from '../ai/trouble/ContinueNoteDialog';
import { HandToDialog } from '../ai/trouble/HandToDialog';
import { MoveAccountDialog, type AccountRoom } from '../ai/trouble/MoveAccountDialog';
import { DiagnosisBlock } from './DiagnosisBlock';
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
  extra?: {
    text?: string;
    until?: string | null;
    ticketId?: string | null;
    label?: string;
    memberId?: string;
    accountId?: string;
  },
  /** `false` when the action failed (the row then keeps what the person typed); anything else counts as done. */
) => void | boolean | Promise<void | boolean>;

const ACTION_ICONS: Record<string, IconName> = {
  answer: 'reply',
  reply: 'reply',
  retry: 'retry',
  approve: 'tick',
  sign_in: 'plug',
  'trouble:stop_child': 'stop',
  'trouble:tell_ai': 'bubble',
  'trouble:wait': 'clock',
  move_account: 'arrow',
};

/** Actions that ask for a little more first: a note, another AI, an account. */
export type RowDialog = 'note' | 'hand' | 'account';
const DIALOG_OF: Record<string, RowDialog> = {
  continue_note: 'note',
  'trouble:continue_note': 'note',
  hand_to: 'hand',
  move_account: 'account',
};

/** The accounts with room, from a window_urgent row's data. */
export function accountRoomOf(row: Row): AccountRoom[] {
  const room = row.data.room;
  if (!Array.isArray(room)) return [];
  return (room as Record<string, unknown>[]).map((a) => ({
    accountId: String(a.accountId ?? ''),
    name: String(a.name ?? a.email ?? a.accountId ?? ''),
    email: typeof a.email === 'string' ? a.email : undefined,
    plan: typeof a.plan === 'string' ? a.plan : undefined,
    used: typeof a.used === 'number' ? a.used : undefined,
    free: typeof a.free === 'number' ? a.free : undefined,
  }));
}
const LIST_LIMIT = 20;
const STEP = 4;

type Extra = Parameters<RowActionHandler>[2];
type Fire = (id: string, extra?: Extra) => Promise<boolean>;
type RowItem = Row['items'][number];

function Avatar({ name, small }: Readonly<{ name: string; small?: boolean }>) {
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

function TicketChip({ id, onClick }: Readonly<{ id: string; onClick?: () => void }>) {
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

/** What a row is, worked out once: which look it has and which of its parts show. */
function rowFacts(
  row: Row,
  projects: Map<string, Project> | undefined,
  expanded: boolean,
  shown: number,
  now?: number,
) {
  const open = row.needs && !row.done && !row.gone;
  const grouped = !row.needs && row.count > 1;
  const actionsShown = row.gone ? row.actions.filter((a) => a.id === 'dismiss') : row.actions;
  return {
    visual: visualOf(row.kind),
    project: row.projectId ? projects?.get(row.projectId) : undefined,
    open,
    unread: !row.read && !row.done,
    actors: row.count > 1 ? groupActors(row) : [],
    grouped,
    huge: grouped && row.count > LIST_LIMIT,
    faded: row.done || row.snoozed || (row.read && !row.needs) || row.gone,
    clickable: !row.needs && !row.gone && !grouped && !row.done && !row.snoozed,
    pageTitle: typeof row.data.pageTitle === 'string' ? row.data.pageTitle : null,
    options: Array.isArray(row.data.options)
      ? (row.data.options as unknown[]).filter((o): o is string => typeof o === 'string')
      : [],
    body: bodyOf(row, now),
    actionsShown,
    // A row whose only buttons are the hover ones (an update) keeps no empty line for them: they float at its corner
    onlyHover:
      !row.snoozed &&
      !grouped &&
      actionsShown.filter((a) => a.id !== 'expand' && !(a.id === 'open' && !row.needs)).length === 0,
    visible: row.items.slice(0, expanded ? shown : 0),
    rest: row.items.length - shown,
  };
}

function bodyOf(row: Row, now?: number): string {
  if (row.gone) return row.goneReason ?? row.body;
  if (row.snoozed && row.snoozedUntil) return snoozeText(row.snoozedUntil, now);
  return row.body;
}

/** Whether the row is open expanded, and how many of its items show; "Open the list" from the panel starts it open. */
function useRowList(row: Row, focused: boolean | undefined, huge: boolean) {
  const [expanded, setExpanded] = useState(!!focused);
  const [shown, setShown] = useState(focused ? row.items.length || STEP : STEP);
  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    setShown(row.items.length || STEP);
    document.querySelector(`[data-row-id="${row.id}"]`)?.scrollIntoView?.({ block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused, row.id]);
  const toggleList = () => {
    if (!expanded && huge) setShown(row.items.length || STEP);
    setExpanded((e) => !e);
  };
  return { expanded, shown, setShown, toggleList };
}

/** The dot and the icon or avatars at the start of a row. */
function RowLead({
  unread,
  needs,
  actors,
  visual,
}: Readonly<{ unread: boolean; needs: boolean; actors: string[]; visual: ReturnType<typeof visualOf> }>) {
  return (
    <>
      {unread ? (
        <span className={`${styles.dot} ${needs ? styles.dotNeeds : styles.dotUpdate}`} aria-label="Unread" />
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
        <span className={styles.icon} style={{ background: visual.bg, color: visual.fg }}>
          <Icon name={visual.icon} size={16} stroke={2} color={visual.fg} />
        </span>
      )}
    </>
  );
}

function PageChip({ title, gone, fire }: Readonly<{ title: string; gone: boolean; fire: Fire }>) {
  if (gone)
    return (
      <span className={styles.chipPage}>
        <Icon name="doc" size={11} />
        {title}
      </span>
    );
  return (
    <button type="button" className={styles.chipPage} onClick={() => void fire('open')}>
      <Icon name="doc" size={11} />
      {title}
    </button>
  );
}

function ProjectChip({ project, fire }: Readonly<{ project: Project; fire: Fire }>) {
  const [projMenu, setProjMenu] = useState(false);
  return (
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
  );
}

/** The chips under a row's text: the AI member, the ticket, the page, the project. */
function RowChips({
  row,
  actors,
  grouped,
  pageTitle,
  project,
  fire,
}: Readonly<{
  row: Row;
  actors: string[];
  grouped: boolean;
  pageTitle: string | null;
  project: Project | undefined;
  fire: Fire;
}>) {
  return (
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
      {pageTitle && <PageChip title={pageTitle} gone={row.gone} fire={fire} />}
      {project && <ProjectChip project={project} fire={fire} />}
    </div>
  );
}

/** The answer box of a question: its options as buttons, a text field, Send and Cancel. */
function AnswerBox({
  options,
  answer,
  onAnswer,
  busy,
  fire,
  onCancel,
}: Readonly<{
  options: string[];
  answer: string;
  onAnswer: (text: string) => void;
  busy: boolean;
  fire: Fire;
  onCancel: () => void;
}>) {
  const input = useRef<HTMLTextAreaElement>(null);
  // the field takes the focus as the box opens
  useEffect(() => input.current?.focus(), []);
  return (
    <div className={styles.answer}>
      {options.length > 0 && (
        <div className={styles.options}>
          {options.map((o) => (
            <button
              key={o}
              type="button"
              className={styles.btn}
              disabled={busy}
              onClick={() => void fire('answer', { text: o })}
            >
              {o}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={input}
        className={styles.answerInput}
        value={answer}
        placeholder="Type your answer…"
        aria-label="Your answer"
        onChange={(e) => onAnswer(e.target.value)}
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
        <button type="button" className={styles.btn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ItemLine({ row, it, now, fire }: Readonly<{ row: Row; it: RowItem; now?: number; fire: Fire }>) {
  return (
    <div className={styles.item}>
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
        <button type="button" className={styles.btn} onClick={() => void fire('open_item', { ticketId: it.ticketId })}>
          Open
        </button>
      )}
    </div>
  );
}

/** The items of a grouped row, with "Showing the last N of M" and "Show N more". */
function ItemList({
  row,
  visible,
  rest,
  now,
  fire,
  onMore,
}: Readonly<{ row: Row; visible: RowItem[]; rest: number; now?: number; fire: Fire; onMore: () => void }>) {
  return (
    <div className={styles.items}>
      {visible.map((it) => (
        <ItemLine key={it.eventId} row={row} it={it} now={now} fire={fire} />
      ))}
      {row.count > row.items.length && (
        <div className={styles.itemMore}>
          Showing the last {row.items.length} of {row.count}.
        </div>
      )}
      {rest > 0 && (
        <div className={styles.itemMore}>
          <button type="button" className={styles.linkBtn} onClick={onMore}>
            <Icon name="down" size={12} /> Show {Math.min(STEP, rest)} more
          </button>
        </div>
      )}
    </div>
  );
}

/** The buttons "Show all N" / "Open the list" of a grouped row. */
function ListToggle({
  huge,
  onPage,
  expanded,
  count,
  toggleList,
  fire,
}: Readonly<{
  huge: boolean;
  onPage?: boolean;
  expanded: boolean;
  count: number;
  toggleList: () => void;
  fire: Fire;
}>) {
  if (huge)
    return (
      <button type="button" className={styles.btn} onClick={() => (onPage ? toggleList() : void fire('open_list'))}>
        {onPage && expanded ? 'Hide the list' : 'Open the list'}
      </button>
    );
  return (
    <button type="button" className={styles.btn} onClick={toggleList}>
      <Icon name="down" size={12} />
      {expanded ? 'Hide' : `Show all ${count}`}
    </button>
  );
}

/** Snooze (hover only, with its menu) and "Mute this ticket" of an open row. */
function OpenRowHoverButtons({ row, fire }: Readonly<{ row: Row; fire: Fire }>) {
  const [menu, setMenu] = useState(false);
  return (
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
  );
}

/** The "More" button (hover only) with its "Turn this kind off" menu. */
function MoreMenu({ fire }: Readonly<{ fire: Fire }>) {
  const [moreMenu, setMoreMenu] = useState(false);
  return (
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
  );
}

/** The small dialog of an action that needs a note, another AI or an account; a failed action keeps it open. */
function RowDialogs({
  row,
  dialog,
  fire,
  onClose,
}: Readonly<{
  row: Row;
  dialog: { id: string; kind: RowDialog };
  fire: (id: string, extra?: Extra) => Promise<boolean>;
  onClose: () => void;
}>) {
  const submit = async (id: string, extra: Extra) => {
    if (!(await fire(id, extra))) throw new Error('That did not go through. Nothing was changed; try again.');
  };
  if (dialog.kind === 'note')
    return (
      <ContinueNoteDialog
        ended={row.kind !== 'run_stuck'}
        onSubmit={(note) => submit(dialog.id, { text: note })}
        onClose={onClose}
      />
    );
  if (dialog.kind === 'hand')
    return (
      <HandToDialog
        projectId={row.projectId ?? ''}
        currentMemberId={row.memberId}
        onSubmit={(memberId, note) => submit(dialog.id, { memberId, text: note })}
        onClose={onClose}
      />
    );
  return (
    <MoveAccountDialog
      room={accountRoomOf(row)}
      until={typeof row.data.until === 'string' ? row.data.until : undefined}
      onSubmit={(accountId) => submit(dialog.id, { accountId })}
      onClose={onClose}
    />
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
}: Readonly<{
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
}>) {
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{ id: string; kind: RowDialog } | null>(null);
  const huge = !row.needs && row.count > LIST_LIMIT;
  const { expanded, shown, setShown, toggleList } = useRowList(row, focused, huge);
  const f = rowFacts(row, projects, expanded, shown, now);

  const fire: Fire = async (id, extra) => {
    setBusy(true);
    try {
      const ok = await onAction(row, id, extra);
      // an answer that went through closes the box and empties the field; a failed one keeps both for another try
      if (id === 'answer' && ok !== false) {
        setAnswering(false);
        setAnswer('');
      }
      return ok !== false;
    } finally {
      setBusy(false);
    }
  };

  const onBodyClick = (e: MouseEvent) => {
    if (!f.clickable) return;
    if ((e.target as HTMLElement).closest('button, a, textarea, input')) return;
    void fire('open');
  };

  return (
    <div
      ref={rowRef}
      data-row-id={row.id}
      data-unread={f.unread ? 'true' : undefined}
      className={`${styles.row} ${f.open ? styles.needsOpen : ''} ${f.faded ? styles.faded : ''} ${
        f.clickable ? styles.clickable : ''
      } ${selected ? styles.selected : ''}`}
      onClick={onBodyClick}
      onKeyDown={(e) => {
        // Enter or Space on the focused row opens it, as a click does (J/K and Enter in the list do the same)
        if (f.clickable && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          void fire('open');
        }
      }}
    >
      <RowLead unread={f.unread} needs={row.needs} actors={f.actors} visual={f.visual} />
      <div className={styles.main}>
        <div className={styles.head}>
          <div className={`${styles.title} ${f.unread || f.open ? '' : styles.titleQuiet}`}>{row.title}</div>
          <span className={styles.time}>{relTime(rowTime(row), now)}</span>
        </div>
        {f.body && <div className={styles.body}>{f.body}</div>}
        <RowChips
          row={row}
          actors={f.actors}
          grouped={f.grouped}
          pageTitle={f.pageTitle}
          project={f.project}
          fire={fire}
        />
        {row.done && row.doneText && (
          <div style={{ marginTop: 6 }}>
            <span className={`${styles.chip} ${styles.chipDone}`}>
              <span className={styles.dotSmall} style={{ background: '#2e6f40' }} />
              Done — {row.doneText.charAt(0).toLowerCase() + row.doneText.slice(1)}
            </span>
          </div>
        )}

        <DiagnosisBlock row={row} />

        {answering && !row.done && (
          <AnswerBox
            options={f.options}
            answer={answer}
            onAnswer={setAnswer}
            busy={busy}
            fire={fire}
            onCancel={() => setAnswering(false)}
          />
        )}

        {expanded && f.visible.length > 0 && (
          <ItemList
            row={row}
            visible={f.visible}
            rest={f.rest}
            now={now}
            fire={fire}
            onMore={() => setShown((n) => n + STEP)}
          />
        )}

        <div className={`${styles.actions} ${f.onlyHover ? styles.actionsFloating : ''}`}>
          {row.snoozed ? (
            <button type="button" className={styles.btn} disabled={busy} onClick={() => void fire('unsnooze')}>
              Bring back now
            </button>
          ) : (
            <>
              {f.grouped && (
                <ListToggle
                  huge={f.huge}
                  onPage={onPage}
                  expanded={expanded}
                  count={row.count}
                  toggleList={toggleList}
                  fire={fire}
                />
              )}
              {f.actionsShown
                .filter((a) => a.id !== 'expand' && !(a.id === 'open' && !row.needs))
                .map((a, i) => {
                  const icon = ACTION_ICONS[a.id];
                  return (
                    <button
                      key={a.id}
                      type="button"
                      disabled={busy}
                      className={`${styles.btn} ${i === 0 && row.needs ? styles.btnPrimary : ''}`}
                      onClick={() => {
                        if (a.id === 'answer') setAnswering((x) => !x);
                        else if (DIALOG_OF[a.id]) setDialog({ id: a.id, kind: DIALOG_OF[a.id] });
                        else void fire(a.id);
                      }}
                    >
                      {icon && <Icon name={icon} />}
                      {a.label}
                    </button>
                  );
                })}
              {f.open && <OpenRowHoverButtons row={row} fire={fire} />}
              {/* "Turn this kind off" changes nothing on a Needs you row (a mute never quiets one), so it is not offered */}
              {!row.gone && !row.needs && <MoreMenu fire={fire} />}
            </>
          )}
        </div>
      </div>
      {dialog && <RowDialogs row={row} dialog={dialog} fire={fire} onClose={() => setDialog(null)} />}
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
