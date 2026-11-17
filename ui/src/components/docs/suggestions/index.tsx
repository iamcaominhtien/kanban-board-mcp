/**
 * AI teams on rich pages, for the page views: the review of a page's suggestions (drawn by its reader), the chip and
 * the bar, "Ask the team", the page's AI settings and the block lock, the endings of a team's run, the tree marker.
 */

import type { ReactNode } from 'react';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import type { DocsPage } from '../../../types/docs';
import { PageSettledContext } from '../pageSettled';
import type { DocsSuggestion } from './api';
import { AskTeamProvider } from './AskTeam';
import { SuggestionFrame } from './SuggestionFrame';
import { ReviewContext, useSuggestionReview, type Review, type ReviewOptions } from './useSuggestionReview';

const frame = (s: DocsSuggestion, rendered: ReactNode) => <SuggestionFrame key={s.id} s={s} rendered={rendered} />;

/**
 * The review of the open page's suggestions: give `review` to {@link ReviewContext}, and `wrap`, `lead`, `tail` to
 * the page's RichDocView (`blockWrap`, `lead`, `tail`).
 * @param o - The page and what the review may do.
 */
export function usePageSuggestions(o: Omit<ReviewOptions, 'frame'>) {
  return useSuggestionReview({ ...o, frame });
}

/**
 * What the page view gives the parts inside it: whether the page is on screen (pageSettled.ts), the review of its
 * suggestions, and "Ask the team".
 * @param props.settled - The page's content is all on screen.
 * @param props.review - The review from {@link usePageSuggestions}.
 * @param props.page - The page.
 * @param props.projectId - Its project.
 * @param props.askable - The reader may ask a team to change the page.
 * @param props.layout - Desktop, tablet or phone.
 * @param props.onOpenTicket - Opens a ticket (a run's "Open run").
 */
export function PageTeamHost({
  settled,
  review,
  page,
  projectId,
  askable,
  layout,
  onOpenTicket,
  children,
}: {
  settled: boolean;
  review: Review | null;
  page: DocsPage;
  projectId: string;
  askable: boolean;
  layout?: DocsLayout;
  onOpenTicket?: (ticketId: string) => void;
  children: ReactNode;
}) {
  return (
    <PageSettledContext.Provider value={settled}>
      <ReviewContext.Provider value={review}>
        <AskTeamProvider
          page={page}
          projectId={projectId}
          canEdit={askable}
          layout={layout}
          onOpenTicket={onOpenTicket}
        >
          {children}
        </AskTeamProvider>
      </ReviewContext.Provider>
    </PageSettledContext.Provider>
  );
}

export { ReviewContext };
export { ReviewBar, SuggestionChip } from './ReviewBar';
export { AskTeamButton, AskTeamProvider, topBlockIdOf, useAskTeam } from './AskTeam';
export { AiChangesItems, BlockLockProvider, LockMarks, TeamApplySettings, lockedBlocks, useBlockLock } from './pageAi';
export { SuggestionMarker, SuggestionsWaiting, TeamRunEndings } from './extras';
