// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OfficeReader from './OfficeReader';

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const slide = (text: string) =>
  `<p:sld ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="3000"/><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
const file = zipSync({
  'ppt/presentation.xml': strToU8(`<p:presentation ${NS}><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`),
  'ppt/slides/slide1.xml': strToU8(slide('First slide')),
  'ppt/slides/slide2.xml': strToU8(slide('Second slide')),
});

describe('OfficeReader: PowerPoint', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(file)),
    );
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => undefined }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('draws the slides, and the outline is one click away', async () => {
    render(
      <OfficeReader
        item={{ id: 'a', name: 'deck.pptx', src: '/uploads/deck.pptx' }}
        which="powerpoint"
        onFacts={vi.fn()}
        actions={null}
      />,
    );
    await waitFor(() => expect(screen.getAllByTestId('slide-canvas').length).toBeGreaterThan(0));
    expect(screen.getAllByText('First slide').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId('slides-mode'));
    expect(screen.queryAllByTestId('slide-canvas')).toHaveLength(0);
    expect(screen.getByText(/Showing the outline/)).toBeTruthy();
  });
});
