import { describe, expect, it } from 'vitest';
import type { RichDoc } from '../../../types/docs';
import type { AiTeam, TeamActivity } from '../../../types/ai';
import { editedPhrase, editedRows } from '../AiChangedBar';
import { teamSubline } from '../GivePageDialog';
import { blockChips, rowCounts } from '../ai/SinceViewedDigest';
import { formattingIcon } from '../ai/NeedsInput';
import { brokenMediaText } from '../ai/DocsHealthView';
import { countChanges, diffBlocks } from '../history/blockDiff';
import type { TeamNote } from './api';
import { lostPhrase, noteWords } from './TeamNotes';

const p = (id: string, text: string, attrs: Record<string, unknown> = {}): RichDoc => ({
  type: 'paragraph',
  attrs: { blockId: id, ...attrs },
  content: [{ type: 'text', text }],
});
const doc = (...content: RichDoc[]): RichDoc => ({ type: 'doc', content });

describe('a team note (G 35–36)', () => {
  const note: TeamNote = {
    id: 'n1',
    kind: 'formatting',
    blockId: 'b-1',
    author: 'Docs team',
    memberId: null,
    runId: null,
    createdAt: '',
    wrote: 'Plain words.',
    after: null,
    lost: { colour: 1, highlight: 1, link: 2 },
  };
  it('names what a rewrite would have removed', () => {
    expect(lostPhrase({ colour: 1, highlight: 1, link: 2 })).toBe('1 colour, 1 highlight and 2 links');
    expect(lostPhrase({ font: 1 })).toBe('1 font change');
    expect(noteWords(note)).toEqual({
      lead: 'Docs team left this block as it is.',
      rest: 'Rewriting it would have removed its formatting: 1 colour, 1 highlight and 2 links.',
    });
  });
  it('says a locked block was not changed', () => {
    expect(noteWords({ ...note, kind: 'locked' }).lead).toBe(
      'Docs team wanted to change this block, but it is locked for teams.',
    );
  });
});

describe('the chip of a page a team edited directly (A 2)', () => {
  it('says what it did in the board words, and lists each block', () => {
    const before = doc(p('b-1', 'One'), p('b-2', 'Two'), p('b-3', 'Three'));
    const after = doc(p('b-1', 'One'), p('b-2', 'Two', { textAlign: 'center' }), p('b-3', 'Three, more'), {
      type: 'pullQuote',
      attrs: { blockId: 'b-9' },
      content: [{ type: 'text', text: 'Q' }],
    });
    const changes = diffBlocks(before, after);
    expect(editedPhrase(countChanges(changes))).toBe('edited 2 blocks, added 1');
    const rows = editedRows(changes, after);
    expect(rows.map((r) => [r.place, r.what])).toEqual([
      ['Paragraph 2', 'Alignment: left → centre'],
      ['Paragraph 3', 'Text edited'],
      ['After paragraph 3', 'Pull quote'],
    ]);
    expect(editedPhrase(null)).toBe('changed this page');
  });
});

describe('Give the page: a team’s line (E 23)', () => {
  const team = { id: 't', roles: [{ key: 'docs', name: 'Docs' }], paused: false } as unknown as AiTeam;
  it('names the roles and what the team does now', () => {
    expect(teamSubline(team, undefined)).toBe('Lead and Docs role · idle');
    const busy = {
      lead: { working: { ticketId: 'KAN-171' } },
      roles: [],
    } as unknown as TeamActivity;
    const three = {
      ...team,
      roles: [
        { key: 'dev', name: 'Dev' },
        { key: 'rev', name: 'Reviewer' },
        { key: 'qa', name: 'QA' },
      ],
    } as unknown as AiTeam;
    expect(teamSubline(three, busy)).toBe('Dev, Reviewer, QA · working on KAN-171');
    expect(teamSubline({ ...team, paused: true }, busy)).toBe('Lead and Docs role · paused');
    expect(teamSubline(undefined, undefined)).toBeNull();
  });
});

describe('the digest row (H 44)', () => {
  it('names the changed blocks and the new ones', () => {
    const b = {
      edited: 3,
      added: 1,
      removed: 0,
      blocks: [
        { blockId: 'a', type: 'paragraph', level: null, n: 2, change: 'edited' as const },
        { blockId: 'b', type: 'heading', level: 2, n: 2, change: 'edited' as const },
        { blockId: 'c', type: 'image', level: null, n: null, change: 'edited' as const },
        { blockId: 'd', type: 'pullQuote', level: null, n: null, change: 'added' as const },
      ],
    };
    expect(blockChips('changed', b).map((c) => c.label)).toEqual(['Paragraph 2', 'Heading 2', 'Image', '+ Pull quote']);
    expect(rowCounts('changed', b)).toBe('3 blocks edited, 1 added');
    const fresh = { edited: 0, added: 14, removed: 0, blocks: [] };
    expect(blockChips('new', fresh)).toEqual([{ label: '+ 14 blocks', added: true }]);
    expect(rowCounts('new', fresh)).toBe('new page');
  });
});

describe('the small words of Docs health and the draft panel', () => {
  it('says what is broken and picks an icon for the formatting', () => {
    const base = { pageId: 'p', title: 'T', ref: '/uploads/a.mp4' };
    expect(brokenMediaText({ ...base, status: 'video_missing', name: 'Board tour.mp4' })).toBe(
      'Video “Board tour.mp4” is not in Project files any more',
    );
    expect(brokenMediaText({ ...base, status: 'image_missing', name: 'The valley road' })).toBe(
      'The image file was deleted: “The valley road”',
    );
    expect(formattingIcon('Title and subtitle centred')).toBe('align');
    expect(formattingIcon('Image floated right')).toBe('float');
    expect(formattingIcon('Pull quote')).toBe('quote');
    expect(formattingIcon('Cover image')).toBe('image');
  });
});
