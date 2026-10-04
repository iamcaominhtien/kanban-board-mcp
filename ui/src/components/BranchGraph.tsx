import { useMemo, useState } from 'react';
import { useBranchGraph, useTicketBranches } from '../api/tickets';
import { extractError } from '../api/extractError';
import type { BranchStatus, GraphCommit, GraphRef, TicketBranch } from '../types';
import styles from './BranchGraph.module.css';

const ROW_H = 30;
const LANE_W = 18;
const PAD = 14;
const PAGE = 80;
const LANE_COLORS = ['#2E6F40', '#6D5DD3', '#2F6FB0', '#C4432A', '#B7791F', '#0F766E'];

const laneColor = (lane: number) => (lane === 0 ? LANE_COLORS[0] : LANE_COLORS[1 + ((lane - 1) % (LANE_COLORS.length - 1))]);

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

interface Edge {
  from: number; // row index of the child
  to: number; // row index of the parent
  secondParent: boolean;
  hidden: number; // commits collapsed between the two ends (overview mode)
}

export function BranchGraph({ ticketId }: { ticketId: string }) {
  const [mode, setMode] = useState<'overview' | 'all'>('overview');
  const [limit, setLimit] = useState(PAGE);
  const { data, isLoading, error } = useBranchGraph(ticketId, limit);
  const { data: ticketBranches = [] } = useTicketBranches(ticketId);

  const layout = useMemo(() => {
    if (!data || !data.linked) return null;
    const byHash = new Map<string, GraphCommit>(data.commits.map((c) => [c.hash, c]));
    const children = new Map<string, number>();
    const mergedTips = new Set<string>();
    data.commits.forEach((c) => {
      c.parents.forEach((p, idx) => {
        children.set(p, (children.get(p) ?? 0) + 1);
        if (idx > 0) mergedTips.add(p); // tip of a branch that was merged in
      });
    });

    const isKey = (c: GraphCommit, i: number) =>
      mode === 'all' ||
      i === 0 ||
      c.refs.length > 0 ||
      c.parents.length !== 1 ||
      !byHash.has(c.parents[0]) ||
      (children.get(c.hash) ?? 0) > 1 ||
      mergedTips.has(c.hash) ||
      byHash.get(c.parents[0])!.lane !== c.lane; // first commit of a side branch

    const visible = data.commits.filter((c, i) => isKey(c, i));
    const rowOf = new Map(visible.map((c, i) => [c.hash, i]));
    const edges: Edge[] = [];
    visible.forEach((c, row) => {
      c.parents.forEach((p, idx) => {
        let cur: string | undefined = p;
        let hidden = 0;
        while (cur && byHash.has(cur) && !rowOf.has(cur)) {
          cur = byHash.get(cur)!.parents[0];
          hidden += 1;
        }
        if (cur && rowOf.has(cur)) edges.push({ from: row, to: rowOf.get(cur)!, secondParent: idx > 0, hidden });
      });
    });
    return { visible, edges, hiddenTotal: data.commits.length - visible.length };
  }, [data, mode]);

  if (isLoading) return <div className={styles.empty}>Loading commit graph…</div>;
  if (error) return <div className={styles.error}>Couldn't load the graph: {extractError(error)}</div>;
  if (!data?.linked) {
    return (
      <div className={styles.empty}>
        <strong>No git repository linked</strong>
        <br />
        Link a repository to this project or ticket (Settings → Git Repositories, or the branch menu on the ticket)
        to see the real commit graph here.
      </div>
    );
  }
  if (!layout || layout.visible.length === 0) {
    return <div className={styles.empty}>No commits found for this ticket's branches yet.</div>;
  }

  const { visible, edges, hiddenTotal } = layout;
  const lanes = Math.max(1, data.laneCount);
  const width = PAD * 2 + lanes * LANE_W;
  const height = visible.length * ROW_H;
  const x = (lane: number) => PAD + lane * LANE_W + LANE_W / 2;
  const y = (row: number) => row * ROW_H + ROW_H / 2;
  const ticketSet = new Set(data.branches ?? []);
  const branchByName = new Map<string, TicketBranch>(ticketBranches.map((b) => [b.name, b]));
  // lane colour of a branch = lane of the commit that is exclusive to it (open work)
  const laneOfBranch = (name: string): number | null => {
    const tip = data.commits.find((c) => c.ticketBranches.includes(name));
    return tip ? tip.lane : null;
  };
  const statusBadge: Record<BranchStatus, string> = {
    baseline: styles.badgeMerged,
    open: styles.badgeOpen,
    merged: styles.badgeMerged,
    stale: styles.badgeStale,
    archived: styles.badgeArchived,
  };
  const legendBranches = ticketBranches.filter((b) => b.status !== 'baseline');

  const chip = (r: GraphRef) => {
    if (r.type === 'head') return <span key="head" className={`${styles.chip} ${styles.chipHead}`}>HEAD</span>;
    if (r.type === 'tag') return <span key={`t-${r.name}`} className={`${styles.chip} ${styles.chipTag}`}>{r.name}</span>;
    if (r.type === 'remote') return <span key={`r-${r.name}`} className={`${styles.chip} ${styles.chipOther}`}>{r.name}</span>;
    const cls = ticketSet.has(r.name) ? styles.chipTicket : r.name === data.base ? styles.chipBase : styles.chipOther;
    const wt = branchByName.get(r.name)?.worktreePath;
    return (
      <span key={`b-${r.name}`} className={`${styles.chip} ${cls}`} title={wt ? `Worktree: ${wt}` : undefined}>
        {wt ? '🌳 ' : ''}{r.name}
      </span>
    );
  };

  const edgePath = (e: Edge) => {
    const child = visible[e.from];
    const parent = visible[e.to];
    const x1 = x(child.lane), y1 = y(e.from), x2 = x(parent.lane), y2 = y(e.to);
    if (x1 === x2) return `M${x1} ${y1} L${x2} ${y2}`;
    const r = ROW_H * 0.6;
    if (e.secondParent) {
      // merge: leave the merge commit sideways, then run down the merged lane
      return `M${x1} ${y1} C${x2} ${y1} ${x2} ${y1 + r / 2} ${x2} ${y1 + r} L${x2} ${y2}`;
    }
    // fork: run down this lane, then curve into the parent lane
    return `M${x1} ${y1} L${x1} ${Math.max(y1, y2 - r)} C${x1} ${y2} ${x2} ${y2 - r / 2} ${x2} ${y2}`;
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.controls}>
        <div className={styles.toggle} role="group" aria-label="Graph detail">
          <button
            type="button"
            className={`${styles.toggleBtn} ${mode === 'overview' ? styles.toggleBtnActive : ''}`}
            onClick={() => setMode('overview')}
          >
            Overview
          </button>
          <button
            type="button"
            className={`${styles.toggleBtn} ${mode === 'all' ? styles.toggleBtnActive : ''}`}
            onClick={() => setMode('all')}
          >
            All commits
          </button>
        </div>
        <span className={styles.meta}>
          {mode === 'overview' && hiddenTotal > 0
            ? `${visible.length} key commits · ${hiddenTotal} more hidden`
            : `${visible.length} commits`}
          {data.truncated ? ' · older history not loaded' : ''}
        </span>
        {data.truncated && (
          <button type="button" className={styles.linkBtn} onClick={() => setLimit((l) => l + PAGE)}>
            Load older commits
          </button>
        )}
      </div>

      {legendBranches.length > 0 && (
        <div className={styles.legend} aria-label="Branches of this ticket">
          {legendBranches.map((b) => {
            const lane = laneOfBranch(b.name);
            const color = lane !== null ? laneColor(lane) : '#9AA8A0';
            return (
              <div key={b.id} className={styles.legendRow}>
                <span className={styles.legendDot} style={{ background: color }} />
                <span className={styles.legendName} title={b.name}>{b.name}</span>
                <span className={`${styles.badge} ${statusBadge[b.status]}`}>
                  {b.status.charAt(0).toUpperCase() + b.status.slice(1)}
                </span>
                {b.isCurrent && (
                  <span className={`${styles.badge} ${styles.badgeHead}`} title="Checked out in the repository's main working tree">
                    HEAD · checked out
                  </span>
                )}
                {b.worktreePath && (
                  <span className={`${styles.badge} ${styles.badgeWorktree}`} title={b.worktreePath}>
                    🌳 worktree
                  </span>
                )}
                {b.inRepo === false && (
                  <span className={`${styles.badge} ${styles.badgeMissing}`} title="This branch doesn't exist in the linked repository">
                    not in repo
                  </span>
                )}
                <span className={styles.legendMeta}>
                  from <span className={styles.legendPath}>{b.branchFrom || 'main'}</span>
                  {b.aheadCount !== undefined && ` · ${b.aheadCount} ahead, ${b.behindCount ?? 0} behind`}
                  {b.worktreePath && (
                    <>
                      {' · '}
                      <span className={styles.legendPath}>{b.worktreePath}</span>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className={styles.scroller}>
        <div className={styles.body}>
          <svg className={styles.svgCol} width={width} height={height} aria-label="Commit graph">
            {edges.map((e, i) => {
              const child = visible[e.from];
              const parent = visible[e.to];
              const lane = Math.max(child.lane, parent.lane); // side lane colours its edges
              return (
                <path
                  key={i}
                  d={edgePath(e)}
                  stroke={laneColor(lane)}
                  strokeWidth={2.2}
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray={e.hidden > 0 ? '3 4' : undefined}
                />
              );
            })}
            {visible.map((c, i) => (
              <g key={c.hash}>
                <circle
                  cx={x(c.lane)}
                  cy={y(i)}
                  r={c.parents.length > 1 ? 6 : 5}
                  fill={c.parents.length > 1 ? '#FFFFFF' : laneColor(c.lane)}
                  stroke={laneColor(c.lane)}
                  strokeWidth={c.parents.length > 1 ? 2.2 : c.ticketBranches.length ? 2 : 0}
                />
                {c.ticketBranches.length > 0 && c.parents.length <= 1 && (
                  <circle cx={x(c.lane)} cy={y(i)} r={8} fill="none" stroke={laneColor(c.lane)} strokeOpacity={0.35} strokeWidth={2} />
                )}
              </g>
            ))}
          </svg>
          <div className={styles.rows}>
            {visible.map((c, i) => {
              const hiddenAfter = edges.find((e) => e.from === i && !e.secondParent)?.hidden ?? 0;
              return (
                <div key={c.hash} className={styles.row} style={{ height: ROW_H }} title={`${c.hash}\n${c.author}\n${new Date(c.date).toLocaleString()}`}>
                  {c.refs.map(chip)}
                  <span className={styles.subject}>{c.subject}</span>
                  {hiddenAfter > 0 && <span className={styles.hidden}>+{hiddenAfter} commits</span>}
                  <span className={styles.hash}>{c.short}</span>
                  <span className={styles.author}>{c.author}</span>
                  <span className={styles.date}>{relativeDate(c.date)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
