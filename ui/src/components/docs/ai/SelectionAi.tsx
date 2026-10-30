import { selectionOk } from '../../../utils/pageAiRules';
import { useAssist } from '../../assist/AssistContext';
import type { Pick } from '../comments/SelectionComment';
import type { PageAiView } from './usePageAiView';

/**
 * AI buttons of the selection bar in the reader: Explain, Summarise and Ask… (docs-ai E2). Mounted inside the
 * comments' selection bar, after its Comment button. Nothing is sent until one is pressed, and none of them edits.
 * @param props.pick - The selection (its quote and where it is on screen).
 * @param props.pageId - The page the selection is on.
 * @param props.view - The page's AI view state, where the answer shows up.
 * @param props.done - Called after a button is used (the bar closes).
 */
export function SelectionAi({
  pick,
  pageId,
  view,
  done,
}: {
  pick: Pick;
  pageId: string;
  view: PageAiView;
  done: () => void;
}) {
  const assist = useAssist();
  const text = pick.anchor.quote;
  if (!selectionOk(text)) return null;
  const run = (fn: () => void) => () => {
    fn();
    done();
  };
  return (
    <>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        data-testid="selection-explain"
        onClick={run(() => view.explainSelection(text, pick.rect, pick.anchor.section))}
      >
        Explain
      </button>
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        data-testid="selection-summarise"
        onClick={run(() => view.summarise(text))}
      >
        Summarise
      </button>
      {assist && (
        <button
          type="button"
          data-testid="selection-ask"
          onMouseDown={(e) => e.preventDefault()}
          style={{ background: '#6b5bd2' }}
          onClick={run(() =>
            assist.ask({
              scope: 'doc',
              docId: pageId,
              text: `About this passage of the page: “${text.slice(0, 600)}” — what does it mean, and is anything missing?`,
            }),
          )}
        >
          ✦ Ask…
        </button>
      )}
    </>
  );
}
