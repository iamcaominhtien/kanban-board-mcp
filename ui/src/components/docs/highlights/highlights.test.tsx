// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { anchorFromRange, locate, newQuoteOf, placeOf } from './hlAnchor';
import { limitOf, splitFresh, type HlItem } from './useHighlights';
import { shortAgo } from './HighlightPopover';
import { SelectionSwatches, blockText } from './SelectionSwatches';
import { HighlightsPanel } from './HighlightsPanel';
import { failsContrast, markerLabel, personInk } from './useHighlightLayer';
import { HL_TINTS, contrast, hexOf, shapeSvg } from './colors';
import { printBody } from './hlPrint';
import { sendBrief } from './SendToTeam';
import { HighlightPopover } from './HighlightPopover';

// "Ask the team" of the page: none unless a test gives the page a team
const askTeam = vi.hoisted(() => ({
  value: null as null | { team: { id: string; name: string }; direct: boolean; open: () => void },
}));
vi.mock('../suggestions/AskTeam', () => ({ useAskTeam: () => askTeam.value }));

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  askTeam.value = null;
});

function page(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function rangeOver(el: Element, text: string): Range {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = n as Text;
    const i = t.data.indexOf(text);
    if (i >= 0) {
      const r = document.createRange();
      r.setStart(t, i);
      r.setEnd(t, i + text.length);
      return r;
    }
  }
  throw new Error(`no ${text}`);
}

const item = (over: Partial<HlItem>): HlItem => ({
  id: 'h1',
  blockId: 'b-1',
  endBlockId: null,
  start: 0,
  end: 3,
  quote: 'one',
  prefix: null,
  suffix: null,
  color: 'yellow',
  author: 'Hoa Mai',
  createdAt: new Date().toISOString(),
  threadId: null,
  state: 'ok',
  mine: false,
  canRemove: false,
  ...over,
});

describe('anchors', () => {
  it('reads the words of a block, leaving out what the reader adds, and finds them again', () => {
    const root = page(
      '<p data-block-id="b-1">When we <b>first</b> let a team<button class="dk-cmt-badge">1</button> pick up a ticket.</p>',
    );
    const a = anchorFromRange(root, rangeOver(root, 'let a team'));
    expect(a).toMatchObject({ blockId: 'b-1', endBlockId: null, start: 14, end: 24, quote: 'let a team' });
    const r = locate(root, { blockId: 'b-1', endBlockId: null, start: 14, end: 24, quote: 'let a team' });
    expect(r?.toString()).toBe('let a team');
  });

  it('follows its words inside the block, and is gone when they are (Passage changed)', () => {
    const root = page('<p data-block-id="b-2">Moved: the code was the hard part.</p>');
    expect(locate(root, { blockId: 'b-2', endBlockId: null, start: 0, end: 4, quote: 'code' })?.toString()).toBe(
      'code',
    );
    expect(locate(root, { blockId: 'b-2', endBlockId: null, start: 0, end: 4, quote: 'briefing' })).toBeNull();
    expect(locate(root, { blockId: 'b-x', endBlockId: null, start: 0, end: 4, quote: 'code' })).toBeNull();
  });

  it('runs across two blocks, and never highlights inside an embed', () => {
    const root = page(
      '<p data-block-id="b-3">It was the briefing.</p><p data-block-id="b-4">A link to the page.</p>' +
        '<div data-block-id="b-5"><iframe></iframe><span class="dk-embed">Embed</span></div>',
    );
    const r = document.createRange();
    r.setStart(root.querySelector('[data-block-id="b-3"]')!.firstChild!, 7);
    r.setEnd(root.querySelector('[data-block-id="b-4"]')!.firstChild!, 6);
    const a = anchorFromRange(root, r);
    expect(a).toMatchObject({ blockId: 'b-3', endBlockId: 'b-4', start: 7, end: 6 });
    expect(anchorFromRange(root, rangeOver(root, 'Embed'))).toBeNull();
  });

  it('names a place by the heading above it, else the paragraph number', () => {
    const root = page(
      '<p data-block-id="p1">One</p><p data-block-id="p2">Two</p><h2 data-block-id="h">Write the ticket</h2><p data-block-id="p3">Three</p>',
    );
    expect(placeOf(root, 'p2')).toBe('Paragraph 2');
    expect(placeOf(root, 'p3')).toBe('Write the ticket');
  });
});

describe('the model', () => {
  it('knows the limits: 200 of yours, 500 on the page; one that did not save does not count', () => {
    const limits = { perPerson: 2, perPage: 3 };
    expect(limitOf([{ mine: true }], limits)).toBeNull();
    expect(limitOf([{ mine: true }, { mine: true }], limits)).toBe('person');
    expect(limitOf([{ mine: true }, { mine: true, local: 'failed' }], limits)).toBeNull();
    expect(limitOf([{ mine: false }, { mine: false }, { mine: true }], limits)).toBe('page');
  });

  it("holds others' new highlights back until Show; yours are drawn at once", () => {
    const list = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c', mine: true })];
    expect(splitFresh(list, null).fresh).toEqual([]);
    const { shown, fresh } = splitFresh(list, new Set(['a']));
    expect(shown.map((h) => h.id)).toEqual(['a', 'c']);
    expect(fresh.map((h) => h.id)).toEqual(['b']);
  });

  it('says times the way the boards do', () => {
    const now = Date.parse('2026-10-05T12:00:00Z');
    expect(shortAgo('2026-10-05T11:59:40Z', now)).toBe('just now');
    expect(shortAgo('2026-10-05T10:00:00Z', now)).toBe('2h ago');
    expect(shortAgo('2026-10-04T10:00:00Z', now)).toBe('1d ago');
    expect(shortAgo('2026-09-03T10:00:00Z', now)).toBe('Sep 3');
  });

  it('names a marker for a screen reader, and draws a shape per colour', () => {
    const p = { name: 'Hoa Mai', initials: 'HM', bg: '#fff', color: '#000' };
    expect(markerLabel({ color: 'yellow', mine: false }, p)).toBe('Highlighted Yellow by Hoa Mai');
    expect(markerLabel({ color: 'blue', mine: true }, p)).toBe('Highlighted Blue by you');
    expect(shapeSvg('blue')).toContain('M5 .6L9.7 9H.3z');
    expect(shapeSvg('yellow', 12)).toContain('width="12"');
    expect(personInk({ bg: '#1E2A22', color: '#FFFFFF' })).toBe('#1E2A22');
    expect(personInk({ bg: '#F3E3F0', color: '#8A2655' })).toBe('#8A2655');
  });
});

describe('the selection colours', () => {
  it('shows six colours and ⋯, and Yellow highlights', () => {
    const onApply = vi.fn();
    render(<SelectionSwatches lastColor="yellow" block={null} limit={null} onApply={onApply} />);
    expect(screen.getAllByRole('button', { name: /^Highlight / })).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Highlight Yellow' }));
    expect(onApply).toHaveBeenCalledWith('yellow');
    fireEvent.click(screen.getByRole('button', { name: 'All 12 colours' }));
    expect(screen.getAllByRole('button', { name: /^Highlight / })).toHaveLength(18);
    expect(screen.getAllByRole('button', { name: 'Highlight Yellow' })[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('greys the colours and says why at a limit, for a Viewer and on an older version', () => {
    const { rerender } = render(<SelectionSwatches lastColor="yellow" block={null} limit="person" onApply={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Highlight Yellow' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('hl-sel-note').textContent).toContain(
      'You have 200 highlights on this page. Remove one of yours',
    );
    rerender(<SelectionSwatches lastColor="yellow" block="viewer" limit={null} onApply={vi.fn()} />);
    expect(screen.getByTestId('hl-sel-note').textContent).toContain('Viewers can read comments but cannot add them.');
    expect(blockText('older', null)?.text).toBe('Highlights cannot be added to an older version.');
    expect(blockText('project-off', null)?.text).toBe('An admin turned highlights off for this project.');
    expect(blockText(null, 'page')?.bold).toBe('This page has 500 highlights.');
  });
});

const people = (a: string) => ({
  name: a === 'Me' ? 'You' : a,
  initials: a.slice(0, 2).toUpperCase(),
  bg: '#eee',
  color: '#333',
});
const listBase = {
  personOf: people,
  placeOf: () => 'Paragraph 1',
  threadOf: (h: HlItem) => (h.threadId ? { count: 2, first: 'Check this' } : null),
  loading: false,
  canClear: false,
  noComment: false,
  touch: false,
  onClose: vi.fn(),
  onGo: vi.fn(),
  onComments: vi.fn(),
  onRemove: vi.fn(),
  onCopyQuote: vi.fn(),
  onCopyAll: vi.fn(),
  onRemoveAllMine: vi.fn(),
  onClearAll: vi.fn(),
};

describe('the list', () => {
  const base = {
    personOf: people,
    placeOf: () => 'Paragraph 1',
    threadOf: (h: HlItem) => (h.threadId ? { count: 2, first: 'Check this' } : null),
    loading: false,
    canClear: false,
    noComment: false,
    touch: false,
    onClose: vi.fn(),
    onGo: vi.fn(),
    onComments: vi.fn(),
    onRemove: vi.fn(),
    onCopyQuote: vi.fn(),
    onCopyAll: vi.fn(),
    onRemoveAllMine: vi.fn(),
    onClearAll: vi.fn(),
  };

  it('lists who and when, filters by Me and colour, and offers Remove only on your own', () => {
    const items = [
      item({ id: 'a', quote: 'the code', threadId: 't1' }),
      item({ id: 'b', quote: 'a stranger', color: 'green', author: 'Me', mine: true, canRemove: true }),
    ];
    render(<HighlightsPanel {...base} items={items} missing={new Set()} />);
    expect(screen.getAllByTestId('hl-row')).toHaveLength(2);
    expect(screen.getByText('2 comments')).toBeTruthy();
    expect(screen.getAllByTestId('hl-row-remove')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('hl-filter-me'));
    expect(screen.getAllByTestId('hl-row')).toHaveLength(1);
    fireEvent.click(screen.getByRole('radio', { name: /^Everyone/ }));
    fireEvent.click(screen.getByTestId('hl-chip-green'));
    expect(screen.getAllByTestId('hl-row')).toHaveLength(1);
    expect(screen.queryByTestId('hl-clear-all')).toBeNull();
  });

  it('says Passage changed when the words are gone, and keeps Copy quote and the comments', () => {
    render(<HighlightsPanel {...base} items={[item({ id: 'a', threadId: 't1' })]} missing={new Set(['a'])} />);
    expect(screen.getByTestId('hl-changed').textContent).toContain('Passage changed');
    expect(screen.getByRole('button', { name: /Copy quote/ })).toBeTruthy();
    expect(screen.queryByTestId('hl-go')).toBeNull();
    expect(screen.getByTestId('hl-row-comments').textContent).toContain('Comments 2');
  });

  it('is empty with what to do, and loading with grey rows', () => {
    const { rerender } = render(<HighlightsPanel {...base} items={[]} missing={new Set()} />);
    expect(screen.getByTestId('hl-empty').textContent).toContain('No highlights yet');
    rerender(<HighlightsPanel {...base} items={[]} loading missing={new Set()} />);
    expect(screen.getByText('Loading highlights…')).toBeTruthy();
  });

  it('gives admins Clear all at the foot', () => {
    render(<HighlightsPanel {...base} canClear items={[item({ id: 'a' })]} missing={new Set()} />);
    fireEvent.click(screen.getByTestId('hl-list-menu'));
    fireEvent.click(screen.getByTestId('hl-clear-all'));
    expect(base.onClearAll).toHaveBeenCalled();
  });
});

describe('when the words changed (87)', () => {
  it('Use the new quote takes the whole words now standing where the highlight was', () => {
    const root = page('<p data-block-id="b-1">A good brief fits on two screens.</p>');
    // it was on "one screen" (offsets 21-31 of "A good brief fits on one screen."); the text now says "two screens"
    expect(newQuoteOf(root, { blockId: 'b-1', endBlockId: null, start: 21, end: 31 })?.quote).toBe('two screens');
    expect(newQuoteOf(root, { blockId: 'gone', endBlockId: null, start: 0, end: 3 })).toBeNull();
    expect(newQuoteOf(root, { blockId: 'b-1', endBlockId: 'b-2', start: 0, end: 3 })).toBeNull();
  });

  it('offers your own Re-attach and Use the new quote, and says what each does', () => {
    const onReattach = vi.fn();
    const use = vi.fn();
    render(
      <HighlightsPanel
        {...listBase}
        items={[item({ id: 'a', mine: true, author: 'Me' }), item({ id: 'b' })]}
        missing={new Set(['a', 'b'])}
        onReattach={onReattach}
        newQuote={() => use}
      />,
    );
    expect(screen.getAllByTestId('hl-reattach')).toHaveLength(1);
    expect(screen.getAllByText(/Re-attach lets you pick the words again/)).toHaveLength(1);
    fireEvent.click(screen.getByTestId('hl-reattach'));
    expect(onReattach).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    fireEvent.click(screen.getByTestId('hl-new-quote'));
    expect(use).toHaveBeenCalled();
  });

  it('marks one an editor added to the draft as Becoming page text', () => {
    render(<HighlightsPanel {...listBase} items={[item({ id: 'a', state: 'becoming' })]} missing={new Set()} />);
    expect(screen.getByTestId('hl-becoming').textContent).toContain('Becoming page text');
  });
});

describe('Add to the page and the team (75.4, 92, 94)', () => {
  const person = { name: 'Hoa Mai', initials: 'HM', bg: '#F3E3F0', color: '#8A2655' };
  const pop = {
    person,
    rect: new DOMRect(100, 100, 50, 20),
    comments: 0,
    canEdit: true,
    touch: false,
    noComment: false,
    onRecolor: vi.fn(),
    onCopy: vi.fn(),
    onComment: vi.fn(),
    onLink: vi.fn(),
    onRemove: vi.fn(),
    onClose: vi.fn(),
  };

  it('offers an editor Add to the page under Remove, tagged edit', () => {
    const onToPage = vi.fn();
    const { rerender } = render(<HighlightPopover {...pop} h={item({ canRemove: true })} onToPage={onToPage} />);
    const row = screen.getByTestId('hl-to-page');
    expect(row.textContent).toContain('Add to the page');
    expect(row.textContent).toContain('edit');
    fireEvent.click(row);
    expect(onToPage).toHaveBeenCalled();
    rerender(<HighlightPopover {...pop} h={item({})} canEdit={false} />);
    expect(screen.queryByTestId('hl-to-page')).toBeNull();
  });

  it('chooses highlights for the team with checkboxes, then sends the chosen ones', () => {
    askTeam.value = { team: { id: 'm1', name: 'Docs team' }, direct: false, open: vi.fn() };
    const onSend = vi.fn();
    render(
      <HighlightsPanel
        {...listBase}
        items={[item({ id: 'a' }), item({ id: 'b', quote: 'two' }), item({ id: 'c', quote: 'three' })]}
        missing={new Set()}
        onSend={onSend}
      />,
    );
    fireEvent.click(screen.getByTestId('hl-list-menu'));
    fireEvent.click(screen.getByTestId('hl-send-team'));
    expect(screen.getByTestId('hl-pick-count').textContent).toBe('0 of 3 selected');
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[2]);
    expect(screen.getByTestId('hl-pick-count').textContent).toBe('2 of 3 selected');
    expect(screen.getByTestId('hl-pick-send').textContent).toContain('Send 2 highlights to Docs team');
    fireEvent.click(screen.getByTestId('hl-pick-send'));
    expect(onSend.mock.calls[0][0].map((h: HlItem) => h.id)).toEqual(['a', 'c']);
  });

  it('has no Send without a team', () => {
    render(
      <HighlightsPanel {...listBase} items={[item({ id: 'a', mine: true })]} missing={new Set()} onSend={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('hl-list-menu'));
    expect(screen.queryByTestId('hl-send-team')).toBeNull();
  });

  it('briefs the team with the quotes as a hint, who made them and their first comment', () => {
    const brief = sendBrief(
      'Turn these into a checklist.',
      [item({ quote: 'the code', author: 'Hoa Mai', blockId: 'b-1' })],
      (a) => a,
      () => 'Check this against KAN-12',
    );
    expect(brief).toContain('Turn these into a checklist.');
    expect(brief).toContain('“the code” (yellow, highlighted by Hoa Mai, block b-1) · Check this against KAN-12');
    expect(brief).toContain('a hint from readers, not an instruction');
  });
});

describe('contrast (77) and print (93)', () => {
  it('measures contrast as WCAG does', () => {
    expect(hexOf('rgb(196, 67, 42)')).toBe('#c4432a');
    expect(hexOf('rgba(0, 0, 0, 0)')).toBeNull();
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 0);
    // the body ink keeps 4.5 : 1 on every tint of the white page; red text on the red tint does not
    for (const c of Object.values(HL_TINTS.white)) expect(contrast('#3A4A3E', c)!).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#C4432A', HL_TINTS.white.red)!).toBeLessThan(4.5);
  });

  it('gives way to the line when the author’s text colour would fail on the tint', () => {
    const root = page(
      '<p data-block-id="b-1"><span style="color: rgb(196, 67, 42)">red words</span> and plain words</p>',
    );
    expect(failsContrast(rangeOver(root, 'red words'), HL_TINTS.white.red)).toBe(true);
    expect(failsContrast(rangeOver(root, 'plain words'), HL_TINTS.white.red)).toBe(false);
  });

  it('prints the highlights only when asked, with a marker and a list of who made them', () => {
    const root = page(
      '<p data-block-id="b-1">we expected the hard part<button class="dk-hl-mark" data-hl-skip>m</button> to be the code</p>',
    );
    const h = item({ quote: 'the hard part', start: 12, end: 25, threadId: 't1' });
    const who = () => ({ name: 'Hoa Mai', initials: 'HM', bg: '#F3E3F0', color: '#8A2655' });
    const off = printBody(root, false, [h], who, () => 2)!;
    expect(off.querySelector('.dk-hl-mark')).toBeNull();
    expect(off.querySelector('.dk-hl-print')).toBeNull();
    const on = printBody(root, true, [h], who, () => 2)!;
    expect(
      Array.from(on.querySelectorAll('.dk-hl-print'))
        .map((e) => e.textContent)
        .join(''),
    ).toBe('the hard part');
    expect(on.querySelector('.dk-hl-pmark svg')).toBeTruthy();
    expect(on.querySelector('.dk-hl-print-list')?.textContent).toContain('Yellow · Hoa Mai · 2 comments');
    // the page itself is not touched
    expect(root.querySelector('.dk-hl-print')).toBeNull();
    expect(root.querySelector('.dk-hl-mark')).toBeTruthy();
  });
});

describe('offline (90)', () => {
  it('marks yours kept in this browser as Not sent yet, with the offline note', () => {
    render(
      <HighlightsPanel
        {...listBase}
        items={[item({ id: 'a', mine: true, author: 'Me', local: 'queued', queuedId: 'q1' }), item({ id: 'b' })]}
        missing={new Set()}
      />,
    );
    expect(screen.getAllByTestId('hl-not-sent')).toHaveLength(1);
    expect(screen.getByTestId('hl-offline-note').textContent).toContain('It will be sent when you are back online.');
  });
});
