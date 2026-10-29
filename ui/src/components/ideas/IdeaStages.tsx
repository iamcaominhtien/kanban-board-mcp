import { useState } from 'react';
import type { IdeaRow, IdeaStage } from '../../types/idea';
import { STAGE_LABELS } from '../../types/idea';
import { AiChip, Demand, ReadinessBar, warningLabel } from './ideaShared';

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
              <span className={`is-stage is-stage-${stage}`}>{STAGE_LABELS[stage]}</span>
              <span className="is-muted">{items.length}</span>
            </header>
            <div className="is-col-hint">{hint}</div>
            {items.map((idea) => (
              <article
                key={idea.id}
                className="is-card"
                draggable
                tabIndex={0}
                data-testid={`idea-card-${idea.id}`}
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/idea-id', idea.id);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => onOpen(idea.id)}
                onKeyDown={(e) => e.key === 'Enter' && onOpen(idea.id)}
              >
                <div className="is-card-title">
                  {idea.title} {idea.source === 'ai' && <AiChip />}
                </div>
                <div className="is-row-sub">
                  <span className="is-mono">{idea.id}</span>
                  {idea.ticket && <span className="is-mono">→ {idea.ticket.id}</span>}
                  {idea.stage === 'parked' && idea.parkUntil && <span className="is-warn">Back {idea.parkUntil}</span>}
                  {idea.warnings.slice(0, 1).map((w) => {
                    const l = warningLabel(w);
                    return (
                      <span key={w} className={`is-warn ${l.tone === 'risk' ? 'is-warn-risk' : ''}`}>
                        {l.text}
                      </span>
                    );
                  })}
                </div>
                <div className="is-card-foot">
                  <ReadinessBar idea={idea} />
                  <Demand voters={idea.voters} max={2} />
                </div>
              </article>
            ))}
            {items.length === 0 && <div className="is-col-empty">Drop an idea here</div>}
          </section>
        );
      })}
    </div>
  );
}
