import fs from 'node:fs';
import path from 'node:path';
import { makeFixtures, cleanFixtures } from '../lib/fixtures.mjs';
import { ensureProject, createTicket, openTicket, addMember, closeTicket, openDocs } from '../lib/ui.mjs';

// Canvases: the editor (tabs, zoom, map, keys, notes, labels, arrows, boards panel, board menu), comments with
// mentions, history, the source editor, the large view and Present, embeds, Move to Docs, a canvas page in Docs and
// "Open on a canvas". Left out: everything that needs an AI run (a team saving a board or answering a mention, the
// AI chips and the "Written by AI" filter have no data here) and drawing a diagram or a sketch (scenarios 30, 31).
export default {
  name: 'Canvas: editor, comments, history, source, viewer, Docs page',
  async run(s) {
    const p = s.page;
    const fx = makeFixtures();
    fx.landing = path.join(fx.dir, 'landing.html');
    fx.pricing = path.join(fx.dir, 'pricing.html');
    fs.writeFileSync(fx.landing, '<!doctype html><html><body><h1>Landing page</h1><p>Welcome to the launch.</p></body></html>');
    fx.extra = path.join(fx.dir, 'extra.html');
    fs.writeFileSync(fx.extra, '<!doctype html><html><body><h1>Extra page</h1></body></html>');
    fx.pricing2 = path.join(fx.dir, 'pricing2.html');
    fs.writeFileSync(fx.pricing2, '<!doctype html><html><head><style>@keyframes fade{from{opacity:.3}to{opacity:1}}h1{animation:fade 1s infinite alternate}</style></head><body><h1>Pricing page v2</h1></body></html>');
    fs.writeFileSync(fx.pricing, '<!doctype html><html><body><h1>Pricing page</h1><p>Plans and prices.</p></body></html>');
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    const plane = () => p.getByTestId('canvas-plane');
    const zoom = async () => parseInt(await p.getByTestId('canvas-zoom').innerText(), 10);
    // the label strip above a board (its name and size): clicking it selects the board
    const boardLabel = (name) => plane().locator('[data-kind="board"]').filter({ hasText: new RegExp(`^${name}\\d{2,4} x \\d`) }).first();
    // Polls a condition on the page (for a position or a count that changes without an event to wait for).
    const until = async (fn, what, ms = 8000) => {
      const t0 = Date.now();
      for (;;) {
        if (await fn().catch(() => false)) return;
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
        await p.waitForTimeout(80);
      }
    };
    // select a board by its label and open its menu (the tools show for the selected board and the one under the mouse)
    const menuOf = async (name) => { await boardLabel(name).click(); await ed().getByTestId('canvas-board-menu-btn').click(); };
    // the canvas of this scenario (read from the first request that names it) and calls made as another person
    let canvasId = '';
    p.on('request', (r) => { const m = /\/canvases\/(cv_[0-9a-f]{8})/.exec(r.url()); if (m && !canvasId) canvasId = m[1]; });
    const api = (method, url, actor, data) => p.request.fetch(new URL(url, s.server.base).href, { method, headers: { 'X-Actor': actor }, data });
    const boardOf = async (name) => (await (await api('GET', `/canvases/${canvasId}`, 'user')).json()).doc.boards.find((b) => b.name === name);
    // This person moves the first note; before the save goes out (0.7 s) Ada saves the same note on the server: the
    // answer to this person's save is "Ada saved a newer version".
    const makeConflict = async (text) => {
      const note = plane().getByTestId('canvas-note').first();
      const nb = await note.boundingBox();
      await p.mouse.move(nb.x + nb.width / 2, nb.y + nb.height / 2);
      await p.mouse.down();
      await p.mouse.move(nb.x + nb.width / 2 + 40, nb.y + nb.height / 2 + 20, { steps: 5 });
      await p.mouse.up();
      const cur = await (await api('GET', `/canvases/${canvasId}`, 'Ada')).json();
      const r = await api('PATCH', `/canvases/${canvasId}`, 'Ada', { base_rev: cur.rev, upsert: { notes: [{ ...cur.doc.notes[0], text }] } });
      if (!r.ok()) throw new Error('Ada save: ' + r.status() + ' ' + (await r.text()));
    };
    const ed = () => p.getByRole('dialog', { name: /^Canvas / });
    // The session turns every text/html answer to a fetch() into a 404 (the Rust server's SPA fallback). A board's page is
    // fetched once before it is drawn (BoardFrame) and is text/html, so it would always read "could not be drawn": let
    // those requests through untouched.
    await s.context.route((u) => /\/canvases\/[^/]+\/boards\/[^/]+\/r\//.test(u.pathname), (r) => r.continue());
    try {
      await s.step('set up: a member, a ticket with the description editor open', async () => {
        await ensureProject(s);
        await addMember(s, 'Ada');
        await createTicket(s, { title: 'Canvas work' });
        await openTicket(s, 'ALP-1');
        await dlg().getByRole('button', { name: 'Edit description' }).click();
        await dlg().locator('[contenteditable="true"]').first().click();
        await p.keyboard.type('Boards for this ticket:');
        await p.keyboard.press('Enter');
      });
      await s.step('New canvas dialog: the choices, then Escape backs out', async () => {
        await dlg().getByRole('button', { name: 'Canvas', exact: true }).click();
        const d = p.getByRole('dialog', { name: 'New canvas' });
        await d.getByText('Saved in').waitFor();
        await d.getByText(/Ticket ALP-1/).waitFor();
        await d.getByRole('radio', { name: /Blank/ }).waitFor();
        await d.getByRole('radio', { name: /From files/ }).waitFor();
        // no name, no Create
        await d.getByRole('button', { name: 'Create canvas' }).isDisabled().then((x) => { if (!x) throw new Error('Create should be disabled without a name'); });
        await d.getByPlaceholder('Login redesign').fill('Scratch');
        await p.keyboard.press('Escape');
        await d.waitFor({ state: 'detached' });
      });
      await s.step('New canvas dialog: From files needs files, then makes a board of each', async () => {
        await dlg().getByRole('button', { name: 'Canvas', exact: true }).click();
        const d = p.getByRole('dialog', { name: 'New canvas' });
        await d.getByPlaceholder('Login redesign').fill('Launch map');
        const [chooser] = await Promise.all([p.waitForEvent('filechooser'), d.getByRole('radio', { name: /From files/ }).click()]);
        await chooser.setFiles([fx.landing, fx.pricing, fx.png]);
        await d.getByText(/3 files: landing\.html, pricing\.html, pattern\.png/).waitFor();
        await d.getByRole('button', { name: 'Choose files' }).waitFor();
        await d.getByRole('button', { name: 'Create canvas' }).click();
        await p.getByRole('dialog', { name: 'Canvas Launch map' }).waitFor();
        await ed().getByText('3 boards').waitFor();
      });
      await s.step('rename the canvas in its header', async () => {
        await ed().getByRole('textbox', { name: 'Canvas name' }).fill('Launch plan');
        await p.keyboard.press('Tab');
        await p.getByRole('dialog', { name: 'Canvas Launch plan' }).waitFor();
        await ed().getByText('in ALP-1 description').waitFor();
      });
      await s.step('page tabs: add one, rename it with a double click, cancel and confirm a delete', async () => {
        await ed().getByRole('button', { name: 'Add a page tab' }).click();
        await ed().getByRole('tab', { name: 'Page 2', selected: true }).waitFor();
        await ed().getByText('0 boards').waitFor();
        await ed().getByRole('tab', { name: 'Page 2' }).dblclick();
        await ed().locator('input[class*="tabInput"]').fill('Ideas');
        await p.keyboard.press('Enter');
        await ed().getByRole('tab', { name: 'Ideas', selected: true }).waitFor();
        await ed().getByRole('button', { name: 'Add a page tab' }).click();
        await ed().getByRole('tab', { name: 'Page 3', selected: true }).waitFor();
        // Cancel on the confirm keeps the tab
        let msg = '';
        p.once('dialog', (d) => { msg = d.message(); void d.dismiss(); });
        await ed().getByRole('button', { name: 'Delete this page tab' }).click();
        if (!/Page 3/.test(msg)) throw new Error('confirm text: ' + msg);
        await ed().getByRole('tab', { name: 'Page 3' }).waitFor();
        p.once('dialog', (d) => void d.accept());
        await ed().getByRole('button', { name: 'Delete this page tab' }).click();
        await ed().getByRole('tab', { name: 'Page 3' }).waitFor({ state: 'detached' });
        await ed().getByRole('tab', { name: 'Ideas' }).waitFor();
        await ed().getByRole('tab', { name: 'Page 1' }).click();
        await ed().getByText('3 boards').waitFor();
      });
      await s.step('zoom: out below 40% draws pictures, in draws the live pages, Fit and the map', async () => {
        const z0 = await zoom();
        await ed().getByRole('button', { name: 'Zoom out' }).click();
        await p.waitForFunction((n) => parseInt(document.querySelector('[data-testid="canvas-zoom"]').innerText, 10) < n, z0);
        // under 40% a board is a picture of its last state, not a live page
        await plane().locator('img[src*="snapshot.png"]').first().waitFor();
        if (await plane().locator('[data-testid="board-iframe"]').count()) throw new Error('live pages below 40%');
        await ed().getByRole('button', { name: 'Zoom in' }).click();
        await ed().getByRole('button', { name: 'Zoom in' }).click();
        await plane().locator('[data-testid="board-iframe"]').first().waitFor();
        await ed().getByRole('button', { name: 'Fit' }).click();
        await p.waitForFunction((n) => parseInt(document.querySelector('[data-testid="canvas-zoom"]').innerText, 10) === n, z0);
        const map = ed().getByRole('button', { name: 'Map' });
        await map.click();
        await ed().getByTestId('canvas-minimap').waitFor({ state: 'detached' });
        await p.keyboard.press('m');
        await ed().getByTestId('canvas-minimap').waitFor();
      });
      await s.step('the map: a click on it moves the view', async () => {
        const before = await boardLabel('landing').boundingBox();
        const mm = await ed().getByTestId('canvas-minimap').boundingBox();
        await p.mouse.click(mm.x + mm.width - 14, mm.y + 12);
        await until(async () => Math.abs((await boardLabel('landing').boundingBox()).x - before.x) > 20, 'the map moved the view');
        await ed().getByRole('button', { name: 'Fit' }).click();
      });
      await s.step('keys: the list under the keyboard button, closed with Escape', async () => {
        await ed().getByRole('button', { name: 'Keys' }).click();
        const k = p.getByRole('dialog', { name: 'Keys' });
        await k.getByText('Select the next / previous board in order').waitFor();
        await k.getByText('Undo / redo layout changes (not source edits)').waitFor();
        await p.keyboard.press('Escape');
        await k.waitFor({ state: 'detached' });
        await ed().waitFor();
      });
      await s.step('keys: tool letters, Tab through the boards, 1 / 2 / 0 for the zoom, F for focus', async () => {
        await plane().focus();
        for (const [key, tool] of [['n', 'Note'], ['a', 'Arrow'], ['t', 'Label'], ['c', 'Comment'], ['h', 'Hand'], ['v', 'Select']]) {
          await p.keyboard.press(key);
          await ed().getByRole('button', { name: tool, exact: true, pressed: true }).waitFor();
        }
        await p.keyboard.press('Tab');
        await p.waitForFunction(() => /^\d+%$/.test(document.querySelector('[data-testid="canvas-zoom"]').innerText));
        await boardLabel('landing').waitFor();
        await p.keyboard.press('1');
        await ed().getByTestId('canvas-zoom').filter({ hasText: '100%' }).waitFor();
        await p.keyboard.press('2');
        await p.keyboard.press('0');
        await ed().getByTestId('canvas-zoom').filter({ hasText: /^\d\d%$/ }).waitFor();
        await p.keyboard.press('f');
        await ed().getByRole('textbox', { name: 'Canvas name' }).waitFor({ state: 'detached' });
        await ed().getByTestId('canvas-zoom').waitFor({ state: 'detached' });
        await p.keyboard.press('f');
        await ed().getByRole('textbox', { name: 'Canvas name' }).waitFor();
      });
      await s.step('wheel, hand tool and Space pan and zoom the plane', async () => {
        const z0 = await zoom();
        const bb = await plane().boundingBox();
        await p.mouse.move(bb.x + bb.width / 2, bb.y + 120);
        await p.keyboard.down('Control');
        await p.mouse.wheel(0, -300);
        await p.keyboard.up('Control');
        await p.waitForFunction((n) => parseInt(document.querySelector('[data-testid="canvas-zoom"]').innerText, 10) > n, z0);
        await p.keyboard.down('Control'); await p.keyboard.press('-'); await p.keyboard.up('Control');
        await p.keyboard.down('Control'); await p.keyboard.press('0'); await p.keyboard.up('Control');
        await ed().getByTestId('canvas-zoom').filter({ hasText: new RegExp(`^${z0}%$`) }).waitFor();
        const before = await boardLabel('landing').boundingBox();
        await ed().getByRole('button', { name: 'Hand', exact: true }).click();
        await p.mouse.move(bb.x + 700, bb.y + 100);
        await p.mouse.down();
        await p.mouse.move(bb.x + 600, bb.y + 60, { steps: 6 });
        await p.mouse.up();
        await until(async () => Math.abs((await boardLabel('landing').boundingBox()).x - before.x) > 40, 'the hand panned the plane');
        await ed().getByRole('button', { name: 'Select', exact: true }).click();
        await ed().getByRole('button', { name: 'Fit' }).click();
      });
      await s.step('note: the Note tool puts a note on the plane and the text is typed in it', async () => {
        await ed().getByRole('button', { name: 'Note', exact: true }).click();
        await plane().click({ position: { x: 500, y: 90 } });
        await plane().getByRole('textbox', { name: 'Note text' }).fill('Ship the pricing page');
        await p.keyboard.press('Escape');
        await plane().getByTestId('canvas-note').filter({ hasText: 'Ship the pricing page' }).waitFor();
      });
      await s.step('note: each of the six colours paints it', async () => {
        const note = plane().getByTestId('canvas-note').filter({ hasText: 'Ship the pricing page' });
        const COLORS = { yellow: 'rgb(255, 243, 184)', green: 'rgb(227, 243, 231)', blue: 'rgb(221, 236, 250)', pink: 'rgb(252, 226, 233)', purple: 'rgb(239, 232, 251)', grey: 'rgb(232, 236, 233)' };
        for (const [name, rgb] of Object.entries(COLORS)) {
          await ed().getByRole('button', { name: `Note colour ${name}` }).click();
          await until(async () => (await note.evaluate((e) => getComputedStyle(e).backgroundColor)) === rgb, `note is ${name}`);
        }
        await ed().getByRole('button', { name: 'Note colour pink' }).click();
      });
      await s.step('label: the Label tool, its text and its size', async () => {
        await ed().getByRole('button', { name: 'Label', exact: true }).click();
        await plane().click({ position: { x: 900, y: 100 } });
        const field = plane().getByRole('textbox', { name: 'Label text' });
        await field.fill('Launch checklist');
        await p.keyboard.press('Enter');
        const label = plane().getByTestId('canvas-label').filter({ hasText: 'Launch checklist' });
        await label.waitFor();
        await ed().getByRole('button', { name: '48', exact: true }).click();
        await ed().getByRole('button', { name: '48', exact: true, pressed: true }).waitFor();
        await until(async () => (await label.evaluate((e) => getComputedStyle(e).fontSize)) === '48px', 'label is 48px');
        await ed().getByRole('button', { name: '20', exact: true }).click();
        await until(async () => (await label.evaluate((e) => getComputedStyle(e).fontSize)) === '20px', 'label is 20px');
        // double click edits it again
        // a real double click (the plane captures the pointer, so the event comes to the plane; it used to edit nothing)
        await label.dblclick();
        await plane().getByRole('textbox', { name: 'Label text' }).fill('Launch checklist v2');
        await p.keyboard.press('Enter');
        await plane().getByTestId('canvas-label').filter({ hasText: 'Launch checklist v2' }).waitFor();
      });
      await s.step('arrow: join the note to a board, give it a label, undo and redo', async () => {
        await ed().getByRole('button', { name: 'Arrow', exact: true }).click();
        await plane().getByTestId('canvas-note').click();
        const bb = await plane().locator('[data-testid="canvas-board"]').first().boundingBox();
        await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
        const line = plane().locator('line[data-kind="arrow"]');
        await line.waitFor({ state: 'attached' });
        const lb = await line.boundingBox();
        let asked = '';
        p.once('dialog', (d) => { asked = d.message(); void d.accept('depends on'); });
        await p.mouse.dblclick(lb.x + lb.width / 2, lb.y + lb.height / 2);
        await until(async () => asked === 'Arrow label', 'the arrow label prompt');
        await plane().focus();
        // the first undo takes the label back, the second the arrow
        for (let i = 0; i < 2; i++) { await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control'); }
        await until(async () => (await line.count()) === 0, 'undo removed the arrow');
        await p.keyboard.down('Control'); await p.keyboard.press('y'); await p.keyboard.up('Control');
        await until(async () => (await line.count()) === 1, 'redo brought the arrow back');
      });
      await s.step('board: drag to move, a handle resizes, a box selects both, the arrow keys nudge', async () => {
        const lab = boardLabel('pricing');
        const b0 = await lab.boundingBox();
        await p.mouse.move(b0.x + 20, b0.y + 8);
        await p.mouse.down();
        await p.mouse.move(b0.x + 20, b0.y + 48, { steps: 8 });
        await p.mouse.up();
        await until(async () => Math.abs((await lab.boundingBox()).y - b0.y) > 20, 'the board moved');
        const h = plane().locator('[data-handle="se"]');
        await h.waitFor();
        const hb = await h.boundingBox();
        await p.mouse.move(hb.x + 4, hb.y + 4);
        await p.mouse.down();
        await p.mouse.move(hb.x - 60, hb.y - 40, { steps: 8 });
        await p.mouse.up();
        await until(async () => !/1280 x 800/.test(await lab.innerText()), 'the board was resized');
        const pb = await plane().boundingBox();
        await p.mouse.move(pb.x + 5, pb.y + 5);
        await p.mouse.down();
        await p.mouse.move(pb.x + pb.width - 5, pb.y + pb.height - 70, { steps: 8 });
        await p.mouse.up();
        await ed().getByText('3 boards').waitFor();
        await p.keyboard.press('Shift+ArrowRight');
        await p.keyboard.press('Escape');
        await ed().getByRole('button', { name: 'Fit' }).click();
      });
      await s.step('Boards tab: find a board, drag a row to set the order, a click jumps to the board', async () => {
        await ed().getByTestId('canvas-comments-btn').click();
        await ed().getByTestId('canvas-tab-boards').click();
        const rows = ed().getByTestId('canvas-board-row');
        await rows.nth(2).waitFor();
        await ed().getByRole('textbox', { name: 'Find a board' }).fill('pri');
        await rows.filter({ hasText: 'pricing' }).waitFor();
        if ((await rows.count()) !== 1) throw new Error('the search should leave one board');
        await ed().getByRole('textbox', { name: 'Find a board' }).fill('zzz');
        await ed().getByText('No boards match.').waitFor();
        await ed().getByRole('textbox', { name: 'Find a board' }).fill('');
        // the order badges show on the plane while this tab is open; dragging pricing above landing swaps them
        await plane().getByTestId('canvas-order-badge').first().waitFor();
        await rows.filter({ hasText: 'pricing' }).dragTo(rows.filter({ hasText: 'landing' }));
        await until(async () => /pricing/.test(await rows.first().innerText()), 'pricing is first in the order');
        await rows.filter({ hasText: 'landing' }).click();
        await until(async () => (await zoom()) > 60, 'a click on a row zooms to the board');
        await ed().getByRole('button', { name: 'Fit' }).click();
        await ed().getByRole('button', { name: 'Close panel' }).click();
      });
      await s.step('board menu: rename, sizes, fit height and a custom size', async () => {
        await boardLabel('pricing').click();
        const menu = () => ed().getByTestId('canvas-board-menu');
        const open = async () => { if (!(await menu().count())) await ed().getByTestId('canvas-board-menu-btn').click(); await menu().waitFor(); };
        await open();
        await menu().getByRole('menuitem', { name: /^Rename/ }).click();
        await plane().getByRole('textbox', { name: 'Board name' }).fill('Pricing v1');
        await p.keyboard.press('Enter');
        await boardLabel('Pricing v1').waitFor();
        await open();
        await menu().getByRole('menuitem', { name: /^Size/ }).click();
        for (const m of ['Desktop 1280 x 800', 'Laptop 1440 x 900', 'Wide 1920 x 1080', 'Tablet 820 x 1180']) await menu().getByRole('menuitem', { name: m }).waitFor();
        await menu().getByRole('menuitem', { name: 'Phone 390 x 844' }).click();
        await boardLabel('Pricing v1').filter({ hasText: '390 x 844' }).waitFor();
        await open();
        await menu().getByRole('menuitem', { name: /^Size/ }).click();
        await menu().getByRole('menuitem', { name: /^Fit height to content/ }).click();
        await until(async () => !/390 x 844/.test(await boardLabel('Pricing v1').innerText()), 'the height fits the page');
        await open();
        await menu().getByRole('menuitem', { name: /^Size/ }).click();
        const asked = [];
        p.on('dialog', async function h(d) { asked.push(d.message()); await d.accept(asked.length === 1 ? '900' : '500'); if (asked.length === 2) p.off('dialog', h); });
        await menu().getByRole('menuitem', { name: /^Custom/ }).click();
        await boardLabel('Pricing v1').filter({ hasText: '900 x 500' }).waitFor();
        if (!/Width/.test(asked[0])) throw new Error('prompt: ' + asked[0]);
        await open();
        await menu().getByRole('menuitem', { name: /^Size/ }).click();
        await menu().getByRole('menuitem', { name: 'Desktop 1280 x 800' }).click();
        await boardLabel('Pricing v1').filter({ hasText: '1280 x 800' }).waitFor();
      });
      await s.step('board menu: replace the content of a board with another page', async () => {
        await ed().getByTestId('canvas-board-menu-btn').click();
        const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.getByRole('menuitem', { name: /^Replace content/ }).click()]);
        await chooser.setFiles(fx.pricing2);
        // zoomed on the board (2) it is drawn live
        await plane().focus();
        await p.keyboard.press('2');
        await plane().frameLocator('iframe[title="Pricing v1"]').getByText('Pricing page v2').waitFor();
        await ed().getByRole('button', { name: 'Fit' }).click();
      });
      await s.step('board menu: duplicate, copy the link, copy as an image, delete the copy', async () => {
        await menuOf('Pricing v1');
        await p.getByRole('menuitem', { name: /^Duplicate/ }).click();
        await ed().getByText('4 boards').waitFor();
        // the copy is placed to the right of the others, out of view: Fit first (clicking it where it is would scroll the plane)
        await ed().getByRole('button', { name: 'Fit' }).click();
        await menuOf('Pricing v1 copy');
        await p.getByRole('menuitem', { name: 'Copy link to board' }).click();
        await p.getByText('Link copied').first().waitFor();
        const link = await p.evaluate(() => navigator.clipboard.readText());
        if (!/canvas:cv_[0-9a-f]{8}#b_/.test(link)) throw new Error('link: ' + link);
        await menuOf('Pricing v1 copy');
        await p.getByRole('menuitem', { name: 'Copy board as image' }).click();
        await p.getByText(/on the clipboard as a picture|Could not copy the picture/).first().waitFor();
        await menuOf('Pricing v1 copy');
        await p.getByTestId('canvas-menu-delete').click();
        await ed().getByText('3 boards').waitFor();
      });
      await s.step('board menu: download the files, a picture, an SVG and a GIF of a board', async () => {
        await boardLabel('Pricing v1').click();
        const dl = async (item, ext) => {
          await ed().getByTestId('canvas-board-menu-btn').click();
          const menu = ed().getByTestId('canvas-board-menu');
          if (!(await menu.getByTestId('canvas-download-png').count())) await menu.getByTestId('canvas-menu-download').click();
          const [d] = await Promise.all([p.waitForEvent('download', { timeout: 20000 }).catch(async (e) => { throw new Error(`no download for ${item}: toasts ${JSON.stringify(await p.locator('[class*=toast]').allInnerTexts())}`); }), menu.getByRole('menuitem', { name: item, exact: false }).first().click()]);
          if (!d.suggestedFilename().endsWith(ext)) throw new Error(`${item}: ${d.suggestedFilename()}`);
        };
        await dl(/^Files/, '.zip');
        await dl(/^Image/, '.png');
        await dl(/^SVG/, '.svg');
        await dl(/^GIF/, '.gif');
      });
      await s.step('download menu of the header: ZIP, the board, overview picture, PDF, links', async () => {
        await boardLabel('Pricing v1').click();
        const menu = () => ed().getByRole('menu').filter({ hasText: 'Download' });
        const open = async () => { await ed().getByTestId('canvas-download-btn').click(); await menu().waitFor(); };
        await open();
        for (const t of [/^All boards/, /^This board/, /^Board as image/, /^Board as SVG/, /^Board as GIF/, /^Overview as image/, /^PDF/, /^To this canvas/, /^To this board/, /^Move to Docs/]) await menu().getByRole('menuitem', { name: t }).waitFor();
        const grab = async (name) => {
          const [d] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), menu().getByRole('menuitem', { name }).click()]);
          return d.suggestedFilename();
        };
        const all = await grab(/^All boards/);
        if (!/\.zip$/.test(all)) throw new Error('zip: ' + all);
        await open();
        const one = await grab(/^This board/);
        if (!/Pricing/.test(one)) throw new Error('board zip: ' + one);
        await open();
        const ov = await grab(/^Overview as image/);
        if (!/Launch plan\.png$/.test(ov)) throw new Error('overview: ' + ov);
        await open();
        const [popup] = await Promise.all([p.waitForEvent('popup'), menu().getByRole('menuitem', { name: /^PDF/ }).click()]);
        await popup.close();
        await open();
        await menu().getByRole('menuitem', { name: /^To this canvas/ }).click();
        await p.getByText('Link copied').first().waitFor();
        const link = await p.evaluate(() => navigator.clipboard.readText());
        if (!/^\[Launch plan\]\(canvas:cv_[0-9a-f]{8}\)$/.test(link) && !/canvas:cv_[0-9a-f]{8}/.test(link)) throw new Error('link: ' + link);
      });
      await s.step('Done: the editor closes and the description holds the canvas as a card with Show… and Edit canvas', async () => {
        await ed().getByTestId('canvas-done').click();
        await ed().waitFor({ state: 'detached' });
        await dlg().locator('[data-canvas]').waitFor();
        await dlg().locator('[data-canvas-name]').filter({ hasText: 'Launch plan' }).waitFor();
        await dlg().getByRole('button', { name: 'Show…' }).waitFor();
      });
      await s.step('embed settings: One board narrows the card to that board', async () => {
        await dlg().getByRole('button', { name: 'Show…' }).click();
        const d = p.getByRole('dialog', { name: 'Embed settings' });
        for (const o of ['Whole canvas', 'One board', 'Link only']) await d.getByRole('button', { name: new RegExp(`^${o}`) }).waitFor();
        await d.getByRole('button', { name: 'pattern', exact: true }).click();
        await d.waitFor({ state: 'detached' });
        await dlg().locator('[data-canvas][data-fragment^="b_"]').waitFor();
        // Cancel leaves it as it is
        await dlg().getByRole('button', { name: 'Show…' }).click();
        await d.getByRole('button', { name: 'Cancel' }).click();
        await d.waitFor({ state: 'detached' });
      });
      await s.step('leave the editor: the card shows one board, View full size opens the large view at it', async () => {
        await dlg().getByRole('heading', { level: 2 }).click();
        await s.settle(2500);
        const emb = dlg().getByTestId('canvas-embed');
        await emb.getByText('pattern · Launch plan').waitFor();
        await emb.getByText('1 frame').waitFor();
        await emb.hover();
        await emb.getByTestId('canvas-view').click();
        const v = p.getByRole('dialog', { name: 'Launch plan' });
        await v.getByText(/\d of \d · pattern/).waitFor();
        await v.getByTestId('canvas-viewer-close').click();
        await v.waitFor({ state: 'detached' });
      });
      await s.step('embed settings: Whole canvas brings all boards back', async () => {
        await dlg().getByText('Boards for this ticket:').click();
        await dlg().getByRole('button', { name: 'Show…' }).click();
        await p.getByRole('dialog', { name: 'Embed settings' }).getByTestId('canvas-show-canvas').click();
        await dlg().locator('[data-canvas]:not([data-fragment])').waitFor();
        await dlg().getByRole('heading', { level: 2 }).click();
        await s.settle(2500);
        await dlg().getByTestId('canvas-embed').getByText(/^\d+ frames$/).waitFor();
      });
      await s.step('the embed card: Edit opens the canvas again, Copy link and Download work', async () => {
        const emb = dlg().getByTestId('canvas-embed');
        await emb.hover();
        await emb.getByTestId('canvas-copy-link').click();
        await p.getByText('Link copied').first().waitFor();
        const [d] = await Promise.all([p.waitForEvent('download'), emb.getByTestId('canvas-download').click()]);
        if (!/\.zip$/.test(d.suggestedFilename())) throw new Error('download: ' + d.suggestedFilename());
        await emb.getByTestId('canvas-edit').click();
        await p.getByRole('dialog', { name: 'Canvas Launch plan' }).waitFor();
        await ed().getByText('Launch checklist v2').or(ed().getByText(/boards$/)).first().waitFor();
      });
      await s.step('comment: the board tool opens the pin box; typing @ offers the people', async () => {
        await boardLabel('landing').click();
        await plane().locator('[data-tools-for]').getByRole('button', { name: 'Comment' }).click();
        const draft = ed().getByTestId('canvas-pin-draft');
        await draft.getByPlaceholder('Is the button label long enough for Vietnamese?').waitFor();
        await draft.getByRole('textbox', { name: 'Comment' }).fill('Check the hero text with @Ad');
        await p.getByRole('listbox', { name: 'Mention a member' }).getByRole('option', { name: /Ada/ }).click();
        await draft.getByRole('textbox', { name: 'Comment' }).filter({ hasText: /@Ada/ }).waitFor();
      });
      await s.step('comment: post it on the board; the pin and the thread show the mention', async () => {
        await ed().getByTestId('canvas-pin-post').click();
        await ed().getByTestId('canvas-pin-draft').waitFor({ state: 'detached' });
        await plane().getByRole('button', { name: 'Comment 1' }).waitFor();
        const panel = ed().getByTestId('canvas-comments');
        const th = panel.getByTestId('canvas-thread').first();
        await th.getByText('Check the hero text with').waitFor();
        await th.locator('span[class*="mention"]').filter({ hasText: '@Ada' }).waitFor();
        await th.getByText('“landing”').waitFor();
        await ed().getByTestId('canvas-comments-btn').filter({ hasText: '1' }).waitFor();
      });
      await s.step('comment: the Comment tool pins to the plane; Esc and Cancel leave the box', async () => {
        await ed().getByTestId('canvas-tool-comment').click();
        await plane().click({ position: { x: 300, y: 120 } });
        const draft = ed().getByTestId('canvas-pin-draft');
        await draft.getByRole('textbox', { name: 'Comment' }).fill('Plane note for later');
        // Esc in the box closes it, as its hint says (the editor used to ignore every key typed in a field, Esc too)
        await p.keyboard.press('Escape');
        await draft.waitFor({ state: 'detached' });
        await ed().getByTestId('canvas-tool-comment').click();
        await plane().click({ position: { x: 300, y: 120 } });
        await draft.getByRole('textbox', { name: 'Comment' }).fill('Plane note for later');
        await draft.getByRole('button', { name: 'Cancel' }).click();
        await draft.waitFor({ state: 'detached' });
        await ed().getByTestId('canvas-tool-comment').click();
        await plane().click({ position: { x: 300, y: 120 } });
        await draft.getByRole('textbox', { name: 'Comment' }).fill('Plane note for later');
        await ed().getByTestId('canvas-pin-post').click();
        await plane().getByRole('button', { name: 'Comment 2' }).waitFor();
        await ed().getByTestId('canvas-comments').getByText('“The plane”').waitFor();
      });
      await s.step('comments panel: reply, resolve, the filters, reopen', async () => {
        const panel = ed().getByTestId('canvas-comments');
        const th = (text) => panel.getByTestId('canvas-thread').filter({ hasText: text });
        await th('hero text').getByPlaceholder('Reply…').fill('Looks fine to me');
        await p.keyboard.press('Enter');
        await th('hero text').getByText('Looks fine to me').waitFor();
        await th('hero text').getByRole('button', { name: 'Resolve' }).click();
        await panel.getByTestId('canvas-thread').filter({ hasText: 'hero text' }).waitFor({ state: 'detached' });
        await ed().getByTestId('canvas-comments-btn').filter({ hasText: '1' }).waitFor();
        await panel.getByRole('button', { name: 'Resolved' }).click();
        await th('hero text').getByText('Resolved').waitFor();
        await th('hero text').getByRole('button', { name: 'Reopen' }).waitFor();
        if (await th('Plane note').count()) throw new Error('an open thread shows under Resolved');
        await panel.getByRole('button', { name: 'Open', exact: true }).click();
        await panel.getByRole('button', { name: 'Only this board' }).click();
        await panel.getByText('No comments here yet.').waitFor();
        await panel.getByRole('button', { name: 'Only this board' }).click();
        await panel.getByRole('button', { name: 'Only mine' }).click();
        await th('Plane note').waitFor();
        await panel.getByRole('button', { name: 'Only mine' }).click();
        await panel.getByRole('button', { name: 'Written by AI' }).click();
        await panel.getByText('No comments here yet.').waitFor();
        await panel.getByRole('button', { name: 'Written by AI' }).click();
        await panel.getByRole('button', { name: 'Resolved' }).click();
        await th('hero text').getByRole('button', { name: 'Reopen' }).click();
        await panel.getByRole('button', { name: 'Open', exact: true }).click();
        await th('hero text').waitFor();
      });
      await s.step('comments panel: a thread selects its board, Create ticket, Copy link, delete a thread', async () => {
        const panel = ed().getByTestId('canvas-comments');
        const th = (text) => panel.getByTestId('canvas-thread').filter({ hasText: text });
        await th('hero text').getByText('“landing”').click();
        await ed().getByTestId('canvas-zoom').waitFor();
        await th('hero text').getByRole('button', { name: 'Create ticket' }).click();
        await p.getByText('Ticket created').first().waitFor();
        await th('hero text').getByRole('button', { name: 'Copy link' }).click();
        await p.getByText('Link copied').first().waitFor();
        await th('Plane note').getByRole('button', { name: 'Delete thread' }).click();
        await panel.getByTestId('canvas-thread').filter({ hasText: 'Plane note' }).waitFor({ state: 'detached' });
        await plane().getByRole('button', { name: 'Comment 2' }).waitFor({ state: 'detached' });
      });
      await s.step('source editor: open a board, change the width of the preview and the text, add a file', async () => {
        await boardLabel('landing').click();
        await plane().locator('[data-tools-for]').getByRole('button', { name: 'Edit' }).click();
        const src = p.getByRole('dialog', { name: 'Edit landing' });
        await src.getByTestId('canvas-locked-for-you').waitFor();
        await src.getByText('Live preview').waitFor();
        await src.getByText(/^1 line|^\d+ lines? ·/).waitFor();
        const text = src.getByRole('textbox', { name: /^Source of / });
        await text.waitFor();
        s.note('file tabs', await src.getByRole('tab').allInnerTexts());
        const frame = src.getByTestId('canvas-source-preview');
        await src.frameLocator('iframe[title="Live preview"]').getByText('Landing page').waitFor();
        const width = async () => frame.evaluate((e) => e.style.width);
        const group = src.getByRole('group', { name: 'Preview width' });
                await group.getByRole('button', { name: 'Phone' }).click();
        await group.getByRole('button', { name: 'Phone', pressed: true }).waitFor();
        await until(async () => (await width()) === '390px', 'the preview is 390 wide');
        await group.getByRole('button', { name: 'Tablet' }).click();
        await until(async () => (await width()) === '768px', 'the preview is 768 wide');
        await group.getByRole('button', { name: 'Desktop' }).click();
        await until(async () => (await width()) === '100%', 'the preview is full width again');
        await text.click();
        await p.keyboard.press('Control+End');
        await p.keyboard.type('\n<p>Edited in the source editor</p>');
        await src.frameLocator('iframe[title="Live preview"]').getByText('Edited in the source editor').waitFor();
        // a file that is not text is refused with a message; Back to editor closes it
        p.once('dialog', (d) => void d.accept('photo.png'));
        await src.getByRole('button', { name: '+ Add file' }).click();
        await src.getByTestId('canvas-source-error').getByText(/Add an \.html, \.css/).waitFor();
        await src.getByRole('button', { name: 'Back to editor' }).click();
        await src.getByTestId('canvas-source-error').waitFor({ state: 'detached' });
        p.once('dialog', (d) => void d.accept('style.css'));
        await src.getByRole('button', { name: '+ Add file' }).click();
        await src.getByRole('tab', { name: 'style.css' }).click();
        await src.getByRole('textbox', { name: 'Source of style.css' }).fill('h1 { color: rgb(200, 0, 0); }');
        await src.getByRole('tab', { name: /landing|index/ }).click();
        await text.click();
        await p.keyboard.press('Control+End');
        await p.keyboard.type('\n<link rel="stylesheet" href="style.css">');
        await src.getByText('Draft kept on this computer').first().waitFor();
      });
      await s.step('source editor: Cancel leaves a draft, opening it again offers the draft; Save to canvas draws the new page', async () => {
        const src = p.getByRole('dialog', { name: 'Edit landing' });
        await src.getByTestId('canvas-source-cancel').click();
        await src.waitFor({ state: 'detached' });
        await plane().locator('[data-tools-for]').getByRole('button', { name: 'Edit' }).click();
        await src.getByText('Draft kept on this computer').first().waitFor();
        await src.getByRole('tab', { name: 'style.css' }).waitFor();
        await src.getByRole('textbox', { name: /^Source of / }).click();
        await p.keyboard.press('Control+s');
        await src.waitFor({ state: 'detached' });
        await p.getByText('Saved to canvas').first().waitFor();
        await plane().focus();
        await p.keyboard.press('2');
        const live = plane().frameLocator('iframe[title="landing"]');
        await live.getByText('Edited in the source editor').waitFor();
        await ed().getByRole('button', { name: 'Fit' }).click();
      });
      await s.step('lock: another person editing a board shows a ribbon and blocks Edit and Delete', async () => {
        const board = await boardOf('landing');
        const r = await api('POST', `/canvases/${canvasId}/boards/${board.id}/lock`, 'Ada');
        if (!r.ok()) throw new Error('lock: ' + r.status());
        await boardLabel('landing').click();
        await plane().getByTestId('canvas-lock-ribbon').filter({ hasText: 'Ada is editing' }).waitFor({ timeout: 15000 });
        const edit = plane().locator('[data-tools-for]').getByRole('button', { name: 'Edit' });
        if (!(await edit.isDisabled())) throw new Error('Edit should be off while Ada has the lock');
        await plane().focus();
        await p.keyboard.press('Delete');
        await p.getByText('A board is being edited').first().waitFor();
        // the key still tries: the source editor says who has it
        await p.keyboard.press('e');
        const blocked = p.getByRole('alertdialog', { name: 'Someone else is editing' });
        await blocked.getByText('Ada is editing landing').waitFor();
        await blocked.getByText(/You can still look, comment and move the board/).waitFor();
        await blocked.getByRole('button', { name: 'OK' }).click();
        await blocked.waitFor({ state: 'detached' });
        await api('DELETE', `/canvases/${canvasId}/boards/${board.id}/lock`, 'Ada');
        await plane().getByTestId('canvas-lock-ribbon').waitFor({ state: 'detached', timeout: 15000 });
      }, { expectConsole: true });
      await s.step('source editor: the lock is lost, Save says so; Back to editor, Copy my source, Save as new board', async () => {
        const board = await boardOf('landing');
        await plane().locator('[data-tools-for]').getByRole('button', { name: 'Edit' }).click();
        const src = p.getByRole('dialog', { name: 'Edit landing' });
        await src.getByTestId('canvas-locked-for-you').waitFor();
        // the lock ends under the editor (a restart, or the idle time) and Ada takes the board
        await api('DELETE', `/canvases/${canvasId}/boards/${board.id}/lock`, 'user');
        await api('POST', `/canvases/${canvasId}/boards/${board.id}/lock`, 'Ada');
        await src.getByRole('textbox', { name: /^Source of / }).fill('<h1>Landing page</h1><p>My unsaved version</p>');
        await src.getByTestId('canvas-source-save').click();
        const err = src.getByTestId('canvas-source-error');
        await err.waitFor();
        s.note('save error', await err.innerText());
        await err.getByRole('button', { name: 'Back to editor' }).click();
        await err.waitFor({ state: 'detached' });
        const lost = src.getByTestId('canvas-lock-lost');
        await lost.getByText('Your lock on landing ended').waitFor();
        await lost.getByRole('button', { name: 'Copy my source' }).click();
        await lost.getByRole('button', { name: 'Copied' }).waitFor();
        await lost.getByRole('button', { name: 'Save as new board' }).click();
        await src.waitFor({ state: 'detached' });
        await ed().getByText('4 boards').waitFor();
        await ed().getByRole('button', { name: 'Fit' }).click();
        await boardLabel('landing \\(mine\\)').waitFor();
        await api('DELETE', `/canvases/${canvasId}/boards/${board.id}/lock`, 'Ada');
      }, { expectConsole: true });
      await s.step('source editor: a newer saved version is reported, the source can be kept as a new board', async () => {
        const board = await boardOf('landing');
        await boardLabel('landing').click();
        await plane().locator('[data-tools-for]').getByRole('button', { name: 'Edit' }).click();
        const src = p.getByRole('dialog', { name: 'Edit landing' });
        await src.getByTestId('canvas-locked-for-you').waitFor();
        const fresh = await (await api('GET', `/canvases/${canvasId}/boards/${board.id}/source`, 'Ada')).json();
        await api('DELETE', `/canvases/${canvasId}/boards/${board.id}/lock`, 'user');
        await api('POST', `/canvases/${canvasId}/boards/${board.id}/lock`, 'Ada');
        const put = await api('PUT', `/canvases/${canvasId}/boards/${board.id}/content`, 'Ada', {
          files: [{ path: fresh.entry, text: '<h1>Landing page</h1><p>Ada saved this</p>' }], entry: fresh.entry, base_content_rev: fresh.rev, release: true,
        });
        if (!put.ok()) throw new Error('Ada save: ' + put.status() + ' ' + (await put.text()));
        await src.getByRole('textbox', { name: /^Source of / }).fill('<h1>Landing page</h1><p>Mine, from an older base</p>');
        await src.getByTestId('canvas-source-save').click();
        const err = src.getByTestId('canvas-source-error');
        await err.waitFor();
        s.note('conflict error', await err.innerText());
        await err.getByText('Ada saved a newer version', { exact: true }).waitFor();
        await err.getByRole('button', { name: 'Save as new board' }).click();
        await src.waitFor({ state: 'detached' });
        await ed().getByText('5 boards').waitFor();
        await ed().getByRole('button', { name: 'Fit' }).click();
      }, { expectConsole: true });
      await s.step('conflict: Ada saves the same note first, the card offers Load theirs', async () => {
        await makeConflict('Ada v1');
        const card = ed().getByTestId('canvas-conflict');
        await card.getByText('Ada saved a newer version').waitFor();
        for (const b of ['Save as copy', 'Load theirs', 'Replace theirs']) await card.getByRole('button', { name: b }).waitFor();
        await card.getByRole('button', { name: 'Load theirs' }).click();
        await card.waitFor({ state: 'detached' });
        await plane().getByTestId('canvas-note').filter({ hasText: 'Ada v1' }).waitFor();
      }, { expectConsole: true });
      await s.step('conflict: Replace theirs saves this plane over the newer one', async () => {
        await makeConflict('Ada v2');
        const card = ed().getByTestId('canvas-conflict');
        await card.getByRole('button', { name: 'Replace theirs' }).click();
        await card.waitFor({ state: 'detached' });
        await ed().getByRole('button', { name: 'Fit' }).click();
        await plane().getByTestId('canvas-note').filter({ hasText: 'Ada v1' }).waitFor();
        await until(async () => (await (await api('GET', `/canvases/${canvasId}`, 'user')).json()).doc.notes[0].text === 'Ada v1', 'the server holds this plane');
      }, { expectConsole: true });
      await s.step('conflict: Save as copy keeps this plane as a second canvas and takes theirs', async () => {
        await makeConflict('Ada v3');
        const card = ed().getByTestId('canvas-conflict');
        await card.getByRole('button', { name: 'Save as copy' }).click();
        await p.getByText('Saved a copy').first().waitFor();
        await card.waitFor({ state: 'detached' });
        await plane().getByTestId('canvas-note').filter({ hasText: 'Ada v3' }).waitFor();
      }, { expectConsole: true });
      await s.step('Save a copy in the header makes a second canvas and copies its link', async () => {
        await ed().getByRole('button', { name: 'Save a copy' }).click();
        await p.getByText('Saved a copy').first().waitFor();
        const clip = await p.evaluate(() => navigator.clipboard.readText());
        if (!/canvas:cv_[0-9a-f]{8}/.test(clip) || clip.includes(canvasId)) throw new Error('clipboard: ' + clip);
      });
      await s.step('Done again; the card is back, Edit opens History', async () => {
        await ed().getByTestId('canvas-done').click();
        await ed().waitFor({ state: 'detached' });
        const emb = dlg().getByTestId('canvas-embed');
        await emb.hover();
        await emb.getByTestId('canvas-edit').click();
        await ed().getByTestId('canvas-history-btn').click();
        const h = p.getByRole('dialog', { name: 'History' });
        await h.getByText(/Every Done and every change in a Docs page/).waitFor();
        const vs = h.getByTestId('canvas-version');
        await until(async () => (await vs.count()) >= 3, 'three versions');
        await vs.first().getByText('Version 3').waitFor();
        // the newest version has nothing to restore
        if (await h.getByTestId('canvas-restore').count()) throw new Error('the newest version offers Restore');
        await h.getByRole('button', { name: 'Name…' }).waitFor();
      });
      await s.step('history: compare version 3 with the one before, the source diff of the changed board', async () => {
        const h = p.getByRole('dialog', { name: 'History' });
        await h.getByTestId('canvas-compare').click();
        const c = p.getByRole('dialog', { name: 'Compare versions' });
        await c.getByText('Compare version 2 and version 3').waitFor();
        await c.getByRole('button', { name: /^landing\s*Changed/ }).click();
        await c.getByText('Before · version 2').waitFor();
        await c.getByText('After · version 3').waitFor();
        await c.getByTestId('canvas-source-diff-btn').click();
        await c.locator('pre[class*="diffBox"]').getByText(/\+.*Ada saved this/).waitFor();
        await c.getByRole('button', { name: 'Close' }).click();
        await c.waitFor({ state: 'detached' });
      });
      await s.step('history: name a version, download its ZIP, restore it', async () => {
        const h = p.getByRole('dialog', { name: 'History' });
        const vs = h.getByTestId('canvas-version');
        await vs.filter({ hasText: 'Version 2' }).click();
        let asked = '';
        p.once('dialog', (d) => { asked = d.message(); void d.accept('Before comments'); });
        await h.getByRole('button', { name: 'Name…' }).click();
        await vs.filter({ hasText: 'Version 2' }).getByText('Before comments').waitFor();
        if (asked !== 'Name this version') throw new Error('prompt: ' + asked);
        const [d] = await Promise.all([p.waitForEvent('download'), h.getByRole('link', { name: /ZIP/ }).click()]);
        if (!/\.zip$/.test(d.suggestedFilename())) throw new Error('zip: ' + d.suggestedFilename());
        await h.getByTestId('canvas-restore').click();
        await p.getByText(/Version 2 is now version 4/).first().waitFor();
        await until(async () => (await vs.count()) >= 4, 'the restore made version 4');
        await vs.first().getByText('Version 4').waitFor();
        await vs.first().getByText(/restored/).waitFor();
        await h.getByRole('button', { name: 'Close', exact: true }).click();
        await h.waitFor({ state: 'detached' });
        // the restored plane has no comments' pins' note: the first state of the canvas
        await ed().getByTestId('canvas-done').click();
        await ed().waitFor({ state: 'detached' });
      });
      await s.step('large view: step through the boards with the arrows, the keys and the filmstrip', async () => {
        await dlg().getByRole('heading', { level: 2 }).click();
        await s.settle(2500);
        const emb = dlg().getByTestId('canvas-embed');
        await emb.hover();
        await emb.getByTestId('canvas-view').click();
        const v = p.getByRole('dialog', { name: 'Launch plan' });
        await v.getByText(/^1 of \d+ · /).waitFor();
        await v.getByRole('button', { name: 'Next board' }).click();
        await v.getByText(/^2 of \d+ · /).waitFor();
        await v.getByRole('button', { name: 'Previous board' }).click();
        await v.getByText(/^1 of \d+ · /).waitFor();
        await p.keyboard.press('ArrowRight');
        await v.getByText(/^2 of \d+ · /).waitFor();
        await p.keyboard.press('Space');
        await v.getByText(/^3 of \d+ · /).waitFor();
        await p.keyboard.press('ArrowLeft');
        await v.getByText(/^2 of \d+ · /).waitFor();
        await v.getByTestId('canvas-filmstrip').getByRole('button', { name: 'pattern' }).click();
        await v.getByText(/ · pattern$/).waitFor();
      });
      await s.step('large view: page width, all boards (G), page tabs', async () => {
        const v = p.getByRole('dialog', { name: 'Launch plan' });
        await v.getByTestId('canvas-filmstrip').getByRole('button', { name: 'landing', exact: true }).click();
        const w = v.getByRole('group', { name: 'Page width' });
        for (const name of ['Phone', 'Tablet', 'Desktop']) {
          await w.getByRole('button', { name }).click();
          await w.getByRole('button', { name, pressed: true }).waitFor();
        }
        await v.getByRole('button', { name: 'All' }).click();
        const grid = v.getByTestId('canvas-grid');
        await grid.getByRole('button', { name: /landing/ }).first().waitFor();
        await p.keyboard.press('g');
        await grid.waitFor({ state: 'detached' });
        await p.keyboard.press('g');
        await grid.getByRole('button', { name: /pattern/ }).click();
        await grid.waitFor({ state: 'detached' });
        await v.getByRole('button', { name: 'Ideas' }).click();
        await v.getByText('This page has no frames yet.').waitFor();
        await v.getByRole('button', { name: 'Page 1' }).click();
        await v.getByTestId('canvas-viewer-board').waitFor();
      });
      await s.step('large view: Try it on the page, and Comments with a new comment and a mention', async () => {
        const v = p.getByRole('dialog', { name: 'Launch plan' });
        await v.getByTestId('canvas-filmstrip').getByRole('button', { name: 'landing', exact: true }).click();
        const tryIt = v.getByTestId('canvas-interact');
        await tryIt.click();
        await v.getByTestId('canvas-interact').and(v.locator('[aria-pressed="true"]')).waitFor();
        await tryIt.click();
        await v.getByRole('button', { name: 'Comments' }).click();
        const side = v.getByTestId('canvas-viewer-comments');
        const group = side.getByRole('group', { name: 'Filter comments' });
        for (const f of ['Open', 'Resolved', 'Only this board']) await group.getByRole('button', { name: f }).waitFor();
        if (await group.getByRole('button', { name: 'Only mine' }).count()) throw new Error('the large view has no Only mine filter');
        await side.getByTestId('canvas-new-comment').waitFor();
        await side.getByPlaceholder(/^Comment on “landing”… Type @ to mention a person or a team$/).fill('Seen in the large view @Ad');
        await p.getByRole('listbox', { name: 'Mention a member' }).getByRole('option', { name: /Ada/ }).click();
        await side.getByRole('button', { name: 'Comment', exact: true }).click();
        await side.getByTestId('canvas-thread').filter({ hasText: 'Seen in the large view' }).waitFor();
        await v.getByTestId('canvas-viewer-pin').first().waitFor();
        await group.getByRole('button', { name: 'Only this board' }).click();
        await side.getByTestId('canvas-thread').filter({ hasText: 'Seen in the large view' }).waitFor();
        await group.getByRole('button', { name: 'Resolved' }).click();
        await side.getByText('No comments here yet.').waitFor();
      });
      await s.step('Present: the bar steps, Try it, Notes and Comments toggles, all boards, Exit', async () => {
        const v = p.getByRole('dialog', { name: 'Launch plan' });
        await v.getByRole('button', { name: 'Present' }).click();
        const pr = p.getByRole('dialog', { name: 'Launch plan' });
        await pr.getByTestId('present-position').waitFor();
        const bar = pr.getByRole('toolbar', { name: 'Present' });
        const pos = async () => (await bar.getByTestId('present-position').innerText()).trim();
        const first = await pos();
        await bar.getByRole('button', { name: 'Next', exact: true }).click();
        await until(async () => (await pos()) !== first, 'Next moved on');
        await bar.getByRole('button', { name: 'Previous', exact: true }).click();
        await until(async () => (await pos()) === first, 'Previous moved back');
        await bar.getByTestId('present-interact').click();
        await bar.getByTestId('present-interact').and(p.locator('[aria-pressed="true"]')).waitFor();
        await bar.getByTestId('present-interact').click();
        await bar.getByRole('button', { name: 'Notes' }).click();
        await bar.getByRole('button', { name: 'Notes', pressed: true }).waitFor();
        await bar.getByRole('button', { name: 'Comments' }).click();
        await bar.getByRole('button', { name: 'Comments', pressed: true }).waitFor();
        await pr.locator('aside').getByText(/Seen in the large view/).waitFor();
        await bar.getByRole('button', { name: 'Comments' }).click();
        await bar.locator('button[title="All boards (G)"]').click();
        await pr.getByTestId('canvas-grid').waitFor();
        await bar.locator('button[title="All boards (G)"]').click();
        await bar.getByTestId('present-exit').click();
        await pr.waitFor({ state: 'detached' });
      });
      await s.step('large view: Open canvas goes to the editor at that board; Try it, Stop, Open and Present from the board', async () => {
        const emb = dlg().getByTestId('canvas-embed');
        await emb.hover();
        await emb.getByTestId('canvas-view').click();
        const v = p.getByTestId('canvas-viewer');
        await v.getByTestId('canvas-filmstrip').getByRole('button', { name: 'landing', exact: true }).click();
        await v.getByTestId('canvas-open-editor').click();
        await ed().waitFor();
        await v.waitFor({ state: 'detached' });
        // the board it was opened at is selected: zoom to it so it is drawn live, then try the page
        await plane().focus();
        await p.keyboard.press('2');
        const tools = plane().locator('[data-tools-for]');
        await tools.getByTestId('canvas-board-try').click();
        await plane().getByTestId('canvas-try-stop').waitFor();
        await plane().getByTestId('canvas-try-stop').click();
        await plane().getByTestId('canvas-try-stop').waitFor({ state: 'detached' });
        await p.keyboard.press('i');
        await plane().getByTestId('canvas-try-stop').waitFor();
        await p.keyboard.press('Escape');
        await plane().getByTestId('canvas-try-stop').waitFor({ state: 'detached' });
        await tools.getByTestId('canvas-board-open').click();
        const big = p.getByTestId('canvas-viewer');
        await big.waitFor();
        await big.getByTestId('canvas-viewer-close').click();
        await big.waitFor({ state: 'detached' });
        await plane().focus();
        await p.keyboard.press('p');
        const pr = p.getByTestId('canvas-present');
        await pr.waitFor();
        await pr.getByTestId('present-exit').click();
        await pr.waitFor({ state: 'detached' });
        // P is Present here and "mark as pending" on the ticket below: the ticket leaves it to the editor (it used to open
        // "Mark ALP-1 as pending" under the editor)
        if (await p.getByText('Mark ALP-1 as pending').count()) throw new Error('the ticket below heard P');
        await ed().getByRole('button', { name: 'Fit' }).click();
      });
      await s.step('Board tool: add a file, an empty board; Sketch and Diagram are offered; a dropped file makes a board', async () => {
        await ed().getByTestId('canvas-tool-board').click();
        const menu = ed().getByRole('menu').filter({ hasText: 'Empty board' });
        await menu.getByRole('menuitem', { name: /Sketch…/ }).waitFor();
        await menu.getByRole('menuitem', { name: /Diagram…/ }).waitFor();
        const [chooser] = await Promise.all([p.waitForEvent('filechooser'), ed().getByTestId('canvas-add-file').click()]);
        await chooser.setFiles(fx.extra);
        await boardLabel('extra').waitFor();
        await ed().getByTestId('canvas-tool-board').click();
        await ed().getByTestId('canvas-add-empty').click();
        await plane().getByTestId('board-empty-label').first().waitFor();
        // a file dragged over the plane shows the veil; dropping it makes a board at the right of the last one
        const dt = await p.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(['<h1>Dropped page</h1>'], 'dropped.html', { type: 'text/html' })); return d; });
        await plane().dispatchEvent('dragover', { dataTransfer: dt });
        await plane().getByTestId('canvas-drop-veil').getByText('Drop files to make boards').waitFor();
        await plane().dispatchEvent('dragleave', { dataTransfer: dt });
        await plane().getByTestId('canvas-drop-veil').waitFor({ state: 'detached' });
        await plane().dispatchEvent('drop', { dataTransfer: dt });
        await ed().getByRole('button', { name: 'Fit' }).click();
        await boardLabel('dropped').waitFor();
        await ed().getByText('6 boards').waitFor();
      });
      await s.step('Done, then the card menu: Save as copy makes a second canvas', async () => {
        await ed().getByTestId('canvas-done').click();
        await ed().waitFor({ state: 'detached' });
        await s.settle(1500);
        const emb = dlg().getByTestId('canvas-embed');
        await emb.hover();
        await emb.getByTestId('canvas-menu').click();
        await p.getByRole('menuitem', { name: /Move to Docs…/ }).waitFor();
        await p.getByRole('menuitem', { name: /Save as copy/ }).click();
        await p.getByText('Saved a copy').first().waitFor();
        const clip = await p.evaluate(() => navigator.clipboard.readText());
        if (!/canvas:cv_[0-9a-f]{8}/.test(clip) || clip.includes(canvasId)) throw new Error('clipboard: ' + clip);
      });
      await s.step('Open on a canvas: an HTML file attached to the ticket starts a new canvas named after it', async () => {
        await dlg().locator('input[type="file"][accept="*/*"]').first().setInputFiles(fx.extra);
        await dlg().getByText('extra.html').first().waitFor({ timeout: 15000 });
        await dlg().getByRole('heading', { level: 2 }).click();
        await s.settle(2500);
        const chip = dlg().locator('[title="Click to preview extra.html"]');
        await chip.waitFor();
        await chip.click();
        const v = p.getByRole('dialog', { name: 'Preview of extra.html' });
        await v.waitFor();
        await v.getByTestId('open-on-canvas').click();
        const menu = p.getByRole('menu').filter({ hasText: 'Choose a canvas' });
        await menu.getByRole('menuitem', { name: /New canvas/ }).waitFor();
        // the canvases of the ticket are offered (the list used to be asked with ownerKind/ownerId: 422, always empty)
        await until(async () => (await menu.getByRole('menuitem').count()) > 1, 'existing canvases listed');
        await p.getByTestId('open-on-new-canvas').click();
        await p.getByText('Added to the canvas').first().waitFor();
        // the file viewer closes so the canvas editor it opened is in front (it used to stay on top of it)
        await v.waitFor({ state: 'detached' });
        await p.getByRole('dialog', { name: 'Canvas extra' }).waitFor();
        await boardLabel('extra').waitFor();
        await ed().getByTestId('canvas-done').click();
        await ed().waitFor({ state: 'detached' });
      }, { expectConsole: true });
      await s.step('Move to Docs from the card: the dialog, Cancel, then a folder and a name', async () => {
        // a folder page to move into (made through the API: this step is about the dialog)
        const proj = (await (await api('GET', '/projects', 'user')).json())[0];
        const mk = await api('POST', `/projects/${proj.id}/docs/pages`, 'user', { title: 'Plans', parent_id: null, template: 'blank' });
        if (!mk.ok()) throw new Error('folder page: ' + mk.status() + ' ' + (await mk.text()));
        const emb = dlg().getByTestId('canvas-embed').first();
        await emb.hover();
        await emb.getByTestId('canvas-menu').click();
        await p.getByTestId('canvas-move-to-docs').click();
        const d = p.getByRole('dialog', { name: 'Move to Docs' });
        await d.getByText(/The canvas moves with its boards, comments and history/).waitFor();
        await d.getByRole('textbox').first().waitFor();
        if ((await d.getByRole('textbox').first().inputValue()) !== 'Launch plan') throw new Error('the default name is the canvas title');
        await d.getByRole('combobox').selectOption({ label: 'Top level' });
        await d.getByRole('button', { name: 'Cancel' }).click();
        await d.waitFor({ state: 'detached' });
        await emb.hover();
        await emb.getByTestId('canvas-menu').click();
        await p.getByTestId('canvas-move-to-docs').click();
        await d.getByRole('textbox').first().fill('Launch plan board');
        await d.getByRole('combobox').selectOption({ label: 'Plans' });
        await d.getByRole('button', { name: 'Move to Docs' }).click();
        await d.waitFor({ state: 'detached' });
        await p.getByText('Moved to Docs').first().waitFor();
        // it is a Docs page now: the card no longer offers the move
        await emb.hover();
        await emb.getByTestId('canvas-menu').click();
        await p.getByRole('menuitem', { name: /Save as copy/ }).waitFor();
        if (await p.getByTestId('canvas-move-to-docs').count()) throw new Error('Move to Docs is offered twice');
        // (Escape would close the ticket under the menu: a click elsewhere closes the menu)
        await p.mouse.click(850, 106);
        await p.getByRole('menuitem', { name: /Save as copy/ }).waitFor({ state: 'detached' });
      });
      await s.step('a blank canvas: one empty frame; with no board the empty state offers From files and Empty board', async () => {
        await dlg().getByText('Boards for this ticket:').click();
        await dlg().getByRole('button', { name: 'Canvas', exact: true }).click();
        const d = p.getByRole('dialog', { name: 'New canvas' });
        await d.getByRole('radio', { name: /Blank/, checked: true }).waitFor();
        await d.getByPlaceholder('Login redesign').fill('Whiteboard');
        await d.getByRole('button', { name: 'Create canvas' }).click();
        await p.getByRole('dialog', { name: 'Canvas Whiteboard' }).waitFor();
        await ed().getByText('1 board', { exact: true }).waitFor();
        await plane().getByTestId('board-empty-label').waitFor();
        await boardLabel('Frame 1').or(plane().locator('div[class*="boardLabel"]').first()).first().click();
        await p.keyboard.press('Delete');
        await ed().getByTestId('canvas-empty').getByText('Add your first board').waitFor();
        await ed().getByTestId('canvas-empty').getByRole('button', { name: 'Empty board' }).click();
        await plane().getByTestId('board-empty-label').waitFor();
        await p.keyboard.press('Delete');
        const [chooser] = await Promise.all([p.waitForEvent('filechooser'), ed().getByTestId('canvas-empty').getByRole('button', { name: 'From files' }).click()]);
        await chooser.setFiles(fx.landing);
        await boardLabel('landing').waitFor();
      });
      await s.step('Move to Docs from the editor header, to the top level', async () => {
        await ed().getByTestId('canvas-download-btn').click();
        await ed().getByTestId('canvas-move-docs-btn').click();
        const d = p.getByRole('dialog', { name: 'Move to Docs' });
        await d.getByRole('textbox').first().fill('Whiteboard page');
        await d.getByRole('button', { name: 'Move to Docs' }).click();
        await d.waitFor({ state: 'detached' });
        await p.getByText('Moved to Docs').first().waitFor();
        await ed().getByTestId('canvas-download-btn').click();
        await ed().getByRole('menuitem', { name: /^All boards/ }).waitFor();
        if (await ed().getByTestId('canvas-move-docs-btn').count()) throw new Error('Move to Docs is offered twice');
        await plane().click({ position: { x: 40, y: 150 } });
        await ed().getByTestId('canvas-done').click();
        await ed().waitFor({ state: 'detached' });
      });
      await s.step('Docs: the moved canvas opens as a page with the breadcrumb, the page menu and Share', async () => {
        await closeTicket(s);
        await openDocs(s);
        const rail = p.getByRole('complementary', { name: /^Docs space/ });
        await rail.getByText('Whiteboard page').first().click();
        const page = p.getByTestId('canvas-page');
        await page.waitFor();
        await page.getByRole('navigation', { name: 'Breadcrumb' }).getByText('Whiteboard page').waitFor();
        const cv = page.getByTestId('canvas-editor');
        await cv.getByTestId('canvas-tab').first().waitFor();
        // a page has no Done: it saves as it goes, and Share copies the link
        if (await cv.getByTestId('canvas-done').count()) throw new Error('a canvas page has a Done button');
        await cv.getByRole('button', { name: 'Share' }).click();
        await p.getByText('Link copied').first().waitFor();
        const clip = await p.evaluate(() => navigator.clipboard.readText());
        if (!/canvas:cv_[0-9a-f]{8}/.test(clip)) throw new Error('clipboard: ' + clip);
        await page.getByTestId('canvas-page-menu').click();
        for (const item of ['Rename', 'Add child page', 'Duplicate', 'Copy link', 'Page history', 'Delete page']) await p.getByRole('menuitem', { name: new RegExp(`^${item}`) }).waitFor();
        await p.keyboard.press('Escape');
        await p.getByRole('menuitem', { name: /^Rename/ }).waitFor({ state: 'detached' });
      });
      await s.step('canvas page: a note is saved as it is made and is still there after a reload', async () => {
        const page = p.getByTestId('canvas-page');
        const cv = page.getByTestId('canvas-editor');
        await cv.getByTestId('canvas-tool-note').click();
        const pb = await cv.getByTestId('canvas-plane').boundingBox();
        await p.mouse.click(pb.x + pb.width - 300, pb.y + 100);
        await cv.getByRole('textbox', { name: 'Note text' }).fill('Kept on the page');
        // the layout is saved 0.7 s after the last change: wait for that save before the reload
        const saved = p.waitForResponse((r) => r.request().method() === 'PATCH' && /\/canvases\/cv_[0-9a-f]{8}$/.test(new URL(r.url()).pathname) && /Kept on the page/.test(r.request().postData() || ''));
        await cv.getByRole('textbox', { name: 'Note text' }).blur();
        await cv.getByTestId('canvas-note').filter({ hasText: 'Kept on the page' }).waitFor();
        await saved;
        await p.reload();
        await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor({ timeout: 20000 });
        if (!(await p.getByTestId('canvas-page').count())) {
          await openDocs(s);
          await p.getByRole('complementary', { name: /^Docs space/ }).getByText('Whiteboard page').first().click();
        }
        await p.getByTestId('canvas-page').getByTestId('canvas-note').filter({ hasText: 'Kept on the page' }).waitFor({ timeout: 20000 });
      });
      await s.step('canvas page: History lists the versions of the page and a version can be looked at', async () => {
        const cv = p.getByTestId('canvas-page').getByTestId('canvas-editor');
        await cv.getByTestId('canvas-history-btn').click();
        const h = p.getByRole('dialog', { name: 'History' });
        await h.getByTestId('canvas-version').first().waitFor();
        await h.getByText(/Version \d/).first().waitFor();
        await h.getByRole('button', { name: 'Close', exact: true }).click();
        await h.waitFor({ state: 'detached' });
      });
      await s.step('canvas page in a folder: the breadcrumb names the folder and a click on it opens it', async () => {
        const rail = p.getByRole('complementary', { name: /^Docs space/ });
        await rail.getByText('Launch plan board').click();
        const page = p.getByTestId('canvas-page');
        const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
        await crumbs.getByText('Launch plan board').waitFor();
        await page.getByTestId('canvas-editor').getByText('6 boards').or(page.getByTestId('canvas-editor').getByText(/^\d+ boards$/)).first().waitFor();
        await crumbs.getByRole('button', { name: 'Plans' }).click();
        await p.getByTestId('canvas-page').waitFor({ state: 'detached' });
        await p.getByRole('textbox', { name: 'Page title' }).or(p.getByRole('heading', { name: 'Plans' })).first().waitFor();
      });
      await s.step('New page: the Canvas template makes a canvas page in the folder; boards are added to it', async () => {
        const rail = p.getByRole('complementary', { name: /^Docs space/ });
        await rail.getByRole('button', { name: 'New page' }).first().click();
        const d = p.getByRole('dialog', { name: 'New page' });
        await d.getByTestId('template-canvas').click();
        await d.getByRole('textbox', { name: 'Title' }).fill('Roadmap board');
        await d.getByRole('button', { name: 'Parent page' }).click();
        await p.getByText('Plans', { exact: true }).last().click();
        await d.getByRole('button', { name: 'Create page' }).click();
        await d.waitFor({ state: 'detached' });
        const page = p.getByTestId('canvas-page');
        await page.waitFor();
        await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button', { name: 'Plans' }).waitFor();
        // a new canvas page starts with one empty frame; files and empty boards are added from the Board tool
        await page.getByText('1 board', { exact: true }).waitFor();
        await page.getByTestId('canvas-tool-board').click();
        const [chooser] = await Promise.all([p.waitForEvent('filechooser'), page.getByTestId('canvas-add-file').click()]);
        await chooser.setFiles([fx.landing, fx.png]);
        await page.getByText('3 boards').waitFor();
        await page.getByTestId('canvas-tool-board').click();
        await page.getByTestId('canvas-add-empty').click();
        await page.getByText('4 boards').waitFor();
      });
      await s.step('the ticket lists the canvas pages under Linked docs and opens one in the large view', async () => {
        // the board's view switch ("Board" also names a canvas tool), as a person would click it
        await p.locator('button[class*="viewBtn"]').filter({ hasText: /^Board$/ }).click();
        await openTicket(s, 'ALP-1');
        const docs = dlg().getByTestId('ticket-docs');
        await docs.scrollIntoViewIfNeeded();
        await docs.getByText('Launch plan board').first().waitFor();
        await docs.getByText('Whiteboard page').first().waitFor();
        await docs.getByText('Launch plan board').first().click();
        await p.getByTestId('canvas-viewer').getByText(/^1 of \d+ · /).waitFor();
        await p.getByTestId('canvas-viewer-close').click();
        await p.getByTestId('canvas-viewer').waitFor({ state: 'detached' });
      });
    } finally {
      cleanFixtures(fx);
    }
  },
};
