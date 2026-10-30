import { describe, expect, it } from 'vitest';
import {
  canWrite,
  commentsRowLabel,
  countCitations,
  findMarkers,
  initialWriteForm,
  markNeedsInput,
  publishLabel,
  publishWarning,
  sendChips,
  stripCitations,
  tidyHints,
  ticketKeySummary,
  writeRequest,
  type SendPreview,
} from './writeRules';

describe('findMarkers', () => {
  it('finds markers with their line and label, also when the editor escaped the brackets', () => {
    const md = 'a [Needs input: maximum rows] b\n\nc \\[Needs input: exports per hour\\]';
    expect(findMarkers(md)).toEqual([
      { text: '[Needs input: maximum rows]', label: 'maximum rows', line: 1 },
      { text: '[Needs input: exports per hour\\]'.replace('\\', ''), label: 'exports per hour', line: 3 },
    ]);
  });

  it('ignores markers inside fenced code and plain brackets', () => {
    expect(findMarkers('```\n[Needs input: x]\n```\n[1] and [Needs something]')).toEqual([]);
  });
});

describe('markNeedsInput', () => {
  it('turns markers into links the reader draws as chips, leaving code alone', () => {
    const out = markNeedsInput('Limit is [Needs input: max rows] and `[Needs input: code]`.');
    expect(out).toContain('[Needs input: max rows](needsinput:Needs%20input%3A%20max%20rows)');
    expect(out).toContain('`[Needs input: code]`');
    expect(markNeedsInput('nothing here')).toBe('nothing here');
  });
});

describe('citations', () => {
  it('counts and strips [n] marks but keeps links and code', () => {
    const md = 'Streams in chunks [1]. See [docs](x) [2]\n```\na[0]\n```';
    expect(countCitations(md)).toBe(3);
    expect(stripCitations(md)).toBe('Streams in chunks. See [docs](x)\n```\na[0]\n```');
  });
});

describe('write form', () => {
  it('starts with code changes off and notes as meeting notes', () => {
    expect(initialWriteForm('ticket').codeChanges).toBe(false);
    expect(initialWriteForm('notes').pageKind).toBe('meeting_notes');
    expect(initialWriteForm('ticket', { ticketId: 'KAN-1' }).ticketId).toBe('KAN-1');
  });

  it('needs a source and a title', () => {
    const t = initialWriteForm('ticket');
    expect(canWrite(t, 'x')).toBe(false);
    expect(canWrite({ ...t, ticketId: 'KAN-1' }, ' ')).toBe(false);
    expect(canWrite({ ...t, ticketId: 'KAN-1' }, 'x')).toBe(true);
    expect(canWrite(initialWriteForm('notes', { text: ' ' }), 'x')).toBe(false);
    expect(canWrite(initialWriteForm('prompt', { text: 'a page' }), 'x')).toBe(true);
  });

  it('only sends code changes for a ticket and never when off', () => {
    const f = { ...initialWriteForm('ticket', { ticketId: 'KAN-1' }), codeChanges: true };
    expect(writeRequest(f, ' T ', 'p1').include.codeChanges).toBe(true);
    expect(writeRequest({ ...f, kind: 'notes', text: 'n' }, 'T', null).include.codeChanges).toBe(false);
    expect(writeRequest({ ...f, codeChanges: false }, 'T', null).include.codeChanges).toBe(false);
    expect(writeRequest(f, ' T ', 'p1')).toMatchObject({ title: 'T', parentId: 'p1', source: { ticketId: 'KAN-1' } });
  });
});

describe('what will be sent', () => {
  const preview: SendPreview = {
    send: {
      ticket: { id: 'KAN-154', title: 'Export' },
      description: true,
      comments: 4,
      pages: [
        { id: 'a', title: 'Auth' },
        { id: 'b', title: 'Data model' },
      ],
      code: false,
      idea: false,
      notes: false,
      prompt: false,
      styleGuide: null,
    },
    skipped: [{ pageId: 'h', title: 'Secret', reason: 'hidden from AI' }],
    notes: [],
  };

  it('lists the ticket, comments and pages, and code only when it is on', () => {
    expect(sendChips(preview).map((c) => c.label)).toEqual(['Ticket', '4 comments', '2 pages']);
    expect(
      sendChips({ ...preview, send: { ...preview.send, code: true, styleGuide: 'Writing docs' } }).map((c) => c.id),
    ).toEqual(['ticket', 'comments', 'pages', 'code', 'style']);
  });

  it('words the comments row', () => {
    expect(commentsRowLabel(4)).toBe('The ticket description and 4 comments');
    expect(commentsRowLabel(1)).toBe('The ticket description and 1 comment');
    expect(commentsRowLabel(null)).toContain('its comments');
  });
});

describe('publish warning', () => {
  it('is hidden without markers', () => {
    expect(publishWarning([]).show).toBe(false);
    expect(publishLabel([], 15)).toBe('Publish v15');
  });

  it('names the marker and the button turns into Publish anyway', () => {
    const w = publishWarning(findMarkers('x [Needs input: maximum rows per export]'));
    expect(w.title).toBe('1 Needs input marker is still in this draft');
    expect(w.detail).toBe('Maximum rows per export. Readers would see the marker.');
    expect(publishLabel(findMarkers('[Needs input: a]'), 15)).toBe('Publish anyway');
  });

  it('counts several markers', () => {
    const w = publishWarning(findMarkers('[Needs input: a] [Needs input: b]'));
    expect(w.title).toBe('2 Needs input markers are still in this draft');
    expect(w.detail).toContain('a; b');
  });
});

describe('tidy hints', () => {
  it('words the counts like the design', () => {
    const keys = [
      { key: 'KAN-12', count: 6, known: true },
      { key: 'KAN-31', count: 2, known: true },
    ];
    expect(ticketKeySummary(keys)).toBe('KAN-12 found 6 times, KAN-31 twice');
    expect(ticketKeySummary([])).toBe('No ticket keys found');
    const h = tidyHints({ pages: 6, ticketKeys: keys, ticketKeyTotal: 8, seeLinks: 4 }, 6);
    expect(h.splitByHeading).toBe('6 pages instead of 1 long page');
    expect(h.seeLinks).toBe('4 found. Shown for review before they are added');
    expect(tidyHints(null, 1).splitByHeading).toBe('Only one section found');
  });
});
