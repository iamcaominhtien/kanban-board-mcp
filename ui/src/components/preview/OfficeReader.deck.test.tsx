// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OfficeReader from './OfficeReader';
import type { PreviewItem } from './types';

const deck: PreviewItem = { id: 'd', name: 'Pitch.pptx', src: '/uploads/pitch.pptx' };
const pdf: PreviewItem = { id: 'p', name: 'Pitch.pdf', src: '/uploads/pitch.pdf' };

describe('OfficeReader: a deck with its PDF', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the deck's own PDF at once and lets the person go back to the outline", () => {
    render(<OfficeReader item={deck} related={[deck, pdf]} which="powerpoint" onFacts={vi.fn()} actions={null} />);
    expect(screen.getByText(/Showing Pitch\.pdf/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('show-outline'));
    expect(screen.queryByTestId('show-outline')).toBeNull();
  });
});
