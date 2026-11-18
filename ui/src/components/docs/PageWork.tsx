import { useEffect, useState } from 'react';
import { usePageSettled } from './pageSettled';
import { LIVE_STATES, usePageWork, type PageWorkTicket } from '../../api/docsWork';
import { DOCS_PHONE_BELOW } from '../../hooks/useDocsLayout';
import { SgIcon } from './suggestions/sgIcons';
import './suggestions/suggestions.css';

const STATE_WORD: Record<string, string> = {
  queued: 'Queued',
  starting: 'Starting',
  running: 'Running',
  needs_input: 'Needs you',
};

function elapsed(from: string | null, now: number): string {
  if (!from) return '';
  const s = Math.max(0, Math.round((now - new Date(from).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The words after the team's name, by the run's state. */
function stateWords(state: string): string {
  if (state === 'running' || state === 'starting') return 'is working on this page';
  if (state === 'queued') return 'is queued for this page';
  return STATE_WORD[state] ?? state;
}

/** The width of the window, for the phone line (below 600 px). */
function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.innerWidth < DOCS_PHONE_BELOW);
  useEffect(() => {
    const on = () => setPhone(window.innerWidth < DOCS_PHONE_BELOW);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return phone;
}

/**
 * "A team is working on this page" (#268, design "AI teams on rich pages" G 38–41): one banner per AI run working now
 * on a ticket tied to the page, with how long and what it is doing, the ticket and Open run, and under it the line that
 * says the page stays editable. On a phone each run is one tappable line. Renders nothing when no AI is working.
 * @param props.pageId - The page.
 * @param props.onOpenTicket - Opens the run's ticket.
 */
export function PageWork({ pageId, onOpenTicket }: { pageId: string; onOpenTicket: (ticketId: string) => void }) {
  const settled = usePageSettled();
  const work = usePageWork(settled ? pageId : null).data;
  const phone = usePhone();
  const live = (work?.tickets ?? []).filter((t): t is PageWorkTicket & { run: NonNullable<PageWorkTicket['run']> } =>
    Boolean(t.run && LIVE_STATES.includes(t.run.state)),
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live.length) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [live.length]);
  if (!live.length) return null;
  const working = live.some((t) => t.run.state !== 'needs_input');
  return (
    <section aria-label="AI at work on this page" data-testid="docs-page-work" className="pw-wrap">
      {live.map((t) => {
        const needs = t.run.state === 'needs_input';
        const time = t.run.state === 'running' && t.run.startedAt ? elapsed(t.run.startedAt, now) : '';
        const dot = <span aria-hidden="true" className={`pw-dot${needs ? ' pw-dot-needs' : ' ai-pulse'}`} />;
        if (phone) {
          return (
            <button
              key={t.id}
              type="button"
              className="pw-banner pw-phone"
              onClick={() => onOpenTicket(t.id)}
              title={t.title}
            >
              {dot}
              <span className="pw-phone-text">
                <b>{t.run.member}</b> <span className={needs ? 'pw-needs' : undefined}>{stateWords(t.run.state)}</span>
                <span className="pw-phone-sub">{[time, t.id].filter(Boolean).join(' · ')}</span>
              </span>
              <span className="pw-phone-go" aria-hidden="true">
                <SgIcon name="chevRight" size={16} />
              </span>
            </button>
          );
        }
        return (
          <div key={t.id} className="pw-banner">
            {dot}
            <span className="pw-text">
              <b>{t.run.member}</b>{' '}
              <span className={needs ? 'pw-needs' : 'pw-state'}>
                {stateWords(t.run.state)}
                {time ? ` · ${time}` : ''}
              </span>
              {t.run.doing && (
                <span className="pw-doing" title={t.run.doing}>
                  {t.run.doing}
                </span>
              )}
            </span>
            <span className="pw-ticket" title={t.title}>
              {t.id}
            </span>
            <button type="button" className="sg-btn pw-open" onClick={() => onOpenTicket(t.id)}>
              {needs ? 'Answer' : 'Open run'}
            </button>
          </div>
        );
      })}
      {working && !phone && (
        <div className="pw-note">
          <SgIcon name="info" size={14} color="#5B6B60" />
          <span>
            You can keep editing. If you change a block the team is working on, its version arrives as a suggestion.
          </span>
        </div>
      )}
    </section>
  );
}
