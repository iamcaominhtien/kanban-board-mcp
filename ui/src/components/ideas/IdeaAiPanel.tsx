import { useState, type ReactNode } from 'react';
import { useIdeaAiStatus, useShapeIdea, type IdeaAiStatus, type ShapeResult } from '../../api/ideaAi';
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
import { useToast } from '../Toast';
import { AiChip } from './ideaShared';

const money = (n: number) => (n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

/**
 * Why AI help is not available, in the words of the design ("AI help is off", "Choose an AI member", "paused until
 * tomorrow"); null when it is on.
 */
export function AiUnavailable({ status, onOpenSettings }: { status: IdeaAiStatus; onOpenSettings?: () => void }) {
  if (status.state === 'on') return null;
  const title = {
    off: 'AI help is off',
    no_member: 'Choose an AI member to use AI help',
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

const STARTERS: { kind: ShapeResult['kind']; label: string; hint: 'shape' | 'exists' }[] = [
  { kind: 'problem', label: 'Draft the problem and the idea', hint: 'shape' },
  { kind: 'assumptions', label: 'Suggest assumptions and cheapest tests', hint: 'shape' },
  { kind: 'exists', label: 'Check what already exists', hint: 'exists' },
  { kind: 'effort', label: 'Guess the effort from the code', hint: 'shape' },
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
  const status = useIdeaAiStatus(idea.projectId).data;
  const shape = useShapeIdea();
  const edit = useEditIdeaPage();
  const addAssumption = useAddAssumption();
  const addComment = useAddComment();
  const addLog = useAddLogEntry();
  const createTest = useCreateTestTicket();
  const [turns, setTurns] = useState<
    { id: number; title: string; result?: ShapeResult; error?: string; kind: ShapeResult['kind']; question?: string }[]
  >([]);
  const [question, setQuestion] = useState('');
  const [added, setAdded] = useState<Set<string>>(new Set());

  async function run(kind: ShapeResult['kind'], title: string, q?: string, retryId?: number) {
    const id = retryId ?? Date.now();
    setTurns((t) =>
      retryId
        ? t.map((x) => (x.id === id ? { ...x, error: undefined, result: undefined } : x))
        : [...t, { id, title, kind, question: q }],
    );
    try {
      const result = await shape.mutateAsync({ ideaId: idea.id, kind, question: q });
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, result } : x)));
    } catch (e) {
      const rule = ideaRuleError(e);
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: rule.message } : x)));
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
        {r.member} · {money(r.cost)} · suggestions are drafts
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
          <MarkdownRenderer>{r.answer ?? ''}</MarkdownRenderer>
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
  const hint = (k: 'shape' | 'exists') => (status ? ` · about ${money(status.hints[k])}` : '');

  return (
    <aside className="is-ai-panel" aria-label="Shape with AI" data-testid="shape-panel">
      <header className="is-ai-head">
        <b>Shape with AI</b>
        {status?.member && <span className="is-muted">{status.member}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" className="is-btn is-btn-ghost is-btn-sm" onClick={onClose} aria-label="Close">
          ×
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
        {turns.length === 0 && open && (
          <div data-testid="shape-empty">
            <p className="is-muted">
              It reads this idea{idea.commentCount ? `, ${idea.commentCount} comments` : ''} and related Docs and
              tickets{status?.settings.readRepo ? ', and the repository (read only)' : ''}. Anything it proposes is a
              draft; you add what you want.
            </p>
            {STARTERS.filter((s) => s.kind !== 'effort' || (!status?.limited && status?.settings.readRepo)).map((s) => (
              <button key={s.kind} type="button" className="is-starter" onClick={() => run(s.kind, s.label)}>
                {s.label}
                <span className="is-muted">{hint(s.hint)}</span>
              </button>
            ))}
            {idea.assumptions.some((a) => a.state !== 'validated') && (
              <button
                type="button"
                className="is-starter"
                onClick={() => run('tests', 'Cheapest test for each assumption')}
              >
                Cheapest test for each assumption<span className="is-muted">{hint('shape')}</span>
              </button>
            )}
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className="is-turn">
            <div className="is-turn-you">{t.question ?? t.title}</div>
            {t.result ? (
              renderResult(t)
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
              <div className="is-muted" aria-live="polite">
                Reading the idea… <AiChip />
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
            run('ask', question.trim(), question.trim());
            setQuestion('');
          }}
        >
          <input
            className="is-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask about this idea…"
            aria-label="Ask about this idea"
          />
          <div className="is-muted" style={{ fontSize: 11.5 }}>
            About {money(status?.hints.ask ?? 0.01)} per answer · suggestions are drafts · Enter sends
          </div>
        </form>
      )}
    </aside>
  );
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
          ? `Chat with ${status.member ?? 'an AI member'} about this idea. It drafts the problem, assumptions and tests; you add what you want.`
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
    <button type="button" className="is-btn" aria-pressed={active} onClick={onClick} data-testid="shape-button">
      <span aria-hidden="true">✦</span> Shape with AI
    </button>
  );
}
