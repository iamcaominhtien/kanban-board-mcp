// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
vi.mock('../ai/aiUi', () => ({ useAiBoardState: () => ({ members: new Map() }) }));
vi.mock('../ai/editor/useEditorAi', () => ({
  useEditorAi: () => ({ onInput: () => {}, onKeyDown: () => false, layer: null }),
  EditorAiSelectionBar: () => null,
}));

import { Composer } from './Composer';
import { draftKey } from './commentUtils';

const me = { name: 'You', initials: 'ME', bg: '#fff', color: '#000' };
const KEY = draftKey('KAN-1');

function renderComposer(onSubmit = vi.fn()) {
  return render(
    <Composer ticketId="KAN-1" projectId="p1" me={me} members={[]} onSubmit={onSubmit} onCancel={vi.fn()} />,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('comment draft', () => {
  it('keeps what is typed as the draft of the ticket', () => {
    renderComposer();
    fireEvent.change(screen.getByTestId('comment-textarea'), { target: { value: 'half a thought' } });
    act(() => void vi.advanceTimersByTime(500));
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toBe('half a thought');
  });

  it('does not bring a sent comment back as the draft when it is sent before the draft was saved', () => {
    // the box stays open while the comment is posted (the parent awaits the server)
    const onSubmit = vi.fn();
    renderComposer(onSubmit);
    fireEvent.change(screen.getByTestId('comment-textarea'), { target: { value: 'already sent' } });
    // Ctrl+Enter right after the last key, while the draft save is still waiting
    fireEvent.click(screen.getByTestId('comment-send'));
    expect(onSubmit).toHaveBeenCalledWith('already sent', undefined);
    act(() => void vi.advanceTimersByTime(1000));
    expect(localStorage.getItem(KEY)).toBeNull();
    cleanup();

    // opening the box again starts empty
    renderComposer();
    expect((screen.getByTestId('comment-textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('saves the draft again when the person types on after sending', () => {
    renderComposer();
    const box = screen.getByTestId('comment-textarea');
    fireEvent.change(box, { target: { value: 'first' } });
    fireEvent.click(screen.getByTestId('comment-send'));
    fireEvent.change(box, { target: { value: 'first and more' } });
    act(() => void vi.advanceTimersByTime(500));
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toBe('first and more');
  });
});
