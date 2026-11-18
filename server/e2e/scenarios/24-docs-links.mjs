import { ensureProject, openDocs } from '../lib/ui.mjs';

// Finding and connecting rich pages (design boards "Rich Docs — search, links & backlinks", RichDocsLinks 1-5, and
// RichDocsStates4 I): a link to a block shows where it goes ("Rate limiting › [table] Limits"), its hover card shows
// the block itself, opening it scrolls to the block and marks it for a few seconds, a link whose block is gone says
// so, Referenced by names the block each link points at and Go to link opens the other page at the link, "[[Page#"
// in the editor lists headings and then blocks and stores the link by ids, and search names what kind of thing
// matched (a picture caption) and opens the page at it. The sizes and colours are checked against the boards.
const text = (t) => ({ type: 'text', text: t });
const para = (id, ...content) => ({ type: 'paragraph', attrs: { blockId: id }, content });
const cell = (kind, t) => ({ type: kind, content: [{ type: 'paragraph', content: [text(t)] }] });
const TARGET = {
  type: 'doc',
  content: [
    para('b-0000a4', text('Every route counts requests per token in a sliding one-minute window.')),
    { type: 'heading', attrs: { level: 2, blockId: 'b-0000a1' }, content: [text('Limits')] },
    {
      type: 'table',
      attrs: { blockId: 'b-0000a2' },
      content: [
        { type: 'tableRow', content: [cell('tableHeader', 'Plan'), cell('tableHeader', 'Requests / min'), cell('tableHeader', 'Burst')] },
        { type: 'tableRow', content: [cell('tableCell', 'Free'), cell('tableCell', '60'), cell('tableCell', '10')] },
        { type: 'tableRow', content: [cell('tableCell', 'Team'), cell('tableCell', '600'), cell('tableCell', '60')] },
      ],
    },
    para('b-0000a5', text('Team plans get ten times the free limits.')),
    { type: 'image', attrs: { blockId: 'b-0000a3', src: '/x.png', alt: '', caption: 'Figure 2. Throttle hits per day' } },
  ],
};
const ref = (pageId, extra) => ({ type: 'docRef', attrs: { page: 'Rate limiting', section: null, label: null, pageId, ...extra } });

export default {
  name: 'Docs links: links to blocks, hover card, arrival mark, gone block, Referenced by, [[Page#, search markers, references, Check links, # tickets',
  async run(s) {
    const p = s.page;
    const base = s.server.base;
    let pid = '';
    let target = '';
    let notes = '';
    const api = async (method, path, body) => {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const t = await r.text();
      if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${t.slice(0, 300)}`);
      return t ? JSON.parse(t) : null;
    };
    const publish = async (title, content) => {
      const page = await api('POST', `/projects/${pid}/docs/pages`, { title });
      await api('PUT', `/docs/pages/${page.id}/draft`, { content });
      await api('POST', `/docs/pages/${page.id}/publish`, { base_version: 0 });
      return page.id;
    };
    const box = (loc) =>
      loc.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          radius: cs.borderRadius,
          bg: cs.backgroundColor,
          color: cs.color,
          font: `${cs.fontWeight} ${cs.fontSize}`,
          border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
          opacity: cs.opacity,
          minH: cs.minHeight,
        };
      });
    const expect = (what, got, want) => {
      for (const [k, v] of Object.entries(want))
        if (got[k] !== v) throw new Error(`${what}: ${k} is ${JSON.stringify(got[k])}, the board has ${JSON.stringify(v)} (${JSON.stringify(got)})`);
    };
    const body = () => p.getByTestId('page-body');
    const openPage = async (title, blockId) => {
      await p.getByRole('tree').getByRole('treeitem', { name: new RegExp(`^${title}`) }).first().click();
      await body().locator(`[data-block-id="${blockId}"]`).first().waitFor();
    };
    const marked = (blockId) => body().locator(`[data-block-id="${blockId}"].dk-link-arrive`);

    await s.step('set up: Rate limiting (a heading, a table under it, a captioned picture) and Decision log linking to them', async () => {
      await ensureProject(s);
      const projects = await api('GET', '/projects');
      pid = (Array.isArray(projects) ? projects : projects.projects)[0].id;
      target = await publish('Rate limiting', TARGET);
      await publish('Decision log', {
        type: 'doc',
        content: [
          para('b-0000b1', text('We chose a per-token window, see '), ref(target, { targetBlockId: 'b-0000a2' }), text(' for the numbers.')),
          para('b-0000b2', text('The rules: '), ref(target, { section: 'Limits', targetBlockId: 'b-0000a1' }), text('.')),
          para('b-0000b3', text('The review dates are in '), ref(target, { targetBlockId: 'b-0000ff' }), text('.')),
        ],
      });
      notes = await publish('Notes', { type: 'doc', content: [para('b-0000c1', text('Numbers: '))] });
      await p.reload();
      await openDocs(s);
      await openPage('Decision log', 'b-0000b1');
    });

    await s.step('a link to a block names its page, the kind and the block: "Rate limiting › [table] Limits"', async () => {
      const chip = body().locator('[data-block-id="b-0000b1"] .dk-chip-page');
      await chip.getByText('Limits', { exact: true }).waitFor();
      expect('block chip', await box(chip), { h: 22, radius: '6px' });
      expect('the ›', await box(chip.locator('.dk-chip-sep')), { opacity: '0.55' });
      expect('the table glyph', await box(chip.locator('svg').nth(1)), { w: 11, h: 11 });
      expect('the block name', await box(chip.locator('.dk-chip-target')), { font: '600 13px' });
      // a heading link shows the heading's current text
      await body().locator('[data-block-id="b-0000b2"] .dk-chip-page').getByText('Limits').waitFor();
    });

    await s.step('hovering it shows the block itself: a 340 px card with the table, its name and "Rate limiting › table"', async () => {
      const chip = body().locator('[data-block-id="b-0000b1"] .dk-chip-page');
      await chip.hover();
      const card = p.getByTestId('block-card');
      await card.waitFor();
      await card.getByText('Rate limiting › table').waitFor();
      await card.locator('table').getByText('Requests / min').waitFor();
      expect('block card', await box(card), { w: 340, radius: '12px', bg: 'rgb(255, 255, 255)' });
      expect('kind tile', await box(card.locator('.dk-kind-tile')), { w: 30, h: 30, radius: '9px', bg: 'rgb(227, 239, 250)' });
      await card.getByRole('button', { name: 'Open in side panel' }).waitFor();
      await p.mouse.move(5, 5);
      await card.waitFor({ state: 'detached' });
    });

    await s.step('opening it scrolls to the table and marks it (#FFF3C4, 10 px corners); the mark fades away', async () => {
      await body().locator('[data-block-id="b-0000b1"] .dk-chip-page').click();
      await p.getByTestId('page-title').getByText('Rate limiting', { exact: true }).waitFor();
      const mark = marked('b-0000a2');
      await mark.waitFor();
      expect('arrival mark', await box(mark), { bg: 'rgb(255, 243, 196)', radius: '10px' });
      const inView = await mark.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
      if (!inView) throw new Error('the linked table is not in view');
      await mark.waitFor({ state: 'detached', timeout: 8000 });
    });

    await s.step('Referenced by: each row says which block it points at ("to Limits · table"); Go to link opens the link', async () => {
      const panel = p.getByTestId('referenced-by');
      await panel.scrollIntoViewIfNeeded();
      const pill = panel.getByTestId('backlink-to').filter({ hasText: 'to Limits · table' });
      await pill.waitFor();
      expect('to pill', await box(pill), { h: 20, radius: '5px', bg: 'rgb(241, 246, 242)', font: '700 11px' });
      await panel.getByTestId('backlink-to').filter({ hasText: 'to Limits · heading' }).waitFor();
      const row = pill.locator('xpath=ancestor::div[2]');
      await row.getByRole('button', { name: 'Go to link' }).click();
      await p.getByTestId('page-title').getByText('Decision log', { exact: true }).waitFor();
      await marked('b-0000b1').waitFor();
    });

    await s.step('a link whose block is gone keeps its words, amber and dashed; its card says "Block not found"', async () => {
      const chip = body().getByTestId('ref-block-missing');
      await chip.waitFor();
      // the board's 1.5 px border: Chromium draws a border under 2 px with whole device pixels (1 px at 1x)
      const gone = await box(chip);
      expect('gone chip', gone, { bg: 'rgb(253, 243, 227)', color: 'rgb(138, 90, 0)' });
      if (!/^1(\.5)?px dashed rgb\(201, 138, 27\)$/.test(gone.border)) throw new Error('gone chip border ' + gone.border);
      await chip.hover();
      const card = p.getByTestId('block-gone');
      await card.getByText('Block not found').waitFor();
      await card.getByRole('button', { name: 'Open page' }).waitFor();
      await p.mouse.move(5, 5);
    });

    await s.step('the editor: "[[Rate limiting#" lists the whole page, then Headings, then Blocks (a 38 px row with a 22 px tile)', async () => {
      await openPage('Notes', 'b-0000c1');
      await p.getByRole('button', { name: 'Edit', exact: true }).click();
      const content = p.getByRole('textbox', { name: 'Page content' });
      await content.getByText('Numbers:').click();
      await p.keyboard.press('End');
      await p.keyboard.type('[[Rate limiting#');
      const menu = p.getByTestId('ref-menu');
      await menu.getByTestId('ref-pick-head').getByText('› choose a heading or a block').waitFor();
      await menu.getByTestId('ref-whole-row').getByText('No heading, no block').waitFor();
      const heading = menu.getByTestId('ref-heading-row').filter({ hasText: 'Limits' });
      await heading.getByText('H2', { exact: true }).waitFor();
      const block = menu.getByTestId('ref-block-row').filter({ hasText: 'Table · 3 columns, 3 rows' });
      await block.waitFor();
      expect('block row', await box(block), { minH: '38px' });
      expect('block tile', await box(block.locator('.dk-kind-tile')), { w: 22, h: 22, radius: '6px', bg: 'rgb(227, 239, 250)' });
      await menu.getByTestId('ref-block-row').filter({ hasText: 'Figure 2. Throttle hits per day' }).getByText('Image · caption').waitFor();
      const order = await menu.evaluate((el) =>
        [...el.querySelectorAll('[data-testid^="ref-"]')].map((n) => n.getAttribute('data-testid')).filter((t) => t !== 'ref-pick-head'),
      );
      if (order.indexOf('ref-heading-row') > order.indexOf('ref-block-row')) throw new Error('headings should come before blocks: ' + order);
      await block.click();
      await content.locator('.dk-chip-page').getByText('Limits').waitFor();
      await p.getByText(/^Saved/).waitFor();
      const stored = await p.getByTestId('docs-editor-surface').evaluate((el) => {
        const found = [];
        el.editor.state.doc.descendants((n) => {
          if (n.type.name === 'docRef') found.push(n.attrs);
        });
        return found;
      });
      if (stored[0]?.pageId !== target || stored[0]?.targetBlockId !== 'b-0000a2') throw new Error('the link is not stored by ids: ' + JSON.stringify(stored));
    });

    await s.step('search reads picture captions: the result says "Picture · caption" and opens the page at the picture', async () => {
      await p.getByRole('button', { name: 'Publish', exact: true }).click();
      const d = p.getByRole('dialog', { name: 'Publish page' });
      await d.getByRole('button', { name: /^Publish v\d+/ }).click();
      await d.waitFor({ state: 'detached' });
      await p.getByRole('button', { name: 'Edit', exact: true }).waitFor();
      const back = await api('GET', `/docs/pages/${target}/backlinks`);
      if (!back.pages.some((r) => r.page_id === notes && r.target_block?.kind === 'table')) throw new Error('Notes is not listed by its block: ' + JSON.stringify(back.pages));
      await p.keyboard.press('Control+k');
      const dlg = p.getByRole('dialog');
      await dlg.getByRole('combobox').or(dlg.getByRole('textbox')).first().fill('throttle');
      const marker = dlg.getByTestId('match-marker').filter({ hasText: 'Picture · caption' });
      await marker.waitFor();
      expect('match marker', await box(marker), { h: 20, radius: '5px', bg: 'rgb(238, 243, 239)', color: 'rgb(58, 74, 62)', font: '700 10.5px' });
      await marker.click();
      await p.getByTestId('page-title').getByText('Rate limiting', { exact: true }).waitFor();
      await marked('b-0000a3').waitFor();
    });

    await s.step('the header says "N references" (F 34): a 32 px green button; its list names each page and the block it links to', async () => {
      const btn = p.getByTestId('refs-button');
      await btn.waitFor();
      if (!/^\d+ references?$/.test((await btn.textContent()).trim())) throw new Error('refs button: ' + (await btn.textContent()));
      expect('refs button', await box(btn), {
        h: 32,
        radius: '8px',
        bg: 'rgb(227, 241, 231)',
        color: 'rgb(31, 90, 49)',
        font: '700 12.5px',
        border: '1px solid rgb(46, 111, 64)',
      });
      await btn.click();
      const pop = p.getByTestId('refs-popover');
      await pop.getByText(/^Referenced by 2 pages$/).waitFor();
      expect('refs popover', await box(pop), { w: 340, radius: '12px', bg: 'rgb(255, 255, 255)' });
      await pop.getByTestId('refs-row').filter({ hasText: 'Decision log' }).filter({ hasText: 'to Limits' }).first().waitFor();
      await btn.click();
      await pop.waitFor({ state: 'detached' });
    });

    await s.step('a block that others link to carries a count (F 35): 24 px, #1F5A31; it lists the places and opens one', async () => {
      const badge = body().getByTestId('block-refs');
      await badge.waitFor();
      expect('block badge', await box(badge), { h: 24, bg: 'rgb(31, 90, 49)', color: 'rgb(255, 255, 255)', font: '700 11.5px' });
      if ((await badge.textContent()).trim() !== '2') throw new Error('badge count: ' + (await badge.textContent()));
      // it sits over the table's top right corner
      const [b, t] = await Promise.all([badge.boundingBox(), body().locator('[data-block-id="b-0000a2"]').first().boundingBox()]);
      if (Math.abs(b.y + b.height / 2 - t.y) > 14 || Math.abs(b.x + b.width - t.x - t.width) > 14)
        throw new Error(`the badge is not at the table's corner: ${JSON.stringify({ b, t })}`);
      await badge.click();
      const pop = p.getByTestId('block-refs-popover');
      await pop.getByText('2 places link to this table').waitFor();
    });

    await s.step('arriving from a link, a strip names the page it came from (D 25); Clear highlight takes the mark away', async () => {
      // the strip lives as long as the mark (4 s): it is looked for right after the click
      await p.getByTestId('block-refs-popover').getByRole('button', { name: /Decision log/ }).click();
      const banner = p.getByTestId('arrival-banner');
      await banner.getByText('Rate limiting').waitFor().catch(async (e) => {
        const seen = await p.evaluate(() => ({
          banner: document.querySelector('[data-testid="arrival-banner"]')?.textContent ?? null,
          marked: [...document.querySelectorAll('.dk-link-arrive')].map((el) => el.getAttribute('data-block-id')),
        }));
        throw new Error(`${e.message.split('\n')[0]} (on the page: ${JSON.stringify(seen)})`);
      });
      expect('arrival banner', await box(banner), { bg: 'rgb(255, 246, 217)', font: '400 13px' });
      await marked('b-0000b1').waitFor();
      await banner.getByRole('button', { name: 'Clear highlight' }).click();
      await banner.waitFor({ state: 'detached' });
      if (await marked('b-0000b1').count()) throw new Error('the mark is still on');
    });

    await s.step('the full search page: Type filter with counts, a table match says "Table · row 3" and shows the row', async () => {
      await p.keyboard.press('Control+k');
      const dlg = p.getByRole('dialog');
      await dlg.getByRole('combobox').or(dlg.getByRole('textbox')).first().fill('team');
      await dlg.getByTestId('match-marker').first().waitFor();
      await p.keyboard.press('Control+Enter');
      const marker = p.getByTestId('match-marker').filter({ hasText: 'Table · row 3' });
      await marker.waitFor();
      const row = p.getByTestId('match-row').first();
      await row.getByText('600').waitFor();
      expect('table row', await box(row), { radius: '6px', border: '1px solid rgb(227, 232, 229)' });
      const tables = p.getByTestId('type-filter-table');
      await tables.waitFor();
      const check = tables.locator('xpath=ancestor::div[@role="checkbox"]');
      if (!/1$/.test((await check.textContent()).trim())) throw new Error('Tables count: ' + (await check.textContent()));
      await check.click();
      await p.getByTestId('match-marker').filter({ hasText: 'Table · row 3' }).waitFor();
      await p.keyboard.press('Escape');
    });

    await s.step('the editor\'s Check links (G 38): a gone block is named with its fix; "Link to the page" mends it', async () => {
      await openPage('Decision log', 'b-0000b1');
      await p.getByRole('button', { name: 'Edit', exact: true }).click();
      await p.getByTestId('check-links').click();
      const panel = p.getByTestId('link-checker');
      await panel.getByTestId('link-checker-summary').getByText('1 of 3 links needs attention').waitFor();
      expect('check panel', await box(panel), { w: 340, bg: 'rgb(251, 252, 251)' });
      const item = panel.getByTestId('link-checker-item');
      await item.getByText('Block not found').waitFor();
      await item.getByRole('button', { name: 'Link to the page' }).click();
      await panel.getByTestId('link-checker-summary').getByText('All 3 links work').waitFor();
      await panel.getByRole('button', { name: 'Close' }).click();
    });

    await s.step('"#" after a space lists the project\'s tickets (C 18); Enter puts in the ticket chip', async () => {
      await api('POST', `/projects/${pid}/tickets`, { title: 'Rate limiting on public endpoints', type: 'story' });
      await p.reload();
      await openDocs(s);
      await openPage('Decision log', 'b-0000b1');
      await p.getByRole('button', { name: 'Edit', exact: true }).click();
      const content = p.getByRole('textbox', { name: 'Page content' });
      await content.getByText('for the numbers.').click();
      await p.keyboard.press('End');
      await p.keyboard.type(' #rate');
      const menu = p.getByTestId('hash-ticket-menu');
      const row = menu.getByTestId('hash-ticket-row').filter({ hasText: 'Rate limiting on public endpoints' });
      await row.waitFor();
      expect('ticket menu', await box(menu), { w: 440, radius: '12px' });
      expect('ticket row', await box(row), { h: 44, radius: '8px', bg: 'rgb(230, 242, 234)' });
      await p.keyboard.press('Enter');
      await menu.waitFor({ state: 'detached' });
      await content.locator('[data-block-id="b-0000b1"] .dk-chip-ticket, [data-block-id="b-0000b1"] [data-ref="ticket"]').first().waitFor();
    });
  },
};
