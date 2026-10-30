import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  editorAiApi,
  editorKeys,
  useEditorAiState,
  type EditorAction,
  type EditorActionInfo,
  type EditorPreview,
  type EditorRequest,
  type EditorResult,
  type EditorSurface,
} from '../../../api/editorAi';
import { assistError } from '../../../api/assist';
import { diagramMarkdown } from '../../../api/diagrams';
import { extractError } from '../../../api/extractError';
import type { AssistDraft } from '../../../types/assist';
import { useDiagrams } from '../../diagrams/DiagramsContext';
import { useToast } from '../../Toast';
import { useAiBoardState } from '../aiUi';
import { wordDiff } from './diff';
import type { EditorAdapter, EditorCapture } from './types';
import './editorAi.css';

/** Options of `useEditorAi`. */
export interface UseEditorAiOptions {
  /** Where the editor is; the server decides what each place offers (design D5). */
  surface: EditorSurface;
  projectId?: string;
  /** The ticket, page or idea the text belongs to: what "This ticket" / "This page" in the prompt box reads. */
  ticketId?: string | null;
  docId?: string | null;
  ideaId?: string | null;
  /** How this kind of editor gives its text to the layer and takes a draft back. */
  adapter: EditorAdapter;
  /** False switches the helpers off for this editor (read-only, no project). */
  enabled?: boolean;
  /** Docs and ideas: how a drawn diagram gets its line in the text. Without it "Draw a diagram" is not offered. */
  insertDiagramLine?: (markdown: string) => void;
  /** Where a diagram saves to, shown in the draw.io editor ("KAN-1 description"). */
  diagramSaveTo?: string;
  /** "Open AI members" on the no-AI-member state. */
  onOpenAiMembers?: () => void;
  /** "See usage" on the over-budget state. */
  onOpenUsage?: () => void;
  /** A draft was accepted (after the text went in, or a list was added). The criteria list uses it to drop a split one. */
  onAccepted?: (action: EditorAction, kind: EditorResult['kind']) => void;
}

/** What `useEditorAi` hands to an editor. */
export interface EditorAi {
  /** AI helpers are on for this project and editor (not turned off, the person is not a viewer…). */
  available: boolean;
  /** The /ai menu and the selection bar of this place, from the server's table. */
  menu: EditorActionInfo[];
  bar: EditorActionInfo[];
  /** No draft or menu is open: the selection bar may show. */
  idle: boolean;
  /** Open the /ai menu at the cursor (Ctrl+J). */
  openMenu: () => void;
  /** Run an action on the selection (or the paragraph at the cursor): a selection bar button, a menu entry. */
  run: (action: EditorAction) => void;
  /** Ctrl+J in the editor. Returns true when it was the shortcut, so the editor can stop it there. */
  onKeyDown: (e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }) => boolean;
  /** Call from the editor's input handler: typing "/ai" opens the menu. */
  onInput: () => void;
  /** Render once next to the editor: the menu, prompt box, draft, bar and state tiles (they live in a portal). */
  layer: ReactNode;
}

type Notice = { code: string; message: string };

type Phase =
  | { name: 'idle' }
  | { name: 'menu'; cap: EditorCapture | null; slash: { remove: () => void } | null }
  | { name: 'prompt'; action: EditorAction; cap: EditorCapture | null }
  | { name: 'drafting'; draftId: string; action: EditorAction; req: EditorRequest; cap: EditorCapture | null }
  | {
      name: 'review';
      draft: AssistDraft;
      action: EditorAction;
      req: EditorRequest;
      cap: EditorCapture | null;
      /** The text changed while it was written: it is shown, not applied. */
      stale?: boolean;
    }
  | { name: 'conflict'; draft: AssistDraft; action: EditorAction; req: EditorRequest; cap: EditorCapture | null }
  | { name: 'notice'; notice: Notice; cap: EditorCapture | null };

const ICONS: Record<string, string> = {
  ask: '✦',
  continue: '✎',
  summarise: '☰',
  criteria: '✓',
  diagram: '◇',
  translate: '#',
  improve: '✦',
  split: '⑂',
  more_criteria: '＋',
};

const PROMPT_ACTIONS: EditorAction[] = ['ask', 'translate', 'diagram'];
const LANG_KEY = 'kanban.ai.translateTo';

function readLang(): string {
  try {
    return localStorage.getItem(LANG_KEY) || 'English';
  } catch {
    return 'English';
  }
}

function dollars(v: number | null | undefined, metered: boolean): string {
  if (!metered) return 'Not metered';
  if (v == null) return '';
  return v < 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

/** Fixed position of a floating layer: under the anchor, flipped above when there is no room. */
function place(rect: DOMRect | null, width: number, height: number, over = false): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const r = rect ?? new DOMRect(vw / 2 - width / 2, vh / 3, 1, 20);
  const left = Math.max(8, Math.min(r.left, vw - width - 8));
  let top = over ? r.top - 4 : r.bottom + 6;
  if (top + height > vh - 8) top = over ? Math.max(8, vh - height - 8) : Math.max(8, r.top - 6 - height);
  return { left, top: Math.max(8, top) };
}

/** A box that follows its anchor while the page scrolls or the window changes. */
function Floating({
  where,
  width,
  over,
  children,
  testId,
  className,
}: {
  where: () => DOMRect | null;
  width: number;
  over?: boolean;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const whereRef = useRef(where);
  whereRef.current = where;
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const h = box.current?.offsetHeight ?? 200;
        const next = place(whereRef.current(), width, h, over);
        setPos((p) => (p && p.left === next.left && p.top === next.top ? p : next));
      });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (box.current) ro?.observe(box.current);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, [width, over]);
  return createPortal(
    <div
      ref={box}
      className={`ea-float ai-root ${className ?? ''}`}
      data-ai-layer
      data-testid={testId}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0, width, visibility: pos ? 'visible' : 'hidden' }}
      onMouseDown={(e) => {
        // clicking the layer must not move the selection or the cursor out of the editor
        if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function Tile({
  tone,
  title,
  children,
  testId,
}: {
  tone: 'blue' | 'amber' | 'red';
  title: string;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <div className={`ea-tile ea-tile-${tone}`} data-testid={testId}>
      <div className="ea-tile-title">{title}</div>
      {children}
    </div>
  );
}

/**
 * AI in an editor (design/screens/ai-where-you-work.md, D). Gives any editor the same help in the same place: the /ai
 * command or Ctrl+J opens a menu, a selection can be improved, shortened, spell-checked, explained or asked about, and
 * the result is a draft over the text with what changed marked. Nothing is written until the person accepts (Tab),
 * Esc discards, Try again writes it again, and Ctrl+Z takes an accepted draft back. "What will be sent" lists exactly
 * what the AI reads before anything is sent. It uses the AI members, permissions, caps and audit that already exist.
 *
 * An editor supplies an `EditorAdapter` (see `adapters.ts`: a textarea, the ticket WYSIWYG field, the Docs editor),
 * renders `layer` once, calls `onKeyDown` / `onInput` from its own handlers, and may show `EditorAiSelectionBar`.
 * @param opts - Where the editor is, what it belongs to and its adapter.
 */
export function useEditorAi(opts: UseEditorAiOptions): EditorAi {
  const { surface, projectId, ticketId, docId, ideaId, adapter, enabled = true } = opts;
  const qc = useQueryClient();
  const toast = useToast();
  const diagrams = useDiagrams();
  const { openAiPage, openAiTab } = useAiBoardState();
  const st = useEditorAiState(projectId, surface, ticketId, enabled && !!projectId);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const code = st.data?.availability.code;
  // AI off for the project, or the editor is switched off: nothing is offered at all
  const available = enabled && !!projectId && !!st.data && code !== 'ai_off';
  const canSuggest = available && code !== 'not_configured';
  const canDiagram = !!opts.insertDiagramLine && !!diagrams;
  const menu = useMemo(
    () =>
      (st.data?.menu ?? []).filter(
        (m) =>
          (m.action !== 'diagram' || canDiagram) &&
          // acceptance criteria belong to a ticket that exists
          !((m.action === 'criteria' || m.action === 'more_criteria') && !ticketId),
      ),
    [st.data?.menu, canDiagram, ticketId],
  );
  const bar = useMemo(() => st.data?.bar ?? [], [st.data?.bar]);

  const close = useCallback(() => setPhase({ name: 'idle' }), []);

  /** A notice for a state the person cannot ask in (design E), or null when they can. */
  const blocked = useCallback((): Notice | null => {
    const a = st.data?.availability;
    if (!a || a.code === 'ok') return null;
    return { code: a.code, message: a.message ?? '' };
  }, [st.data?.availability]);

  const body = useCallback(
    (action: EditorAction, cap: EditorCapture | null, extra: Partial<EditorRequest> = {}): EditorRequest => ({
      surface,
      action,
      selection: cap?.selection ?? '',
      before: cap?.before ?? '',
      after: cap?.after ?? '',
      ticketId: ticketId ?? undefined,
      docId: docId ?? undefined,
      ideaId: ideaId ?? undefined,
      ...extra,
    }),
    [surface, ticketId, docId, ideaId],
  );

  const fail = useCallback((e: unknown, cap: EditorCapture | null) => {
    const b = assistError(e);
    setPhase({
      name: 'notice',
      cap,
      notice: { code: b?.code ?? 'error', message: b?.detail ?? extractError(e) },
    });
  }, []);

  const startDraft = useCallback(
    async (action: EditorAction, req: EditorRequest, cap: EditorCapture | null) => {
      if (!projectId) return;
      try {
        const d = await editorAiApi.draft(projectId, req);
        setPhase({ name: 'drafting', draftId: d.id, action, req, cap });
      } catch (e) {
        fail(e, cap);
      }
    },
    [projectId, fail],
  );

  const run = useCallback(
    (action: EditorAction) => {
      const notice = blocked();
      const cap = adapter.capture('paragraph');
      if (notice) {
        setPhase({ name: 'notice', notice, cap });
        return;
      }
      if (PROMPT_ACTIONS.includes(action)) {
        setPhase({ name: 'prompt', action, cap });
        return;
      }
      void startDraft(action, body(action, cap), cap);
    },
    [adapter, blocked, body, startDraft],
  );

  const openMenu = useCallback(
    (slash: { remove: () => void } | null = null) => {
      if (!available) return;
      const cap = adapter.capture('paragraph');
      const notice = blocked();
      if (notice) {
        setPhase({ name: 'notice', notice, cap });
        return;
      }
      setPhase({ name: 'menu', cap, slash });
    },
    [available, adapter, blocked],
  );

  const onKeyDown = useCallback<EditorAi['onKeyDown']>(
    (e) => {
      if (!available) return false;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        openMenu();
        return true;
      }
      return false;
    },
    [available, openMenu],
  );

  const onInput = useCallback(() => {
    if (!canSuggest || phaseRef.current.name !== 'idle') return;
    const s = adapter.slash?.();
    if (s) {
      setPhase({ name: 'menu', cap: adapter.capture('paragraph'), slash: s });
    }
  }, [canSuggest, adapter]);

  // ---- poll the draft while it is written -------------------------------------------------------------------------
  const [partial, setPartial] = useState('');
  const drafting = phase.name === 'drafting' ? phase : null;
  useEffect(() => {
    if (!drafting) return undefined;
    let stop = false;
    let timer = 0;
    setPartial('');
    const tick = async () => {
      try {
        const d = await editorAiApi.getDraft(drafting.draftId);
        if (stop) return;
        if (d.status === 'pending') {
          setPartial(((d.payload as { partial?: string }).partial as string | undefined) ?? '');
          timer = window.setTimeout(tick, 350);
          return;
        }
        if (d.status === 'open') {
          const res = (d.payload as { result?: EditorResult }).result;
          const replaces = res?.kind === 'replace' && !!drafting.cap?.selection;
          const changed = replaces && drafting.cap?.current() === null;
          setPhase(
            changed
              ? { name: 'conflict', draft: d, action: drafting.action, req: drafting.req, cap: drafting.cap }
              : { name: 'review', draft: d, action: drafting.action, req: drafting.req, cap: drafting.cap },
          );
          return;
        }
        if (d.status === 'cancelled') {
          setPhase({ name: 'idle' });
          return;
        }
        const err = d.result?.error;
        setPhase({
          name: 'notice',
          cap: drafting.cap,
          notice: { code: err?.code ?? 'error', message: err?.message ?? 'The draft did not come back.' },
        });
      } catch (e) {
        if (!stop) fail(e, drafting.cap);
      }
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [drafting?.draftId, fail]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- keys while the layer is open: Esc, Tab, arrows --------------------------------------------------------------
  const [active, setActive] = useState(0);
  const acceptRef = useRef<() => void>(() => undefined);
  const discardRef = useRef<() => void>(() => undefined);
  const chooseRef = useRef<(i: number) => void>(() => undefined);
  useEffect(() => {
    if (phase.name === 'idle') return undefined;
    const onKey = (e: KeyboardEvent) => {
      const p = phaseRef.current;
      const stopIt = () => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      };
      if (e.key === 'Escape') {
        stopIt();
        if (p.name === 'review' || p.name === 'conflict') void discardRef.current();
        else if (p.name === 'drafting') void editorAiApi.cancel(p.draftId).finally(close);
        else close();
        return;
      }
      if (p.name === 'review' && e.key === 'Tab' && !e.shiftKey) {
        stopIt();
        void acceptRef.current();
        return;
      }
      if (p.name === 'menu') {
        const n = menu.length;
        if (e.key === 'ArrowDown') {
          stopIt();
          setActive((a) => (a + 1) % Math.max(1, n));
        } else if (e.key === 'ArrowUp') {
          stopIt();
          setActive((a) => (a - 1 + Math.max(1, n)) % Math.max(1, n));
        } else if (e.key === 'Enter' || e.key === 'Tab') {
          stopIt();
          chooseRef.current(activeRef.current);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase.name, menu.length, close]);
  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => setActive(0), [phase.name]);

  // ---- accept, discard, try again ----------------------------------------------------------------------------------
  const finish = useCallback(
    (title: string, text = 'Ctrl+Z takes it back.') => {
      toast.success(title, text);
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      void qc.invalidateQueries({ queryKey: editorKeys.state(projectId ?? '', surface, ticketId) });
      close();
    },
    [toast, qc, projectId, surface, ticketId, close],
  );

  const accept = useCallback(
    async (how?: { items?: string[]; below?: boolean }) => {
      const p = phaseRef.current;
      if (p.name !== 'review') return;
      const res = (p.draft.payload as { result?: EditorResult }).result;
      if (!res) return;
      try {
        if (res.kind === 'list') {
          await editorAiApi.accept(p.draft.id, how?.items);
          optsRef.current.onAccepted?.(p.action, 'list');
          finish('Criteria added', 'They are on the ticket, and Activity says they were suggested by the AI.');
          return;
        }
        if (res.kind === 'diagram' && res.diagram) {
          const d = optsRef.current;
          diagrams?.openEditor({
            projectId: d.projectId ?? '',
            initialXml: res.diagram.xml,
            label: res.diagram.title,
            saveTo: d.diagramSaveTo,
            itemKind: d.surface === 'doc' || d.surface === 'idea' ? 'doc' : 'ticket',
            itemId: (d.docId ?? d.ticketId) || undefined,
            onSaved: (saved) => {
              d.insertDiagramLine?.(diagramMarkdown(saved));
              void editorAiApi.accept(p.draft.id).catch(() => undefined);
            },
          });
          close();
          return;
        }
        // the text goes in first, as one undoable step; then the board records it
        const cap = p.stale || how?.below ? adapter.capture('selection') : p.cap;
        const kind = res.kind === 'replace' && !p.stale && !how?.below ? 'replace' : 'insert';
        const ok = cap?.apply(res.text ?? '', {
          kind,
          block: res.kind === 'answer' || p.action === 'summarise' || how?.below,
        });
        if (!ok) {
          setPhase({
            name: 'notice',
            cap: p.cap,
            notice: { code: 'apply_failed', message: 'The text could not be put in. Copy the draft instead.' },
          });
          return;
        }
        await editorAiApi.accept(p.draft.id);
        finish('Draft accepted');
      } catch (e) {
        fail(e, p.cap);
      }
    },
    [adapter, diagrams, finish, close, fail],
  );

  const discard = useCallback(async () => {
    const p = phaseRef.current;
    if (p.name === 'review' || p.name === 'conflict') await editorAiApi.discard(p.draft.id).catch(() => undefined);
    close();
  }, [close]);
  acceptRef.current = () => void accept();
  discardRef.current = () => void discard();

  const tryAgain = useCallback(async () => {
    const p = phaseRef.current;
    if (p.name !== 'review' && p.name !== 'conflict') return;
    try {
      await editorAiApi.retry(p.draft.id);
      setPhase({
        name: 'drafting',
        draftId: p.draft.id,
        action: p.action,
        req: p.req,
        cap: adapter.capture('paragraph'),
      });
    } catch (e) {
      fail(e, p.cap);
    }
  }, [adapter, fail]);

  const goOn = useCallback(async () => {
    const p = phaseRef.current;
    if (p.name !== 'review') return;
    try {
      await editorAiApi.goOn(p.draft.id);
      setPhase({ name: 'drafting', draftId: p.draft.id, action: p.action, req: p.req, cap: p.cap });
    } catch (e) {
      fail(e, p.cap);
    }
  }, [fail]);

  const chooseMenu = useCallback(
    (i: number) => {
      const p = phaseRef.current;
      if (p.name !== 'menu') return;
      const item = menu[i];
      if (!item) return;
      p.slash?.remove();
      run(item.action);
    },
    [menu, run],
  );
  chooseRef.current = chooseMenu;

  // ---- the layer ---------------------------------------------------------------------------------------------------
  const where = useCallback(
    (cap: EditorCapture | null) => () => cap?.where() ?? adapter.root()?.getBoundingClientRect() ?? null,
    [adapter],
  );

  // a draft sits over the text, the width of the editor and starting at its left edge; the menu hangs at the cursor
  const whereBlock = useCallback(
    (cap: EditorCapture | null) => () => {
      const r = cap?.where() ?? null;
      const root = adapter.root()?.getBoundingClientRect() ?? null;
      if (!r || !root) return r ?? root;
      return new DOMRect(root.left + 6, r.top, Math.max(1, root.width - 12), r.height);
    },
    [adapter],
  );
  const blockWidth = Math.min(720, Math.max(380, (adapter.root()?.getBoundingClientRect().width ?? 600) - 12));

  let layer: ReactNode = null;
  if (phase.name === 'menu') {
    layer = (
      <Floating where={where(phase.cap)} width={330} testId="ea-menu">
        <div className="ea-menu" role="menu" aria-label="AI">
          {menu.map((m, i) => (
            <button
              key={m.action}
              type="button"
              role="menuitem"
              className={`ea-menu-item ${i === active ? 'ea-menu-on' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => chooseMenu(i)}
              data-testid={`ea-menu-${m.action}`}
            >
              <span className="ea-menu-ico">{ICONS[m.action] ?? '✦'}</span>
              <span className="ea-menu-text">
                <b>{m.label}</b>
                <span>{m.hint}</span>
              </span>
            </button>
          ))}
          <div className="ea-menu-foot">
            <kbd>↑↓</kbd> move · <kbd>Enter</kbd> run · <kbd>Esc</kbd> close
          </div>
        </div>
      </Floating>
    );
  } else if (phase.name === 'prompt') {
    layer = (
      <Floating where={whereBlock(phase.cap)} width={Math.min(blockWidth, 560)} testId="ea-prompt">
        <PromptBox
          action={phase.action}
          cap={phase.cap}
          surface={surface}
          projectId={projectId ?? ''}
          body={body}
          hasTicket={!!ticketId}
          hasPage={!!docId}
          onCancel={close}
          onGenerate={(extra) => void startDraft(phase.action, body(phase.action, phase.cap, extra), phase.cap)}
        />
      </Floating>
    );
  } else if (phase.name === 'drafting') {
    layer = (
      <Floating where={whereBlock(phase.cap)} width={Math.min(blockWidth, 520)} over testId="ea-drafting">
        <div className="ea-draft">
          <div className="ea-draft-head">
            <span className="ai-spin" /> <b>{labelOf(phase.action, st.data?.menu, st.data?.bar)}</b>
            <span className="ai-muted">Writing a draft. Nothing is changed yet.</span>
          </div>
          {partial && <div className="ea-draft-text ea-add-text">{partial}</div>}
        </div>
        <div className="ea-pill">
          <span className="ea-pill-title">✦ Drafting…</span>
          <button
            type="button"
            className="ea-pill-btn"
            data-testid="ea-stop"
            onClick={() => void editorAiApi.cancel(phase.draftId).finally(close)}
          >
            Stop <kbd>Esc</kbd>
          </button>
        </div>
      </Floating>
    );
  } else if (phase.name === 'review' || phase.name === 'conflict') {
    const res = (phase.draft.payload as { result?: EditorResult }).result;
    const review = phase.name === 'review' ? phase : null;
    const metered = phase.draft.cost > 0;
    layer = (
      <Floating where={whereBlock(phase.cap)} width={blockWidth} over testId="ea-review">
        {phase.name === 'conflict' ? (
          <Tile tone="amber" title="The paragraph changed" testId="ea-conflict">
            <div className="ai-hint">Someone edited it while the AI was writing. Your draft was not applied.</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="ai-btn ai-btn-primary ai-btn-sm" onClick={() => void tryAgain()}>
                Try again
              </button>
              <button
                type="button"
                className="ai-btn ai-btn-sm"
                data-testid="ea-show-draft"
                onClick={() =>
                  setPhase({
                    name: 'review',
                    draft: phase.draft,
                    action: phase.action,
                    req: phase.req,
                    cap: phase.cap,
                    stale: true,
                  })
                }
              >
                Show the draft
              </button>
              <button type="button" className="ai-link" onClick={() => void discard()}>
                Discard
              </button>
            </div>
          </Tile>
        ) : (
          res && (
            <DraftCard
              res={res}
              before={phase.req.selection ?? ''}
              stale={!!review?.stale}
              onAccept={(items) => void accept({ items })}
              onBelow={() => void accept({ below: true })}
              onDiscard={() => void discard()}
              onCopy={() => {
                void navigator.clipboard?.writeText(res.text ?? (res.items ?? []).join('\n'));
                toast.success('Copied');
              }}
            />
          )
        )}
        {review && res && res.kind !== 'list' && res.kind !== 'diagram' && (
          <div className="ea-pill" data-testid="ea-pill">
            <span className="ea-pill-title">
              ✦ {labelOf(phase.action, st.data?.menu, st.data?.bar)} · {dollars(phase.draft.cost, metered)}
            </span>
            {res.kind === 'answer' ? (
              <>
                <button
                  type="button"
                  className="ea-pill-btn ea-pill-go"
                  data-testid="ea-insert-below"
                  onClick={() => void accept({ below: true })}
                >
                  Insert below
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ea-pill-btn ea-pill-go"
                data-testid="ea-accept"
                onClick={() => void accept()}
              >
                {review.stale ? 'Insert at cursor' : 'Accept'} <kbd>Tab</kbd>
              </button>
            )}
            <button type="button" className="ea-pill-btn" data-testid="ea-discard" onClick={() => void discard()}>
              Discard <kbd>Esc</kbd>
            </button>
            <button type="button" className="ea-pill-btn" data-testid="ea-retry" onClick={() => void tryAgain()}>
              Try again
            </button>
          </div>
        )}
        {review && res?.cutShort && res.kind !== 'list' && (
          <Tile tone="amber" title="The reply is partial" testId="ea-cut-short">
            <div className="ai-hint">The AI hit its length limit. What it wrote is kept.</div>
            <button
              type="button"
              className="ai-btn ai-btn-primary ai-btn-sm"
              style={{ alignSelf: 'flex-start' }}
              data-testid="ea-continue"
              onClick={() => void goOn()}
            >
              Continue
            </button>
          </Tile>
        )}
      </Floating>
    );
  } else if (phase.name === 'notice') {
    layer = (
      <Floating where={where(phase.cap)} width={380} testId="ea-notice">
        <NoticeTile
          notice={phase.notice}
          onClose={close}
          onMembers={() => {
            close();
            (optsRef.current.onOpenAiMembers ?? (() => openAiPage?.()))();
          }}
          onUsage={() => {
            close();
            (optsRef.current.onOpenUsage ?? (() => openAiTab?.('usage')))();
          }}
        />
      </Floating>
    );
  }

  return {
    available,
    menu,
    bar,
    idle: phase.name === 'idle',
    openMenu: () => openMenu(),
    run,
    onKeyDown,
    onInput,
    layer,
  };
}

function labelOf(action: EditorAction, ...lists: (EditorActionInfo[] | undefined)[]): string {
  for (const l of lists) {
    const f = l?.find((x) => x.action === action);
    if (f) return f.label.replace('…', '');
  }
  return action;
}

/** The states of design E, as tiles. */
function NoticeTile({
  notice,
  onClose,
  onMembers,
  onUsage,
}: {
  notice: Notice;
  onClose: () => void;
  onMembers: () => void;
  onUsage: () => void;
}) {
  switch (notice.code) {
    case 'not_configured':
      return (
        <Tile tone="blue" title="✦ Choose an AI to use these helpers" testId="ea-no-member">
          <div className="ai-hint">
            The AI button, @ picker and /ai appear when an AI member that can read this project exists.
          </div>
          <button type="button" className="ai-btn ai-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onMembers}>
            Open AI members
          </button>
        </Tile>
      );
    case 'over_budget':
      return (
        <Tile tone="amber" title="⚠ AI is paused until tomorrow" testId="ea-over-budget">
          <div className="ai-hint">
            The daily cap was reached. Ask-only answers and drafts stop; reading the thread still works.
          </div>
          <button type="button" className="ai-btn ai-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onUsage}>
            See usage
          </button>
        </Tile>
      );
    case 'viewer':
      return (
        <Tile tone="blue" title="🔒 You can read, not ask" testId="ea-viewer">
          <div className="ai-hint">Only members can ask the AI. You can still read answers posted on this ticket.</div>
          <button type="button" className="ai-link" style={{ alignSelf: 'flex-start' }} onClick={onClose}>
            Close
          </button>
        </Tile>
      );
    default:
      return (
        <Tile tone="red" title="The AI could not do that" testId="ea-error">
          <div className="ai-hint">{notice.message || 'Something went wrong. Nothing was changed.'}</div>
          <button type="button" className="ai-btn ai-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={onClose}>
            Close
          </button>
        </Tile>
      );
  }
}

/** The draft over the text: what changed marked for a replacement, the new text for an insertion. */
function DraftCard({
  res,
  before,
  stale,
  onAccept,
  onBelow,
  onDiscard,
  onCopy,
}: {
  res: EditorResult;
  before: string;
  stale: boolean;
  onAccept: (items?: string[]) => void;
  onBelow: () => void;
  onDiscard: () => void;
  onCopy: () => void;
}) {
  const [picked, setPicked] = useState<Set<number>>(() => new Set((res.items ?? []).map((_, i) => i)));
  const diff = useMemo(
    () => (res.kind === 'replace' && !stale && before ? wordDiff(before, res.text ?? '') : null),
    [res.kind, res.text, before, stale],
  );
  if (res.kind === 'list') {
    const items = res.items ?? [];
    const chosen = items.filter((_, i) => picked.has(i));
    return (
      <div className="ea-draft ea-draft-list" data-testid="ea-list">
        <div className="ea-draft-label">Draft · {items.length} acceptance criteria</div>
        {items.map((t, i) => (
          <label key={i} className="ea-list-item">
            <input
              type="checkbox"
              checked={picked.has(i)}
              onChange={() => {
                const n = new Set(picked);
                if (n.has(i)) n.delete(i);
                else n.add(i);
                setPicked(n);
              }}
            />
            {t}
          </label>
        ))}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="ai-btn ai-btn-primary ai-btn-sm"
            disabled={!chosen.length}
            data-testid="ea-add-criteria"
            onClick={() => onAccept(chosen)}
          >
            ✓ Add {chosen.length === items.length && items.length === 2 ? 'both' : chosen.length}
          </button>
          <button type="button" className="ai-btn ai-btn-sm" onClick={onDiscard}>
            Dismiss
          </button>
        </div>
      </div>
    );
  }
  if (res.kind === 'diagram' && res.diagram) {
    return (
      <div className="ea-draft" data-testid="ea-diagram">
        <div className="ea-draft-label">Draft · diagram</div>
        <b>{res.diagram.title}</b>
        <div className="ai-muted">
          {res.diagram.nodes.length} boxes, {res.diagram.edges.length} arrows:{' '}
          {res.diagram.nodes.map((n) => n.label).join(' → ')}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="ai-btn ai-btn-primary ai-btn-sm"
            data-testid="ea-open-diagram"
            onClick={() => onAccept()}
          >
            Open in the diagram editor
          </button>
          <button type="button" className="ai-btn ai-btn-sm" onClick={onDiscard}>
            Discard
          </button>
        </div>
        <div className="ai-muted">It is saved only when you save the drawing; you can change it first.</div>
      </div>
    );
  }
  return (
    <div className="ea-draft" data-testid={`ea-draft-${res.kind}`}>
      {res.kind === 'answer' && <div className="ea-draft-label">Answer · not part of the text</div>}
      {res.kind === 'insert' && (
        <div className="ea-draft-label">Draft · will be added {stale ? 'at the cursor' : 'here'}</div>
      )}
      {stale && res.kind === 'replace' && (
        <div className="ea-draft-label">Draft · the text changed, so it is not applied</div>
      )}
      <div className="ea-draft-text" data-testid="ea-draft-text">
        {diff ? (
          diff.map((s, i) => (
            <span key={i} className={s.kind === 'del' ? 'ea-del' : s.kind === 'add' ? 'ea-add' : undefined}>
              {s.text}
            </span>
          ))
        ) : (
          <span className={res.kind === 'answer' ? undefined : 'ea-add'}>{res.text}</span>
        )}
      </div>
      {(res.kind === 'answer' || stale) && (
        <div style={{ display: 'flex', gap: 8 }}>
          {res.kind === 'answer' && (
            <button type="button" className="ai-btn ai-btn-sm" onClick={onBelow}>
              Insert below
            </button>
          )}
          <button type="button" className="ai-btn ai-btn-sm" onClick={onCopy} data-testid="ea-copy">
            Copy
          </button>
        </div>
      )}
    </div>
  );
}

/** "Ask AI to write" (design D4): the prompt, what it reads, what will be sent, the cost, Generate. */
function PromptBox({
  action,
  cap,
  surface,
  projectId,
  body,
  hasTicket,
  hasPage,
  onCancel,
  onGenerate,
}: {
  action: EditorAction;
  cap: EditorCapture | null;
  surface: EditorSurface;
  projectId: string;
  body: (a: EditorAction, c: EditorCapture | null, extra?: Partial<EditorRequest>) => EditorRequest;
  hasTicket: boolean;
  hasPage: boolean;
  onCancel: () => void;
  onGenerate: (extra: Partial<EditorRequest>) => void;
}) {
  const translate = action === 'translate';
  const [prompt, setPrompt] = useState('');
  const [language, setLanguage] = useState(readLang);
  const [withTicket, setWithTicket] = useState(true);
  const [withPage, setWithPage] = useState(true);
  const [withSelection, setWithSelection] = useState(true);
  const [showSent, setShowSent] = useState(false);
  const [preview, setPreview] = useState<EditorPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasSel = !!cap?.selection.trim();
  const include = useMemo(
    () => ({ ticket: hasTicket && withTicket, page: hasPage && withPage, selection: hasSel && withSelection }),
    [hasTicket, withTicket, hasPage, withPage, hasSel, withSelection],
  );
  const extra = useMemo<Partial<EditorRequest>>(
    () => ({ prompt: translate ? '' : prompt, language: translate ? language : undefined, include }),
    [prompt, translate, language, include],
  );
  const ready = translate ? !!language.trim() : !!prompt.trim() || action === 'diagram';
  useEffect(() => {
    let stop = false;
    const t = window.setTimeout(async () => {
      try {
        const p = await editorAiApi.preview(
          projectId,
          body(action, cap, {
            ...extra,
            prompt: extra.prompt || (action === 'ask' || action === 'diagram' ? '…' : ''),
          }),
        );
        if (!stop) {
          setPreview(p);
          setError(null);
        }
      } catch (e) {
        if (!stop) setError(assistError(e)?.detail ?? extractError(e));
      }
    }, 350);
    return () => {
      stop = true;
      window.clearTimeout(t);
    };
  }, [projectId, action, cap, body, extra]);
  const est = preview?.estimate;
  return (
    <div className="ea-prompt" data-testid="ea-prompt-box">
      <div className="ea-prompt-row">
        <span className="ea-prompt-spark">✦</span>
        {translate ? (
          <input
            autoFocus
            value={language}
            aria-label="Translate into"
            placeholder="Translate into… (English, Tiếng Việt, 日本語)"
            data-testid="ea-language"
            onChange={(e) => setLanguage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) {
                e.preventDefault();
                try {
                  localStorage.setItem(LANG_KEY, language);
                } catch {
                  /* storage unavailable */
                }
                onGenerate(extra);
              }
            }}
          />
        ) : (
          <input
            autoFocus
            value={prompt}
            aria-label="What should it write?"
            placeholder={
              action === 'diagram'
                ? 'Describe the diagram…'
                : surface === 'doc' || surface === 'idea'
                  ? 'Ask AI to write, with this page as context…'
                  : 'Ask AI to write, with this ticket as context…'
            }
            data-testid="ea-prompt-input"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready) {
                e.preventDefault();
                onGenerate(extra);
              }
            }}
          />
        )}
      </div>
      <div className="ea-chips">
        {hasTicket && (
          <button
            type="button"
            className={`ea-chip ${withTicket ? 'ea-chip-on' : ''}`}
            aria-pressed={withTicket}
            onClick={() => setWithTicket((v) => !v)}
            data-testid="ea-chip-ticket"
          >
            ▭ This ticket
          </button>
        )}
        {hasPage && (
          <button
            type="button"
            className={`ea-chip ${withPage ? 'ea-chip-on' : ''}`}
            aria-pressed={withPage}
            onClick={() => setWithPage((v) => !v)}
            data-testid="ea-chip-page"
          >
            ▭ This page
          </button>
        )}
        {hasSel && (
          <button
            type="button"
            className={`ea-chip ${withSelection ? 'ea-chip-on' : ''}`}
            aria-pressed={withSelection}
            onClick={() => setWithSelection((v) => !v)}
            data-testid="ea-chip-selection"
          >
            T Selected text
          </button>
        )}
        <button
          type="button"
          className="ea-sent-btn"
          aria-expanded={showSent}
          onClick={() => setShowSent((v) => !v)}
          data-testid="ea-sent"
        >
          What will be sent ⓘ
        </button>
        <span style={{ flex: 1 }} />
        <span className="ai-muted" data-testid="ea-cost">
          {est ? (est.metered ? `About ${dollars(est.usd, true)}` : 'Not metered') : ''}
        </span>
      </div>
      {showSent && (
        <div className="ea-sent" data-testid="ea-sent-list">
          {preview?.pieces.map((p, i) => (
            <div key={i} className="ea-sent-row">
              <b>{p.label}</b>
              <span className="ai-muted">
                {p.chars.toLocaleString()} characters · about {p.tokens.toLocaleString()} tokens
              </span>
              {p.preview && <span className="ea-sent-preview">{p.preview}</span>}
            </div>
          ))}
          {preview?.privateSkipped.map((t) => (
            <div key={t} className="ea-sent-row ai-muted">
              “{t}” is private: its text is not sent.
            </div>
          ))}
          {preview && (
            <div className="ai-muted" style={{ marginTop: 4 }}>
              Never sent: {preview.neverSent.join(' · ')}.
            </div>
          )}
          {!preview && !error && <div className="ai-muted">Working out what would be sent…</div>}
        </div>
      )}
      {error && <div className="ai-error-text">{error}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          className="ai-btn ai-btn-primary ai-btn-sm"
          disabled={!ready}
          data-testid="ea-generate"
          onClick={() => {
            if (translate) {
              try {
                localStorage.setItem(LANG_KEY, language);
              } catch {
                /* storage unavailable */
              }
            }
            onGenerate(extra);
          }}
        >
          Generate
        </button>
        <button type="button" className="ai-btn ai-btn-sm" onClick={onCancel}>
          Cancel <kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}

/**
 * The selection bar of design D2 for editors that have no bar of their own: a dark pill under the selected text with
 * Improve, Shorten, Fix spelling, Explain and Ask… It shows only while text is selected in the editor.
 * @param props.ai - What `useEditorAi` returned.
 * @param props.adapter - The same adapter the hook was given.
 */
export function EditorAiSelectionBar({ ai, adapter }: { ai: EditorAi; adapter: EditorAdapter }) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEffect(() => {
    if (!ai.available) return undefined;
    const update = () => {
      const root = adapter.root();
      if (!root) return setRect(null);
      const inside = root.contains(document.activeElement) || root.contains(window.getSelection()?.anchorNode ?? null);
      if (!inside) return setRect(null);
      const cap = adapter.capture('selection');
      setRect(cap && cap.selection.trim().length > 1 ? cap.where() : null);
    };
    const el = () => adapter.root();
    document.addEventListener('selectionchange', update);
    const events = ['mouseup', 'keyup', 'select'] as const;
    const target = el();
    events.forEach((ev) => target?.addEventListener(ev, update));
    return () => {
      document.removeEventListener('selectionchange', update);
      events.forEach((ev) => target?.removeEventListener(ev, update));
    };
  }, [ai.available, adapter]);
  if (!ai.available || !ai.idle || !rect || !ai.bar.length) return null;
  return (
    <Floating where={() => rect} width={Math.min(420, window.innerWidth - 16)} testId="ea-bar" className="ea-bar-wrap">
      <div className="ea-bar" role="toolbar" aria-label="AI on the selection">
        {ai.bar.map((b) => (
          <button
            key={b.action}
            type="button"
            className={b.action === 'ask' ? 'ea-bar-ask' : undefined}
            data-testid={`ea-bar-${b.action}`}
            onClick={() => ai.run(b.action)}
          >
            {b.action === 'ask' ? '✦ ' : ''}
            {b.label}
          </button>
        ))}
      </div>
    </Floating>
  );
}
