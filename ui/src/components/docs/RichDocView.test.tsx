// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocsRefRequest, RichDoc } from '../../types/docs';

const refs = vi.hoisted(() => ({ asked: [] as DocsRefRequest[][] }));

vi.mock('../../api/docs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/docs')>()),
  useResolveRefs: (_projectId: string, list: DocsRefRequest[]) => {
    refs.asked.push(list);
    return {
      data: list.map((r) =>
        r.kind === 'page'
          ? { kind: 'page', status: 'ok', pageId: `id-${r.title}`, title: r.title }
          : r.key.startsWith('MH-') || r.key === 'KAN-999'
            ? // a screen id, or a ticket that does not exist
              { kind: 'ticket', status: 'missing', key: r.key }
            : { kind: 'ticket', status: 'ok', key: r.key, title: `Ticket ${r.key}`, ticketStatus: 'todo' },
      ),
    };
  },
}));
vi.mock('../../api/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/projects')>()),
  useProjectPrefixes: () => new Set(['KAN']),
}));
vi.mock('../diagrams/DiagramEmbed', () => ({
  DiagramEmbed: ({ id, label }: { id: string; label: string }) => <div data-testid="diagram">{`${id}:${label}`}</div>,
}));
vi.mock('../sketch/SketchEmbed', () => ({
  SketchEmbed: ({ id }: { id: string }) => <div data-testid="sketch">{id}</div>,
}));
vi.mock('../canvas/CanvasEmbed', () => ({
  CanvasEmbed: ({ id, boardId }: { id: string; boardId?: string }) => (
    <div data-testid="canvas">{`${id}:${boardId ?? ''}`}</div>
  ),
  CanvasChip: () => null,
}));
vi.mock('../FileAttachmentCard', () => ({
  FileAttachmentCard: ({ url, fileName }: { url: string; fileName: string }) => (
    <span data-testid="file-card">{`${fileName}@${url}`}</span>
  ),
}));

import { markdownToDoc, seqIds } from '../../richdoc';
import { DocsMarkdown } from './DocsMarkdown';
import { RichDocView } from './RichDocView';

afterEach(() => {
  cleanup();
  refs.asked = [];
});

function show(doc: RichDoc, extra: Partial<Parameters<typeof RichDocView>[0]> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RichDocView doc={doc} projectId="p1" {...extra} />
    </QueryClientProvider>,
  );
}

const t = (text: string, marks?: RichDoc['marks']): RichDoc =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };
const para = (blockId: string, content: RichDoc[], attrs: Record<string, unknown> = {}): RichDoc => ({
  type: 'paragraph',
  attrs: { blockId, ...attrs },
  content,
});

describe('RichDocView: what DocsMarkdown shows', () => {
  const md = [
    '# Guide',
    '',
    '## Setup',
    '',
    'Install it.',
    '',
    '## Setup',
    '',
    '### Café & *bar*',
    '',
    '- one',
    '- two',
    '',
    '- [x] done',
    '- [ ] open',
    '',
    '| Method | Path |',
    '| --- | --- |',
    '| GET | /x |',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '> [!WARNING]',
    '> Careful.',
  ].join('\n');

  it('gives headings the ids the Markdown reader gives them, and an h2 its section link', () => {
    const doc = markdownToDoc(md, seqIds());
    const rich = show(doc);
    const ids = Array.from(rich.container.querySelectorAll('h1,h2,h3')).map((h) => h.id);
    const anchors = Array.from(rich.container.querySelectorAll('h2 .dk-anchor')).map((a) => a.getAttribute('href'));
    rich.unmount();
    const old = render(
      <QueryClientProvider client={new QueryClient()}>
        <DocsMarkdown projectId="p1">{md}</DocsMarkdown>
      </QueryClientProvider>,
    );
    expect(ids).toEqual(Array.from(old.container.querySelectorAll('h1,h2,h3')).map((h) => h.id));
    expect(ids).toEqual(['docs-guide', 'docs-setup', 'docs-setup-2', 'docs-café-bar']);
    expect(anchors).toEqual(['#setup', '#setup-2']);
  });

  it('draws task lists, tables, code and callouts with the classes comments and find-in-page read', () => {
    const { container } = show(markdownToDoc(md, seqIds()));
    expect(container.querySelector('.dk-md')).toBeTruthy();
    expect(container.querySelectorAll('ul.dk-tasks li.dk-task')).toHaveLength(2);
    expect(container.querySelector('li.dk-task [role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('table.dk-table thead th')?.textContent).toBe('Method');
    expect(container.querySelector('table.dk-table td span')?.textContent).toBe('GET');
    expect(container.querySelector('.dk-code')?.getAttribute('data-lang')).toBe('ts');
    expect(container.querySelector('.dk-code')?.textContent).toContain('const a = 1;');
    expect(container.querySelector('.dk-callout[data-callout="warning"]')?.textContent).toContain('Careful.');
  });

  it('puts data-block-id on every block', () => {
    const doc = markdownToDoc(md, seqIds());
    const { container } = show(doc);
    const ids: string[] = [];
    const walk = (n: RichDoc) => {
      if (typeof n.attrs?.blockId === 'string') ids.push(n.attrs.blockId);
      n.content?.forEach(walk);
    };
    walk(doc);
    expect(ids.length).toBeGreaterThan(15);
    for (const id of ids) expect(container.querySelector(`[data-block-id="${id}"]`), id).toBeTruthy();
  });
});

describe('RichDocView: references and embeds', () => {
  const doc: RichDoc = {
    type: 'doc',
    content: [
      para('b-000001', [
        t('See '),
        { type: 'docRef', attrs: { page: 'API', section: 'Auth', label: null } },
        t(', '),
        { type: 'docRef', attrs: { page: 'Spec', label: 'the spec' } },
        t(', '),
        { type: 'ticketRef', attrs: { key: 'KAN-1' } },
        t(' and KAN-2 [Needs input: owner]'),
      ]),
      para('b-000002', [t('report.pdf', [{ type: 'link', attrs: { href: '/uploads/report_ab.pdf' } }])]),
      para('b-000003', [t('site', [{ type: 'link', attrs: { href: 'https://example.com' } }])]),
      { type: 'diagram', attrs: { blockId: 'b-000004', id: 'dg_1', label: 'Flow' } },
      { type: 'sketch', attrs: { blockId: 'b-000005', id: 'sk_1', label: 'Idea' } },
      { type: 'canvas', attrs: { blockId: 'b-000006', id: 'cv_1', label: 'Board', fragment: 'b_9' } },
      { type: 'fileCard', attrs: { blockId: 'b-000007', src: '/uploads/a_1.xlsx', name: 'a.xlsx', size: 3 } },
      { type: 'pageCard', attrs: { blockId: 'b-000008', page: 'Roadmap' } },
      { type: 'ticketCard', attrs: { blockId: 'b-000009', key: 'KAN-3' } },
      { type: 'mathBlock', attrs: { blockId: 'b-00000a', latex: 'x^2' } },
      para('b-00000b', [{ type: 'mathInline', attrs: { latex: 'y' } }]),
    ],
  };

  it('resolves every reference in one call and draws them as chips', () => {
    const { container } = show(doc);
    expect(refs.asked[refs.asked.length - 1]).toEqual([
      { kind: 'page', title: 'API', anchor: 'Auth' },
      { kind: 'page', title: 'Spec', anchor: null },
      { kind: 'ticket', key: 'KAN-1' },
      { kind: 'ticket', key: 'KAN-2' },
      { kind: 'page', title: 'Roadmap', anchor: null },
      { kind: 'ticket', key: 'KAN-3' },
    ]);
    const text = container.querySelector('[data-block-id="b-000001"]')!.textContent!;
    expect(text).toMatch(/API\s*›\s*Auth/);
    expect(text).toContain('the spec');
    expect(text).toContain('KAN-1');
    expect(text).toContain('KAN-2');
    expect(container.querySelector('[data-block-id="b-000001"] .dk-needs-input')?.textContent).toBe(
      'Needs input: owner',
    );
  });

  it('draws upload links as file cards, web links as external links, and the drawings', () => {
    const { container, getAllByTestId, getByTestId } = show(doc);
    expect(getAllByTestId('file-card').map((e) => e.textContent)).toEqual(['report.pdf@/uploads/report_ab.pdf']);
    // a file card block is the docs' own card (board "Embeds" frame 38): badge, name, type and size, Download
    const card = getByTestId('doc-file-card');
    expect(card.querySelector('.dk-fc-name')?.textContent).toBe('a.xlsx');
    expect(card.querySelector('a[download]')?.getAttribute('download')).toBe('a.xlsx');
    const ext = container.querySelector('a.dk-ext')!;
    expect(ext.getAttribute('href')).toBe('https://example.com');
    expect(ext.getAttribute('target')).toBe('_blank');
    expect(getByTestId('diagram').textContent).toBe('dg_1:Flow');
    expect(getByTestId('sketch').textContent).toBe('sk_1');
    expect(getByTestId('canvas').textContent).toBe('cv_1:b_9');
    expect(container.querySelector('[data-block-id="b-00000a"] .katex')).toBeTruthy();
    expect(container.querySelector('.dk-math-inline .katex')).toBeTruthy();
    expect(container.querySelector('[data-block-id="b-000008"]')?.textContent).toContain('Roadmap');
    expect(container.querySelector('[data-block-id="b-000009"]')?.textContent).toContain('KAN-3');
  });
});

describe('ticket keys that are not tickets', () => {
  // Bug: a screen id such as MH-005 in prose matched the ticket-key pattern and was drawn as a red "not found"
  // chip. A key found in plain text is a chip when it is a ticket or has a project's prefix (a ticket that is gone
  // still shows "not found"); any other stays text. One the author placed as a ticket reference is always a chip.
  it('leaves a key with no project prefix as text, chips a real ticket and flags a missing one', () => {
    const doc: RichDoc = {
      type: 'doc',
      content: [para('b-000001', [t('Dialogs MH-005 and MH-006, then KAN-7 and KAN-999.')])],
    };
    const { container } = show(doc);
    const p = container.querySelector('[data-block-id="b-000001"]')!;
    expect(p.textContent).toContain('MH-005 and MH-006');
    expect(p.querySelectorAll('.dk-chip')).toHaveLength(2);
    expect(p.querySelector('[data-testid="ref-ticket-KAN-7"]')).toBeTruthy();
    // the only broken chip is the ticket with a project's prefix
    expect(p.querySelectorAll('.dk-chip-missing')).toHaveLength(1);
    expect(p.querySelector('.dk-chip-missing')?.textContent).toContain('KAN-999');
  });

  it('keeps the broken chip for a ticket reference the author placed', () => {
    const doc: RichDoc = {
      type: 'doc',
      content: [para('b-000001', [{ type: 'ticketRef', attrs: { key: 'MH-005' } }])],
    };
    const { container } = show(doc);
    expect(container.querySelectorAll('.dk-chip-missing')).toHaveLength(1);
  });

  it('does the same for Markdown text', () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <DocsMarkdown projectId="p1">{'Dialogs MH-005 and KAN-7 and KAN-999.'}</DocsMarkdown>
      </QueryClientProvider>,
    );
    expect(container.textContent).toContain('MH-005');
    expect(container.querySelectorAll('.dk-chip-missing')).toHaveLength(1);
    expect(container.querySelector('.dk-chip-missing')?.textContent).toContain('KAN-999');
    expect(container.querySelector('[data-testid="ref-ticket-KAN-7"]')).toBeTruthy();
  });
});

describe('RichDocView: format 1 attributes', () => {
  it('draws alignment, marks, images, cells, columns and callouts', () => {
    const doc: RichDoc = {
      type: 'doc',
      content: [
        para(
          'b-000001',
          [
            t('pink', [{ type: 'highlight', attrs: { color: 'pink' } }]),
            t('teal', [{ type: 'textStyle', attrs: { color: 'teal', fontFamily: 'lora', fontSize: 18 } }]),
            t('u', [{ type: 'underline' }]),
            t('2', [{ type: 'superscript' }]),
            t('i', [{ type: 'subscript' }]),
          ],
          { textAlign: 'center', indent: 2, dropCap: 3 },
        ),
        {
          type: 'image',
          attrs: {
            blockId: 'b-000002',
            src: '/uploads/p.png',
            alt: 'Plan',
            placement: 'floatRight',
            widthPct: 40,
            caption: 'Planning night',
          },
        },
        {
          type: 'table',
          attrs: { blockId: 'b-000003' },
          content: [
            {
              type: 'tableRow',
              attrs: { blockId: 'b-000004' },
              content: [
                {
                  type: 'tableCell',
                  attrs: { blockId: 'b-000005', colspan: 2, background: 'yellow' },
                  content: [para('b-000006', [t('wide')])],
                },
              ],
            },
          ],
        },
        {
          type: 'columns',
          attrs: { blockId: 'b-000007', ratio: '1:2' },
          content: [
            { type: 'column', attrs: { blockId: 'b-000008' }, content: [para('b-000009', [t('left')])] },
            { type: 'column', attrs: { blockId: 'b-00000a' }, content: [para('b-00000b', [t('right')])] },
          ],
        },
        {
          type: 'callout',
          attrs: { blockId: 'b-00000c', kind: 'danger', title: 'Do not' },
          content: [para('b-00000d', [t('Stop.')])],
        },
        { type: 'callout', attrs: { blockId: 'b-00000e', kind: 'note' }, content: [para('b-00000f', [t('n')])] },
        { type: 'horizontalRule', attrs: { blockId: 'b-000010', style: 'stars' } },
        {
          type: 'blockquote',
          attrs: { blockId: 'b-000011', variant: 'card', source: 'Ada' },
          content: [para('b-000012', [t('q')])],
        },
        { type: 'pullQuote', attrs: { blockId: 'b-000013', source: 'Bo' }, content: [t('Big words')] },
      ],
    };
    const { container } = show(doc);
    const p = container.querySelector<HTMLElement>('[data-block-id="b-000001"]')!;
    expect(p.tagName).toBe('P');
    expect(p.style.textAlign).toBe('center');
    expect(p.style.marginLeft).toBe('48px');
    expect(p.className).toContain('dk-dropcap-3');
    expect(p.querySelector('mark')?.getAttribute('style')).toContain('var(--rd-hl-pink)');
    const span = p.querySelector<HTMLElement>('span[style*="rd-c-teal"]')!;
    expect(span.style.fontSize).toBe('18px');
    expect(span.style.fontFamily).toContain('Lora');
    expect(p.querySelector('u')?.textContent).toBe('u');
    expect(p.querySelector('sup')?.textContent).toBe('2');
    expect(p.querySelector('sub')?.textContent).toBe('i');

    const fig = container.querySelector<HTMLElement>('[data-block-id="b-000002"]')!;
    expect(fig.className).toContain('dk-img-floatRight');
    expect(fig.style.width).toBe('40%');
    expect(fig.querySelector('figcaption')?.textContent).toBe('Planning night');
    expect(fig.querySelector('img')?.getAttribute('alt')).toBe('Plan');

    const cell = container.querySelector<HTMLTableCellElement>('td[data-block-id="b-000005"]')!;
    expect(cell.colSpan).toBe(2);
    expect(cell.getAttribute('style')).toContain('var(--rd-hl-yellow)');

    const cols = container.querySelector<HTMLElement>('[data-block-id="b-000007"]')!;
    expect(cols.className).toContain('dk-columns');
    expect(cols.style.gridTemplateColumns).toBe('1fr 2fr');
    expect(cols.querySelectorAll('.dk-column')).toHaveLength(2);

    const danger = container.querySelector('[data-block-id="b-00000c"]')!;
    expect(danger.getAttribute('data-callout')).toBe('danger');
    expect(danger.textContent).toContain('Do not');
    expect(container.querySelector('[data-block-id="b-00000e"]')?.getAttribute('data-callout')).toBe('note');
    expect(container.querySelector('[data-block-id="b-000010"]')?.getAttribute('role')).toBe('separator');
    expect(container.querySelector('blockquote.dk-quote-card')?.textContent).toContain('Ada');
    expect(container.querySelector('.dk-pullquote')?.textContent).toContain('Big words');
  });

  it('shows a video as a poster with a play button and plays nothing until it is pressed', () => {
    const doc: RichDoc = {
      type: 'doc',
      content: [
        { type: 'video', attrs: { blockId: 'b-000001', src: '/uploads/demo.mp4', title: 'Release demo' } },
        { type: 'htmlEmbed', attrs: { blockId: 'b-000002', html: '<b>x</b>', title: 'Widget' } },
        { type: 'linkEmbed', attrs: { blockId: 'b-000003', url: 'https://example.com/a', title: 'Example' } },
      ],
    };
    const { container, getByRole } = show(doc);
    // before Play only the metadata loads (the length, the first frame): no autoplay, no player controls
    const still = container.querySelector('video')!;
    expect(still.getAttribute('preload')).toBe('metadata');
    expect(still.autoplay).toBe(false);
    expect(still.controls).toBe(false);
    fireEvent.click(getByRole('button', { name: 'Play Release demo' }));
    const video = container.querySelector('video')!;
    expect(video.getAttribute('src')).toBe('/uploads/demo.mp4');
    expect(video.autoplay).toBe(false);
    expect(video.controls).toBe(true);
    // Rich Docs phase 5: the HTML runs in its own frame, never in the page itself
    const html = container.querySelector('[data-block-id="b-000002"]')!;
    expect(html.textContent).toContain('HTML');
    expect(html.textContent).toContain('Widget');
    const frame = html.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('<b>x</b>');
    expect(html.querySelector('b')).toBeNull();
    expect(container.querySelector('[data-block-id="b-000003"] a')?.getAttribute('href')).toBe('https://example.com/a');
  });

  it('marks the top-level blocks a later version changed', () => {
    const doc = markdownToDoc('First line.\n\nSecond line.', seqIds());
    const { container } = show(doc, { changedIn: new Map([['Second line.', 4]]) });
    const changed = container.querySelectorAll('.dk-changed');
    expect(changed).toHaveLength(1);
    expect(changed[0].textContent).toBe('Second line.');
    expect(changed[0].getAttribute('data-changed-in')).toBe('Changed in v4');
  });

  it('renders a long page in pieces and calls onRendered once all are there', async () => {
    const doc: RichDoc = {
      type: 'doc',
      content: Array.from({ length: 130 }, (_, i) =>
        i % 10 === 0
          ? { type: 'heading', attrs: { level: 2 }, content: [t('Part')] }
          : para(`b-${(i + 1).toString(16).padStart(6, '0')}`, [t(`line ${i}`)]),
      ),
    };
    const onRendered = vi.fn();
    const { container } = show(doc, { progressive: true, onRendered });
    expect(container.querySelector('[data-rendering]')).toBeTruthy();
    for (let i = 0; i < 40 && container.querySelector('[data-rendering]'); i++) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
    }
    expect(container.querySelector('[data-rendering]')).toBeNull();
    expect(onRendered).toHaveBeenCalled();
    const ids = Array.from(container.querySelectorAll('h2')).map((h) => h.id);
    expect(ids).toHaveLength(13);
    expect(ids[12]).toBe('docs-part-13');
  });
});
