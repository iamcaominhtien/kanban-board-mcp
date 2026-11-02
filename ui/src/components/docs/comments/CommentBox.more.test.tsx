// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const startNew = vi.fn();
vi.mock('../../../api/projects', () => ({ useProject: () => ({ data: { prefix: 'KAN' } }) }));
vi.mock('../../../api/tickets', () => ({ uploadAnyFile: vi.fn() }));
vi.mock('../RefSuggester', () => ({ RefSuggester: () => null }));
vi.mock('../../diagrams/useDiagramStarter', () => ({
  useDiagramStarter: () => ({ available: true, startNew, pickFile: vi.fn(), startImport: vi.fn(), fileInput: null }),
}));
vi.mock('../../sketch/useSketchStarter', () => ({ useSketchStarter: () => ({ available: false, start: vi.fn() }) }));
vi.mock('../../canvas/useCanvasStarter', () => ({ useCanvasStarter: () => ({ available: false, start: vi.fn() }) }));

import { CommentBox } from './CommentBox';

afterEach(() => cleanup());

describe('the comment box toolbar', () => {
  it('keeps B, I, code, @ and [[ in the bar, with attach and diagram as inline tools after a separator', () => {
    render(<CommentBox projectId="p" members={[]} onSubmit={async () => undefined} onCancel={() => undefined} />);
    for (const label of ['Bold', 'Italic', 'Code', 'Mention', 'Link a page'])
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    expect(screen.queryByTestId('comment-more')).toBeNull();
    expect(screen.getByTestId('comment-attach')).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId('comment-diagram'));
    expect(startNew).toHaveBeenCalled();
    expect(screen.getByTestId('comment-attach')).toBeTruthy();
  });
});
