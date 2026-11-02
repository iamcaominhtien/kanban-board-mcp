import { useState, type ReactNode } from 'react';
import type { AiMember, AiRun } from '../../../types/ai';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { AiBadge } from '../AiThread';
import { AiAvatar, useAiBoardState } from '../aiUi';
import { addressedTo, chainOf, clock, handoffsIn, joinText, namesList, type AiLookup, type TalkRun } from './aiTalk';
import './talk.css';

function Face({ member, name, size }: { member: AiMember | undefined; name: string; size: number }) {
  if (member)
    return <AiAvatar provider={member.provider} color={member.color} glyph={member.glyph} size={size} title={name} />;
  return (
    <span className="tk-face" style={{ width: size, height: size }} title={name}>
      {name.slice(0, 2).toUpperCase()}
    </span>
  );
}

/** Two or three faces, overlapping. */
export function Faces({ names, members, size = 22 }: { names: string[]; members: AiMember[]; size?: number }) {
  return (
    <span className="tk-faces" aria-hidden="true">
      {names.slice(0, 3).map((n) => (
        <span key={n} className="tk-faces-one">
          <Face member={members.find((m) => m.name === n)} name={n} size={size} />
        </span>
      ))}
    </span>
  );
}

/**
 * A run of comments between AIs (ai-story-flow P): folded, one line that says who talked, how often, when, and that
 * nothing in it asks you; shown, the whole exchange in order with each message's addressee, the hand-offs between
 * them, and a Join in box that writes to all of them at once.
 * @param props.run - The comments of the run, oldest first.
 * @param props.ticketId - The ticket they are on.
 * @param props.ai - Who is an AI member, and their names.
 * @param props.runs - The ticket's AI runs (the hand-offs and the mention chain are read from them).
 * @param props.onJoin - Post a comment (the existing comment API); resolves once it is saved.
 * @param props.open - Shown (true) or folded; the thread keeps it so a link to a comment inside can open it.
 * @param props.onOpenChange - Show or Fold was pressed.
 */
export function AiTalkFold({
  run,
  ticketId,
  ai,
  runs,
  onJoin,
  open,
  onOpenChange,
}: {
  run: TalkRun;
  ticketId: string;
  ai: AiLookup;
  runs: AiRun[];
  onJoin: (text: string) => Promise<unknown>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { members, settings } = useAiBoardState();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = [...members.values()];
  const handoffs = handoffsIn(run, runs);
  const talked = run.comments.length;
  const summary = (
    <>
      {handoffs.length > 0 ? ` · ${handoffs.length} hand-off${handoffs.length === 1 ? '' : 's'}` : ''} ·{' '}
      {clock(run.first)} to {clock(run.last)} · no question for you
    </>
  );
  const people = run.names
    .map((n) => all.find((m) => m.name === n))
    .filter((m): m is AiMember => !!m && m.kind === 'ai');

  if (!open)
    return (
      <div className="tk-fold" data-testid="ai-talk-fold" data-comment-ids={run.ids.join(' ')}>
        <Faces names={run.names} members={all} />
        <div className="tk-fold-text">
          <b>
            {namesList(run.names)} talked {talked} time{talked === 1 ? '' : 's'}
          </b>
          <span className="tk-hint">{summary}</span>
        </div>
        <button
          type="button"
          className="tk-btn"
          aria-expanded={false}
          data-testid="ai-talk-show"
          onClick={() => onOpenChange(true)}
        >
          <Chevron /> Show
        </button>
      </div>
    );

  const chain = chainOf(run, runs, ai);
  const max = settings?.maxChainDepth;
  // the messages and the hand-offs, in the order they happened
  const lines: { at: string; node: ReactNode }[] = [
    ...run.comments.map((c) => {
      const member = all.find((m) => m.name === c.author);
      return {
        at: c.at,
        node: (
          <div key={c.id} className="tk-msg" data-comment-id={c.id} data-testid="ai-talk-message">
            <Face member={member} name={c.author} size={28} />
            <div className="tk-msg-body">
              <div className="tk-msg-head">
                <b>{c.author}</b>
                <AiBadge />
                <span className="tk-to" data-testid="ai-talk-to">
                  {addressedTo(c, ai)}
                </span>
                <span className="tk-hint">{clock(c.at)}</span>
              </div>
              <div className="tk-msg-text">
                <MarkdownRenderer>{c.text}</MarkdownRenderer>
              </div>
            </div>
          </div>
        ),
      };
    }),
    ...handoffs.map((r) => ({
      at: r.queuedAt,
      node: (
        <div key={r.id} className="tk-handoff" data-testid="ai-talk-handoff">
          <span aria-hidden="true">⇄</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            {ai.nameOf(r.startedBy)} handed {ticketId} to {r.memberName ?? ai.nameOf(r.memberId)}
            {r.instruction ? ` · ${r.instruction.split('\n')[0].slice(0, 80)}` : ''}
          </span>
          <span className="tk-hint">{clock(r.queuedAt)}</span>
        </div>
      ),
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  const send = async () => {
    const body = text.trim();
    if (!body || people.length === 0) return;
    setSending(true);
    setError(null);
    try {
      await onJoin(joinText(people, body));
      setText('');
    } catch {
      setError('Could not send it. Try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="tk-talk" data-testid="ai-talk-open">
      <div className="tk-talk-head">
        <Faces names={run.names} members={all} size={24} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <b style={{ fontSize: 14 }}>The conversation on {ticketId}</b>
          <div className="tk-hint">
            {talked} message{talked === 1 ? '' : 's'}
            {handoffs.length > 0 ? ` · ${handoffs.length} hand-off${handoffs.length === 1 ? '' : 's'}` : ''}
            {chain ? ` · chain ${chain.path.join(' → ')} · depth ${chain.depth}${max ? ` of ${max}` : ''}` : ''}
          </div>
        </div>
        <button
          type="button"
          className="tk-btn"
          aria-expanded={true}
          data-testid="ai-talk-fold-again"
          onClick={() => onOpenChange(false)}
        >
          <Chevron /> Fold
        </button>
      </div>
      <div className="tk-rule" />
      {lines.map((l) => l.node)}
      {people.length > 0 && (
        <div className="tk-join" data-testid="ai-talk-join">
          <div className="tk-join-head">
            <People /> Join in
            <span className="tk-hint" style={{ fontWeight: 500 }}>
              They read it at their next turn
            </span>
          </div>
          <div className="tk-box">
            <textarea
              aria-label="Join in"
              placeholder="Tell them what you want, for example: also check keyboard use."
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
              }}
            />
            <div className="tk-box-foot">
              {people.map((m) => (
                <span key={m.id} className="tk-chip">
                  {m.name}
                </span>
              ))}
              <span className="tk-hint">{people.length === 2 ? 'both are' : 'all are'} in this chain</span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                className="tk-btn tk-btn-primary"
                disabled={!text.trim() || sending}
                data-testid="ai-talk-send"
                onClick={() => void send()}
              >
                {people.length === 2
                  ? 'Send to both'
                  : people.length === 1
                    ? `Send to ${people[0].name}`
                    : 'Send to all'}
              </button>
            </div>
          </div>
          {error && (
            <div className="tk-error" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function People() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
