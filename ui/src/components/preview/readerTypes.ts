import type { ReactNode } from 'react';
import type { PreviewItem } from './types';

/** What the viewer hands to a reader. */
export interface ReaderProps {
  item: PreviewItem;
  /** Report facts the reader learned (image size, line count, ...) for the header and details. */
  onFacts: (facts: Record<string, string>) => void;
  /** Download and open-in-app buttons, for a reader to show next to a problem. */
  actions: ReactNode;
  /** Where the file downloads from (for a reader that offers the whole file next to a cut-off one). */
  downloadHref?: string;
  /** Go to the next (1) or previous (-1) file; used by swipe. */
  onNavigate?: (dir: -1 | 1) => void;
}
