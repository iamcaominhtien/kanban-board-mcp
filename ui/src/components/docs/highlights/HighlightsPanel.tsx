/**
 * The list of a page's highlights (design board "Rich Docs — reading", K 78, 80, 82, 87, 111, 119, 123, 124): who made
 * each and when, in the page's order; Everyone / Me / By person and a colour filter; Go to passage, Comments and
 * Remove (your own, or any for people who can edit the page); "Passage changed" when its words are gone; and at the
 * foot Copy all as text with a menu (Send highlights to the team…, Add all to the page, Remove all my highlights…,
 * and for admins Clear all highlights on this page…). On your own whose words are gone: Re-attach and Use the new
 * quote (87). Sending to the team first turns the list into a choice with checkboxes (94, 105, 107). The same list is the rail beside the page on a desktop, a drawer on a tablet and a sheet on a phone.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { useAskTeam } from '../suggestions/AskTeam';
import type { HighlightColor } from '../../../api/docsHighlights';
import { HL_COLORS, HL_INK, HlShape, colorName, tintOf } from './colors';
import { HlIcon } from './hlIcons';
import { HlAvatar, shortAgo } from './HighlightPopover';
import type { HlPerson } from './useHighlightLayer';
import type { HlItem } from './useHighlights';

/** A highlight's thread as the list shows it. */
export interface HlThreadInfo {
  count: number;
  /** The first comment's words. */
  first: string;
}

/** Who the list shows. */
type Who = { kind: 'all' } | { kind: 'me' } | { kind: 'people'; names: string[] };

interface Props {
  /** In the page's order. */
  items: HlItem[];
  /** Ids whose words are not on the page ("Passage changed"). */
  missing: ReadonlySet<string>;
  personOf: (author: string) => HlPerson;
  /** "Paragraph 1", the heading above it, "Pull quote". */
  placeOf: (h: HlItem) => string;
  threadOf: (h: HlItem) => HlThreadInfo | null;
  loading: boolean;
  /** Admins: Clear all highlights on this page. */
  canClear: boolean;
  /** A Viewer or an older version: no Comment button where no thread exists. */
  noComment: boolean;
  /** Tablet or phone: 44 px rows and buttons. */
  touch: boolean;
  /** Tabs above the list (the rail beside the outline), or null. */
  tabs?: ReactNode;
  onClose: () => void;
  onGo: (h: HlItem) => void;
  onComments: (h: HlItem) => void;
  onRemove: (h: HlItem) => void;
  onCopyQuote: (h: HlItem) => void;
  onCopyAll: () => void;
  onRemoveAllMine: () => void;
  onClearAll: () => void;
  /** Re-attach one of yours whose words are gone: pick the words again (87). */
  onReattach?: (h: HlItem) => void;
  /** Use the new quote: the edited words where it was; absent when nothing stands there any more. */
  newQuote?: (h: HlItem) => (() => void) | null;
  /** People who can edit the page: "Add all to the page" (119). */
  onAddAllToPage?: () => void;
  /** Send the chosen highlights to the page's AI team (94); offered when the page has one. */
  onSend?: (chosen: HlItem[]) => void;
}

const firstName = (p: HlPerson) => (p.name === 'You' ? 'You' : (p.name.split(/\s+/)[0] ?? p.name));

/**
 * The highlights list.
 * @param props - The highlights, how to name their people and places, and what each button does.
 */
export function HighlightsPanel(props: Props) {
  const { items, missing, personOf, placeOf, threadOf, loading, canClear, noComment, touch, tabs, onClose } = props;
  const [who, setWho] = useState<Who>({ kind: 'all' });
  const [color, setColor] = useState<HighlightColor | null>(null);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const team = useAskTeam();
  const [picking, setPicking] = useState<Set<string> | null>(null);
  const canSend = !!team && !!props.onSend;

  const mineCount = items.filter((h) => h.mine).length;
  const people = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of items) m.set(h.author, (m.get(h.author) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);
  const byWho = items.filter((h) =>
    who.kind === 'all' ? true : who.kind === 'me' ? h.mine : who.names.includes(h.author),
  );
  const colours = HL_COLORS.map((c) => [c, byWho.filter((h) => h.color === c).length] as const).filter(
    ([, n]) => n > 0,
  );
  const shown = color ? byWho.filter((h) => h.color === color) : byWho;
  const picked = who.kind === 'people' ? who.names : [];
  const showing =
    who.kind === 'people' && picked.length === 1
      ? `Showing ${personOf(picked[0]).name === 'You' ? 'your' : `${personOf(picked[0]).name}’s`} ${byWho.length} ${byWho.length === 1 ? 'highlight' : 'highlights'}.`
      : null;

  const togglePerson = (name: string) => {
    const names = picked.includes(name) ? picked.filter((n) => n !== name) : [...picked, name];
    setWho(names.length ? { kind: 'people', names } : { kind: 'all' });
  };

  return (
    <div className={`hl-panel${touch ? ' is-touch' : ''}`} data-testid="hl-panel" data-nocomment>
      {tabs}
      {picking && team ? (
        <div className="hl-panel-head hl-pick-head" data-testid="hl-pick-head">
          <div className="hl-panel-title">
            <span className="hl-panel-name">Send to {team.team.name}</span>
            <button type="button" className="hl-btn hl-btn-30" onClick={() => setPicking(null)}>
              Cancel
            </button>
          </div>
          <div className="hl-pick-count">
            <span style={{ color: 'var(--dp-ink, #1E2A22)' }} data-testid="hl-pick-count">
              {picking.size} of {items.length} selected
            </span>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="hl-btn hl-btn-30"
              onClick={() => setPicking(new Set(items.filter((h) => !h.local).map((h) => h.id)))}
            >
              Select all
            </button>
          </div>
        </div>
      ) : (
        <div className="hl-panel-head">
          <div className="hl-panel-title">
            <span className="hl-panel-name">
              Highlights{' '}
              {!loading && (
                <span className={`hl-count${items.length ? '' : ' is-zero'}`} data-testid="hl-panel-count">
                  {items.length}
                </span>
              )}
            </span>
            <button type="button" className="hl-x hl-panel-close" aria-label="Close the highlights" onClick={onClose}>
              <HlIcon name="close" size={16} />
            </button>
          </div>
          {loading ? (
            <div className="hl-panel-sub" role="status">
              <span className="mc-spin" style={{ width: 12, height: 12 }} />
              Loading highlights…
            </div>
          ) : items.length > 0 ? (
            <>
              <div className="hl-panel-sub">
                <HlIcon name="people" size={12} stroke={2} />
                {showing ?? 'Everyone in the project who can read this page sees these.'}
              </div>
              <div className="hl-seg" role="radiogroup" aria-label="Whose highlights">
                <button
                  type="button"
                  role="radio"
                  aria-checked={who.kind === 'all'}
                  className={who.kind === 'all' ? 'is-on' : ''}
                  onClick={() => setWho({ kind: 'all' })}
                >
                  Everyone {items.length}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={who.kind === 'me'}
                  className={who.kind === 'me' ? 'is-on' : ''}
                  onClick={() => setWho({ kind: 'me' })}
                  data-testid="hl-filter-me"
                >
                  Me {mineCount}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={who.kind === 'people'}
                  aria-expanded={peopleOpen}
                  className={who.kind === 'people' ? 'is-on' : ''}
                  onClick={() => setPeopleOpen((v) => !v)}
                  data-testid="hl-filter-people"
                >
                  By person ▾
                </button>
              </div>
              {peopleOpen && (
                <div className="dk-menu hl-people" role="menu" data-testid="hl-people-menu">
                  {people.map(([name, n]) => {
                    const p = personOf(name);
                    const on = picked.includes(name);
                    return (
                      <button
                        key={name}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={on}
                        className="dk-mi"
                        onClick={() => togglePerson(name)}
                      >
                        <span className={`hl-check${on ? ' is-on' : ''}`} aria-hidden="true">
                          {on && (
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3">
                              <path d="M5 12.5L10 17.5L19 7" />
                            </svg>
                          )}
                        </span>
                        <HlAvatar person={p} size={20} />
                        <span style={{ flex: 1, textAlign: 'left' }}>
                          {p.name === 'You' ? `${name} (you)` : p.name}
                        </span>
                        <span className="hl-people-n">{n}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="hl-chips" role="group" aria-label="Colour">
                <button
                  type="button"
                  className={`hl-chip${color === null ? ' is-on' : ''}`}
                  aria-pressed={color === null}
                  onClick={() => setColor(null)}
                >
                  All colours
                </button>
                {colours.map(([c, n]) => (
                  <button
                    key={c}
                    type="button"
                    className={`hl-chip${color === c ? ' is-on' : ''}`}
                    aria-pressed={color === c}
                    onClick={() => setColor(color === c ? null : c)}
                    data-testid={`hl-chip-${c}`}
                  >
                    <HlShape color={c} size={10} />
                    {colorName(c)} {n}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      )}
      {items.some((h) => h.local === 'queued') && (
        <div className="hl-offline-note" role="status" data-testid="hl-offline-note">
          <HlIcon name="offline" size={14} stroke={2} color="#8A5A00" />
          <span>
            <b>You are offline.</b> Not sent yet. It will be sent when you are back online.
          </span>
        </div>
      )}
      <div className="hl-list" data-testid="hl-list">
        {loading ? (
          [0, 1, 2].map((i) => (
            <div key={i} className="hl-skel-row" aria-hidden="true">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div className="skel" style={{ width: 12, height: 12, borderRadius: '50%' }} />
                <div className="skel" style={{ width: 90, height: 11 }} />
                <div className="skel" style={{ width: 70, height: 11, marginLeft: 'auto' }} />
              </div>
              <div className="skel" style={{ width: '100%', height: 14 }} />
              <div className="skel" style={{ width: '64%', height: 14 }} />
              <div style={{ display: 'flex', gap: 6 }}>
                <div className="skel" style={{ width: 110, height: 32, borderRadius: 8 }} />
                <div className="skel" style={{ width: 90, height: 32, borderRadius: 8 }} />
              </div>
            </div>
          ))
        ) : items.length === 0 ? (
          <div className="hl-empty" data-testid="hl-empty">
            <span className="hl-empty-ico">
              <HlIcon name="marker" size={22} color="#8A5A00" />
            </span>
            <div className="hl-empty-title">No highlights yet</div>
            <div className="hl-empty-text">
              Select some text on the page to highlight it. Everyone in the project who can read this page will see it.
            </div>
          </div>
        ) : (
          (picking ? items : shown).map((h) => (
            <Row
              key={h.id}
              h={h}
              changed={missing.has(h.id)}
              person={personOf(h.author)}
              place={placeOf(h)}
              thread={threadOf(h)}
              noComment={noComment}
              onGo={() => props.onGo(h)}
              onComments={() => props.onComments(h)}
              onRemove={() => props.onRemove(h)}
              onCopyQuote={() => props.onCopyQuote(h)}
              onReattach={h.mine && props.onReattach ? () => props.onReattach?.(h) : undefined}
              newQuote={h.mine && missing.has(h.id) && props.newQuote ? props.newQuote(h) : undefined}
              picked={picking && !h.local ? picking.has(h.id) : undefined}
              onPick={() =>
                setPicking((p) => {
                  if (!p) return p;
                  const next = new Set(p);
                  if (next.has(h.id)) next.delete(h.id);
                  else next.add(h.id);
                  return next;
                })
              }
            />
          ))
        )}
      </div>
      {picking && team && (
        <div className="hl-panel-foot hl-pick-foot">
          <button
            type="button"
            className="st-btn st-btn-primary hl-pick-send"
            disabled={picking.size === 0}
            onClick={() => {
              const chosen = items.filter((h) => picking.has(h.id));
              setPicking(null);
              props.onSend?.(chosen);
            }}
            data-testid="hl-pick-send"
          >
            <HlIcon name="send" size={14} stroke={2} />
            Send {picking.size} {picking.size === 1 ? 'highlight' : 'highlights'} to {team.team.name}
          </button>
        </div>
      )}
      {!picking && !loading && items.length > 0 && (
        <div className="hl-panel-foot">
          <button type="button" className="hl-btn" onClick={props.onCopyAll} data-testid="hl-copy-all">
            <HlIcon name="copy" size={14} stroke={2} />
            Copy all as text
          </button>
          <span style={{ flex: 1 }} />
          {(mineCount > 0 || canClear || canSend || !!props.onAddAllToPage) && (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                className="hl-btn hl-btn-ico"
                aria-label="More for the highlights"
                aria-expanded={menu}
                onClick={() => setMenu((v) => !v)}
                data-testid="hl-list-menu"
              >
                <HlIcon name="dots" size={14} stroke={2} />
              </button>
              {menu && (
                <div className="dk-menu hl-foot-menu" role="menu">
                  {canSend && team && (
                    <button
                      type="button"
                      role="menuitem"
                      className="dk-mi"
                      data-testid="hl-send-team"
                      onClick={() => {
                        setMenu(false);
                        setPicking(new Set());
                      }}
                    >
                      <span className="hl-mi-two">
                        <span>Send highlights to {team.team.name}…</span>
                        <span className="hl-mi-hint">Choose some, then Send to {team.team.name}</span>
                      </span>
                    </button>
                  )}
                  {props.onAddAllToPage && (
                    <button
                      type="button"
                      role="menuitem"
                      className="dk-mi"
                      data-testid="hl-add-all"
                      onClick={() => {
                        setMenu(false);
                        props.onAddAllToPage?.();
                      }}
                    >
                      <span className="hl-mi-two">
                        <span>Add all to the page</span>
                        <span className="hl-mi-hint">Makes them page text. Editors only.</span>
                      </span>
                    </button>
                  )}
                  {mineCount > 0 && (
                    <button
                      type="button"
                      role="menuitem"
                      className="dk-mi"
                      data-testid="hl-remove-mine"
                      onClick={() => {
                        setMenu(false);
                        props.onRemoveAllMine();
                      }}
                    >
                      <span>Remove all my highlights…</span>
                    </button>
                  )}
                  {canClear && (
                    <button
                      type="button"
                      role="menuitem"
                      className="dk-mi hl-mi-danger"
                      data-testid="hl-clear-all"
                      onClick={() => {
                        setMenu(false);
                        props.onClearAll();
                      }}
                    >
                      <span className="hl-mi-two">
                        <span>Clear all highlights on this page…</span>
                        <span className="hl-mi-hint">Admins only</span>
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  h,
  changed,
  person,
  place,
  thread,
  noComment,
  onGo,
  onComments,
  onRemove,
  onCopyQuote,
  onReattach,
  newQuote,
  picked,
  onPick,
}: {
  h: HlItem;
  changed: boolean;
  person: HlPerson;
  place: string;
  thread: HlThreadInfo | null;
  noComment: boolean;
  onGo: () => void;
  onComments: () => void;
  onRemove: () => void;
  onCopyQuote: () => void;
  onReattach?: () => void;
  /** Use the new quote: the action, null when nothing stands there, undefined when not offered. */
  newQuote?: (() => void) | null;
  /** Choosing for the team: whether it is chosen (undefined: not choosing). */
  picked?: boolean;
  onPick: () => void;
}) {
  const ink = HL_INK[h.color];
  const picking = picked !== undefined;
  const body = (
    <>
      <div className="hl-row-head">
        <HlShape color={h.color} size={11} />
        <span className="hl-row-colour">{colorName(h.color)}</span>
        <span className="hl-row-place">{place ? `· ${place}` : ''}</span>
        {changed && (
          <span className="hl-badge" data-testid="hl-changed">
            <HlIcon name="warn" size={11} stroke={2.4} />
            Passage changed
          </span>
        )}
        {h.local === 'failed' && <span className="hl-badge hl-badge-red">Not saved</span>}
        {h.local === 'queued' && (
          <span className="hl-row-offline" data-testid="hl-not-sent">
            <HlIcon name="offline" size={11} stroke={2} color="#8A5A00" />
            Not sent yet
          </span>
        )}
        {h.state === 'becoming' && !changed && (
          <span className="hl-badge hl-badge-green" data-testid="hl-becoming">
            <HlIcon name="pen" size={11} stroke={2.2} />
            Becoming page text
          </span>
        )}
      </div>
      <div className="hl-row-who">
        <HlAvatar person={person} />
        {firstName(person)} · {shortAgo(h.createdAt)}
      </div>
      <span
        className="hl-row-quote"
        style={{ background: tintOf(h.color), borderBottomColor: ink }}
        data-testid="hl-row-quote"
      >
        “{h.quote}”
      </span>
      {thread && (
        <div className="hl-row-thread">
          <HlIcon name="comment" size={13} stroke={2} color="var(--dp-muted, #5B6B60)" />
          <span>
            <b>{thread.count === 1 ? '1 comment' : `${thread.count} comments`}</b>
            {thread.first ? ` · ${thread.first}` : ''}
          </span>
        </div>
      )}
      {changed && (
        <div className="hl-row-note">
          The text was edited or removed, so the highlight cannot stay on it. Its comments stay on the page.
          {onReattach && ' Re-attach lets you pick the words again; Use the new quote takes the edited words.'}
        </div>
      )}
    </>
  );
  if (picking) {
    return (
      <label className={`hl-row hl-row-pick${picked ? ' is-on' : ''}`} data-testid="hl-row" data-hl={h.id}>
        <input type="checkbox" className="hl-pick-input" checked={picked} onChange={onPick} />
        <span className={`hl-check hl-check-22${picked ? ' is-on' : ''}`} aria-hidden="true">
          {picked && <HlIcon name="check" size={13} stroke={3} color="#fff" />}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>{body}</span>
      </label>
    );
  }
  return (
    <div className="hl-row" data-testid="hl-row" data-hl={h.id} data-color={h.color}>
      {body}
      <div className="hl-row-acts">
        {changed && onReattach && (
          <button type="button" className="hl-btn" onClick={onReattach} data-testid="hl-reattach">
            <HlIcon name="link" size={14} stroke={2} />
            Re-attach
          </button>
        )}
        {changed && newQuote !== undefined && (
          <button
            type="button"
            className="hl-btn"
            disabled={!newQuote}
            title={newQuote ? undefined : 'Nothing stands where it was any more.'}
            onClick={() => newQuote?.()}
            data-testid="hl-new-quote"
          >
            <HlIcon name="refresh" size={14} stroke={2} />
            Use the new quote
          </button>
        )}
        {changed ? (
          <button type="button" className="hl-btn" onClick={onCopyQuote}>
            <HlIcon name="copy" size={14} stroke={2} />
            Copy quote
          </button>
        ) : (
          <button type="button" className="hl-btn" onClick={onGo} data-testid="hl-go">
            <HlIcon name="go" size={14} stroke={2} />
            Go to passage
          </button>
        )}
        {(thread || !noComment) && !h.local && (
          <button type="button" className="hl-btn" onClick={onComments} data-testid="hl-row-comments">
            <HlIcon name="comment" size={14} stroke={2} />
            {thread ? `Comments ${thread.count}` : 'Comment'}
          </button>
        )}
        {h.mine && (
          <button type="button" className="hl-btn" onClick={onRemove} data-testid="hl-row-remove">
            <HlIcon name="trash" size={14} stroke={2} />
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
