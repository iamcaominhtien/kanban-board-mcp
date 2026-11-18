import { ensureProject, openDocs } from '../lib/ui.mjs';

// Highlight while reading (design board "Rich Docs — reading", K 74-128): the colours in the selection bar, the
// layer on the page (tint, dotted line, marker), the bubble on a highlight (recolour, comment, remove), someone
// else's new highlights behind "Show", the list beside the page (filters, Go to passage, Remove with Undo, Remove all
// mine, Clear all), the limit, "Couldn't save", highlights off for a page, and the list on a tablet and a phone.
// Other people act through the API with their own name (x-actor), as a second browser would.
const para = (id, text) => ({ type: 'paragraph', attrs: { blockId: id }, content: [{ type: 'text', text }] });
const DOC = {
  type: 'doc',
  content: [
    para('b-000001', 'When we first let an AI team pick up a ticket, we expected the hard part to be the code. It was the briefing.'),
    para('b-000002', 'So we started writing tickets for a stranger. Each one names the goal and what a reviewer will check.'),
    { type: 'heading', attrs: { level: 2, blockId: 'b-000003' }, content: [{ type: 'text', text: 'Write the ticket for a stranger' }] },
    para('b-000004', 'A good brief fits on one screen. We settled on three short parts and stopped adding fields.'),
    { type: 'heading', attrs: { level: 2, blockId: 'b-000005' }, content: [{ type: 'text', text: 'Read the report, not the log' }] },
    para('b-000006', 'The log tells you what happened. The report tells you what the team decided.'),
  ],
};

export default {
  name: 'Docs highlights: select and highlight, the bubble, the list, Undo, limits, off, tablet and phone',
  async run(s) {
    const p = s.page;
    const base = s.server.base;
    let pid = '';
    let pageId = '';
    const api = async (method, path, body, actor) => {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(actor ? { 'x-actor': actor } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    };
    // selects words of a block, as a mouse would, and lets the selection bar see it
    const select = async (blockId, text) => {
      await p.evaluate(({ blockId, text }) => {
        const el = document.querySelector(`[data-testid="page-body"] [data-block-id="${blockId}"]`);
        if (!el) throw new Error('no block ' + blockId);
        const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = w.nextNode(); n; n = w.nextNode()) {
          const i = n.data.indexOf(text);
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + text.length);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(r);
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          return;
        }
        throw new Error(`no "${text}" in ${blockId}`);
      }, { blockId, text });
      await p.getByTestId('selection-toolbar').waitFor();
    };
    const registered = () => p.evaluate(() => [...CSS.highlights.keys()].filter((k) => k.startsWith('dk-hl-')).sort());
    const list = async () => (await api('GET', `/docs/pages/${pageId}/highlights`)).highlights;
    const box = (loc) => loc.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return { w: Math.round(r.width), h: Math.round(r.height), radius: cs.borderRadius, bg: cs.backgroundColor, font: `${cs.fontWeight} ${cs.fontSize}`, padding: cs.padding, border: cs.borderTopWidth + ' ' + cs.borderTopColor };
    });
    const expect = (what, got, want) => {
      for (const [k, v] of Object.entries(want)) if (got[k] !== v) throw new Error(`${what}: ${k} is ${JSON.stringify(got[k])}, the board has ${JSON.stringify(v)} (${JSON.stringify(got)})`);
    };
    const openPage = async () => {
      await p.reload();
      await openDocs(s);
      await p.getByRole('tree').getByRole('treeitem', { name: /^Field notes/ }).first().click();
      await p.getByTestId('page-body').locator('[data-block-id="b-000001"]').waitFor();
    };

    await s.step('set up: a published rich page Field notes, and Hoa Mai, a member', async () => {
      await ensureProject(s);
      const projects = await api('GET', '/projects');
      pid = (Array.isArray(projects) ? projects : projects.projects)[0].id;
      const page = await api('POST', `/projects/${pid}/docs/pages`, { title: 'Field notes' });
      pageId = page.id;
      await api('PUT', `/docs/pages/${pageId}/draft`, { content: DOC });
      await api('POST', `/docs/pages/${pageId}/publish`, { base_version: 0 });
      await api('POST', `/projects/${pid}/members`, { name: 'Hoa Mai', role: 'member' });
      await openPage();
    });

    await s.step('the first time: a one-line tip under the page bar, Got it puts it away for good', async () => {
      const tip = p.getByTestId('hl-tip');
      await tip.getByText('Highlight while you read.').waitFor();
      expect('tip', await box(tip), { bg: 'rgb(232, 241, 250)' });
      await tip.getByRole('button', { name: 'Got it' }).click();
      await tip.waitFor({ state: 'detached' });
      await openPage();
      if (await p.getByTestId('hl-tip').count()) throw new Error('the tip came back');
    });

    await s.step('select words: six colours and ⋯ come before Comment, each a 24 px tile in a 32 px cell', async () => {
      await select('b-000001', 'we expected the hard part to be the code');
      const bar = p.getByTestId('selection-toolbar');
      const tiles = bar.getByTestId('hl-swatches').locator('.hl-sw');
      if ((await tiles.count()) !== 6) throw new Error('six colours expected, got ' + (await tiles.count()));
      const order = await tiles.evaluateAll((els) => els.map((e) => e.dataset.color));
      if (order.join() !== 'yellow,green,blue,pink,orange,violet') throw new Error('colour order ' + order);
      expect('a colour cell', await box(tiles.first()), { w: 32, h: 32 });
      expect('a colour tile', await box(tiles.first().locator('.hl-sw-tile')), { w: 24, h: 24, radius: '8px', bg: 'rgb(255, 233, 168)' });
      expect('⋯', await box(bar.getByTestId('hl-more-colours')), { w: 32, h: 32, radius: '8px' });
      // the colours come first, then Comment
      const first = await bar.evaluate((el) => el.firstElementChild?.getAttribute('data-testid'));
      if (first !== 'hl-swatches') throw new Error('the colours should lead the bar, got ' + first);
      await bar.getByTestId('selection-comment').waitFor();
      await bar.getByTestId('hl-more-colours').click();
      await bar.getByTestId('hl-all-colours').locator('.hl-sw').nth(11).waitFor();
      expect('a tile of the 12', await box(bar.getByTestId('hl-all-colours').locator('.hl-sw-tile').first()), { w: 26, h: 26 });
      expect('the 12 panel', await box(bar.getByTestId('hl-all-colours')), { w: 300, padding: '10px' });
      s.note('bar', await box(bar));
      await bar.getByTestId('hl-more-colours').click();
      await bar.getByTestId('hl-all-colours').waitFor({ state: 'detached' });
    });

    await s.step('Yellow highlights the words: no page version, a tint with a dotted line and a marker', async () => {
      const [req] = await Promise.all([
        p.waitForRequest((r) => r.method() === 'POST' && /\/highlights$/.test(r.url())),
        p.getByTestId('selection-toolbar').getByTestId('hl-swatch-yellow').click(),
      ]);
      const sent = JSON.parse(req.postData() ?? '{}');
      if (sent.block_id !== 'b-000001' || sent.quote !== 'we expected the hard part to be the code' || sent.color !== 'yellow')
        throw new Error('sent ' + req.postData());
      await p.getByTestId('hl-marker').first().waitFor();
      const reg = await registered();
      if (!reg.includes('dk-hl-yellow')) throw new Error('no yellow layer: ' + reg);
      await p.getByTestId('highlights-count').getByText('1', { exact: true }).waitFor();
      const page = await api('GET', `/docs/pages/${pageId}`);
      if (page.version !== 1) throw new Error('a highlight made a version: v' + page.version);
      // the layer lays the markers out again when the saved highlight replaces the one being sent: read the saved
      // marker in one go, once it is in its block (a marker read across a re-layout is a detached node)
      const mark = await (
        await p.waitForFunction(() => {
          const el = [...document.querySelectorAll('[data-testid="hl-marker"]')].find(
            (e) => !e.dataset.hl.startsWith('local-') && e.isConnected && e.closest('[data-block-id]'),
          );
          if (!el) return null;
          return {
            svg: el.querySelector('svg')?.getAttribute('width'),
            dot: getComputedStyle(el.querySelector('.dk-hl-dot')).width,
            label: el.getAttribute('aria-label'),
            // the marker is not page text: the block's words are unchanged
            text: el.closest('[data-block-id]').textContent.includes('codeHighlighted'),
          };
        })
      ).jsonValue();
      if (mark.svg !== '10' || mark.dot !== '10px' || mark.label !== 'Highlighted Yellow by you' || mark.text) throw new Error('marker ' + JSON.stringify(mark));
    });

    await s.step('the bubble on your highlight: the colour ringed, Remove highlight is yours; recolour to Green', async () => {
      await p.getByTestId('hl-marker').first().click();
      const pop = p.getByTestId('hl-popover');
      await pop.getByText('Highlighted by you · just now').waitFor();
      await pop.getByText('yours', { exact: true }).waitFor();
      expect('bubble', await box(pop), { w: 292, radius: '12px', padding: '4px' });
      expect('Copy', await box(pop.getByTestId('hl-copy')), { h: 50, font: '600 11px' });
      await s.shot('bubble');
      expect('Remove highlight', await box(pop.getByTestId('hl-remove')), { h: 34, font: '600 13px' });
      if ((await pop.getByTestId('hl-recolor-yellow').getAttribute('aria-pressed')) !== 'true') throw new Error('yellow is not ringed');
      await Promise.all([
        p.waitForRequest((r) => r.method() === 'PATCH' && /\/docs\/highlights\//.test(r.url())),
        pop.getByTestId('hl-recolor-green').click(),
      ]);
      await p.waitForFunction(() => CSS.highlights.has('dk-hl-green') && !CSS.highlights.has('dk-hl-yellow'));
      await p.keyboard.press('Escape');
      await pop.waitFor({ state: 'detached' });
    });

    await s.step("someone else's new highlight waits behind a chip: 1 new highlight by Hoa Mai · Show", async () => {
      await api('POST', `/docs/pages/${pageId}/highlights`, { block_id: 'b-000002', start: 0, end: 45, quote: 'So we started writing tickets for a stranger.', color: 'pink' }, 'Hoa Mai');
      const strip = p.getByTestId('hl-new-strip');
      await strip.getByText('1 new highlight by Hoa Mai').waitFor();
      // not drawn by itself
      if ((await p.getByTestId('hl-marker').count()) !== 1) throw new Error('the new highlight was drawn before Show');
      await strip.getByTestId('hl-new-show').click();
      await strip.waitFor({ state: 'detached' });
      await p.locator('[data-testid="hl-marker"][aria-label="Highlighted Pink by Hoa Mai"]').waitFor();
      await p.getByTestId('highlights-count').getByText('2', { exact: true }).waitFor();
      // Hoa Mai's bubble: who and when, colours greyed, no Remove for a member who is not its author... the board
      // user is an admin and can edit the page, so Remove is offered "as editor"
      await p.locator('[data-testid="hl-marker"][aria-label="Highlighted Pink by Hoa Mai"]').click();
      const pop = p.getByTestId('hl-popover');
      await pop.getByText(/^Highlighted by Hoa Mai · /).waitFor();
      await pop.getByText('as editor').waitFor();
      if (!(await pop.getByTestId('hl-recolor-pink').isDisabled())) throw new Error("someone else's colours should be greyed");
      await p.keyboard.press('Escape');
    });

    await s.step('a note on a highlight is a comment thread: Comment opens the page comment box on its words', async () => {
      await p.locator('[data-testid="hl-marker"][aria-label="Highlighted Pink by Hoa Mai"]').click();
      await p.getByTestId('hl-popover').getByTestId('hl-comment').click();
      const dlg = p.getByRole('dialog', { name: 'New comment' });
      await dlg.getByText('“So we started writing tickets for a stranger.”').waitFor();
      await dlg.getByPlaceholder('Write a comment…').fill('Check this against ALP-1.');
      const [link] = await Promise.all([
        p.waitForRequest((r) => r.method() === 'PATCH' && /\/docs\/highlights\//.test(r.url()), { timeout: 8000 }),
        p.keyboard.press('Control+Enter'),
      ]);
      if (!JSON.parse(link.postData() ?? '{}').thread_id) throw new Error('the thread was not linked: ' + link.postData());
      await s.settle();
      const pink = (await list()).find((h) => h.color === 'pink');
      if (!pink?.thread_id) throw new Error('the server did not keep the thread');
      await p.getByTestId('comments-close').click();
    });

    await s.step('the list beside the page: a tab next to Outline, rows in page order, Everyone / Me, colour chips', async () => {
      await p.getByTestId('highlights-button').click();
      const panel = p.getByTestId('hl-panel');
      await panel.waitFor();
      await panel.getByTestId('tab-highlights').waitFor();
      const rows = panel.getByTestId('hl-row');
      await rows.nth(1).waitFor();
      const quotes = await panel.getByTestId('hl-row-quote').allInnerTexts();
      if (!quotes[0].includes('we expected') || !quotes[1].includes('So we started')) throw new Error('not in page order: ' + quotes);
      await rows.nth(1).getByText('1 comment').waitFor();
      await rows.nth(0).getByText('Paragraph 1', { exact: false }).waitFor();
      expect('title', await box(panel.locator('.hl-panel-name')), { font: '700 15px' });
      expect('Everyone / Me', await box(panel.locator('.hl-seg button').first()), { h: 28, font: '600 12.5px' });
      expect('a colour chip', await box(panel.getByTestId('hl-chip-green')), { h: 28, radius: '999px', font: '600 12px' });
      expect('Go to passage', await box(rows.first().getByTestId('hl-go')), { h: 32, radius: '8px', font: '600 12.5px', padding: '0px 12px' });
      expect('a row', await box(rows.first()), { padding: '11px 12px 10px' });
      expect('the rail', await box(p.locator('.hl-rail')), { w: 336 });
      // Remove is only on your own (78)
      if (await rows.nth(1).getByTestId('hl-row-remove').count()) throw new Error("Remove on someone else's row");
      await panel.getByTestId('hl-filter-me').click();
      if ((await rows.count()) !== 1) throw new Error('Me should show one');
      await panel.getByRole('radio', { name: /^Everyone/ }).click();
      await panel.getByTestId('hl-chip-pink').click();
      if ((await rows.count()) !== 1) throw new Error('the Pink chip should show one');
      await panel.getByRole('button', { name: 'All colours' }).click();
      await s.shot('list');
      await rows.first().getByTestId('hl-go').click();
      await p.getByTestId('hl-flash').waitFor({ state: 'attached' });
    });

    await s.step('your own without a thread goes at once, with Undo for 8 seconds; Undo brings it back', async () => {
      const panel = p.getByTestId('hl-panel');
      await Promise.all([
        p.waitForRequest((r) => r.method() === 'DELETE' && /\/docs\/highlights\//.test(r.url())),
        panel.getByTestId('hl-row').first().getByTestId('hl-row-remove').click(),
      ]);
      const toast = p.getByTestId('hl-undo');
      await toast.getByText('Highlight removed · Green').waitFor();
      expect('the Undo message', await box(toast), { w: 360, radius: '12px', bg: 'rgb(30, 42, 34)' });
      await Promise.all([
        p.waitForResponse((r) => /\/highlights\/restore$/.test(r.url())),
        toast.getByTestId('hl-undo-button').click(),
      ]);
      await panel.getByTestId('hl-row').nth(1).waitFor();
    });

    await s.step('Remove all my highlights asks first; other people’s stay', async () => {
      const panel = p.getByTestId('hl-panel');
      await panel.getByTestId('hl-list-menu').click();
      await panel.getByTestId('hl-remove-mine').click();
      const dlg = p.getByTestId('hl-confirm');
      await dlg.getByText('Remove all my highlights?').waitFor();
      await dlg.getByText('Other people’s highlights stay.', { exact: false }).waitFor();
      expect('confirm', await box(dlg), { w: 460, radius: '16px' });
      await dlg.getByRole('button', { name: 'Remove 1 highlight' }).click();
      await p.getByTestId('hl-undo').getByText('1 highlight removed').waitFor();
      await p.getByTestId('hl-undo').getByTestId('hl-undo-button').click();
      await panel.getByTestId('hl-row').nth(1).waitFor();
    });

    await s.step('admins clear all highlights on the page, counted per person; Undo', async () => {
      const panel = p.getByTestId('hl-panel');
      await panel.getByTestId('hl-list-menu').click();
      await panel.getByTestId('hl-clear-all').getByText('Admins only').waitFor();
      await panel.getByTestId('hl-clear-all').click();
      const dlg = p.getByTestId('hl-confirm');
      await dlg.getByText('Clear all highlights on this page?').waitFor();
      await dlg.getByText('1 by Hoa Mai', { exact: false }).waitFor();
      await dlg.getByRole('button', { name: 'Clear 2 highlights' }).click();
      await p.getByTestId('hl-undo').getByText('2 highlights cleared').waitFor();
      await panel.getByTestId('hl-empty').getByText('No highlights yet').waitFor();
      await p.getByTestId('hl-undo').getByTestId('hl-undo-button').click();
      await panel.getByTestId('hl-row').nth(1).waitFor();
      await panel.getByRole('button', { name: 'Close the highlights' }).click();
      await panel.waitFor({ state: 'detached' });
    });

    await s.step('could not save: a dashed red line and a warning mark stay, and Try again sends it', async () => {
      await p.route('**/highlights', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 500, body: '{}' }) : route.continue()));
      await select('b-000004', 'three short parts');
      await p.getByTestId('selection-toolbar').getByTestId('hl-swatch-blue').click();
      const msg = p.getByTestId('hl-save-failed');
      await msg.getByText('Couldn’t save the highlight.').waitFor();
      await p.waitForFunction(() => CSS.highlights.has('dk-hl-blue-failed'));
      await p.locator('.dk-hl-mark.is-failed').waitFor();
      expect('the message', await box(msg), { w: 380, bg: 'rgb(253, 241, 238)' });
      await p.unroute('**/highlights');
      await msg.getByTestId('hl-retry').click();
      await msg.waitFor({ state: 'detached' });
      await p.waitForFunction(() => CSS.highlights.has('dk-hl-blue') && !CSS.highlights.has('dk-hl-blue-failed'));
    }, { expectConsole: true });

    await s.step('at 200 of yours the colours are greyed and the bar says why', async () => {
      const mine = (await list()).filter((h) => h.author !== 'Hoa Mai').length;
      for (let i = mine; i < 200; i += 1) {
        await api('POST', `/docs/pages/${pageId}/highlights`, { block_id: 'b-000006', start: 4, end: 7, quote: 'log', color: 'grey' });
      }
      await openPage();
      await select('b-000006', 'what the team decided');
      const note = p.getByTestId('hl-sel-note');
      await note.getByText('You have 200 highlights on this page.').waitFor();
      expect('the limit note', await box(note), { bg: 'rgb(253, 243, 227)' });
      if (!(await p.getByTestId('hl-swatch-yellow').isDisabled())) throw new Error('the colours should be greyed');
      await api('POST', `/docs/pages/${pageId}/highlights/clear`, { scope: 'mine' });
      await p.evaluate(() => getSelection().removeAllRanges());
    });

    await s.step('off for this page: hidden, the button greyed with the reason, the bar says so', async () => {
      await api('PATCH', `/docs/pages/${pageId}/settings`, { settings: { highlights: 'off' } });
      await openPage();
      const btn = p.getByTestId('highlights-button');
      await btn.waitFor();
      if ((await btn.getAttribute('aria-disabled')) !== 'true') throw new Error('the button should be disabled');
      if (!/Highlights are off for this page/.test((await btn.getAttribute('title')) ?? '')) throw new Error('no reason on the button');
      if (await p.getByTestId('hl-marker').count()) throw new Error('highlights drawn while off');
      await select('b-000001', 'It was the briefing');
      await p.getByTestId('hl-sel-note').getByText(/Highlights are off for this page/).waitFor();
      await p.evaluate(() => getSelection().removeAllRanges());
      await api('PATCH', `/docs/pages/${pageId}/settings`, { settings: { highlights: 'comment' } });
    });

    await s.step('removed while you read: Hoa Mai removes the highlight you have open; one short message says so', async () => {
      const h = await api('POST', `/docs/pages/${pageId}/highlights`, { block_id: 'b-000002', start: 61, end: 69, quote: 'the goal', color: 'orange' }, 'Hoa Mai');
      await openPage();
      await p.locator(`[data-testid="hl-marker"][data-hl="${h.id}"]`).click();
      await p.getByTestId('hl-popover').getByText('Highlighted by Hoa Mai · just now').waitFor();
      await api('DELETE', `/docs/highlights/${h.id}`, undefined, 'Hoa Mai');
      const note = p.getByTestId('hl-removed-note');
      await note.getByText('Hoa Mai removed a highlight you were looking at. Its comments stay on the page.').waitFor();
      expect('the message (126)', await box(note), { w: 380, bg: 'rgb(30, 42, 34)', padding: '11px 14px' });
      await p.getByTestId('hl-popover').waitFor({ state: 'detached' });
      await note.getByTestId('hl-removed-ok').click();
      await note.waitFor({ state: 'detached' });
    });

    await s.step('Add to the page: an editor turns Hoa Mai’s highlight into page text; Becoming page text until publish', async () => {
      const h = await api('POST', `/docs/pages/${pageId}/highlights`, { block_id: 'b-000004', start: 69, end: 90, quote: 'stopped adding fields', color: 'yellow' }, 'Hoa Mai');
      await openPage();
      await p.locator(`[data-testid="hl-marker"][data-hl="${h.id}"]`).click();
      const row = p.getByTestId('hl-popover').getByTestId('hl-to-page');
      expect('the Add to the page row', await box(row), { h: 34, font: '600 13px' });
      await row.click();
      const dlg = p.getByTestId('hl-to-page-confirm');
      await dlg.getByText('Add to the page?').waitFor();
      await dlg.getByText('Needs edit rights. People who can only read do not get this option.').waitFor();
      expect('the confirm (92)', await box(dlg), { w: 500, radius: '16px' });
      await dlg.getByRole('button', { name: 'Add to the page' }).click();
      await p.getByTestId('hl-note').getByText('Added to the page draft. Readers see it when you publish.').waitFor();
      const after = (await list()).find((x) => x.id === h.id);
      if (after?.state !== 'becoming') throw new Error('not becoming: ' + JSON.stringify(after));
      await p.getByTestId('highlights-button').click();
      await p.locator(`[data-testid="hl-row"][data-hl="${h.id}"]`).getByTestId('hl-becoming').getByText('Becoming page text').waitFor();
      await p.getByRole('button', { name: 'Close the highlights' }).click();
      // a publish carries the words as page text, and the shared one goes
      const pg = await api('GET', `/docs/pages/${pageId}`);
      await api('POST', `/docs/pages/${pageId}/publish`, { base_version: pg.version });
      if ((await list()).some((x) => x.id === h.id)) throw new Error('the shared highlight stayed after the publish');
    });

    await s.step('Passage changed: Use the new quote takes the edited words; Re-attach picks the words again', async () => {
      const a = await api('POST', `/docs/pages/${pageId}/highlights`, { block_id: 'b-000004', start: 21, end: 31, quote: 'one screen', color: 'blue' });
      const b = await api('POST', `/docs/pages/${pageId}/highlights`, { block_id: 'b-000004', start: 21, end: 31, quote: 'one screen', color: 'violet' });
      const edited = JSON.parse(JSON.stringify(DOC).replace('fits on one screen.', 'fits on two screens.'));
      await api('PUT', `/docs/pages/${pageId}/draft`, { content: edited });
      const pg = await api('GET', `/docs/pages/${pageId}`);
      await api('POST', `/docs/pages/${pageId}/publish`, { base_version: pg.version });
      await openPage();
      await p.getByTestId('highlights-button').click();
      const rowA = p.locator(`[data-testid="hl-row"][data-hl="${a.id}"]`);
      const rowB = p.locator(`[data-testid="hl-row"][data-hl="${b.id}"]`);
      await rowA.getByTestId('hl-changed').waitFor();
      await rowA.getByText(/Re-attach lets you pick the words again; Use the new quote takes the edited words\./).waitFor();
      expect('Re-attach', await box(rowA.getByTestId('hl-reattach')), { h: 32, font: '600 12.5px', radius: '8px' });
      const [req] = await Promise.all([
        p.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/docs/highlights/${a.id}`)),
        rowA.getByTestId('hl-new-quote').click(),
      ]);
      if (JSON.parse(req.postData() ?? '{}').quote !== 'two screens') throw new Error('new quote sent ' + req.postData());
      await rowA.getByTestId('hl-go').waitFor();
      await rowB.getByTestId('hl-reattach').click();
      await p.getByTestId('hl-reattach-strip').getByText('Re-attach the highlight.').waitFor();
      await select('b-000004', 'three short parts');
      const [req2] = await Promise.all([
        p.waitForRequest((r) => r.method() === 'PATCH' && r.url().endsWith(`/docs/highlights/${b.id}`)),
        p.getByTestId('selection-toolbar').getByTestId('hl-attach-here').click(),
      ]);
      const sent = JSON.parse(req2.postData() ?? '{}');
      if (sent.quote !== 'three short parts' || sent.block_id !== 'b-000004') throw new Error('re-attach sent ' + req2.postData());
      await p.getByTestId('hl-reattach-strip').waitFor({ state: 'detached' });
      await rowB.getByTestId('hl-go').waitFor();
      const states = (await list()).filter((x) => x.id === a.id || x.id === b.id).map((x) => x.state);
      if (states.join() !== 'ok,ok') throw new Error('states ' + states);
      await p.getByRole('button', { name: 'Close the highlights' }).click();
    });

    await s.step('print: Include highlights is off by default; on, the tint, the line, the marker and a list of who', async () => {
      await p.evaluate(() => {
        window.print = () => {
          const sheet = document.querySelector('.dk-print-sheet');
          window.__printed = {
            marks: sheet?.querySelectorAll('.dk-hl-print').length ?? 0,
            readerMarks: sheet?.querySelectorAll('.dk-hl-mark').length ?? 0,
            list: sheet?.querySelector('.dk-hl-print-list')?.textContent ?? '',
          };
          window.dispatchEvent(new Event('afterprint'));
        };
      });
      // Ctrl+P opens the print panel (the header may fold Print into More at this width)
      await p.keyboard.press('Control+p');
      const dlg = p.getByTestId('print-dialog');
      await dlg.getByText('Off by default. Prints everyone’s highlights with a marker, and a list at the foot with who made them.').waitFor();
      if ((await dlg.getByTestId('print-highlights').getAttribute('aria-checked')) === 'true') throw new Error('Include highlights should start off');
      await dlg.getByTestId('print-go').click();
      let printed = await p.evaluate(() => window.__printed);
      if (printed.marks || printed.readerMarks || printed.list) throw new Error('highlights printed while off ' + JSON.stringify(printed));
      await p.keyboard.press('Control+p');
      await dlg.getByTestId('print-highlights').click();
      await dlg.getByTestId('print-go').click();
      printed = await p.evaluate(() => window.__printed);
      if (!printed.marks || !/Highlights/.test(printed.list) || !/Blue · You/.test(printed.list)) throw new Error('printed ' + JSON.stringify(printed));
    });

    await s.step('offline: a new highlight waits in this browser, Not sent yet, and is sent when the connection returns', async () => {
      await openPage();
      const before = (await list()).length;
      await p.context().setOffline(true);
      await select('b-000006', 'what the team decided');
      await p.getByTestId('selection-toolbar').getByTestId('hl-swatch-green').click();
      await p.waitForFunction(() => CSS.highlights.has('dk-hl-green'));
      await p.getByTestId('highlights-button').click();
      const panel = p.getByTestId('hl-panel');
      const note = panel.getByTestId('hl-offline-note');
      await note.getByText('Not sent yet. It will be sent when you are back online.').waitFor();
      expect('the offline note (90)', await box(note), { bg: 'rgb(253, 243, 227)' });
      await panel.getByTestId('hl-not-sent').getByText('Not sent yet').waitFor();
      if ((await list()).length !== before) throw new Error('sent while offline');
      await p.context().setOffline(false);
      await panel.getByTestId('hl-not-sent').waitFor({ state: 'detached' });
      await note.waitFor({ state: 'detached' });
      const now = await list();
      if (!now.some((h) => h.quote === 'what the team decided' && h.color === 'green')) throw new Error('not sent when back online');
      await p.getByRole('button', { name: 'Close the highlights' }).click();
    }, { expectConsole: true });

    await s.step('Edit mode: the highlights stay as a dotted line with their markers, not part of the text; Hide', async () => {
      await openPage();
      const n = (await list()).length;
      await p.getByTestId('edit-page').click();
      const strip = p.getByTestId('hl-edit-strip');
      await strip.getByText('Highlights stay on the page while you edit.').waitFor();
      // one on plain words (not the ones Add to the page made page text)
      const plain = (await list()).find((h) => h.quote === 'what the team decided');
      const deco = p.locator(`.ProseMirror .dk-hl-edit[data-hl="${plain.id}"]`).first();
      await deco.waitFor();
      const line = await deco.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { style: cs.borderBottomStyle, width: cs.borderBottomWidth, bg: cs.backgroundColor };
      });
      if (line.style !== 'dotted' || line.width !== '2px' || line.bg !== 'rgba(0, 0, 0, 0)') throw new Error('edit line ' + JSON.stringify(line));
      const marks = await p.locator('.ProseMirror [data-testid="hl-edit-marker"]').count();
      if (marks !== n) throw new Error(`${marks} markers for ${n} highlights`);
      // not part of the text: the block's words are unchanged
      const text = await p.locator('.ProseMirror p').first().textContent();
      if (!text.startsWith('When we first let an AI team pick up a ticket, we expected the hard part to be the code.')) throw new Error('text ' + text);
      await strip.getByTestId('hl-edit-hide').click();
      await strip.getByText('Highlights are hidden while you edit.').waitFor();
      if (await p.locator('.ProseMirror .dk-hl-edit').count()) throw new Error('still drawn after Hide');
      await strip.getByTestId('hl-edit-hide').click();
      await p.locator('.ProseMirror .dk-hl-edit').first().waitFor();
      await openPage();
    });

    await s.step('tablet: the bar button opens the list in a drawer from the right; 44 px buttons', async () => {
      // the open page folds to the tablet layout (the tree is a drawer there)
      await p.setViewportSize({ width: 820, height: 1180 });
      await p.locator('[data-testid="docs-page"][data-layout="tablet"]').waitFor();
      await p.getByTestId('highlights-button').click();
      const drawer = p.getByTestId('hl-drawer');
      await drawer.getByTestId('hl-panel').waitFor();
      expect('Go to passage (tablet)', await box(drawer.getByTestId('hl-go').first()), { h: 44 });
      await p.keyboard.press('Escape');
      await drawer.waitFor({ state: 'detached' });
    });

    await s.step('phone: Highlights is the middle of five bottom-bar items, with its count; a sheet', async () => {
      await p.setViewportSize({ width: 390, height: 844 });
      await p.locator('[data-testid="docs-page"][data-layout="phone"]').waitFor();
      const bar = p.getByTestId('read-bar');
      const items = await bar.locator('.dk-readbar-btn').allInnerTexts();
      if (items.map((t) => t.split('\n').pop().trim()).join(',') !== 'Outline,Find,Highlights,Text,Share') throw new Error('bottom bar: ' + items);
      // five equal items
      const widths = await bar.locator('.dk-readbar-btn').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
      const barW = await bar.evaluate((el) => Math.round(el.getBoundingClientRect().width));
      if (new Set(widths).size !== 1 || Math.abs(widths[0] * 5 - barW) > 2) throw new Error(`bottom bar items ${widths} on ${barW}`);
      const left = await bar.evaluate((el) => Math.round(el.getBoundingClientRect().left));
      // the board: 78 px each on the 390 px phone, the bar from edge to edge
      if (barW !== 390 || left !== 0 || widths[0] !== 78) throw new Error(`bottom bar ${barW} at ${left}, items ${widths}`);
      const scrollX = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      if (scrollX) throw new Error('the bottom bar makes the page scroll sideways');
      s.note('bottom bar', { widths, barW, left });
      await bar.getByTestId('read-highlights').click();
      const sheet = p.getByTestId('hl-sheet');
      await sheet.getByTestId('hl-panel').waitFor();
      expect('Go to passage (phone)', await box(sheet.getByTestId('hl-go').first()), { h: 44 });
      await sheet.getByTestId('hl-go').first().click();
      await sheet.waitFor({ state: 'detached' });
      await p.setViewportSize({ width: 1440, height: 900 });
    });
  },
};
