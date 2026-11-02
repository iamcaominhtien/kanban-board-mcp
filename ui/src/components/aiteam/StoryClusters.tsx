import { useState } from 'react';
import type { FlowCluster, FlowStory } from '../../api/aiTeam';
import { CLUSTERS_SHOWN, clusterRows, storyLook, type ClusterRow, type ClusterSort } from './flowScope';
import { FS_ICON, FsIcon } from './ScopeBar';

const LAYERS = 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5';

/** The progress bar of a Story: done dark green, building light green, what waits red (design H). */
function Progress({ c, story }: { c: FlowCluster; story: FlowStory | null }) {
  const total = story?.progress.total ?? c.total;
  if (!total) return null;
  const done = story?.progress.done ?? c.done;
  const building = story?.progress.building ?? 0;
  const waiting = story?.blocked ? (story.progress.waiting ?? 0) : 0;
  const pct = (n: number) => `${Math.max(0, Math.min(100, (n / total) * 100))}%`;
  return (
    <span className="fs-bar6" aria-hidden="true">
      <i style={{ width: pct(done), background: '#2E6F40' }} />
      <i style={{ width: pct(building), background: '#7DBF8E' }} />
      <i style={{ width: pct(waiting), background: '#C4432A' }} />
    </span>
  );
}

function Card({
  row,
  faded,
  lit,
  onHover,
  onOpen,
}: {
  row: ClusterRow;
  faded: boolean;
  lit: boolean;
  onHover: (c: FlowCluster | null) => void;
  onOpen: (storyId: string) => void;
}) {
  const { cluster: c, story } = row;
  const look = storyLook(story?.state ?? c.state, { blocked: !!story?.blocked, planWaiting: story?.planWaiting });
  return (
    <button
      type="button"
      className={`fs-cl${faded ? ' faded' : ''}${lit ? ' lit' : ''}`}
      onMouseEnter={() => onHover(c)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(c)}
      onBlur={() => onHover(null)}
      onClick={() => onOpen(c.storyId!)}
      data-testid={`cluster-${c.storyId}`}
    >
      <span className="fs-cl-row">
        <FsIcon d={FS_ICON.story} color="#1B3A6B" width={2} />
        <span className="fs-cl-t">{story?.title ?? c.title}</span>
      </span>
      <span className="fs-cl-row">
        <span className="fs-cl-code">{c.storyId}</span>
        <span className="fs-chip" style={{ background: look.bg, color: look.fg }}>
          <FsIcon d={look.icon} size={11} color={look.fg} width={2.2} />
          {look.label}
        </span>
      </span>
      <span className="fs-cl-row">
        <Progress c={c} story={story} />
        <span style={{ fontSize: 11, color: '#3A4A3E' }}>
          {story?.progress.done ?? c.done} of {story?.progress.total ?? c.total}
        </span>
      </span>
    </button>
  );
}

/**
 * The Stories under the project map (design/screens/ai-story-flow.md, H and H2): one card per Story with AI work in
 * the range, hovering one draws its share of every arrow, clicking it opens the Story. The tickets in no Story are one
 * more card with a dashed edge. A busy range shows the first few, folds the Stories that are done into one line and
 * the rest that run into "N more running".
 */
export function StoryClusters({
  clusters,
  stories,
  hovered,
  onHover,
  onOpen,
}: {
  clusters: FlowCluster[];
  stories: FlowStory[];
  hovered: FlowCluster | null;
  onHover: (c: FlowCluster | null) => void;
  onOpen: (storyId: string) => void;
}) {
  const [sort, setSort] = useState<ClusterSort>('activity');
  const [all, setAll] = useState(false);
  const [openDone, setOpenDone] = useState(false);
  const { rows, loose } = clusterRows(clusters, stories, sort);
  if (!rows.length && !loose) return null;
  const busy = rows.length > CLUSTERS_SHOWN;
  const running = rows.filter((r) => !r.done);
  const done = rows.filter((r) => r.done);
  const shownRunning = busy && !all ? running.slice(0, 3) : running;
  const moreRunning = running.length - shownRunning.length;
  const shownDone = !busy || openDone ? done : [];
  const lit = (c: FlowCluster) => hovered === c;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="story-clusters">
      <div className="fs-clhead">
        <span className="fs-h">Stories in this range</span>
        <span className="fs-hint">
          {busy ? `${rows.length} · the busiest first` : 'hover one to see its share of every arrow · click to open it'}
        </span>
        <span style={{ flex: 1 }} />
        {busy && (
          <div className="fs-seg-sm" role="group" aria-label="Sort the Stories">
            <button type="button" className={sort === 'activity' ? 'on' : ''} onClick={() => setSort('activity')}>
              By activity
            </button>
            <button type="button" className={sort === 'state' ? 'on' : ''} onClick={() => setSort('state')}>
              By state
            </button>
          </div>
        )}
      </div>
      <div className="fs-clgrid">
        {shownRunning.map((r) => (
          <Card key={r.cluster.storyId} row={r} faded={false} lit={lit(r.cluster)} onHover={onHover} onOpen={onOpen} />
        ))}
        {shownDone.map((r) => (
          <Card key={r.cluster.storyId} row={r} faded lit={lit(r.cluster)} onHover={onHover} onOpen={onOpen} />
        ))}
        {busy && done.length > 0 && !openDone && (
          <button type="button" className="fs-clfold" onClick={() => setOpenDone(true)} data-testid="clusters-done">
            <FsIcon d={FS_ICON.ticket} color="#5B6B60" size={15} />
            <span>
              <b>
                {done.length} {done.length === 1 ? 'Story' : 'Stories'} done
              </b>
              &nbsp;· folded, faded in the map
            </span>
          </button>
        )}
        {moreRunning > 0 && (
          <button type="button" className="fs-clfold" onClick={() => setAll(true)} data-testid="clusters-more">
            <FsIcon d={LAYERS} color="#5B6B60" size={15} />
            <span>
              <b>{moreRunning} more running</b>&nbsp;· show all
            </span>
          </button>
        )}
        {loose && (
          <div
            className={`fs-cl loose${lit(loose) ? ' lit' : ''}`}
            onMouseEnter={() => onHover(loose)}
            onMouseLeave={() => onHover(null)}
            data-testid="cluster-loose"
          >
            <span className="fs-cl-row">
              <FsIcon d={FS_ICON.inbox} color="#5B6B60" width={2} />
              <span className="fs-cl-t">Not in a Story</span>
            </span>
            <span style={{ fontSize: 11.5, color: '#5B6B60' }}>
              {loose.tickets} ticket{loose.tickets === 1 ? '' : 's'} · {loose.handoffs} hand-off
              {loose.handoffs === 1 ? '' : 's'}
            </span>
            <span className="fs-bar6" aria-hidden="true">
              <i
                style={{
                  width: `${Math.min(
                    100,
                    (loose.tickets /
                      Math.max(
                        1,
                        clusters.reduce((n, c) => n + c.tickets, 0),
                      )) *
                      100,
                  )}%`,
                  background: '#9AA8A0',
                }}
              />
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
