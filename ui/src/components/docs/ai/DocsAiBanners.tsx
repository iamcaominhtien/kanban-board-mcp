import type { DocsPage } from '../../../types/docs';
import { FreshnessBanner } from './FreshnessBanner';

/**
 * Banners above a page that come from Docs AI: the "may be out of date" banner (docs-ai-care A), shown only to
 * people who can edit the page.
 */
export function DocsAiBanners(props: {
  projectId: string;
  page: DocsPage;
  canEdit: boolean;
  /** Opens a ticket (the freshness banner's "Open KAN-12"). */
  onOpenTicket?: (ticketId: string) => void;
}) {
  return (
    <>
      <FreshnessBanner {...props} />
    </>
  );
}
