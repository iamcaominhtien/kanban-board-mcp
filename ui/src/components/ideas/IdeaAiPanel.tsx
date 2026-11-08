import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  keptKey,
  newRequestId,
  requestShape,
  stopShape,
  useIdeaAiStatus,
  useKeptSuggestions,
  useShapeIdea,
  type IdeaAiStatus,
  type KeptTurn,
  type ShapeResult,
} from '../../api/ideaAi';
import {
  ideaRuleError,
  useAddAssumption,
  useAddComment,
  useAddLogEntry,
  useCreateTestTicket,
  useEditIdeaPage,
} from '../../api/ideas';
import type { Idea } from '../../types/idea';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { PanelMaxButton, PanelResizer, panelSizing } from '../PanelResizer';
import { useToast } from '../Toast';
import { AiChip, BulbIcon } from './ideaShared';
import { IdeaIcon } from './ideaIcons';
import { LineIcon } from '../ui/LineIcon';

const money = (n: number) => (n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

/**
 * Why AI help is not available, in the words of the design ("AI help is off", "AI help is not available right now", "paused until
 * tomorrow"); null when it is on.
 */
export function AiUnavailable({ status, onOpenSettings }: { status: IdeaAiStatus; onOpenSettings?: () => void }) {
  if (status.state === 'on') return null;
  const title = {
    off: 'AI help is off',
    unavailable: 'AI help is not available right now',
    cap: 'AI help paused until tomorrow',
  }[status.state];
  return (
    <div
      className={`is-banner ${status.state === 'cap' ? 'is-banner-warn' : ''}`}
      role="status"
      data-testid="ai-unavailable"
    >
      <div style={{ flex: 1 }}>
        <b>{title}</b>
        <div>{status.message}</div>
      </div>
      {onOpenSettings && (
        <button type="button" className="is-btn is-btn-sm" onClick={onOpenSettings}>
          Open settings
        </button>
      )}
    </div>
  );
}

/**
 * Keep with "Ask an AI member to suggest a problem statement and assumptions" on (ICT-5): after the idea is kept, the
 * same two Shape requests as the "Draft the problem" and "Suggest assumptions" starters run. Their drafts wait for the
 * idea's Shape with AI panel (it opens with them); nothing is added to the idea until a person adds it there.
 * @returns `suggest(ideaId, title)`, which runs in the background and tells the person with a toast.
 */
export function useSuggestOnKeep() {
  const qc = useQueryClient();
  const toast = useToast();
  const suggest = useCallback(
    async (ideaId: string, ideaTitle: string) => {
      const asks: { kind: ShapeResult['kind']; title: string }[] = [
        { kind: 'problem', title: STARTERS[0].label },
        { kind: 'assumptions', title: STARTERS[1].label },
      ];
      const base = Date.now();
      const turns: KeptTurn[] = asks.map((a, i) => ({ id: base + i, kind: a.kind, title: a.title }));
      qc.setQueryData<KeptTurn[]>(keptKey(ideaId), turns);
      const put = (id: number, patch: Partial<KeptTurn>) =>
        qc.setQueryData<KeptTurn[]>(keptKey(ideaId), (all) =>
          (all ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)),
        );
      let ok = 0;
      for (const t of turns) {
        try {
          put(t.id, { result: await requestShape({ ideaId, kind: t.kind }) });
          ok += 1;
        } catch (e) {
          put(t.id, { error: ideaRuleError(e).message });
        }
      }
      void qc.invalidateQueries({ queryKey: ['ideas', 'ai', 'status'] });
      if (ok > 0) {
        toast.success(`Suggestions ready for “${ideaTitle}”`, 'Open the idea: they wait in Shape with AI to be added.');
      } else {
        qc.removeQueries({ queryKey: keptKey(ideaId) });
        toast.error(
          'The AI suggestion could not be made',
          'The idea was kept as Exploring without a suggestion. You can ask again from its page.',
          undefined,
          { label: 'Try again', onClick: () => void suggest(ideaId, ideaTitle) },
        );
      }
    },
    [qc, toast],
  );
  return suggest;
}

const STARTERS: { kind: ShapeResult['kind']; label: string }[] = [
  { kind: 'problem', label: 'Draft the problem and the idea' },
  { kind: 'assumptions', label: 'Suggest assumptions and cheapest tests' },
  { kind: 'exists', label: 'Check what already exists' },
  { kind: 'effort', label: 'Guess the effort from the code' },
];

interface Props {
  idea: Idea;
  onClose: () => void;
  onOpenIdea: (id: string) => void;
  onOpenTicket: (id: string) => void;
  onOpenSettings?: () => void;
}

/** "Shape with AI": a chat docked beside the idea. Everything it proposes is a draft with an Add button. */
export function ShapePanel({ idea, onClose, onOpenIdea, onOpenTicket, onOpenSettings }: Props) {
  const toast = useToast();
  const panel = useResizablePanel('shape-ai', 380, { min: 320 });
  const sizing = panelSizing(panel);
  const status = useIdeaAiStatus(idea.projectId).data;
  const shape = useShapeIdea();
  const edit = useEditIdeaPage();
  const addAssumption = useAddAssumption();
  const addComment = useAddComment();
  const addLog = useAddLogEntry();
  const createTest = useCreateTestTicket();
  const [turns, setTurns] = useState<
    {
      id: number;
      title: string;
      result?: ShapeResult;
      error?: string;
      /** Stopped by the person (IP-16): nothing was drafted. */
      stopped?: boolean;
      kind: ShapeResult['kind'];
      question?: string;
      requestId?: string;
    }[]
  >([]);
  const [question, setQuestion] = useState('');
  const [added, setAdded] = useState<Set<string>>(new Set());
  const kept = useKeptSuggestions(idea.id);

  // the suggestions asked for on Keep (ICT-5) join the conversation, and fill in as they arrive
  useEffect(() => {
    if (!kept.length) return;
    setTurns((t) => {
      // a turn asked again here (it has a request id) is this panel's own from then on
      const local = new Map(t.map((x) => [x.id, x]));
      const merged = kept.map((k) => {
        const own = local.get(k.id);
        return own?.requestId ? own : k;
      });
      return [...merged, ...t.filter((x) => !kept.some((k) => k.id === x.id))];
    });
  }, [kept]);

  async function run(kind: ShapeResult['kind'], title: string, q?: string, retryId?: number) {
    const id = retryId ?? Date.now();
    const requestId = newRequestId();
    setTurns((t) =>
      retryId
        ? t.map((x) => (x.id === id ? { ...x, error: undefined, result: undefined, stopped: false, requestId } : x))
        : [...t, { id, title, kind, question: q, requestId }],
    );
    try {
      const result = await shape.mutateAsync({ ideaId: idea.id, kind, question: q, requestId });
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, result } : x)));
    } catch (e) {
      const rule = ideaRuleError(e);
      setTurns((t) =>
        t.map((x) => (x.id === id ? { ...x, error: rule.message, stopped: rule.code === 'stopped' } : x)),
      );
    }
  }

  async function stop(requestId: string) {
    try {
      await stopShape(requestId);
    } catch (e) {
      toast.error('Could not stop it', ideaRuleError(e).message);
    }
  }

  const mark = (key: string) => setAdded((a) => new Set(a).add(key));
  const oops =
    (title: string) =>
    (e: unknown): undefined => {
      toast.error(title, ideaRuleError(e).message);
      return undefined;
    };

  async function addProblem(r: ShapeResult) {
    const text = [r.problem && `## Problem\n\n${r.problem}`, r.idea && `## Idea\n\n${r.idea}`]
      .filter(Boolean)
      .join('\n\n');
    await edit
      .mutateAsync({ id: idea.id, body: idea.body ? `${idea.body}\n\n${text}` : text, ai: true })
      .catch(oops('Could not add'));
    mark('problem');
  }

  function renderResult(turn: (typeof turns)[number]) {
    const r = turn.result!;
    const footer = (
      <div className="is-muted" style={{ marginTop: 6 }}>
        {r.member}
        {r.cost > 0 ? ` · ${money(r.cost)}` : ''} · suggestions are drafts
      </div>
    );
    if (r.kind === 'problem') {
      return (
        <>
          <div className="is-draft">
            <div className="is-label">Draft · problem and idea</div>
            {r.problem && <p>{r.problem}</p>}
            {r.idea && <p>{r.idea}</p>}
            <button
              type="button"
              className="is-btn is-btn-sm"
              disabled={added.has('problem')}
              onClick={() => addProblem(r)}
            >
              {added.has('problem') ? 'Added' : 'Add to the page'}
            </button>
          </div>
          {footer}
        </>
      );
    }
    if (r.kind === 'assumptions') {
      const list = r.assumptions ?? [];
      return (
        <>
          <div className="is-draft">
            <div className="is-label">Draft · {list.length} assumptions</div>
            {list.map((a, i) => (
              <div key={i} className="is-draft-item">
                <div>
                  {a.text} <span className="is-tag">{a.impact}</span>
                </div>
                {a.cheapestTest && <div className="is-muted">Cheapest test: {a.cheapestTest}</div>}
                <button
                  type="button"
                  className="is-btn is-btn-sm"
                  disabled={added.has(`a${turn.id}-${i}`)}
                  onClick={async () => {
                    await addAssumption
                      .mutateAsync({ id: idea.id, text: a.text, impact: a.impact, ai: true })
                      .catch(oops('Could not add'));
                    mark(`a${turn.id}-${i}`);
                  }}
                >
                  {added.has(`a${turn.id}-${i}`) ? 'Added' : 'Add'}
                </button>
              </div>
            ))}
            {list.length > 1 && (
              <button
                type="button"
                className="is-btn is-btn-sm is-btn-primary"
                onClick={async () => {
                  for (const [i, a] of list.entries()) {
                    if (added.has(`a${turn.id}-${i}`)) continue;
                    await addAssumption
                      .mutateAsync({ id: idea.id, text: a.text, impact: a.impact, ai: true })
                      .catch(oops('Could not add'));
                    mark(`a${turn.id}-${i}`);
                  }
                }}
              >
                Add all {list.length}
              </button>
            )}
          </div>
          {footer}
        </>
      );
    }
    if (r.kind === 'tests') {
      return (
        <>
          <div className="is-draft">
            <div className="is-label">Draft · cheapest test for each</div>
            {(r.tests ?? []).map((t) => {
              const a = idea.assumptions.find((x) => x.id === t.assumptionId);
              return (
                <div key={t.assumptionId} className="is-draft-item">
                  <div className="is-muted">{a?.text}</div>
                  <div>{t.test}</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="is-btn is-btn-sm"
                      disabled={added.has(`t${t.assumptionId}`) || !idea.projectId}
                      title={idea.projectId ? undefined : 'Choose a project first'}
                      onClick={async () => {
                        const res = await createTest
                          .mutateAsync({ id: idea.id, assumptionId: t.assumptionId, title: t.test.slice(0, 120) })
                          .catch(oops('Could not create the test'));
                        if (res) {
                          mark(`t${t.assumptionId}`);
                          toast.success(`Created ${res.ticket.id}`, undefined, 5000, {
                            label: 'Open ticket',
                            onClick: () => onOpenTicket(res.ticket.id),
                          });
                        }
                      }}
                    >
                      {added.has(`t${t.assumptionId}`) ? 'Created' : 'Create test ticket'}
                    </button>
                    <button
                      type="button"
                      className="is-btn is-btn-sm"
                      onClick={async () => {
                        await addComment
                          .mutateAsync({ id: idea.id, body: `Cheapest test for “${a?.text ?? ''}”: ${t.test}` })
                          .catch(oops('Could not post'));
                        toast.success('Posted to comments');
                      }}
                    >
                      Post to comments
                    </button>
                  </div>
                </div>
              );
            })}
            {(r.tests ?? []).length === 0 && <div className="is-muted">No test to suggest.</div>}
          </div>
          {footer}
        </>
      );
    }
    if (r.kind === 'effort') {
      return (
        <>
          <div className="is-draft">
            <div className="is-label">Draft · effort guess</div>
            <div>
              <b>{r.effort}</b> (AI estimate)
            </div>
            <p>{r.why}</p>
            {(r.files ?? []).length > 0 && <div className="is-muted">Based on: {(r.files ?? []).join(', ')}</div>}
            <button
              type="button"
              className="is-btn is-btn-sm"
              disabled={added.has('effort')}
              onClick={async () => {
                await edit
                  .mutateAsync({ id: idea.id, effortGuess: `${r.effort} (AI estimate)`, ai: true })
                  .catch(oops('Could not save'));
                mark('effort');
              }}
            >
              {added.has('effort') ? 'Saved' : 'Use as effort guess'}
            </button>
          </div>
          {footer}
        </>
      );
    }
    if (r.kind === 'exists') {
      return (
        <>
          <div className="is-draft">
            <div className="is-label">What already exists</div>
            <p>{r.summary || 'Nothing close was found.'}</p>
            {(r.items ?? []).map((i) => (
              <div key={i.id} className="is-draft-item">
                <button
                  type="button"
                  className="is-link"
                  onClick={() =>
                    i.kind === 'idea' ? onOpenIdea(i.id) : i.kind === 'ticket' ? onOpenTicket(i.id) : undefined
                  }
                >
                  {i.title}
                </button>{' '}
                <span className="is-muted">
                  {i.kind} {i.kind !== 'doc' ? i.id : ''} · {Math.round(i.score * 100)}% similar
                </span>
                <div>{i.why}</div>
              </div>
            ))}
          </div>
          {footer}
        </>
      );
    }
    return (
      <>
        <div className="is-draft">
          <MarkdownRenderer docs={idea.projectId ? { projectId: idea.projectId } : undefined}>
            {r.answer ?? ''}
          </MarkdownRenderer>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="is-btn is-btn-sm"
              onClick={async () => {
                await addComment.mutateAsync({ id: idea.id, body: r.answer ?? '' }).catch(oops('Could not post'));
                toast.success('Posted to comments');
              }}
            >
              Post to comments
            </button>
            <button
              type="button"
              className="is-btn is-btn-sm"
              disabled={added.has(`log${turn.id}`) || idea.stage === 'archived' || idea.stage === 'shipped'}
              onClick={async () => {
                await addLog
                  .mutateAsync({ id: idea.id, kind: 'research', body: r.answer ?? '', ai: true })
                  .catch(oops('Could not save to the log'));
                mark(`log${turn.id}`);
              }}
            >
              {added.has(`log${turn.id}`) ? 'Saved to the log' : 'Save to log'}
            </button>
          </div>
        </div>
        {footer}
      </>
    );
  }

  const open = status?.state === 'on';

  return (
    <aside
      className={`is-ai-panel ${sizing.className}`}
      style={sizing.style}
      aria-label="Shape with AI"
      data-testid="shape-panel"
    >
      <PanelResizer panel={panel} label="Resize Shape with AI" />
      <header className="is-ai-head">
        <IdeaIcon name="sparkle" size={15} color="#6D5DD3" />
        <b>Shape with AI</b>
        {status?.member && <span className="is-muted">{status.member}</span>}
        <span style={{ flex: 1 }} />
        <PanelMaxButton panel={panel} className="is-btn is-btn-ghost is-btn-sm" />
        <button type="button" className="is-btn is-btn-ghost is-btn-sm" onClick={onClose} aria-label="Close">
          <LineIcon name="close" size={14} />
        </button>
      </header>
      {status && !open && <AiUnavailable status={status} onOpenSettings={onOpenSettings} />}
      {status?.limited && open && (
        <div className="is-banner" role="status">
          <div>
            <b>AI help is limited.</b> This idea has no project: it can read ideas and workspace Docs, but there is no
            repository to look at, so no effort guess. Choose a project to get the full help.
          </div>
        </div>
      )}
      <div className="is-ai-body">
        {open && (
          <div className="is-reading" data-testid="shape-reading">
            <span className="is-muted">Reading:</span>
            <span className="is-read-chip">
              <BulbIcon size={11} /> This idea
            </span>
            {idea.commentCount > 0 && (
              <span className="is-read-chip">
                <IdeaIcon name="comment" size={11} /> {idea.commentCount}{' '}
                {idea.commentCount === 1 ? 'comment' : 'comments'}
              </span>
            )}
            <span className="is-read-chip">
              <IdeaIcon name="doc" size={11} /> related Docs and tickets
            </span>
            {status?.settings.readRepo && !status.limited && (
              <span className="is-read-chip">
                <IdeaIcon name="branch" size={11} /> repo (read only)
              </span>
            )}
          </div>
        )}
        {turns.length === 0 && open && (
          <div data-testid="shape-empty">
            <p className="is-muted">Anything it proposes is a draft; you add what you want.</p>
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className="is-turn">
            <div className="is-turn-you">{t.question ?? t.title}</div>
            {t.result ? (
              renderResult(t)
            ) : t.stopped ? (
              <div className="is-working" data-testid="shape-stopped">
                <span className="is-grow is-muted">{t.error}</span>
                <button
                  type="button"
                  className="is-btn is-btn-sm"
                  onClick={() => run(t.kind, t.title, t.question, t.id)}
                >
                  Try again
                </button>
              </div>
            ) : t.error ? (
              <div className="is-banner is-banner-risk" role="alert">
                <div style={{ flex: 1 }}>
                  <b>The AI could not answer.</b> {t.error} Nothing was changed.
                </div>
                <button
                  type="button"
                  className="is-btn is-btn-sm"
                  onClick={() => run(t.kind, t.title, t.question, t.id)}
                >
                  Try again
                </button>
              </div>
            ) : (
              <div className="is-working" aria-live="polite">
                <span className="is-spin" aria-hidden="true" />
                <span className="is-grow">
                  Reading the idea… <AiChip />
                </span>
                <Elapsed />
                {/* the cost is known only when the answer comes back (a run reports it at its end): it is shown on
                    the draft, never guessed here */}
                {t.requestId && (
                  <button
                    type="button"
                    className="is-btn is-btn-sm"
                    data-testid="shape-stop"
                    onClick={() => void stop(t.requestId!)}
                  >
                    Stop
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      {open && (
        <form
          className="is-ai-input"
          onSubmit={(e) => {
            e.preventDefault();
            if (!question.trim()) return;
            void run('ask', question.trim(), question.trim());
            setQuestion('');
          }}
        >
          {turns.length === 0 && (
            <div className="is-starter-chips">
              {STARTERS.filter((s) => s.kind !== 'effort' || (!status?.limited && status?.settings.readRepo)).map(
                (s) => (
                  <button
                    key={s.kind}
                    type="button"
                    className="is-starter-chip"
                    title={s.label}
                    onClick={() => run(s.kind, s.label)}
                  >
                    {s.label}
                  </button>
                ),
              )}
              {idea.assumptions.some((a) => a.state !== 'validated') && (
                <button
                  type="button"
                  className="is-starter-chip"
                  onClick={() => run('tests', 'Cheapest test for each assumption')}
                >
                  Cheapest test for each assumption
                </button>
              )}
            </div>
          )}
          <div className="is-ai-inrow">
            <input
              className="is-input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask about this idea…"
              aria-label="Ask about this idea"
            />
            <button type="submit" className="is-send" aria-label="Send" disabled={!question.trim()}>
              <LineIcon name="send" size={15} />
            </button>
          </div>
          <div className="is-muted" style={{ fontSize: 11.5 }}>
            Suggestions are drafts · Enter sends
          </div>
        </form>
      )}
    </aside>
  );
}

/** Seconds since the work started ("12 s"), while the AI is reading. */
function Elapsed() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="is-muted">{Math.round((now - start) / 1000)} s</span>;
}

/** The card of the idea page's right rail that opens the chat. Hidden while AI help is off. */
export function AiRailCard({ idea, onOpen }: { idea: Idea; onOpen: () => void }) {
  const status = useIdeaAiStatus(idea.projectId).data;
  if (!status || status.state === 'off') return null;
  return (
    <section className="is-rail-card" data-testid="ai-rail-card">
      <div className="is-label">AI help</div>
      <p className="is-muted" style={{ margin: '4px 0 8px' }}>
        {status.state === 'on'
          ? `Chat with ${status.member ?? 'the Idea AI'} about this idea. It drafts the problem, assumptions and tests; you add what you want.`
          : status.message}
      </p>
      <button type="button" className="is-btn is-btn-sm" onClick={onOpen} disabled={status.state !== 'on'}>
        Open chat
      </button>
    </section>
  );
}

/** The "Shape with AI" button of the page header; nothing is drawn while AI help is off. */
export function ShapeButton({
  projectId,
  onClick,
  active,
}: {
  projectId: string | null;
  onClick: () => void;
  active: boolean;
}): ReactNode {
  const status = useIdeaAiStatus(projectId).data;
  if (!status || status.state === 'off') return null;
  return (
    <button
      type="button"
      className="is-btn is-btn-ai"
      aria-pressed={active}
      onClick={onClick}
      data-testid="shape-button"
    >
      <span aria-hidden="true">
        <LineIcon name="sparkle" size={12} />
      </span>{' '}
      Shape with AI
    </button>
  );
}
