import { createContext, useContext } from 'react';

/**
 * Whether the open Docs page has finished showing its content. The panels around it (Referenced by, the tickets on
 * the page, Send to AI, the version list) ask the server only then: asked at the same moment as the page, they ran on
 * the same server loop before it and made the page itself show up to a second later. Outside a page view it is true.
 */
export const PageSettledContext = createContext(true);

/** Whether the open page has shown its content (see PageSettledContext). */
export function usePageSettled(): boolean {
  return useContext(PageSettledContext);
}
