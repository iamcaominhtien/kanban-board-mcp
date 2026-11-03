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
  type AskAction,
  type AskResult,
  type IdeaAdvice,
} from '../../api/ideaAi';
import { ideaRuleError, useCreateTestTicket, useMergeIdea, useMoveIdea } from '../../api/ideas';
import { FooterNote, ModalShell, Spacer } from '../docs/docsShared';
import { dateIn } from './ideaShared';
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
const VERB: Record<IdeaAdvice['action'], string> = {
  keep: 'Keep',
  park: 'Park',
  merge: 'Merge',
  archive: 'Archive',
  none: 'No suggestion',
};
/** What "Accept …" in the summary row takes in one go (IAI-1); archive is always one by one. */
const BULK: IdeaAdvice['action'][] = ['keep', 'merge', 'park'];

/** "Merge and Park", "Keep, Merge and Park". */
function joinVerbs(actions: IdeaAdvice['action'][]): string {
  const words = BULK.filter((a) => actions.includes(a)).map((a) => VERB[a]);
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : (words[0] ?? '');
}

/** One line of the bulk accept confirmation: what will happen to the idea. */
function moveLine(a: IdeaAdvice, title: string): string {
  if (a.action === 'merge') return `Merge “${title}” into “${a.targetTitle ?? a.targetId}”`;
  if (a.action === 'park') return `Park “${title}” until ${dateIn(a.parkDays ?? 30)}`;
  return `Keep “${title}”: it moves to Exploring`;
}

/**
 * "Accept Merge and Park": one confirmation that lists every move, then each move is made as its own dialog would
 * (IAI-1). It is an extra action: the Accept of each row still opens that row's dialog.
 */
function BulkAcceptDialog({
  items,
  titles,
  onClose,
}: {
  items: IdeaAdvice[];
  titles: Record<string, string>;
  onClose: () => void;
}) {
  const toast = useToast();
  const move = useMoveIdea();
  const merge = useMergeIdea();
  const state = useAdviceState();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const title = (a: IdeaAdvice) => titles[a.ideaId] ?? a.ideaId;

  async function accept() {
    setBusy(true);
    const failed: string[] = [];
    let done = 0;
    for (const a of items) {
      try {
        if (a.action === 'merge' && a.targetId) await merge.mutateAsync({ id: a.ideaId, intoId: a.targetId });
        else if (a.action === 'park')
          await move.mutateAsync({ id: a.ideaId, to: 'parked', parkUntil: dateIn(a.parkDays ?? 30), via: 'Park' });
        else await move.mutateAsync({ id: a.ideaId, to: 'exploring', via: 'Keep' });
        state.mutate({ id: a.id, state: 'accepted' });
        done += 1;
      } catch (e) {
        failed.push(`${title(a)}: ${ideaRuleError(e).message}`);
      }
    }
    setBusy(false);
    if (done) toast.success(`Accepted ${done} suggestion${done === 1 ? '' : 's'}`);
    if (failed.length) setErrors(failed);
    else onClose();
  }

  return (
    <ModalShell
      width={460}
      ariaLabel="Accept these suggestions"
      title={`Accept ${joinVerbs(items.map((a) => a.action))}?`}
      subtitle="Each move is made as its own dialog would make it. Archive is always one by one."
      onClose={onClose}
      footer={
        <>
          {errors.length > 0 && <FooterNote>{errors.join(' · ')}</FooterNote>}
          <Spacer />
          <button type="button" className="is-btn" onClick={onClose}>
            {errors.length ? 'Close' : 'Cancel'}
          </button>
          {!errors.length && (
            <button
              type="button"
              className="is-btn is-btn-primary"
              onClick={accept}
              disabled={busy}
              data-testid="bulk-accept-confirm"
            >
              Accept {items.length} move{items.length === 1 ? '' : 's'}
            </button>
          )}
        </>
      }
    >
      <ul className="is-root is-dlg-body" data-testid="bulk-accept-moves" style={{ margin: 0, paddingLeft: 32 }}>
        {items.map((a) => (
          <li key={a.id} style={{ padding: '3px 0' }}>
            {moveLine(a, title(a))}
            <div className="is-muted">{a.reason}</div>
          </li>
        ))}
      </ul>
    </ModalShell>
  );
}

/**
 * The summary row at the top of the Inbox list: ask the AI to read the new ideas and suggest what to do with each. It
 * never presses a button; "Accept" on a row opens the same dialog a person would use.
 */
export function AdviceBar({
  projectId,
  ideaIds,
  onOpenSettings,
  titles = {},
}: {
  projectId: string | null;
  ideaIds: string[];
  onOpenSettings?: () => void;
  /** Idea titles by id, for the moves listed by "Accept Merge and Park". */
  titles?: Record<string, string>;
}) {
  const toast = useToast();
  const status = useIdeaAiStatus(projectId).data;
  const advice = useIdeaAdvice(ideaIds, !!status?.settings.triageAdvice && status.state === 'on', true);
  const request = useRequestAdvice();
  const [bulk, setBulk] = useState(false);
  if (!status || status.state === 'off' || !status.settings.triageAdvice) return null;
  if (status.state !== 'on') return <AiUnavailable status={status} onOpenSettings={onOpenSettings} />;
  const open = (advice.data ?? []).filter((a) => a.action !== 'none');
  const bulkItems = open.filter((a) => BULK.includes(a.action) && !a.stale && (a.action !== 'merge' || a.targetId));

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
      {bulkItems.length > 0 && (
        <button type="button" className="is-btn is-btn-sm" onClick={() => setBulk(true)} data-testid="bulk-accept">
          <IdeaIcon name="check" size={13} />
          Accept {joinVerbs(bulkItems.map((a) => a.action))}
        </button>
      )}
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
      {bulk && <BulkAcceptDialog items={bulkItems} titles={titles} onClose={() => setBulk(false)} />}
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
  const all = useIdeaAdvice(ideaIds, on, true).data?.filter((a) => a.ideaId === ideaId) ?? [];
  const advice = all.find((a) => a.action !== 'none');
  const notSure = all.find((a) => a.action === 'none');
  const state = useAdviceState();
  if (!on) return null;
  if (!advice && notSure) {
    // the AI read it and had no suggestion (IAI-1): said so, nothing to accept
    return (
      <div className="is-row-advice" data-testid={`row-advice-${ideaId}`}>
        <div className="is-row-advice-head">
          <span className="is-grow" />
          <span className="is-muted" title={notSure.reason || undefined} data-testid={`row-not-sure-${ideaId}`}>
            No suggestion: not sure
          </span>
        </div>
      </div>
    );
  }
  if (!advice) return null;
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
  const [turns, setTurns] = useState<{ id: number; q: string; a?: AskResult; error?: string }[]>([]);
  const [creating, setCreating] = useState<AskAction | null>(null);

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
                {(t.a.actions ?? []).length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }} data-testid="ask-actions">
                    {(t.a.actions ?? []).map((act) =>
                      act.kind === 'create_test_ticket' ? (
                        <button
                          key={`t-${act.ideaId}-${act.assumptionId}`}
                          type="button"
                          className="is-btn is-btn-sm"
                          title={act.assumptionText}
                          onClick={() => setCreating(act)}
                        >
                          <IdeaIcon name="flask" size={13} />
                          Create test ticket
                        </button>
                      ) : (
                        <button
                          key={`o-${act.ideaId}`}
                          type="button"
                          className="is-btn is-btn-sm"
                          title={`${act.ideaId} · ${act.ideaTitle}`}
                          onClick={() => onOpenIdea(act.ideaId)}
                        >
                          <LineIcon name="external" size={13} />
                          Open the idea
                        </button>
                      ),
                    )}
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
            void send(q.trim());
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
      {creating && <CreateTestTicketDialog action={creating} onClose={() => setCreating(null)} />}
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

/**
 * "Create test ticket" from an Ask answer (IAI-3): the usual test ticket of an assumption, filled in with what the
 * answer suggested. Nothing is created until the person presses Create; the title can be changed first.
 */
export function CreateTestTicketDialog({ action, onClose }: { action: AskAction; onClose: () => void }) {
  const toast = useToast();
  const create = useCreateTestTicket();
  const [title, setTitle] = useState(action.title ?? `Test: ${action.assumptionText ?? ''}`);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!action.assumptionId || !title.trim()) return;
    setError(null);
    try {
      const res = await create.mutateAsync({
        id: action.ideaId,
        assumptionId: action.assumptionId,
        title: title.trim(),
      });
      toast.success(
        `Created ${res.ticket.id}`,
        'It tests this assumption. When it is Done you are asked what it showed.',
      );
      onClose();
    } catch (e) {
      setError(ideaRuleError(e).message);
    }
  }

  return (
    <ModalShell
      width={440}
      ariaLabel="Create a test ticket"
      title="Create a test ticket"
      subtitle={`For “${action.ideaTitle}”. Filled in from the answer; change what you want.`}
      onClose={onClose}
      footer={
        <>
          {error && <FooterNote>{error}</FooterNote>}
          <Spacer />
          <button type="button" className="is-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="is-btn is-btn-primary"
            onClick={submit}
            disabled={create.isPending || !title.trim()}
            data-testid="create-test-confirm"
          >
            Create
          </button>
        </>
      }
    >
      <div className="is-root is-dlg-body" style={{ flex: 'none', background: 'transparent' }}>
        <label className="is-field">
          <span className="is-label">Title</span>
          <input
            className="is-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Title"
            maxLength={200}
          />
        </label>
        <div className="is-field">
          <span className="is-label">Tests the assumption</span>
          <span>{action.assumptionText}</span>
        </div>
      </div>
    </ModalShell>
  );
}
