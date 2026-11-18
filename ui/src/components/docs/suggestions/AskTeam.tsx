/**
 * "Ask the team" on a selection (design "AI teams on rich pages", F 28–34): one purple button on the selection bar
 * that asks the page's AI team to do a small job on the selected passage. Its menu follows the board: Rewrite,
 * Shorten, Change tone ›, Fix grammar, Translate › (the languages the board already offers), Make a table, Format this
 * as… ›, then Explain (a local answer, when the view has one) and the "Ask the team to…" line. A job goes to the team
 * the way "Give to an AI team" does (a ticket linked to the page and its run, with the passage quoted); the answer
 * comes back as suggestions, the block shows "Docs team is rewriting this · KAN-172" while the run works, and the page
 * stays editable.
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
import { BottomSheet } from '../DocsSheets';
import { usePageSettled } from '../pageSettled';
import { useTeamApply } from './api';
import { notForAi, pageApply } from './pageAi';
import { SheetHead } from './ReviewBar';
import { SgIcon, Spark, type SgIconName } from './sgIcons';
import './suggestions.css';

/** What the person selected: the passage, the top-level block it is in, and where the button is on screen. */
export interface AskCapture {
  quote: string;
  blockId: string | null;
  rect: { left: number; right: number; top: number; bottom: number };
  /** A local answer about the passage (the reader's or the editor's Explain); no Explain row without it. */
  explain?: () => void;
}

/** The verbs of the menu that send a job at once; `doing` names the job on the block while the team has it. */
export const VERBS = [
  {
    id: 'improve',
    label: 'Rewrite',
    icon: 'wand',
    doing: 'rewriting',
    task: 'Improve this passage: clearer and easier to read, with the same meaning.',
  },
  {
    id: 'shorten',
    label: 'Shorten',
    icon: 'shorten',
    doing: 'shortening',
    task: 'Make this passage shorter and keep what matters.',
  },
  {
    id: 'fix',
    label: 'Fix grammar',
    icon: 'check',
    doing: 'fixing',
    task: 'Fix the spelling and grammar of this passage. Change nothing else.',
  },
  { id: 'table', label: 'Make a table', icon: 'table', doing: 'formatting', task: 'Format this passage as a table.' },
] as const satisfies readonly { id: string; label: string; icon: SgIconName; doing: string; task: string }[];
/** "Format this as…": what the passage can become, with the board's icon of each. */
export const FORMATS = [
  'Heading 2',
  'Pull quote',
  'Callout',
  'Bulleted list',
  'Numbered list',
  'Task list',
  'Two columns',
] as const;
const FORMAT_ICON: Record<(typeof FORMATS)[number], SgIconName> = {
  'Heading 2': 'heading',
  'Pull quote': 'quote',
  Callout: 'callout',
  'Bulleted list': 'bullets',
  'Numbered list': 'numbered',
  'Task list': 'tasks',
  'Two columns': 'columns',
};
const FORMAT_TASK: Record<(typeof FORMATS)[number], string> = {
  'Heading 2': 'Turn this passage into a level 2 heading.',
  'Pull quote': 'Format this passage as a pull quote.',
  Callout: 'Format this passage as a callout.',
  'Bulleted list': 'Format this passage as a bulleted list.',
  'Numbered list': 'Format this passage as a numbered list.',
  'Task list': 'Format this passage as a task list.',
  'Two columns': 'Lay this passage out in two columns.',
};
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
  /** What the team is doing to it ("rewriting"); older holds have none. */
  doing?: string;
}

/** What the selection bars ask for. */
export interface AskTeam {
  /** The team that gets the jobs. */
  team: { id: string; name: string };
  /** "Changes arrive as suggestions here" (false) or "saved on the page at once" (true). */
  direct: boolean;
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

type Sub = null | 'format' | 'tone' | 'translate';

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
    async (task: string, capture: AskCapture, doing = 'working on') => {
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
            {
              blockId: capture.blockId,
              ticketId: out.ticket.id,
              team: team.name,
              at: new Date().toISOString(),
              doing,
            },
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
    () => (offered && team ? { team, direct, open: (capture) => setMenu({ capture, sub: null }) } : null),
    [offered, team, direct],
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
          onSend={(task, doing) => void send(task, menu.capture, doing)}
          onClose={() => setMenu(null)}
        />
      )}
    </AskTeamContext.Provider>
  );
}

const SAFE_ID = /^[\w-]{1,64}$/;

const HOLD_FONT = "700 11.5px 'Plus Jakarta Sans', sans-serif";

/** The width in px of a hold's label, to place its ticket chip after it (the label is a pseudo-element). */
function labelWidth(text: string): number {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.font = HOLD_FONT;
      return Math.ceil(ctx.measureText(text).width);
    }
  } catch {
    /* no canvas (tests): an estimate */
  }
  return Math.ceil(text.length * 6.4);
}

/**
 * "Docs team is rewriting this · KAN-172" on the blocks a team holds (board F 31): the block in a dashed purple frame,
 * a pulsing dot, the words and the ticket in a small chip; the page stays editable.
 */
function HoldMarks({ holds }: { holds: Hold[] }) {
  const safe = holds.filter((h) => SAFE_ID.test(h.blockId) && SAFE_ID.test(h.ticketId));
  if (!safe.length) return null;
  const css = safe
    .map((h) => {
      const sel = `[data-block-id="${h.blockId}"]`;
      const label = `${h.team.replace(/["\\\n]/g, '')} is ${h.doing ?? 'working on'} this`;
      const chipLeft = 12 + 14 + labelWidth(label) + 7;
      return `${sel}{position:relative;box-sizing:border-box;border:1.5px dashed #7C5CD6;border-radius:9px;background:#F9F7FE;padding:31px 12px 10px}
${sel}:not(.dk-changed)::before{content:"${label}";position:absolute;left:12px;top:8px;height:18px;display:inline-flex;align-items:center;font:700 11.5px/18px var(--font-ui,'Plus Jakarta Sans',sans-serif);font-style:normal;letter-spacing:0;text-transform:none;padding-left:14px;color:#5B3AA6;background:radial-gradient(circle at 3.5px 50%,#7C5CD6 3.5px,transparent 4px) no-repeat;pointer-events:none;z-index:1}
${sel}:not(.dk-changed)::after{content:"${h.ticketId}";position:absolute;left:${chipLeft}px;top:8px;font:700 11.5px/16px 'JetBrains Mono',monospace;font-style:normal;letter-spacing:0;text-transform:none;border:1px solid #DDD3F5;background:#fff;border-radius:6px;padding:0 8px;color:#1E2A22;pointer-events:none;z-index:1}`;
    })
    .join('\n');
  return <style data-testid="sg-hold-marks">{css}</style>;
}

/**
 * The menu of "Ask the team" (board F 29–30, 34): the team and how its changes arrive, the verbs with their icons,
 * Change tone, Translate and Format this as… opening their choices in place, and the "Ask the team to…" line that
 * takes the job in words. On a phone it is a sheet with 48 px rows.
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
  onSend: (task: string, doing: string) => void;
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

  const iconSize = phone ? 18 : 15;
  const item = (label: string, onClick: () => void, o: { icon?: SgIconName; more?: boolean; testId?: string } = {}) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      className="sg-ask-item"
      data-testid={o.testId}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {o.icon && (
        <span className="sg-ask-ico">
          <SgIcon name={o.icon} size={iconSize} />
        </span>
      )}
      <span className="sg-ask-label">{label}</span>
      {o.more && (
        <span className="sg-ask-more" aria-hidden="true">
          <SgIcon name="chevRight" size={phone ? 16 : 12} sw={phone ? 2.2 : 2.4} />
        </span>
      )}
    </button>
  );
  const back = item('‹ Back', () => onSub(null));
  const choices = (
    list: readonly string[],
    task: (v: string) => string,
    doing: string,
    icons?: Record<string, SgIconName>,
  ) => (
    <>
      {back}
      {list.map((v) => item(v, () => onSend(task(v), doing), { icon: icons?.[v], testId: `ask-team-${v}` }))}
    </>
  );
  const verb = (id: (typeof VERBS)[number]['id']) => {
    const v = VERBS.find((x) => x.id === id)!;
    return item(v.label, () => onSend(v.task, v.doing), { icon: v.icon, testId: `ask-team-${v.id}` });
  };

  let body: ReactNode;
  if (sub === 'format') {
    body = choices(FORMATS, (v) => FORMAT_TASK[v as (typeof FORMATS)[number]], 'formatting', FORMAT_ICON);
  } else if (sub === 'tone') {
    body = choices(
      TONES,
      (v) =>
        v === 'Shorter sentences'
          ? 'Rewrite this passage with shorter sentences.'
          : `Rewrite this passage in a ${v.toLowerCase()} tone.`,
      'rewriting',
    );
  } else if (sub === 'translate') {
    body = choices(LANGUAGES, (v) => `Translate this passage into ${v}.`, 'translating');
  } else {
    body = (
      <>
        {verb('improve')}
        {verb('shorten')}
        {item('Change tone', () => onSub('tone'), { icon: 'tone', more: true, testId: 'ask-team-tone' })}
        {verb('fix')}
        {item('Translate', () => onSub('translate'), { icon: 'translate', more: true, testId: 'ask-team-translate' })}
        {verb('table')}
        {item('Format this as…', () => onSub('format'), { icon: 'palette', more: true, testId: 'ask-team-format' })}
        {capture.explain &&
          item(
            'Explain',
            () => {
              onClose();
              capture.explain?.();
            },
            { icon: 'info', testId: 'ask-team-explain' },
          )}
        <form
          className="sg-ask-input"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onSend(text.trim(), 'working on');
          }}
        >
          <input
            aria-label="Ask the team to…"
            placeholder="Ask the team to…"
            value={text}
            data-testid="ask-team-ask"
            onChange={(e) => setText(e.target.value)}
          />
          <button type="submit" aria-label={`Send to ${team}`} disabled={!text.trim()} data-testid="ask-team-send">
            <SgIcon name="send" size={14} color="#5B3AA6" />
          </button>
        </form>
      </>
    );
  }

  const head = (
    <div className="sg-ask-head">
      <span className="sg-ask-badge" aria-hidden="true">
        <SgIcon name="agent" size={11} />
        <span className="sg-ask-badge-ai">
          <Spark size={6} color="#fff" />
        </span>
      </span>
      <span className="sg-ask-who">
        <b>{team}</b>
        <span>{direct ? 'Changes are saved on the page at once' : 'Changes arrive as suggestions here'}</span>
      </span>
    </div>
  );
  const foot = !sub && (
    <div className="sg-ask-foot">
      {direct ? 'This page is set to apply directly' : 'This page is set to suggest first'}
    </div>
  );
  if (phone) {
    return (
      <BottomSheet label={`Ask ${team}`} onClose={onClose} testId="ask-team-sheet" hideTitle>
        <SheetHead title={`Ask ${team}`} action="Cancel" onAction={onClose} />
        <div className="sg-ask-touch sg-ask-phone" role="menu" aria-label={`Ask ${team}`}>
          {body}
          {foot}
        </div>
      </BottomSheet>
    );
  }
  const left = Math.max(8, Math.min(capture.rect.left, window.innerWidth - 268));
  const below = capture.rect.bottom + 6;
  const top = below + 400 > window.innerHeight ? Math.max(8, capture.rect.top - 406) : below;
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
      <div className="sg-ask-sep" />
      {body}
      {foot}
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
      <Spark size={13} color="#5B3AA6" />
      Ask the team
      <SgIcon name="chevDown" size={12} sw={2.6} />
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
