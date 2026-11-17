/**
 * What the page editor gives the editor inside it for AI teams: the block lock of the block menu ("Teams cannot
 * change this", with the marks on locked blocks) and "Ask the team" on the selection bar. It holds the editor's
 * error boundary, so the editor screen swaps one wrapper for the other.
 */

import type { ReactNode } from 'react';
import type { DocsLayout } from '../../../hooks/useDocsLayout';
import type { DocsPage } from '../../../types/docs';
import { EditorErrorBoundary } from '../editor/EditorErrorBoundary';
import { AskTeamProvider } from './AskTeam';
import { BlockLockProvider } from './pageAi';

/**
 * The editor's AI team providers around its error boundary.
 * @param props.page - The page being edited.
 * @param props.projectId - Its project.
 * @param props.layout - Desktop, tablet or phone.
 * @param props.onOpenTicket - Opens a ticket (a run's "Open run").
 */
export function EditorTeamHost({
  page,
  projectId,
  layout,
  onOpenTicket,
  children,
}: {
  page: DocsPage;
  projectId: string;
  layout?: DocsLayout;
  onOpenTicket?: (ticketId: string) => void;
  children: ReactNode;
}) {
  return (
    <BlockLockProvider page={page}>
      <AskTeamProvider page={page} projectId={projectId} canEdit layout={layout} onOpenTicket={onOpenTicket}>
        <EditorErrorBoundary>{children}</EditorErrorBoundary>
      </AskTeamProvider>
    </BlockLockProvider>
  );
}
