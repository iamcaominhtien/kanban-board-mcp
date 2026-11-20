// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { groupBroken, parseRef } from './BrokenGroups';
import { hashTickets } from './HashTicketMenu';
import { markerWords, TableRowSnip } from './MatchMarker';
import { parsePastedPageLink } from './pastedLink';
import { brokenWhy, needsAttention } from './LinkChecker';

describe('finding and connecting pages', () => {
  it('names a table match by its row and draws the row', () => {
    expect(markerWords({ kind: 'table', row: 2 })).toBe('Table · row 2');
    expect(markerWords({ kind: 'table' })).toBe('Table');
    render(<TableRowSnip cells={['Free', '60 / min limit']} terms={['limit']} />);
    const row = screen.getByTestId('match-row');
    expect(row.children).toHaveLength(2);
    expect(row.querySelector('mark')?.textContent).toBe('limit');
    expect((row.children[1] as HTMLElement).style.background).toBe('rgb(255, 246, 214)');
  });

  it('groups broken links by what they point at, largest first', () => {
    const groups = groupBroken([
      { pageId: 'a', title: 'Overview', ref: '[[Old rules]]', status: 'missing' },
      { pageId: 'b', title: 'Planning', ref: '[[Old rules]]', status: 'missing' },
      {
        pageId: 'a',
        title: 'Overview',
        ref: '[[Decision log#Review dates]]',
        status: 'block_missing',
        blockId: 'b-000001',
      },
    ]);
    expect(groups.map((g) => [g.page, g.anchor, g.rows.length])).toEqual([
      ['Old rules', null, 2],
      ['Decision log', 'Review dates', 1],
    ]);
    expect(parseRef('[[Spec#Fields]]')).toEqual({ page: 'Spec', anchor: 'Fields' });
  });

  it('offers tickets after # by key or title', () => {
    const ts = [
      { id: 'KAN-12', title: 'Rate limiting on public endpoints', status: 'in_progress' },
      { id: 'KAN-9', title: 'Token auth', status: 'done' },
    ];
    expect(hashTickets(ts, '').map((t) => t.id)).toEqual(['KAN-12', 'KAN-9']);
    expect(hashTickets(ts, 'rate').map((t) => t.id)).toEqual(['KAN-12']);
    expect(hashTickets(ts, 'kan-9').map((t) => t.id)).toEqual(['KAN-9']);
  });

  it('reads a pasted link to a page or a block of this app', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const origin = 'http://localhost:5173';
    expect(parsePastedPageLink(`${origin}/?docs=${id}#block-b-00ab12`, origin)).toEqual({
      pageId: id,
      blockId: 'b-00ab12',
    });
    expect(parsePastedPageLink(`${origin}/?docs=${id}`, origin)).toEqual({ pageId: id, blockId: null });
    expect(parsePastedPageLink(`https://elsewhere.example/?docs=${id}`, origin)).toBeNull();
    expect(parsePastedPageLink('not a link', origin)).toBeNull();
  });

  it('says why a link needs attention', () => {
    expect(needsAttention({ kind: 'page', status: 'ok' })).toBe(false);
    expect(needsAttention({ kind: 'page', status: 'in_bin' })).toBe(true);
    expect(brokenWhy({ kind: 'page', status: 'block_missing' })).toBe('Block not found');
  });
});

describe('broken-link group fixes and gone uploads (G 40, Ai H 47)', () => {
  it('finds the closest heading, lists the pages of a group, names a gone upload', async () => {
    const { alike, closestHeading, perPage, groupBroken, mediaWhy, isMedia } = await import('./BrokenGroups');
    expect(alike('Indexes', 'Index plan')).toBeGreaterThan(0.5);
    expect(closestHeading('Indexes', [{ text: 'Fields' }, { text: 'Index plan' }])).toBe('Index plan');
    expect(closestHeading('Indexes', [{ text: 'Fields' }])).toBeNull();
    const groups = groupBroken([
      { pageId: 'a', title: 'Overview', ref: '[[Old rules]]', status: 'missing' },
      { pageId: 'b', title: 'Planning', ref: '[[Old rules]]', status: 'missing' },
      { pageId: 'b', title: 'Planning', ref: '[[Old rules]]', status: 'missing', blockId: 'b-000002' },
      { pageId: 'c', title: 'Blog', ref: '/uploads/x.mp4', status: 'video_missing', name: 'Board tour.mp4' },
    ]);
    expect(perPage(groups[0])).toBe('Overview (1) · Planning (2)');
    const video = groups.find((g) => isMedia(g.status))!;
    expect(video.page).toBe('Board tour.mp4');
    expect(mediaWhy(video.status, video.page)).toBe('Video “Board tour.mp4” is not in Project files any more');
  });
});
