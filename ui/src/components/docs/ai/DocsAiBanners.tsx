import type { DocsPage } from '../../../types/docs';
import { FreshnessBanner } from './FreshnessBanner';
import { ProposalBanner } from './ProposalBanner';

/**
 * Banners above a page that come from Docs AI: proposed changes from an AI member (docs-ai-care B) and the
 * "may be out of date" banner (docs-ai-care A). Both are shown only to people who can edit the page.
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
      <ProposalBanner {...props} />
      <FreshnessBanner {...props} />
    </>
  );
}
