import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useIdeaForTicket } from '../../api/ideas';
import { plural } from '../docs/docsShared';
import { BulbIcon } from './ideaShared';
import './ideas.css';

interface IdeaLinks {
  /** Open the idea's page in the Idea Space. */
  openIdea: (ideaId: string) => void;
}

const Ctx = createContext<IdeaLinks>({ openIdea: () => undefined });

/** Lets any ticket view open the idea it started as, without knowing how the app switches spaces. */
export const IdeaLinksProvider = Ctx.Provider;

/** The links a ticket view can follow into the Idea Space. */
export function useIdeaLinks(): IdeaLinks {
  return useContext(Ctx);
}

/**
 * The small lightbulb next to a ticket key on cards, list rows and the timeline. Hovering shows where it came
 * from and a link back. Only tickets promoted from an idea carry one.
 * @param props.ticketId - The ticket.
 * @param props.ideaId - The idea it came from (`fromIdeaId`); nothing is drawn without it.
 */
export function IdeaBulb({ ticketId, ideaId }: { ticketId: string; ideaId?: string | null }) {
  const [open, setOpen] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { openIdea } = useIdeaLinks();
  const info = useIdeaForTicket(open && ideaId ? ticketId : '');
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  if (!ideaId) return null;
  const idea = info.data?.fromIdea;

  return (
    <span
      className="is-bulb"
      data-testid="idea-bulb"
      aria-label={`Started as idea ${ideaId}`}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        timer.current = setTimeout(
          () => setOpen({ x: Math.min(window.innerWidth - 300, r.left), y: r.bottom + 6 }),
          200,
        );
      }}
      onMouseLeave={() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setOpen(null), 150);
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <BulbIcon size={13} />
      {open && (
        <span
          className="is-hovercard"
          role="tooltip"
          style={{ left: open.x, top: open.y }}
          onMouseEnter={() => timer.current && clearTimeout(timer.current)}
          onMouseLeave={() => setOpen(null)}
        >
          <b>Started as an idea</b>
          <div className="is-muted">
            {idea
              ? [
                  idea.demand,
                  idea.assumptionsTotal
                    ? `${idea.assumptionsChecked} of ${idea.assumptionsTotal} assumptions checked`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || idea.title
              : ideaId}
          </div>
          <button
            type="button"
            className="is-link"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(null);
              openIdea(ideaId);
            }}
          >
            Open the idea
          </button>
        </span>
      )}
    </span>
  );
}

/**
 * "Started as an idea": the block of the ticket page that says where the ticket came from, what was already
 * confirmed and what is still to check, with links to the idea's log and activity.
 * @param props.ticketId - The ticket being viewed.
 * @param props.onOpenTicket - Open a test ticket.
 */
export function StartedAsIdea({
  ticketId,
  fromIdeaId,
  onOpenTicket,
}: {
  ticketId: string;
  fromIdeaId?: string | null;
  onOpenTicket: (id: string) => void;
}) {
  const { openIdea } = useIdeaLinks();
  const q = useIdeaForTicket(fromIdeaId ? ticketId : '');
  const idea = q.data?.fromIdea;
  if (!fromIdeaId || !idea) return null;
  return (
    <section
      className="is-root is-from-idea"
      style={{ flex: 'none' }}
      aria-label="Started as an idea"
      data-testid="started-as-idea"
    >
      <div className="is-label">Started as an idea</div>
      <div style={{ marginTop: 3 }}>
        <button type="button" className="is-link is-mono" onClick={() => openIdea(idea.id)}>
          {idea.id}
        </button>{' '}
        <span className="is-muted">
          {[
            idea.demand,
            idea.assumptionsTotal
              ? `${idea.assumptionsChecked} of ${idea.assumptionsTotal} assumptions checked first`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      {idea.open.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div className="is-label">To check before closing</div>
          {idea.open.map((a) => (
            <div key={a.id} className="is-check-item">
              <span aria-hidden="true">☐</span>
              <span>
                {a.text}
                {a.testTicketId ? (
                  <>
                    {' '}
                    <button type="button" className="is-link is-mono" onClick={() => onOpenTicket(a.testTicketId!)}>
                      test {a.testTicketId}
                    </button>
                  </>
                ) : (
                  <span className="is-muted"> · no test yet</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="is-links">
        <button type="button" className="is-link" onClick={() => openIdea(idea.id)}>
          Open the idea
        </button>
        <button type="button" className="is-link" onClick={() => openIdea(idea.id)}>
          Idea log ({idea.logCount})
        </button>
        <button type="button" className="is-link" onClick={() => openIdea(idea.id)}>
          Idea activity
        </button>
      </div>
      {idea.confirmed.length > 0 && (
        <div className="is-muted" style={{ marginTop: 6 }}>
          {plural(idea.confirmed.length, 'assumption')} confirmed before it was built.
        </div>
      )}
    </section>
  );
}

/**
 * Shown on a ticket that tests an assumption: asks what the test showed when the ticket is closed.
 * @param props.ticketId - The ticket being viewed.
 */
export function TestsAssumption({
  ticketId,
  testsAssumptionId,
  closed,
  onAnswer,
}: {
  ticketId: string;
  testsAssumptionId?: string | null;
  closed: boolean;
  onAnswer: (ideaId: string, assumptionId: string, outcome: 'validated' | 'disproved' | 'unsure') => Promise<void>;
}) {
  const { openIdea } = useIdeaLinks();
  const q = useIdeaForTicket(testsAssumptionId ? ticketId : '');
  const t = q.data?.tests;
  const [done, setDone] = useState<string | null>(null);
  if (!testsAssumptionId || !t) return null;
  const open = t.status === 'untested' || t.status === 'testing';
  return (
    <section
      className="is-root is-from-idea"
      style={{ flex: 'none' }}
      aria-label="Tests an assumption"
      data-testid="tests-assumption"
    >
      <div className="is-label">Tests an assumption of an idea</div>
      <div style={{ margin: '4px 0' }}>“{t.text}”</div>
      <div className="is-muted">
        Impact if wrong: {t.impact} · {done ?? t.status}{' '}
        <button type="button" className="is-link" onClick={() => openIdea(t.ideaId)}>
          Open the idea
        </button>
      </div>
      {closed && open && !done && (
        <div className="is-ask">
          <b>Did the test show that this is true?</b>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            {(
              [
                ['validated', 'Yes, validated'],
                ['disproved', 'No, disproved'],
                ['unsure', 'Not sure yet'],
              ] as const
            ).map(([o, label]) => (
              <button
                key={o}
                type="button"
                className="is-btn is-btn-sm"
                onClick={async () => {
                  await onAnswer(t.ideaId, t.assumptionId, o);
                  setDone(o === 'unsure' ? 'not sure yet' : o);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
