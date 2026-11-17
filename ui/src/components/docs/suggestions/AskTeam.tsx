/**
 * "Ask the team" on a selection (design "AI teams on rich pages", F 28–34): one purple button on the selection bar
 * that asks the page's AI team to do a small job on the selected passage. Its menu has the verbs first (Improve,
 * Shorten, Fix spelling, Explain, Ask…), then "Format this as…", "Change tone" and "Translate" (the languages the
 * board already offers). A job goes to the team the way "Give to an AI team" does (a ticket linked to the page and its
 * run, with the passage quoted); the answer comes back as suggestions, the block shows "Docs team has it" while the
 * run works, and the page stays editable. Explain stays a local answer.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useDocsAiState } from '../../../api/docsAi';
import { LIVE_STATES, useAssignPage, usePageWork } from '../../../api/docsWork';
import { extractError } from '../../../api/extractError';
import { useMembers } from '../../../api/members';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import type { DocsPage } from '../../../types/docs';
import { LANGUAGES } from '../../../utils/pageAiRules';
import { useToast } from '../../Toast';
import { LineIcon } from '../../ui/LineIcon';
import { BottomSheet } from '../DocsSheets';
import { usePageSettled } from '../pageSettled';
import { useTeamApply } from './api';
import { notForAi, pageApply } from './pageAi';
import './suggestions.css';

/** What the person selected: the passage, the top-level block it is in, and where the button is on screen. */
export interface AskCapture {
  quote: string;
  blockId: string | null;
  rect: { left: number; right: number; top: number; bottom: number };
  /** A local answer about the passage (the reader's or the editor's Explain); no Explain row without it. */
  explain?: () => void;
}

/** The verbs of the menu, in its order. */
export const VERBS = [
  { id: 'improve', label: 'Improve', task: 'Improve this passage: clearer and easier to read, with the same meaning.' },
  { id: 'shorten', label: 'Shorten', task: 'Make this passage shorter and keep what matters.' },
  { id: 'fix', label: 'Fix spelling', task: 'Fix the spelling and grammar of this passage. Change nothing else.' },
] as const;
/** "Format this as…": what the passage can become. */
export const FORMATS = ['Table', 'Bulleted list', 'Numbered list', 'Callout', 'Pull quote'] as const;
/** "Change tone": plain choices. */
export const TONES = ['Friendly', 'Formal', 'Plain', 'Confident', 'Shorter sentences'] as const;

/**
 * The instruction a team gets: the job, then the passage quoted, then the rule to change nothing else.
 * @param task - The job in words.
 * @param c - The selection.
 */
export function teamInstruction(task: string, c: Pick<AskCapture, 'quote' | 'blockId'>): string {
  const where = c.blockId ? ` (block ${c.blockId})` : '';
  return `${task}\n\nThe passage${where}:\n“${c.quote.trim().slice(0, 2000)}”\n\nChange only this passage and leave the rest of the page as it is.`;
}

/** A block a team holds: it was sent to the team, whose run has not ended yet. */
interface Hold {
  blockId: string;
  ticketId: string;
  team: string;
  at: string;
}

/** What the selection bars ask for. */
export interface AskTeam {
  /** The team that gets the jobs. */
  team: { id: string; name: string };
  /** Opens the menu for a selection. */
  open: (capture: AskCapture) => void;
}

const AskTeamContext = createContext<AskTeam | null>(null);

/** "Ask the team" of the open page, or null when it is not offered (no AI team, a viewer, a page not for AI teams). */
export function useAskTeam(): AskTeam | null {
  return useContext(AskTeamContext);
}

const holdKey = (pageId: string) => `docsTeamHolds:${pageId}`;

function readHolds(pageId: string): Hold[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(holdKey(pageId)) ?? '[]') as unknown;
    return Array.isArray(v) ? (v as Hold[]) : [];
  } catch {
    return [];
  }
}

function writeHolds(pageId: string, holds: Hold[]) {
  try {
    sessionStorage.setItem(holdKey(pageId), JSON.stringify(holds));
  } catch {
    /* storage unavailable: kept for this view */
  }
}

type Sub = null | 'format' | 'tone' | 'translate' | 'ask';

/**
 * Offers "Ask the team" to the selection bars inside it, draws its menu and marks the blocks a team holds.
 * @param props.page - The page.
 * @param props.projectId - Its project.
 * @param props.canEdit - Only people who can edit the page ask a team to change it.
 * @param props.layout - Desktop, tablet or phone (rows of 48 px, a sheet on a phone).
 * @param props.onOpenTicket - Opens the ticket of the run ("Open run").
 */
export function AskTeamProvider({
  page,
  projectId,
  canEdit,
  layout = 'desktop',
  onOpenTicket,
  children,
}: {
  page: DocsPage;
  projectId: string;
  canEdit: boolean;
  layout?: DocsLayout;
  onOpenTicket?: (ticketId: string) => void;
  children: ReactNode;
}) {
  const toast = useToast();
  const members = useMembers(projectId).data;
  const docsAi = useDocsAiState(projectId).data;
  const settled = usePageSettled();
  const teamApply = useTeamApply(canEdit && settled ? projectId : null).data?.aiApply;
  const assign = useAssignPage(page.id);
  const [menu, setMenu] = useState<{ capture: AskCapture; sub: Sub } | null>(null);
  const [holds, setHolds] = useState<Hold[]>(() => readHolds(page.id));
  const work = usePageWork(holds.length ? page.id : null).data;

  useEffect(() => setHolds(readHolds(page.id)), [page.id]);

  const team = useMemo(() => {
    const ais = (members ?? []).filter((m) => m.kind === 'ai');
    const chosen = ais.find((m) => m.id === docsAi?.memberId) ?? ais[0];
    return chosen ? { id: chosen.id, name: chosen.name } : null;
  }, [members, docsAi?.memberId]);
  const offered = canEdit && !!team && page.version > 0 && !notForAi(page.settings);
  const direct = (pageApply(page.settings) ?? (team ? teamApply?.[team.id] : null)) === 'direct';

  // a hold ends when its run has ended
  useEffect(() => {
    if (!work || !holds.length) return;
    const next = holds.filter((h) => {
      const t = work.tickets.find((x) => x.id === h.ticketId);
      if (!t?.run) return true;
      return LIVE_STATES.includes(t.run.state) || (t.run.endedAt ?? '') < h.at;
    });
    if (next.length !== holds.length) {
      setHolds(next);
      writeHolds(page.id, next);
    }
  }, [work, holds, page.id]);

  const send = useCallback(
    async (task: string, capture: AskCapture) => {
      if (!team) return;
      setMenu(null);
      try {
        const out = await assign.mutateAsync({
          memberId: team.id,
          kind: 'write',
          instruction: teamInstruction(task, capture),
        });
        if (capture.blockId) {
          const next = [
            ...holds.filter((h) => h.blockId !== capture.blockId),
            { blockId: capture.blockId, ticketId: out.ticket.id, team: team.name, at: new Date().toISOString() },
          ];
          setHolds(next);
          writeHolds(page.id, next);
        }
        if (out.error) {
          toast.error(`${out.ticket.id} was made, but the run did not start`, out.error);
          return;
        }
        toast.success(
          `Sent to ${team.name}`,
          `${out.ticket.id}. ${direct ? 'Its changes are saved on the page.' : 'Its changes arrive as suggestions here.'} You can keep editing.`,
          undefined,
          onOpenTicket ? { label: 'Open run', onClick: () => onOpenTicket(out.ticket.id) } : undefined,
        );
      } catch (e) {
        toast.error(`Couldn't send it to ${team.name}`, extractError(e));
      }
    },
    [team, assign, holds, page.id, toast, direct, onOpenTicket],
  );

  const value = useMemo<AskTeam | null>(
    () => (offered && team ? { team, open: (capture) => setMenu({ capture, sub: null }) } : null),
    [offered, team],
  );

  return (
    <AskTeamContext.Provider value={value}>
      {children}
      <HoldMarks holds={holds} />
      {menu && value && (
        <AskTeamMenu
          team={value.team.name}
          direct={direct}
          capture={menu.capture}
          sub={menu.sub}
          layout={layout}
          onSub={(sub) => setMenu((m) => (m ? { ...m, sub } : m))}
          onSend={(task) => void send(task, menu.capture)}
          onClose={() => setMenu(null)}
        />
      )}
    </AskTeamContext.Provider>
  );
}

const SAFE_ID = /^[\w-]{1,64}$/;

/** "Docs team has it · KAN-172" on the blocks a team holds; the page stays editable. */
function HoldMarks({ holds }: { holds: Hold[] }) {
  const safe = holds.filter((h) => SAFE_ID.test(h.blockId) && SAFE_ID.test(h.ticketId));
  if (!safe.length) return null;
  const css = safe
    .map((h) => {
      const sel = `[data-block-id="${h.blockId}"]`;
      const label = `${h.team.replace(/["\\\n]/g, '')} has it · ${h.ticketId}`;
      return `${sel}{position:relative;outline:2px dashed #CDBEF2;outline-offset:4px;border-radius:2px}
${sel}:not(.dk-changed)::before{content:"${label}";position:absolute;left:0;top:-14px;font:700 10px/16px var(--font-ui,'Plus Jakarta Sans',sans-serif);padding:0 6px;border-radius:5px;background:#EFE8FB;color:#5B3AA6;pointer-events:none;z-index:1}`;
    })
    .join('\n');
  return <style data-testid="sg-hold-marks">{css}</style>;
}

/**
 * The menu of "Ask the team": the verbs, then Format this as…, Change tone and Translate, each opening its choices
 * in place; Ask… takes the job in words.
 */
function AskTeamMenu({
  team,
  direct,
  capture,
  sub,
  layout,
  onSub,
  onSend,
  onClose,
}: {
  team: string;
  direct: boolean;
  capture: AskCapture;
  sub: Sub;
  layout: DocsLayout;
  onSub: (s: Sub) => void;
  onSend: (task: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const phone = layout === 'phone';
  useEffect(() => {
    if (phone) return undefined;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, phone]);

  const item = (label: string, onClick: () => void, more = false, testId?: string) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      className="sg-ask-item"
      data-testid={testId}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <span>{label}</span>
      {more && (
        <span className="sg-ask-more" aria-hidden="true">
          ›
        </span>
      )}
    </button>
  );
  const back = item('‹ Back', () => onSub(null));
  const choices = (list: readonly string[], task: (v: string) => string) => (
    <>
      {back}
      {list.map((v) => item(v, () => onSend(task(v)), false, `ask-team-${v}`))}
    </>
  );

  let body: ReactNode;
  if (sub === 'format') {
    body = choices(FORMATS, (v) => `Format this passage as a ${v.toLowerCase()}.`);
  } else if (sub === 'tone') {
    body = choices(TONES, (v) =>
      v === 'Shorter sentences'
        ? 'Rewrite this passage with shorter sentences.'
        : `Rewrite this passage in a ${v.toLowerCase()} tone.`,
    );
  } else if (sub === 'translate') {
    body = choices(LANGUAGES, (v) => `Translate this passage into ${v}.`);
  } else if (sub === 'ask') {
    body = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onSend(text.trim());
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 6 }}
      >
        {back}
        <label className="sg-label-small" htmlFor="sg-ask-text">
          Ask the team to…
        </label>
        <textarea
          id="sg-ask-text"
          autoFocus
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add a short example after this paragraph"
          style={{ font: 'inherit', fontSize: 13, padding: 8, borderRadius: 8, border: '1px solid #C7D2CB' }}
        />
        <button type="submit" className="st-btn st-btn-primary" disabled={!text.trim()} data-testid="ask-team-send">
          Send to {team}
        </button>
      </form>
    );
  } else {
    body = (
      <>
        {VERBS.map((v) => item(v.label, () => onSend(v.task), false, `ask-team-${v.id}`))}
        {capture.explain &&
          item(
            'Explain',
            () => {
              onClose();
              capture.explain?.();
            },
            false,
            'ask-team-explain',
          )}
        {item('Ask…', () => onSub('ask'), true, 'ask-team-ask')}
        <div className="sg-ask-sep" />
        {item('Format this as…', () => onSub('format'), true, 'ask-team-format')}
        {item('Change tone', () => onSub('tone'), true, 'ask-team-tone')}
        {item('Translate', () => onSub('translate'), true, 'ask-team-translate')}
      </>
    );
  }

  const head = (
    <div className="sg-ask-head">
      <b>{team}</b>
      <span>{direct ? 'Changes are saved on the page at once' : 'Changes arrive as suggestions here'}</span>
    </div>
  );
  if (phone) {
    return (
      <BottomSheet label={`Ask ${team}`} onClose={onClose} testId="ask-team-sheet">
        <div className="sg-ask-touch" role="menu" aria-label={`Ask ${team}`}>
          {head}
          {body}
        </div>
      </BottomSheet>
    );
  }
  const left = Math.max(8, Math.min(capture.rect.left, window.innerWidth - 268));
  const below = capture.rect.bottom + 6;
  const top = below + 380 > window.innerHeight ? Math.max(8, capture.rect.top - 386) : below;
  return createPortal(
    <div
      ref={ref}
      className={`sg-ask-menu docs-root${layout === 'tablet' ? ' sg-ask-touch' : ''}`}
      role="menu"
      aria-label={`Ask ${team}`}
      data-testid="ask-team-menu"
      style={{ left, top }}
    >
      {head}
      {body}
      {!sub && <div className="sg-ask-foot">Nothing is written into your text while you wait.</div>}
    </div>,
    document.body,
  );
}

/**
 * The purple "Ask the team" button of a selection bar.
 * @param props.capture - Reads the selection when pressed (null: nothing usable is selected).
 * @param props.onOpened - Called after the menu opened (the reader's bar closes).
 * @param props.className - Extra classes (the editor's bubble button look).
 */
export function AskTeamButton({
  capture,
  onOpened,
  className,
}: {
  capture: () => Omit<AskCapture, 'rect'> | null;
  onOpened?: () => void;
  className?: string;
}) {
  const ask = useAskTeam();
  if (!ask) return null;
  return (
    <button
      type="button"
      className={`sg-ask-btn${className ? ` ${className}` : ''}`}
      data-testid="ask-team"
      title={`Ask ${ask.team.name} to change the selection`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        const c = capture();
        if (!c || !c.quote.trim()) return;
        const r = e.currentTarget.getBoundingClientRect();
        ask.open({ ...c, rect: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } });
        onOpened?.();
      }}
    >
      <LineIcon name="sparkle" size={12} />
      Ask the team
    </button>
  );
}

/**
 * The top-level block a DOM node is in (the outermost element with a block id inside the reader), for the reader's
 * selection.
 * @param node - Where the selection starts.
 */
export function topBlockIdOf(node: Node | null | undefined): string | null {
  let el: Element | null = node instanceof Element ? node : (node?.parentElement ?? null);
  let id: string | null = null;
  while (el && !el.classList.contains('dk-rich')) {
    const b = el.getAttribute('data-block-id');
    if (b) id = b;
    el = el.parentElement;
  }
  return id;
}
