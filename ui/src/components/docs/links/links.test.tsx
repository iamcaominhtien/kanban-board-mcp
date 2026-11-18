// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { pageRefKey } from '../../../utils/docsMarkdown';
import { blockOfAnchor, revealBlock } from './blockAnchor';
import { findNode } from './BlockCard';
import { kindWord } from './BlockKind';
import { MatchMarker, markerWords, matchAnchor } from './MatchMarker';

describe('links to headings and blocks', () => {
  it('reads a block id from an anchor or a copied link', () => {
    expect(blockOfAnchor('b-3f2a9c')).toBe('b-3f2a9c');
    expect(blockOfAnchor('block-b-3f2a9c')).toBe('b-3f2a9c');
    expect(blockOfAnchor('limits')).toBeNull();
    expect(blockOfAnchor(null)).toBeNull();
  });

  it('keeps a link that stores ids apart from one by title', () => {
    expect(pageRefKey({ title: 'Spec', anchor: null })).toBe('Spec#');
    expect(pageRefKey({ title: 'Spec', pageId: 'p1', blockId: 'b-000001' })).toBe('Spec#@p1/b-000001');
  });

  it('scrolls to the block and marks it, then takes the mark away', () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div data-block-id="b-00000a">Limits</div>';
    const el = document.querySelector('[data-block-id]') as HTMLElement;
    el.scrollIntoView = vi.fn();
    const stop = revealBlock('b-00000a');
    vi.advanceTimersByTime(100);
    expect(el.scrollIntoView).toHaveBeenCalled();
    expect(el.classList.contains('dk-link-arrive')).toBe(true);
    vi.advanceTimersByTime(4100);
    expect(el.classList.contains('dk-link-arrive')).toBe(false);
    stop();
    vi.useRealTimers();
  });

  it('names a match by what it is, and opens it at its block', () => {
    expect(markerWords({ kind: 'image', field: 'caption' })).toBe('Picture · caption');
    expect(markerWords({ kind: 'image', field: 'alt' })).toBe('Picture · description');
    expect(markerWords({ kind: 'text' })).toBeNull();
    expect(matchAnchor({ blockId: 'b-000002', slug: 'limits' })).toBe('b-000002');
    expect(matchAnchor({ blockId: null, slug: 'limits' })).toBe('limits');
    render(<MatchMarker match={{ kind: 'table' }} />);
    expect(screen.getByTestId('match-marker').textContent).toBe('Table');
    expect(kindWord('code')).toBe('code');
  });

  it('finds a block anywhere in a page', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'columns',
          attrs: { blockId: 'b-000001' },
          content: [{ type: 'paragraph', attrs: { blockId: 'b-000002' } }],
        },
      ],
    };
    expect(findNode(doc as never, 'b-000002')?.type).toBe('paragraph');
    expect(findNode(doc as never, 'b-ffffff')).toBeNull();
  });
});
