// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/tickets', () => ({ uploadAnyFile: vi.fn() }));
vi.mock('../MarkdownRenderer', () => ({ MarkdownRenderer: () => null }));
vi.mock('../docs/RefSuggester', () => ({ RefSuggester: () => null }));
vi.mock('../docs/Icon', () => ({ Icon: () => null }));
vi.mock('../diagrams/DiagramIcon', () => ({ DiagramIcon: () => null }));
vi.mock('../diagrams/useDiagramStarter', () => ({ useDiagramStarter: () => ({ available: false }) }));
vi.mock('../sketch/SketchIcon', () => ({ SketchIcon: () => null }));
vi.mock('../sketch/useSketchStarter', () => ({ useSketchStarter: () => ({ available: false }) }));
vi.mock('../canvas/CanvasIcon', () => ({ CanvasIcon: () => null }));
vi.mock('../canvas/useCanvasStarter', () => ({ useCanvasStarter: () => ({ available: false }) }));
vi.mock('../ai/MentionPlan', () => ({ MentionPlan: () => null }));
vi.mock('../ai/ComposerAi', () => ({ AskSplit: () => null }));
vi.mock('../ai/aiUi', () => ({
  useAiBoardState: () => ({ members: new Map([['m1', { id: 'm1', name: 'Dev An', kind: 'ai' }]]) }),
}));
vi.mock('../ai/aiAvailability', () => ({
  aiAvailability: () => ({ label: 'Idle', note: '', tone: 'ok', usable: true }),
}));
vi.mock('../ai/editor/useEditorAi', () => ({
  useEditorAi: () => ({ onInput: () => {}, onKeyDown: () => false, layer: null }),
  EditorAiSelectionBar: () => null,
}));

import { Composer } from './Composer';

const me = { name: 'You', initials: 'ME', bg: '#fff', color: '#000' };
const PILL = '@[Dev An](member:m1) what does total() return?';

function renderComposer(onSubmit = vi.fn(), ticketFast = false) {
  return render(
    <Composer
      ticketId="KAN-1"
      projectId="p1"
      me={me}
      members={[]}
      prefill={PILL}
      ticketFast={ticketFast}
      onSubmit={onSubmit}
      onCancel={vi.fn()}
    />,
  );
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('Fast on a comment that wakes an AI', () => {
  it('sends the comment as fast when Fast is ticked', () => {
    const onSubmit = vi.fn();
    renderComposer(onSubmit);
    const fast = screen.getByTestId('comment-fast');
    expect(fast.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(fast);
    expect(fast.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('comment-send'));
    expect(onSubmit).toHaveBeenCalledWith(PILL, expect.objectContaining({ intent: 'ask', fast: true }));
  });

  it('sends it at the ticket pace when Fast is not ticked', () => {
    const onSubmit = vi.fn();
    renderComposer(onSubmit);
    fireEvent.click(screen.getByTestId('comment-send'));
    expect(onSubmit.mock.calls[0][1].fast).toBeUndefined();
  });

  it('says the ticket is fast already instead of offering the switch', () => {
    renderComposer(vi.fn(), true);
    expect(screen.getByTestId('comment-fast-ticket').textContent).toContain('Fast · ticket');
    expect(screen.queryByTestId('comment-fast')).toBeNull();
  });
});
