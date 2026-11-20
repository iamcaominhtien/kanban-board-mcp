/**
 * "Skip to page content" (RichDocsStates frame 69): the first Tab stop of a Docs page shows it; Enter moves the focus
 * to the page text, past the project bar, the views and the tree.
 */

import './states.css';

/** The id of the page text the skip link moves to (the reading column). */
export const PAGE_MAIN_ID = 'dk-page-main';

/** The skip link; hidden until it has the keyboard focus. */
export function SkipLink() {
  return (
    <a
      className="dst-skip"
      href={`#${PAGE_MAIN_ID}`}
      data-testid="skip-link"
      onClick={(e) => {
        const main = document.getElementById(PAGE_MAIN_ID);
        if (!main) return;
        e.preventDefault();
        main.focus({ preventScroll: false });
      }}
    >
      Skip to page content
    </a>
  );
}
