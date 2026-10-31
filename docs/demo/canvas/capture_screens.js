const { chromium } = require('playwright');
const ids = require('/tmp/cvdemo/ids.json');
const B = 'http://127.0.0.1:8000';
const out = '/tmp/cvdemo/pdf/';
(async () => {
  const br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5, permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage();
  const shot = async (name) => { await p.waitForTimeout(500); await p.screenshot({ path: out + name + '.png' }); console.log('shot', name); };
  await p.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' });
  await p.getByText('Redesign the sign-in screens').first().click();
  await p.waitForTimeout(1800);
  // 01 the card in a ticket description, with its hover actions
  const embed = p.locator('[data-testid=canvas-embed]').first();
  await embed.scrollIntoViewIfNeeded();
  await embed.hover();
  await shot('01-ticket-card');
  // 02 large view
  await embed.locator('[data-testid=canvas-embed-stage]').click();
  await p.waitForSelector('[data-testid=canvas-viewer]');
  await p.waitForTimeout(1500);
  await p.getByRole('button', { name: /Comments/ }).first().click();
  await shot('02-large-view');
  await p.keyboard.press('g');
  await shot('03-all-boards-grid');
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  // 04 the editor
  await embed.hover();
  await p.locator('[data-testid=canvas-edit]').first().click();
  await p.waitForSelector('[data-testid=canvas-editor]');
  await p.waitForTimeout(2500);
  await shot('04-editor-fit');
  // select a board at readable zoom
  const boxes = p.locator('[data-testid=canvas-board]');
  const b1 = await boxes.nth(1).boundingBox();
  await p.mouse.click(b1.x + b1.width / 2, b1.y + b1.height / 2);
  await p.keyboard.press('2');
  await p.waitForTimeout(700);
  const sel = await p.locator('[data-testid=canvas-board]').nth(1).boundingBox();
  await p.mouse.move(sel.x + sel.width / 2, sel.y + 40);
  await shot('05-board-selected');
  await p.getByTestId('canvas-board-menu-btn').click();
  await shot('06-board-menu');
  await p.keyboard.press('Escape');
  await p.keyboard.press('0');
  // 07 comments + boards tabs
  await p.getByTestId('canvas-comments-btn').click();
  await shot('07-comments-panel');
  await p.getByTestId('canvas-tab-boards').click();
  await shot('08-boards-panel');
  await p.getByRole('button', { name: 'Close panel' }).click();
  // 09 the second page tab (picture board and a page with blocked content)
  await p.getByRole('tab', { name: 'Marketing' }).click();
  await p.waitForTimeout(1200);
  await p.keyboard.press('0');
  await p.waitForTimeout(800);
  const promo = p.locator('[data-testid=canvas-board]').nth(1);
  const pb = await promo.boundingBox();
  await p.mouse.click(pb.x + pb.width / 2, pb.y + pb.height / 2);
  await p.keyboard.press('2');
  await p.waitForTimeout(1200);
  await p.getByTestId('canvas-blocked-chip').click();
  await shot('09-blocked-content');
  await p.getByRole('tab', { name: 'Page 1' }).click();
  await p.waitForTimeout(600);
  await p.keyboard.press('0');
  // 10 proposal review
  await p.getByTestId('canvas-open-proposals').click();
  await p.waitForSelector('[data-testid=canvas-proposal]');
  await p.waitForTimeout(2500);
  await shot('10-ai-proposal');
  await p.getByRole('button', { name: 'Compare in source' }).first().click();
  await p.locator('[data-testid=canvas-source-diff]').first().scrollIntoViewIfNeeded();
  await shot('11-proposal-source-diff');
  await p.getByRole('button', { name: 'Close' }).last().click();
  // 12 ask AI panel
  const first = await p.locator('[data-testid=canvas-board]').nth(1).boundingBox();
  await p.mouse.click(first.x + first.width / 2, first.y + first.height / 2);
  await p.keyboard.press('Control+j');
  await p.getByTestId('canvas-ai-text').fill('Move the error under the password field and show it in red on both boards.');
  await shot('12-ask-ai');
  await p.keyboard.press('Escape');
  // 13 lock by another person
  await fetch(`${B}/canvases/${ids.cid}/boards/${ids.b[2]}/lock`, { method: 'POST', headers: { 'x-actor': 'An Nguyen' } });
  await p.waitForTimeout(5200);
  const third = await p.locator('[data-testid=canvas-board]').nth(2).boundingBox();
  await p.mouse.click(third.x + third.width / 2, third.y + third.height / 2);
  await p.keyboard.press('2');
  await shot('13-locked-by-someone');
  await p.keyboard.press('e');
  await p.waitForSelector('[data-testid=canvas-source-blocked]');
  await shot('14-lock-card');
  await p.getByRole('button', { name: 'OK' }).click();
  await p.keyboard.press('0');
  // 15 source editor of an unlocked board
  const f0 = await p.locator('[data-testid=canvas-board]').nth(0).boundingBox();
  await p.mouse.click(f0.x + f0.width / 2, f0.y + f0.height / 2);
  await p.keyboard.press('e');
  await p.waitForSelector('[data-testid=canvas-source-editor]');
  await p.waitForTimeout(1500);
  await shot('15-source-editor');
  await p.getByTestId('canvas-source-cancel').click();
  // 16 conflict
  const cv = await (await fetch(`${B}/canvases/${ids.cid}`)).json();
  const bd = cv.doc.boards.find(x => x.id === ids.b[3]);
  await fetch(`${B}/canvases/${ids.cid}`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-actor': 'Hoa Mai' }, body: JSON.stringify({ base_rev: cv.rev, upsert: { boards: [{ ...bd, x: bd.x + 400 }] } }) });
  const fourth = await p.locator('[data-testid=canvas-board]').nth(3).boundingBox();
  await p.mouse.move(fourth.x + fourth.width / 2, fourth.y + fourth.height / 2);
  await p.mouse.down(); await p.mouse.move(fourth.x + fourth.width / 2 - 30, fourth.y + fourth.height / 2 + 30, { steps: 5 }); await p.mouse.up();
  await p.waitForSelector('[data-testid=canvas-conflict]', { timeout: 8000 });
  await shot('16-conflict');
  await p.getByTestId('canvas-load-theirs').click();
  await p.waitForTimeout(600);
  // 17 history + compare
  await p.getByTestId('canvas-history-btn').click();
  await p.waitForSelector('[data-testid=canvas-history]');
  await p.waitForTimeout(1200);
  await shot('17-history');
  // accept the proposal first so there is something to compare
  await p.getByRole('button', { name: 'Close' }).first().click().catch(() => {});
  await p.getByTestId('canvas-open-proposals').click();
  await p.waitForSelector('[data-testid=canvas-proposal]');
  await p.waitForTimeout(1500);
  await p.getByTestId('canvas-ai-waiting').scrollIntoViewIfNeeded();
  await shot('17b-proposal-waits-for-lock');
  await fetch(`${B}/canvases/${ids.cid}/boards/${ids.b[2]}/lock`, { method: 'DELETE', headers: { 'x-actor': 'An Nguyen' } });
  await p.getByRole('button', { name: 'Close' }).last().click();
  await p.waitForTimeout(5000);
  await p.getByTestId('canvas-open-proposals').click();
  await p.waitForSelector('[data-testid=canvas-proposal]');
  await p.waitForTimeout(1500);
  await p.getByTestId('canvas-proposal-accept-all').click();
  await p.waitForSelector('[data-testid=canvas-proposal]', { state: 'detached', timeout: 10000 });
  await p.waitForTimeout(1500);
  await p.getByTestId('canvas-history-btn').click();
  await p.waitForSelector('[data-testid=canvas-history]');
  await p.waitForTimeout(1500);
  await p.locator('[data-testid=canvas-version]').first().click();
  await p.waitForTimeout(800);
  await p.getByTestId('canvas-compare').click();
  await p.waitForSelector('[data-testid=canvas-compare-view]');
  await p.waitForTimeout(2000);
  await shot('18-compare');
  await p.getByRole('button', { name: 'Source diff' }).click();
  await p.waitForTimeout(500);
  await shot('19-compare-source-diff');
  await p.getByRole('button', { name: 'Close' }).last().click();
  await p.getByRole('button', { name: 'Close' }).first().click().catch(() => {});
  // 20 present
  await p.keyboard.press('0');
  await p.getByTestId('canvas-present-btn').click();
  await p.waitForSelector('[data-testid=canvas-present]');
  await p.waitForTimeout(1500);
  await shot('20-present');
  await p.keyboard.press('g');
  await shot('21-present-grid');
  await p.keyboard.press('Escape'); await p.keyboard.press('Escape');
  // 22 download menu, keys
  await p.waitForTimeout(500);
  await p.getByTestId('canvas-download-btn').click();
  await shot('22-download-menu');
  await p.keyboard.press('Escape');
  await p.keyboard.press('?');
  await shot('23-keys');
  await p.keyboard.press('Escape');
  await p.getByTestId('canvas-done').click();
  await p.waitForTimeout(1500);
  // 24 description editor, new canvas dialog
  await p.getByText('Agreed in the design review').first().click();
  await p.waitForTimeout(800);
  await p.getByTestId('editor-canvas').click();
  await p.waitForSelector('[data-testid=canvas-new]');
  await p.getByTestId('canvas-new-name').fill('Settings screens');
  await shot('24-new-canvas-dialog');
  await p.getByRole('button', { name: 'Cancel' }).click();
  await p.locator('[data-canvas]').first().scrollIntoViewIfNeeded();
  await p.getByRole('button', { name: 'Show…' }).first().click();
  await shot('25-embed-settings');
  await p.getByRole('button', { name: 'Cancel' }).click();
  // 26 move to docs
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);
  await br.close();
})();
