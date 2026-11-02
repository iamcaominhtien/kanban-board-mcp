import { useState } from 'react';
import {
  useAdviceState,
  useAskIdeas,
  useIdeaAdvice,
  useIdeaAiStatus,
  useIdeaDigest,
  useRequestAdvice,
  useRunDigest,
  useUpdateIdeaAiSettings,
  type IdeaAdvice,
} from '../../api/ideaAi';
import { ideaRuleError } from '../../api/ideas';
import type { IdeaScope } from '../../types/idea';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { relativeTime } from '../../utils/relativeTime';
import { useToast } from '../Toast';
import { AiUnavailable } from './IdeaAiPanel';
import { AiChip, BulbIcon } from './ideaShared';
import type { Decision } from './useIdeaMoves';
import { LineIcon } from '../ui/LineIcon';
import { IdeaIcon, type IdeaIconName } from './ideaIcons';

const money = (n: number) => (n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);
const VERB: Record<IdeaAdvice['action'], string> = { keep: 'Keep', park: 'Park', merge: 'Merge', archive: 'Archive' };

/**
 * The summary row at the top of the Inbox list: ask the AI to read the new ideas and suggest what to do with each. It
 * never presses a button; "Accept" on a row opens the same dialog a person would use.
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
    <div className="is-advice-sum" data-testid="advice-bar">
      <IdeaIcon name="sparkle" size={14} color="#6D5DD3" />
      <div className="is-grow">
        {open.length > 0 ? (
          <>
            <span className="is-advice-n">
              {open.length} suggestion{open.length === 1 ? '' : 's'}
            </span>{' '}
            {status.member ?? 'The AI'} read the {ideaIds.length} new ideas. You decide; archive is always one by one.
          </>
        ) : (
          `${status.member ?? 'The AI'} can read the ${ideaIds.length} new ideas and suggest Keep, Park, Merge or Archive.`
        )}
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

/** "AI advice is on for this project" and its switch, in the triage header (the same setting as Settings › Idea Space). */
export function AdviceSwitch({ projectId }: { projectId: string | null }) {
  const status = useIdeaAiStatus(projectId).data;
  const update = useUpdateIdeaAiSettings(projectId);
  const toast = useToast();
  if (!projectId || !status || !status.settings.enabled) return null;
  const on = status.settings.triageAdvice;
  return (
    <label className="is-advice-switch">
      <span className="is-muted">AI advice is {on ? 'on' : 'off'} for this project</span>
      <input
        type="checkbox"
        role="switch"
        checked={on}
        disabled={update.isPending}
        aria-label="AI advice in triage"
        data-testid="advice-switch"
        onChange={(e) =>
          update.mutate(
            { triageAdvice: e.target.checked },
            { onError: (err) => toast.error('Could not change the setting', ideaRuleError(err).message) },
          )
        }
      />
    </label>
  );
}

/** The advice for one Inbox row: what to do, why, how sure; Accept opens the same dialog as the key would. */
export function RowAdvice({
  projectId,
  ideaId,
  ideaIds,
  onAccept,
}: {
  projectId: string | null;
  ideaId: string;
  /** All the ids of the list, so this reads the same cached advice as the summary row. */
  ideaIds: string[];
  onAccept: (decision: Decision, advice: IdeaAdvice) => void;
}) {
  const status = useIdeaAiStatus(projectId).data;
  const on = !!status?.settings.triageAdvice && status.state === 'on';
  const advice = useIdeaAdvice(ideaIds, on).data?.find((a) => a.ideaId === ideaId);
  const state = useAdviceState();
  if (!on || !advice) return null;
  return (
    <div className="is-row-advice" data-testid={`row-advice-${ideaId}`}>
      <div className="is-row-advice-head">
        <span className="is-grow is-row-advice-reason">{advice.reason}</span>
        <span className="is-advice-chip">
          <IdeaIcon name="sparkle" size={11} />
          {VERB[advice.action]}
        </span>
      </div>
      <div className="is-row-advice-foot">
        <span className="is-muted">
          Confidence: <b>{advice.confidence[0].toUpperCase() + advice.confidence.slice(1)}</b>
        </span>
        <span className="is-grow" />
        {!advice.stale && (
          <button
            type="button"
            className="is-btn is-btn-sm"
            onClick={() => onAccept(advice.action as Decision, advice)}
          >
            <IdeaIcon name="check" size={13} />
            Accept
          </button>
        )}
        <button
          type="button"
          className="is-btn is-btn-sm"
          onClick={() => state.mutate({ id: advice.id, state: 'ignored' })}
        >
          Ignore
        </button>
      </div>
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
    <div className="is-ask is-advice-card" data-testid="advice-card">
      <div className="is-comment-head">
        <IdeaIcon name="sparkle" size={14} color="#6D5DD3" />
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
    <aside className="is-ai-panel is-ai-panel-docked" aria-label="Ask about ideas" data-testid="ask-panel">
      <header className="is-ai-head">
        <IdeaIcon name="sparkle" size={15} color="#6D5DD3" />
        <b>Ask about ideas</b>
        {status?.member && <span className="is-muted">{status.member}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" className="is-btn is-btn-ghost is-btn-sm" onClick={onClose} aria-label="Close">
          <LineIcon name="close" size={14} />
        </button>
      </header>
      {status && status.state !== 'on' && <AiUnavailable status={status} onOpenSettings={onOpenSettings} />}
      {status?.state === 'on' && !status.settings.ask && (
        <div className="is-banner">Ask about ideas is turned off for this project.</div>
      )}
      <div className="is-ai-body">
        {turns.length === 0 && on && (
          <div className="is-muted">
            Ask about the ideas in this view. Answers list the ideas they used, and nothing is changed.
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className="is-turn">
            <div className="is-turn-you">{t.q}</div>
            {t.a ? (
              <>
                <MarkdownRenderer docs={projectId ? { projectId } : undefined}>{t.a.answer}</MarkdownRenderer>
                {t.a.sources.length > 0 && (
                  <div className="is-source-chips">
                    {t.a.sources.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="is-source-chip"
                        onClick={() => onOpenIdea(s.id)}
                        title={`${s.id} · ${s.title}`}
                      >
                        <BulbIcon size={12} />
                        <span className="is-source-chip-t">{s.title || s.id}</span>
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
          {turns.length === 0 && (
            <div className="is-starter-chips">
              {ASK_STARTERS.map((s) => (
                <button key={s} type="button" className="is-starter-chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
          <div className="is-ai-inrow">
            <input
              className="is-input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ask about your ideas…"
              aria-label="Ask about your ideas"
            />
            <button type="submit" className="is-send" aria-label="Send" disabled={!q.trim()}>
              <LineIcon name="send" size={15} />
            </button>
          </div>
          <div className="is-muted" style={{ fontSize: 11.5 }}>
            About {money(status?.hints.ask ?? 0.01)} per question · Enter sends
          </div>
        </form>
      )}
    </aside>
  );
}

const DIGEST_ICONS: Record<string, IdeaIconName> = {
  stale: 'clock',
  merge: 'merge',
  tests: 'flask',
  parked: 'calendar',
  waiting: 'inbox',
};

/** "2 ideas are stale (…): A, B." → the count in bold, the rest as written. */
function DigestLine({ text }: { text: string }) {
  const m = /^(\d+ (?:ideas?|pairs?|tests?|parked ideas?))(.*)$/s.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      <b>{m[1]}</b>
      {m[2]}
    </>
  );
}

/** The sentence the AI added under the findings, if any (the digest text ends with it after a blank line). */
function digestNote(text: string): string | null {
  const parts = text.trim().split(/\n\s*\n/);
  const last = parts[parts.length - 1]?.trim() ?? '';
  return parts.length > 1 && !last.startsWith('- ') && !last.startsWith('**Weekly digest**') ? last : null;
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

  const writeNow = (
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
  );
  const hide = (
    <button type="button" className="is-btn is-btn-ghost is-btn-sm" onClick={() => setHidden(true)}>
      Hide
    </button>
  );

  if (!digest) {
    return (
      <div className="is-digest is-digest-slim" data-testid="digest-card">
        <span className="is-digest-chip">
          <IdeaIcon name="sparkle" size={12} />
          Weekly digest
        </span>
        <span className="is-grow">
          <b>Weekly grooming is on.</b> The first digest is written on Monday at 9:00, or now.
        </span>
        {writeNow}
        {hide}
      </div>
    );
  }

  const note = digestNote(digest.text);
  const created = new Date(digest.createdAt);
  const when = `${created.toLocaleDateString('en-GB', { weekday: 'long' })} ${created.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
  return (
    <div className="is-digest" data-testid="digest-card">
      <div className="is-digest-head">
        <span className="is-digest-chip">
          <IdeaIcon name="sparkle" size={12} />
          Weekly digest
        </span>
        <span className="is-muted" title={relativeTime(digest.createdAt)}>
          {when}
          {digest.ai ? ` · ${money(digest.cost)}` : ' · no AI cost'} · read {digest.ideasRead} ideas
        </span>
        {digest.ai && <AiChip />}
        <span className="is-grow" />
        {onOpenInbox && (
          <button type="button" className="is-btn is-btn-sm" onClick={onOpenInbox}>
            Open Inbox
          </button>
        )}
        {writeNow}
        {hide}
      </div>
      {digest.items.length === 0 && <div className="is-digest-row">Nothing needs attention this week.</div>}
      {digest.items.map((item) => {
        const toInbox = item.kind === 'parked' || item.kind === 'waiting';
        return (
          <div key={item.kind} className="is-digest-row">
            <IdeaIcon name={DIGEST_ICONS[item.kind] ?? 'info'} size={15} color="#7A5A06" />
            <span className="is-grow">
              <DigestLine text={item.text} />
              {onOpenIdea &&
                item.ideaIds.slice(0, 8).map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="is-link is-mono is-digest-id"
                    onClick={() => onOpenIdea(id)}
                  >
                    {id}
                  </button>
                ))}
            </span>
            {toInbox && onOpenInbox ? (
              <button type="button" className="is-btn is-btn-sm" onClick={onOpenInbox}>
                Open Inbox
              </button>
            ) : (
              item.ideaIds.length > 0 &&
              onOpenIdea && (
                <button type="button" className="is-btn is-btn-sm" onClick={() => onOpenIdea(item.ideaIds[0])}>
                  Review
                </button>
              )
            )}
          </div>
        );
      })}
      {note && (
        <div className="is-digest-note">
          <MarkdownRenderer docs={projectId ? { projectId } : undefined}>{note}</MarkdownRenderer>
        </div>
      )}
      <div className="is-digest-foot">
        Shown on the Idea Space home and in the Inbox. A digest is not a notification; nobody is pinged.
      </div>
    </div>
  );
}
