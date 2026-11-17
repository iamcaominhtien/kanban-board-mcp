// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocsTreeNode } from '../../../types/docs';
import { SuggestionMarker, SuggestionsWaiting, endingOf } from './extras';

afterEach(() => cleanup());

describe('how a team run on the page ended', () => {
  it('names the four endings', () => {
    expect(endingOf('running', 0, false)).toBeNull();
    expect(endingOf('finished', 3, false)).toBe('suggested');
    expect(endingOf('finished', 0, true)).toBe('direct');
    expect(endingOf('finished', 0, false)).toBe('nothing');
    expect(endingOf('failed', 0, false)).toBe('failed');
    expect(endingOf('timed_out', 0, false)).toBe('failed');
    expect(endingOf('needs_input', 0, false)).toBe('needs');
  });
});

describe('the tree marker and the digest line', () => {
  const node = (id: string, title: string, suggestions?: number) =>
    ({ id, title, suggestions }) as unknown as DocsTreeNode;

  it('shows ✦ and the count only when suggestions wait', () => {
    const { container, rerender } = render(<SuggestionMarker count={0} />);
    expect(container.textContent).toBe('');
    rerender(<SuggestionMarker count={3} />);
    expect(container.textContent).toBe('✦3');
    // kept out of the row's accessible name
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it('says how many suggestions wait and on which pages', () => {
    const open = vi.fn();
    render(
      <SuggestionsWaiting
        nodes={[node('a', 'Roadmap', 3), node('b', 'API'), node('c', 'Notes', 1)]}
        onOpenPage={open}
      />,
    );
    expect(screen.getByTestId('sg-waiting').textContent).toContain('✦ 4 suggestions waiting');
    screen.getByText('Roadmap · 3').click();
    expect(open).toHaveBeenCalledWith('a');
  });
});
