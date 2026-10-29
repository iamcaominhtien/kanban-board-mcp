import type { DocsPage } from '../../../types/docs';

/**
 * Create tickets from a page (docs-ai-care C): drafts to review, nothing created before the button.
 * `selection` limits it to the text a person selected. Owned by the tickets feature.
 */
export function CreateTicketsDialog(_props: {
  projectId: string;
  page: DocsPage;
  selection?: string;
  onClose: () => void;
  onOpenTicket?: (ticketId: string) => void;
}) {
  return null;
}
