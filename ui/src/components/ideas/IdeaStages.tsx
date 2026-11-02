import { useState } from 'react';
import type { IdeaRow, IdeaStage } from '../../types/idea';
import { STAGE_LABELS } from '../../types/idea';
import { AiChip, Demand, ReadinessBar, shortDate } from './ideaShared';
import { IdeaIcon } from './ideaIcons';
import { WarningChip } from './IdeaList';

/** The dot before each column's name. */
const STAGE_DOTS: Record<IdeaStage, string> = {
  inbox: '#B8860B',
  exploring: '#2F6FB0',
  ready: '#2E6F40',
  building: '#E8861A',
  parked: '#9AA8A0',
  shipped: '#7C5CD6',
  archived: '#9AA8A0',
};
/** Columns an idea cannot be dropped into by hand: Building comes from Promote, Shipped from the ticket. */
const NO_DROP_HINT: IdeaStage[] = ['building', 'shipped'];

const COLUMNS: { stage: IdeaStage; hint: string }[] = [
  { stage: 'exploring', hint: 'Learning what must be true.' },
  { stage: 'ready', hint: 'Everything that matters has been tested.' },
  { stage: 'building', hint: 'Promoted. Follows the ticket.' },
  { stage: 'parked', hint: 'Back on a date.' },
  { stage: 'shipped', hint: 'The ticket is Done.' },
];

interface Props {
  ideas: IdeaRow[];
  showArchived: boolean;
  onOpen: (id: string) => void;
  /** An idea was dropped on a column: the move flow decides what happens (dialog, checks, Promote). */
  onMove: (idea: IdeaRow, to: IdeaStage) => void;
}

/** The same ideas as columns. Dragging is allowed; a move that skips the checks asks first. */
export function IdeaStages({ ideas, showArchived, onOpen, onMove }: Props) {
  const [over, setOver] = useState<IdeaStage | null>(null);
  const columns = showArchived
    ? [...COLUMNS, { stage: 'archived' as IdeaStage, hint: 'Kept with their reason.' }]
    : COLUMNS;

  return (
    <div className="is-stages" role="list" aria-label="Stages">
      {columns.map(({ stage, hint }) => {
        const items = ideas.filter((i) => i.stage === stage);
        return (
          <section
            key={stage}
            className={`is-col ${over === stage ? 'is-col-over' : ''}`}
            role="listitem"
            aria-label={STAGE_LABELS[stage]}
            data-testid={`stage-col-${stage}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(stage);
            }}
            onDragLeave={() => setOver((o) => (o === stage ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const id = e.dataTransfer.getData('text/idea-id');
              const idea = ideas.find((i) => i.id === id);
              if (idea) onMove(idea, stage);
            }}
          >
            <header className="is-col-head">
              <span className="is-col-dot" style={{ background: STAGE_DOTS[stage] }} aria-hidden="true" />
              <b>{STAGE_LABELS[stage]}</b>
              <span className="is-muted">{items.length}</span>
            </header>
            <div className="is-col-hint">{hint}</div>
            {items.map((idea) => (
              <article
                key={idea.id}
                className="is-card"
                draggable
                tabIndex={0}
                title={idea.id}
                data-testid={`idea-card-${idea.id}`}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/idea-id', idea.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => onOpen(idea.id)}
                onKeyDown={(e) => e.target === e.currentTarget && e.key === 'Enter' && onOpen(idea.id)}
              >
                <div className="is-card-title">
                  {idea.title} {idea.source === 'ai' && <AiChip />}
                </div>
                {idea.warnings.slice(0, 1).map((w) => (
                  <span key={w} className="is-card-chip">
                    <WarningChip warning={w} />
                  </span>
                ))}
                {idea.tags.length > 0 && (
                  <div className="is-card-tags">
                    {idea.tags.slice(0, 4).map((t) => (
                      <span key={t} className="is-tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <ReadinessBar idea={idea} />
                <div className="is-card-foot">
                  <span className="is-card-votes">
                    <IdeaIcon name="thumb" size={13} color="#5B6B60" />
                    {idea.voters.length ? (
                      <Demand voters={idea.voters} max={2} title={`Wanted by ${idea.voters.join(', ')}`} />
                    ) : (
                      <span title="Nobody has asked for this yet">0</span>
                    )}
                  </span>
                  <span className="is-mono is-muted is-card-key">{idea.id}</span>
                  <span className="is-grow" />
                  {idea.stage === 'parked' && idea.parkUntil && (
                    <span className="is-muted">Back {shortDate(idea.parkUntil)}</span>
                  )}
                  {idea.ticket && (
                    <span className="is-ticket-chip" title={`${idea.ticket.title} · ${idea.ticket.status}`}>
                      <span
                        className="is-dot"
                        style={{ background: idea.stage === 'shipped' ? '#2E6F40' : '#E8861A' }}
                      />
                      {idea.ticket.id}
                    </span>
                  )}
                  {idea.stage === 'ready' && (
                    <button
                      type="button"
                      className="is-btn is-btn-sm is-btn-primary"
                      data-testid={`stage-promote-${idea.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onMove(idea, 'building');
                      }}
                    >
                      <IdeaIcon name="rocket" size={12} />
                      Promote
                    </button>
                  )}
                </div>
              </article>
            ))}
            {items.length === 0 && !NO_DROP_HINT.includes(stage) && (
              <div className="is-col-empty">Drop an idea here</div>
            )}
          </section>
        );
      })}
    </div>
  );
}
