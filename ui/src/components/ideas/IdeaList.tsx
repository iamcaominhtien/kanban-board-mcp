import { useEffect, useMemo, useRef, useState } from 'react';
import { useSetIdeaProject } from '../../api/ideas';
import type { IdeaBucketCounts, IdeaRow, IdeaScope, IdeaStage } from '../../types/idea';
import { STAGE_LABELS } from '../../types/idea';
import { relativeTime } from '../../utils/relativeTime';
import type { Project } from '../../types';
import { ProjectSelect } from './TriageDialogs';
import { AiChip, Demand, ReadinessBar, StagePill, sourceLine, warningLabel } from './ideaShared';

export type StageFilter = 'active' | IdeaStage;
export const LIST_FILTERS: StageFilter[] = [
  'active',
  'exploring',
  'ready',
  'building',
  'parked',
  'shipped',
  'archived',
];

/** Filter chips of the list: Active plus one per stage, with the counts of the scope being looked at. */
export function StageChips({
  value,
  onChange,
  counts,
}: {
  value: StageFilter;
  onChange: (f: StageFilter) => void;
  counts?: IdeaBucketCounts;
}) {
  return (
    <>
      {LIST_FILTERS.map((f) => {
        const n = counts ? (f === 'active' ? counts.active : counts.stages[f]) : undefined;
        return (
          <button key={f} type="button" className="is-chip" aria-pressed={value === f} onClick={() => onChange(f)}>
            {f === 'active' ? 'Active' : STAGE_LABELS[f]}
            {n !== undefined && n > 0 && <small>{n}</small>}
          </button>
        );
      })}
    </>
  );
}

/** The cell with the title, tags, where it came from and the warnings of a row. */
function IdeaCell({ idea }: { idea: IdeaRow }) {
  const from = sourceLine(idea);
  return (
    <>
      <div className="is-row-title">
        {idea.title} {idea.source === 'ai' && <AiChip />}
      </div>
      <div className="is-row-sub">
        <span className="is-mono">{idea.id}</span>
        {idea.tags.slice(0, 4).map((t) => (
          <span key={t} className="is-tag">
            {t}
          </span>
        ))}
        {from && <span>{from}</span>}
        {idea.stage === 'parked' && idea.parkUntil && <span className="is-warn">Back {idea.parkUntil}</span>}
        {idea.stage === 'archived' && idea.archiveReason && (
          <span className="is-warn">{idea.archiveNote ?? idea.archiveReason.replace('_', ' ')}</span>
        )}
        {idea.warnings.map((w) => {
          const l = warningLabel(w);
          return (
            <span key={w} className={`is-warn ${l.tone === 'risk' ? 'is-warn-risk' : ''}`}>
              {l.text}
            </span>
          );
        })}
      </div>
    </>
  );
}

interface ListProps {
  ideas: IdeaRow[];
  scope: IdeaScope;
  projects: Project[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onOpen: (id: string) => void;
  onOpenTicket: (ticketId: string) => void;
  emptyAction?: React.ReactNode;
  /** Filters are on: say "no match" instead of "no ideas yet". */
  filtered: boolean;
}

/** The ranked list: where an idea is, how much of it was tested, who wants it and whether it became a ticket. */
export function IdeaList({
  ideas,
  scope,
  projects,
  selectedId,
  onSelect,
  onOpen,
  onOpenTicket,
  emptyAction,
  filtered,
}: ListProps) {
  const setProject = useSetIdeaProject();
  const [assigning, setAssigning] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const showProject = scope === 'all';
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  useEffect(() => {
    // arrow keys move the selection, Enter opens it
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (t?.isContentEditable || ideas.length === 0) return;
      const i = ideas.findIndex((x) => x.id === selectedId);
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        onSelect(ideas[Math.min(ideas.length - 1, i + 1)].id);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        onSelect(ideas[Math.max(0, i - 1)].id);
      } else if (e.key === 'Enter' && i >= 0 && !(t && /^(BUTTON|A)$/.test(t.tagName))) {
        e.preventDefault();
        onOpen(ideas[i].id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ideas, selectedId, onSelect, onOpen]);

  if (ideas.length === 0) {
    return (
      <div className="is-empty">
        <h3>{filtered ? 'No idea matches' : 'No ideas here yet'}</h3>
        <div>
          {filtered ? 'Try another filter or search.' : 'Press C to write one down. It goes to the Inbox first.'}
        </div>
        <div style={{ marginTop: 14 }}>{emptyAction}</div>
      </div>
    );
  }

  return (
    <table className="is-table" aria-label="Ideas">
      <thead>
        <tr>
          <th>Idea</th>
          {showProject && <th>Project</th>}
          <th>Stage</th>
          <th>Readiness (assumptions)</th>
          <th>Demand</th>
          <th>Ticket</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody ref={bodyRef}>
        {ideas.map((idea) => {
          const project = idea.projectId ? projectName.get(idea.projectId) : null;
          return (
            <tr
              key={idea.id}
              className="is-row"
              tabIndex={0}
              aria-selected={selectedId === idea.id}
              onClick={() => onOpen(idea.id)}
              onFocus={() => onSelect(idea.id)}
              data-testid={`idea-row-${idea.id}`}
            >
              <td>
                <IdeaCell idea={idea} />
              </td>
              {showProject && (
                <td onClick={(e) => assigning === idea.id && e.stopPropagation()}>
                  {project ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span className="is-dot" style={{ background: project.color }} /> {project.prefix}
                    </span>
                  ) : assigning === idea.id ? (
                    <ProjectSelect
                      value={null}
                      onChange={(id) => {
                        setAssigning(null);
                        if (id) setProject.mutate({ id: idea.id, projectId: id });
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="is-btn is-btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setAssigning(idea.id);
                      }}
                    >
                      Assign
                    </button>
                  )}
                </td>
              )}
              <td>
                <StagePill stage={idea.stage} />
              </td>
              <td>
                <ReadinessBar idea={idea} />
              </td>
              <td>
                <Demand voters={idea.voters} />
              </td>
              <td>
                {idea.ticket ? (
                  <button
                    type="button"
                    className="is-link is-mono"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenTicket(idea.ticket!.id);
                    }}
                    title={`${idea.ticket.title} · ${idea.ticket.status}`}
                  >
                    {idea.ticket.id}
                  </button>
                ) : (
                  <span className="is-muted">—</span>
                )}
              </td>
              <td className="is-muted" style={{ whiteSpace: 'nowrap' }}>
                {relativeTime(idea.updatedAt)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
