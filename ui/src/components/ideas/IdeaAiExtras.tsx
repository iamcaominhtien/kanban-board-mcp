import { useState } from 'react';
import {
  useAdviceState,
  useAskIdeas,
  useIdeaAdvice,
  useIdeaAiStatus,
  useIdeaDigest,
  useRequestAdvice,
  useRunDigest,
  type IdeaAdvice,
} from '../../api/ideaAi';
import { ideaRuleError } from '../../api/ideas';
import type { IdeaScope } from '../../types/idea';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { relativeTime } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { AiUnavailable } from './IdeaAiPanel';
import { AiChip } from './ideaShared';
import type { Decision } from './useIdeaMoves';

const money = (n: number) => (n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const VERB: Record<IdeaAdvice['action'], string> = { keep: 'Keep', park: 'Park', merge: 'Merge', archive: 'Archive' };

/**
 * The strip above the Inbox: ask the AI to read the new ideas and suggest what to do with each. It never presses a
 * button; "Accept" opens the same dialog a person would use.
 */
export function AdviceBar({
  projectId,
  ideaIds,
  onOpenSettings,
}: {
  projectId: string | null;
  ideaIds: string[];
  onOpenSettings?: () => void;
}) {
  const toast = useToast();
  const status = useIdeaAiStatus(projectId).data;
  const advice = useIdeaAdvice(ideaIds, !!status?.settings.triageAdvice && status.state === 'on');
  const request = useRequestAdvice();
  if (!status || status.state === 'off' || !status.settings.triageAdvice) return null;
  if (status.state !== 'on') return <AiUnavailable status={status} onOpenSettings={onOpenSettings} />;
  const open = advice.data ?? [];

  async function ask() {
    try {
      const res = await request.mutateAsync(ideaIds);
      const quiet = res.none.length;
      toast.info(
        `${res.advice.length} suggestion${res.advice.length === 1 ? '' : 's'}`,
        quiet ? `${quiet} left to you: the AI was not sure.` : undefined,
      );
    } catch (e) {
      toast.error('The AI suggestion could not be made', `${ideaRuleError(e).message} The ideas were not changed.`);
    }
  }

  return (
    <div className="is-banner is-banner-ai" style={{ marginBottom: 12 }} data-testid="advice-bar">
      <div style={{ flex: 1 }}>
        <b>AI advice is on for this project.</b>{' '}
        {open.length > 0
          ? `${open.length} suggestion${open.length === 1 ? '' : 's'} for ${ideaIds.length} ideas. You decide; archive is always one by one.`
          : `${status.member ?? 'The AI'} can read the ${ideaIds.length} new ideas and suggest Keep, Park, Merge or Archive.`}
      </div>
      <button
        type="button"
        className="is-btn is-btn-sm"
        onClick={ask}
        disabled={request.isPending || ideaIds.length === 0}
      >
        {request.isPending
          ? 'Reading…'
          : open.length
            ? 'Ask again'
            : `Get advice · about ${money(status.hints.advice * ideaIds.length)}`}
      </button>
    </div>
  );
}

/** The advice for the idea in focus: what to do, why, how sure it is; Accept does what a person would with one key. */
export function AdviceCard({
  projectId,
  ideaId,
  onAccept,
  onNotSure,
}: {
  projectId: string | null;
  ideaId: string;
  onAccept: (decision: Decision, advice: IdeaAdvice) => void;
  onNotSure?: () => void;
}) {
  const status = useIdeaAiStatus(projectId).data;
  const advice = useIdeaAdvice([ideaId], !!status?.settings.triageAdvice && status.state === 'on').data?.[0];
  const state = useAdviceState();
  const request = useRequestAdvice();
  const [why, setWhy] = useState(false);
  if (!status?.settings.triageAdvice || status.state === 'off' || !advice) return null;
  const decision = advice.action as Decision;
  return (
    <div className="is-ask" data-testid="advice-card">
      <div className="is-comment-head">
        <AiChip />
        <b>
          {VERB[advice.action]}
          {advice.action === 'merge' && advice.targetId ? ` into ${advice.targetId}` : ''}
          {advice.action === 'park' && advice.parkDays ? ` for ${advice.parkDays} days` : ''}
        </b>
        <span className="is-muted">Confidence: {advice.confidence[0].toUpperCase() + advice.confidence.slice(1)}</span>
      </div>
      <div>{advice.reason}</div>
      {advice.stale ? (
        <div className="is-banner is-banner-warn" style={{ marginTop: 8 }}>
          <div style={{ flex: 1 }}>
            <b>This idea changed since the advice.</b> The idea was edited after the AI read it. Ask again before
            accepting.
          </div>
          <button type="button" className="is-btn is-btn-sm" onClick={() => request.mutate([ideaId])}>
            Ask again
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button type="button" className="is-btn is-btn-sm is-btn-primary" onClick={() => onAccept(decision, advice)}>
            {advice.action === 'merge' ? 'Merge into it' : 'Accept'}
          </button>
          <button
            type="button"
            className="is-btn is-btn-sm"
            onClick={() => {
              state.mutate({ id: advice.id, state: 'ignored' });
              onNotSure?.();
            }}
          >
            {advice.action === 'merge' ? 'Not the same' : 'Ignore'}
          </button>
          <button type="button" className="is-link" onClick={() => setWhy(!why)}>
            Why {status.member ?? 'the AI'} suggests {VERB[advice.action]}
          </button>
        </div>
      )}
      {why && (
        <div className="is-muted" style={{ marginTop: 6 }}>
          {advice.reason} · {money(advice.cost)} · {relativeTime(advice.createdAt)}
        </div>
      )}
    </div>
  );
}

/** Marks advice accepted once the person did it. */
export function useAcceptAdvice() {
  const state = useAdviceState();
  return (id: string) => state.mutate({ id, state: 'accepted' });
}

const ASK_STARTERS = ['What should we test next?', 'Which ideas are stale?', 'What is ready to promote?'];

/** "Ask about ideas": a side panel; the answer always lists the ideas it used. */
export function AskPanel({
  projectId,
  scope,
  onClose,
  onOpenIdea,
  onOpenSettings,
}: {
  projectId?: string;
  scope: IdeaScope;
  onClose: () => void;
  onOpenIdea: (id: string) => void;
  onOpenSettings?: () => void;
}) {
  const status = useIdeaAiStatus(projectId ?? null).data;
  const ask = useAskIdeas();
  const [q, setQ] = useState('');
  const [turns, setTurns] = useState<
    {
      id: number;
      q: string;
      a?: { answer: string; sources: { id: string; title: string }[]; ideasRead: number; cost: number; member: string };
      error?: string;
    }[]
  >([]);

  async function send(text: string) {
    const id = Date.now();
    setTurns((t) => [...t, { id, q: text }]);
    try {
      const a = await ask.mutateAsync({ question: text, projectId, scope });
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, a } : x)));
    } catch (e) {
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: ideaRuleError(e).message } : x)));
    }
  }

  const on = status?.state === 'on' && status.settings.ask;
  return (
    <aside className="is-ai-panel" aria-label="Ask about ideas" data-testid="ask-panel">
      <header className="is-ai-head">
        <b>Ask about ideas</b>
        {status?.member && <span className="is-muted">{status.member}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" className="is-btn is-btn-ghost is-btn-sm" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {status && status.state !== 'on' && <AiUnavailable status={status} onOpenSettings={onOpenSettings} />}
      {status?.state === 'on' && !status.settings.ask && (
        <div className="is-banner">Ask about ideas is turned off for this project.</div>
      )}
      <div className="is-ai-body">
        {turns.length === 0 &&
          on &&
          ASK_STARTERS.map((s) => (
            <button key={s} type="button" className="is-starter" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        {turns.map((t) => (
          <div key={t.id} className="is-turn">
            <div className="is-turn-you">{t.q}</div>
            {t.a ? (
              <>
                <MarkdownRenderer>{t.a.answer}</MarkdownRenderer>
                {t.a.sources.length > 0 && (
                  <div className="is-row-sub">
                    {t.a.sources.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="is-link"
                        onClick={() => onOpenIdea(s.id)}
                        title={s.title}
                      >
                        {s.id}
                      </button>
                    ))}
                  </div>
                )}
                <div className="is-muted" style={{ marginTop: 4, fontSize: 11.5 }}>
                  Read {t.a.ideasRead} ideas · {money(t.a.cost)}. Answers can be wrong; check the sources.
                </div>
              </>
            ) : t.error ? (
              <div className="is-banner is-banner-risk" role="alert">
                <div style={{ flex: 1 }}>
                  <b>The AI could not answer.</b> {t.error} Nothing was changed.
                </div>
                <button type="button" className="is-btn is-btn-sm" onClick={() => send(t.q)}>
                  Try again
                </button>
              </div>
            ) : (
              <div className="is-muted">Reading the ideas…</div>
            )}
          </div>
        ))}
      </div>
      {on && (
        <form
          className="is-ai-input"
          onSubmit={(e) => {
            e.preventDefault();
            if (!q.trim()) return;
            send(q.trim());
            setQ('');
          }}
        >
          <input
            className="is-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ask about your ideas…"
            aria-label="Ask about your ideas"
          />
          <div className="is-muted" style={{ fontSize: 11.5 }}>
            About {money(status?.hints.ask ?? 0.01)} per question · Enter sends
          </div>
        </form>
      )}
    </aside>
  );
}

/** The weekly digest, shown on the Idea Space home and in the Inbox. A digest is not a notification. */
export function DigestCard({
  projectId,
  onOpenInbox,
  onOpenIdea,
}: {
  projectId: string | null;
  onOpenInbox?: () => void;
  onOpenIdea?: (id: string) => void;
}) {
  const toast = useToast();
  const status = useIdeaAiStatus(projectId).data;
  const digest = useIdeaDigest(projectId).data;
  const run = useRunDigest(projectId);
  const [hidden, setHidden] = useState(false);
  if (!status || (!digest && !status.settings.weeklyGrooming)) return null;
  const week = digest && Date.now() - new Date(digest.createdAt).getTime() < 8 * 86400000;
  if (hidden || (digest && !week)) return null;

  return (
    <div
      className="is-banner is-banner-ai"
      style={{ marginBottom: 12, alignItems: 'flex-start' }}
      data-testid="digest-card"
    >
      <div style={{ flex: 1 }}>
        {digest ? (
          <>
            <MarkdownRenderer>{digest.text}</MarkdownRenderer>
            <div className="is-muted" style={{ fontSize: 11.5 }}>
              {relativeTime(digest.createdAt)} · read {digest.ideasRead} ideas
              {digest.ai ? ` · ${money(digest.cost)} ` : ' · no AI cost '}
              {digest.ai && <AiChip />}
            </div>
            {digest.items.some((i) => i.ideaIds.length) && onOpenIdea && (
              <div className="is-row-sub">
                {Array.from(new Set(digest.items.flatMap((i) => i.ideaIds)))
                  .slice(0, 8)
                  .map((id) => (
                    <button key={id} type="button" className="is-link is-mono" onClick={() => onOpenIdea(id)}>
                      {id}
                    </button>
                  ))}
              </div>
            )}
          </>
        ) : (
          <div>
            <b>Weekly grooming is on.</b> The first digest is written on Monday at 9:00, or now.
          </div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {onOpenInbox && (
          <button type="button" className="is-btn is-btn-sm" onClick={onOpenInbox}>
            Open Inbox
          </button>
        )}
        <button
          type="button"
          className="is-btn is-btn-sm"
          disabled={run.isPending}
          onClick={() =>
            run.mutate(undefined, {
              onError: (e) => toast.error('Could not write the digest', ideaRuleError(e).message),
            })
          }
        >
          {run.isPending ? 'Writing…' : 'Write it now'}
        </button>
        <button type="button" className="is-btn is-btn-ghost is-btn-sm" onClick={() => setHidden(true)}>
          Hide
        </button>
      </div>
    </div>
  );
}
