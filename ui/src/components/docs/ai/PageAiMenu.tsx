import type { DocsPage } from '../../../types/docs';

/**
 * The AI button in the page header, beside Comments and Share (docs-ai B). Shown only when Docs AI is on for the
 * project (`aiGate`); lists what AI can do with this page and starts nothing until a row is picked.
 */
export function PageAiMenu(_props: {
  projectId: string;
  page: DocsPage;
  canEdit: boolean;
  /** Opens Settings › Docs (for the "no AI member" row). */
  onOpenSettings?: () => void;
}) {
  return null;
}
