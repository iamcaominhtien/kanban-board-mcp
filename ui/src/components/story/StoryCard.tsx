import { useState } from 'react';
import { useStories } from '../../api/stories';
import type { Ticket } from '../../types';
import type { StoryView } from '../../types/story';
import { GiveStoryDialog } from './GiveStoryDialog';
import { PlanReviewDialog } from './PlanReview';
import {
  Ico,
  PausedChip,
  RoleBadge,
  StoryBar,
  StoryStateChip,
  SteppedIn,
  blockedLead,
  fallbackStory,
  storyFace,
} from './storyUi';
import styles from './story.module.css';

/** The Story view of a Story ticket: from GET /projects/{pid}/stories, or what its ticket says until that answers. */
export function useStoryOf(ticket: Ticket, allTickets: Ticket[] = []): StoryView {
  const { data } = useStories(ticket.projectId);
  const found = data?.find((s) => s.id === ticket.id);
  return found ?? fallbackStory(ticket, allTickets);
}

interface StoryCardProps {
  ticket: Ticket;
  allTickets?: Ticket[];
  /** Opens the Story page. */
  onOpen?: (ticket: Ticket) => void;
}

/**
 * A Story on the board (design/screens/ai-story-flow.md C, C2): a tinted card with a blue outline, the bookmark and
 * the word Story, a progress bar instead of points, the PM, the state chip, the amber "Plan needs you" strip when the
 * plan waits for you, what a Blocked Story waits for, and how often a person stepped in. It is never dragged: it
 * moves with its state.
 */
export function StoryCard({ ticket, allTickets = [], onOpen }: StoryCardProps) {
  const story = useStoryOf(ticket, allTickets);
  const [dialog, setDialog] = useState<'hand' | 'plan' | null>(null);
  const face = storyFace(story);
  const { done, total } = story.progress;
  const planCount = story.plan?.items.length ?? 0;

  const progressText =
    face === 'draft'
      ? story.blocked?.kind === 'plan'
        ? story.blocked.text
        : 'Not given to the PM yet'
      : face === 'plan_needs_you'
        ? 'Plan not approved yet'
        : face === 'planning'
          ? 'The PM is writing the plan'
          : `${done} of ${total} tickets done`;

  return (
    <>
      <div
        className={styles.card}
        role="button"
        tabIndex={0}
        data-story-id={ticket.id}
        data-testid="story-card"
        data-face={face}
        aria-label={`Story ${ticket.id}: ${story.title}`}
        onClick={() => onOpen?.(ticket)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen?.(ticket);
          }
        }}
      >
        <div className={styles.cardHead}>
          <span className={styles.storyWord}>
            <Ico name="story" size={15} color="#1B3A6B" width={2} />
            Story
          </span>
          <span className={styles.mono}>{ticket.id}</span>
        </div>

        <div className={styles.cardTitle}>{story.title || ticket.title}</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <StoryBar story={story} />
          <div className={styles.progressText}>
            <span>{progressText}</span>
          </div>
        </div>

        {face === 'draft' && (
          <button
            type="button"
            className={styles.link}
            onClick={(e) => {
              e.stopPropagation();
              setDialog('hand');
            }}
            data-testid="story-card-hand"
          >
            <Ico name="send" size={12} color="#1B3A6B" />
            Give it to the PM
          </button>
        )}

        {face === 'plan_needs_you' && (
          <button
            type="button"
            className={`${styles.strip} ${styles.stripAmber}`}
            onClick={(e) => {
              e.stopPropagation();
              setDialog('plan');
            }}
            data-testid="story-card-plan"
          >
            <Ico name="hand" size={13} color="#7A5A06" />
            <span>
              <b>
                Plan for {planCount} ticket{planCount === 1 ? '' : 's'}
              </b>{' '}
              is waiting for your approval
            </span>
          </button>
        )}

        {face === 'blocked' && story.blocked && (
          <div className={`${styles.strip} ${styles.stripRed}`} data-testid="story-card-blocked">
            <Ico name="warn" size={13} color="#A5321E" />
            <span>
              <b>{blockedLead(story.blocked.kind)}</b> {story.blocked.text}
            </span>
          </div>
        )}

        <div className={styles.footer}>
          <RoleBadge role="pm" title={story.pm?.name ?? 'PM'} />
          <StoryStateChip face={face} />
          {story.paused && <PausedChip />}
          <span style={{ flex: 1 }} />
        </div>

        <SteppedIn story={story} />
      </div>

      {dialog === 'hand' && (
        <GiveStoryDialog projectId={ticket.projectId} story={story} onClose={() => setDialog(null)} />
      )}
      {dialog === 'plan' && <PlanReviewDialog story={story} onClose={() => setDialog(null)} />}
    </>
  );
}
