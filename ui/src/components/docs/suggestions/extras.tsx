/**
 * The smaller parts of "AI teams on rich pages": how a team's run on the page ended (G 39: done with suggestions,
 * done directly, nothing to change, stopped, needs you), the ✦ marker of a page with suggestions in the tree, and the
 * space digest's "N suggestions waiting" line.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LIVE_STATES, usePageWork } from '../../../api/docsWork';
import type { DocsPage, DocsTreeNode } from '../../../types/docs';
import { LineIcon } from '../../ui/LineIcon';
import { usePageSettled } from '../pageSettled';
import { useSuggestions } from './api';
import { suggestionsWord } from './describe';
import './suggestions.css';

/** How a run on the page ended. */
export type Ending = 'suggested' | 'direct' | 'nothing' | 'failed' | 'needs';

/** One ending to show. */
interface Shown {
  runId: string;
  ticketId: string;
  team: string;
  ending: Ending;
  count: number;
  /** The page's version when the run was seen working (for "See changes"). */
  from: number;
  doing: string | null;
}

/**
 * Which ending a run had.
 * @param state - The run's state.
 * @param suggestions - Suggestions it left on the page that still wait.
 * @param changed - The page got a new version while it worked.
 */
export function endingOf(state: string, suggestions: number, changed: boolean): Ending | null {
  if (state === 'needs_input') return 'needs';
  if (LIVE_STATES.includes(state)) return null;
  if (state !== 'finished') return 'failed';
  if (suggestions > 0) return 'suggested';
  return changed ? 'direct' : 'nothing';
}

/**
 * The banner a team's run leaves when it ends (only for runs seen working while the page was open). It goes when it
 * is dismissed or the next run starts.
 * @param props.page - The page.
 * @param props.onOpenTicket - Opens the run's ticket (Report, Open run, Answer).
 * @param props.onReview - Goes to the suggestions.
 * @param props.onCompare - Opens the diff of two versions.
 */
export function TeamRunEndings({
  page,
  onOpenTicket,
  onReview,
  onCompare,
}: {
  page: DocsPage;
  onOpenTicket: (ticketId: string) => void;
  onReview?: () => void;
  onCompare?: (from: number, to: number) => void;
}) {
  // asked once the page is on screen, as the other panels around it are (pageSettled.ts)
  const on = usePageSettled() && page.version > 0;
  const work = usePageWork(on ? page.id : null).data;
  const suggestions = useSuggestions(page.id, on).data?.suggestions;
  const seen = useRef(new Map<string, number>());
  const [shown, setShown] = useState<Shown[]>([]);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!work) return;
    const next: Shown[] = [];
    let starting = false;
    for (const t of work.tickets) {
      const run = t.run;
      if (!run) continue;
      if (LIVE_STATES.includes(run.state) && run.state !== 'needs_input') {
        if (!seen.current.has(run.id)) {
          seen.current.set(run.id, page.version);
          starting = true;
        }
        continue;
      }
      const from = seen.current.get(run.id);
      if (from === undefined) continue;
      const count = (suggestions ?? []).filter((s) => s.runId === run.id).length;
      const ending = endingOf(run.state, count, page.version > from);
      if (ending) next.push({ runId: run.id, ticketId: t.id, team: run.member, ending, count, from, doing: run.doing });
    }
    // a new run starting puts away the endings of the last ones
    setShown((prev) => (starting ? [] : next.length || prev.length ? next : prev));
  }, [work, suggestions, page.version]);

  const list = shown.filter((s) => !hidden.has(s.runId));
  if (!list.length) return null;
  return (
    <div className="docs-root" data-testid="sg-run-endings">
      {list.map((s) => {
        const report = (
          <button type="button" className="sg-btn" onClick={() => onOpenTicket(s.ticketId)}>
            {s.ending === 'nothing' ? 'Read its Report' : s.ending === 'needs' ? 'Answer' : 'Report'}
          </button>
        );
        let text: ReactNode;
        let action: ReactNode = null;
        if (s.ending === 'suggested') {
          text = (
            <>
              <b>{s.team}</b> finished: {suggestionsWord(s.count)}.
            </>
          );
          action = onReview && (
            <button type="button" className="sg-btn sg-btn-primary" onClick={onReview}>
              Review
            </button>
          );
        } else if (s.ending === 'direct') {
          text = (
            <>
              <b>{s.team}</b> finished and saved its changes on the page.
            </>
          );
          action = onCompare && (
            <button type="button" className="sg-btn" onClick={() => onCompare(s.from, page.version)}>
              See changes
            </button>
          );
        } else if (s.ending === 'nothing') {
          text = (
            <>
              <b>{s.team}</b> finished and had nothing to change on this page.
            </>
          );
        } else if (s.ending === 'failed') {
          text = (
            <>
              <b>{s.team}</b> stopped before it changed anything.
            </>
          );
        } else {
          text = (
            <>
              <b>{s.team}</b> needs you{s.doing ? <span style={{ color: '#5B6B60' }}> · {s.doing}</span> : null}
            </>
          );
        }
        return (
          <div
            key={s.runId}
            className={`sg-ending${s.ending === 'failed' ? ' sg-ending-failed' : s.ending === 'needs' ? ' sg-ending-needs' : ''}`}
            role="status"
            data-ending={s.ending}
          >
            <LineIcon name={s.ending === 'failed' ? 'warning' : 'sparkle'} size={14} />
            <span>{text}</span>
            {action}
            {report}
            <button
              type="button"
              className="dk-icobtn"
              aria-label="Dismiss"
              style={{ width: 26, height: 26 }}
              onClick={() => setHidden((h) => new Set(h).add(s.runId))}
            >
              <LineIcon name="close" size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The ✦ and the number of suggestions waiting on a page, in its tree row. */
export function SuggestionMarker({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <span className="sg-tree-mark" title={`${suggestionsWord(count)} waiting`} aria-hidden="true">
      ✦{count}
    </span>
  );
}

/**
 * "N suggestions waiting" in the space digest: the pages with suggestions, each opens the page.
 * @param props.nodes - The space's tree (each row carries its count).
 * @param props.onOpenPage - Opens a page.
 */
export function SuggestionsWaiting({
  nodes,
  onOpenPage,
}: {
  nodes: DocsTreeNode[];
  onOpenPage: (pageId: string) => void;
}) {
  const pages = nodes.filter((n) => (n.suggestions ?? 0) > 0);
  if (!pages.length) return null;
  const total = pages.reduce((a, n) => a + (n.suggestions ?? 0), 0);
  return (
    <div
      data-testid="sg-waiting"
      style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 12.5 }}
    >
      <span style={{ color: '#5B3AA6', fontWeight: 700 }}>✦ {suggestionsWord(total)} waiting</span>
      {pages.slice(0, 4).map((n) => (
        <button
          key={n.id}
          type="button"
          className="sg-btn"
          style={{ height: 22, fontSize: 11.5 }}
          onClick={() => onOpenPage(n.id)}
        >
          {n.title} · {n.suggestions}
        </button>
      ))}
    </div>
  );
}
