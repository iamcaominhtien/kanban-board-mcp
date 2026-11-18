import { ensureProject, createTicket, openTicket, openMembers, home } from '../lib/ui.mjs';

// The sketch editor beyond 07: the New sketch dialog, every tool and its options, colours, layers, crop and resize,
// saving (a copy, Done, a conflict, the "Save your drawing?" question), the embed (Edit sketch, View large) and the AI
// panel on the stand-in AI. Drawing is checked in what is stored: the PNG and the source of the saved sketch.
// Not covered: shapes drawn by the AI ("Shapes from the AI", "Show on the drawing", Accept: the Rust server only
// answers with ideas, its `ops` are always empty), Stop on a running AI answer (the stand-in answers at once), the
// viewer role (needs a second signed-in person) and the "too large to save" banner (needs a 10 MB picture).
export default {
  name: 'Sketch editor: tools, colours, layers, crop, saving, embed, AI panel',
  group: 'ai',
  async run(s) {
    const p = s.page;
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    const ed = () => p.getByTestId('sketch-editor');
    const opts = () => ed().getByRole('toolbar', { name: /options$/ });
    const layers = () => ed().getByRole('region', { name: 'Layers' });
    const colourPanel = () => ed().getByRole('region', { name: 'Colour' });
    const rows = () => ed().getByTestId('sketch-layer');
    const cursor = () => ed().locator('footer span[class*="cursor"]');
    const saves = [];
    p.on('response', async (r) => {
      const u = new URL(r.url());
      if (!['POST', 'PUT'].includes(r.request().method()) || !/^\/sketches(\/[^/]+(\/copy)?)?$/.test(u.pathname)) return;
      if (!r.ok()) return;
      try { saves.push(await r.json()); } catch { /* not JSON */ }
    });
    let aiChat = null;
    p.on('response', (r) => { const m = new URL(r.url()).pathname.match(/^\/ai\/sketch\/chats\/([^/]+)\/messages$/); if (m && r.ok()) aiChat = m[1]; });
    const getJson = async (path) => (await p.request.get(`${s.server.base}${path}`)).json();
    const tool = async (id) => { await ed().getByTestId(`sketch-tool-${id}`).click(); await ed().getByTestId(`sketch-tool-${id}`).and(p.locator('[aria-pressed="true"]')).waitFor(); };
    const dims = (t) => ed().getByTestId('sketch-dims').filter({ hasText: t }).waitFor();

    // document coordinates -> screen: read what the footer says for one mouse position (the zoom is shown on the page)
    const mapper = async () => {
      const bb = await p.getByTestId('sketch-canvas').boundingBox();
      await p.mouse.move(bb.x + 5, bb.y + 5);
      const before = await cursor().innerText();
      const sx = bb.x + 330, sy = bb.y + 300;
      await p.mouse.move(sx, sy);
      await p.waitForFunction(([el0, prev]) => {
        const el = document.querySelector('[data-testid="sketch-editor"] footer span[class*="cursor"]');
        return el && el.textContent && el.textContent !== prev && /x -?\d+, y -?\d+/.test(el.textContent);
      }, [null, before]);
      const m = (await cursor().innerText()).match(/x (-?\d+), y (-?\d+)/);
      const zoom = parseInt(await p.getByTestId('sketch-zoom').innerText(), 10) / 100;
      return { at: (x, y) => [sx + (x - Number(m[1])) * zoom, sy + (y - Number(m[2])) * zoom] };
    };
    const stroke = async (map, pts, steps = 8) => {
      const [x0, y0] = map.at(...pts[0]);
      await p.mouse.move(x0, y0);
      await p.mouse.down();
      for (const pt of pts.slice(1)) { const [x, y] = map.at(...pt); await p.mouse.move(x, y, { steps }); }
      await p.mouse.up();
    };
    const setColour = async (hex) => {
      const f = colourPanel().getByRole('textbox', { name: 'Colour as hex' });
      await f.fill(hex);
      await f.blur();
    };
    // Save a copy: stores what is on the canvas as a sketch (the first time it creates it) and answers with it
    const saveCopy = async () => {
      const n = saves.length;
      await ed().getByTestId('sketch-save-copy').click();
      await p.waitForFunction(() => /Saved/.test(document.querySelector('[data-testid="sketch-saved-status"]')?.textContent || ''));
      await expectCount(() => saves.length > n);
      return saves[saves.length - 1];
    };
    const expectCount = async (cond) => { for (let i = 0; i < 100 && !cond(); i++) await p.waitForTimeout(50); if (!cond()) throw new Error('no save seen'); };
    // pixel [r,g,b,a] of the stored PNG of a sketch at a document position
    const pix = (id, x, y) => p.evaluate(async ([base, id, x, y]) => {
      const blob = await (await fetch(`${base}/sketches/${id}/png`, { cache: 'no-store' })).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      return Array.from(g.getImageData(x, y, 1, 1).data);
    }, [s.server.base, id, x, y]);
    // how many pixels of a box of the stored PNG are not transparent
    const inked = (id, x, y, w, h) => p.evaluate(async ([base, id, x, y, w, h]) => {
      const blob = await (await fetch(`${base}/sketches/${id}/png`, { cache: 'no-store' })).blob();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(x, y, w, h).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    }, [s.server.base, id, x, y, w, h]);
    const near = (a, b, tol = 6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
    const expectPix = async (id, x, y, want, what) => {
      const got = await pix(id, x, y);
      if (!near(got, want)) throw new Error(`${what}: pixel (${x},${y}) is ${got}, expected ${want}`);
    };
    const sourceOf = (id) => getJson(`/sketches/${id}/source`);
    const layerNames = async () => (await rows().locator('button[title="Double-click to rename"]').allInnerTexts());

    await s.step('set up: a project with an AI team, a ticket with the description editor open', async () => {
      s.server.signIn();
      s.server.fake({ FAKE_CLAUDE_MODE: 'assistant', FAKE_CLAUDE_ASSISTANT_JSON: JSON.stringify({ answer: 'Try a retry button next to the error.', ideas: ['Retry button', 'Offline banner'] }) });
      await ensureProject(s);
      await openMembers(s);
      await p.getByTestId('members-tab-ai').click();
      await p.getByRole('button', { name: /Add AI team/ }).first().click();
      const d = p.getByRole('dialog', { name: 'Add AI team' });
      await d.getByTestId('team-name').fill('Sketch helper');
      await d.getByTestId('team-working-dir').fill(s.server.dirs.repo);
      await d.getByTestId('add-team-submit').click();
      await p.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      await home(s);
      await createTicket(s, { title: 'Draw things' });
      await openTicket(s, 'ALP-1');
      await dlg().getByRole('button', { name: 'Edit description' }).click();
      await dlg().locator('[contenteditable="true"]').first().click();
      await p.keyboard.type('Sketches for this ticket:');
      await p.keyboard.press('Enter');
    });

    await s.step('New sketch dialog: three sizes, two backgrounds; Cancel closes the editor', async () => {
      await dlg().getByRole('button', { name: 'Sketch', exact: true }).click();
      const nd = p.getByRole('dialog', { name: 'New sketch' });
      await nd.getByRole('radiogroup', { name: 'Size' }).waitFor();
      await nd.getByText('New sketch', { exact: true }).waitFor();
      await nd.getByText('Background', { exact: true }).waitFor();
      const wide = nd.getByTestId('sketch-size-wide');
      if ((await wide.getAttribute('aria-checked')) !== 'true') throw new Error('Wide is not the default');
      await nd.getByTestId('sketch-size-small').click();
      await nd.getByTestId('sketch-size-small').and(p.locator('[aria-checked="true"]')).waitFor();
      await nd.getByTestId('sketch-size-square').click();
      await nd.getByTestId('sketch-bg-clear').click();
      await nd.getByTestId('sketch-bg-clear').and(p.locator('[aria-checked="true"]')).waitFor();
      await nd.getByRole('button', { name: 'Cancel' }).click();
      await ed().waitFor({ state: 'detached' });
    });

    await s.step('Small size and white background: a locked Background layer under Sketch', async () => {
      await dlg().getByRole('button', { name: 'Sketch', exact: true }).click();
      const nd = p.getByRole('dialog', { name: 'New sketch' });
      await nd.getByTestId('sketch-size-small').click();
      await nd.getByRole('button', { name: 'Start drawing' }).click();
      await dims('600 × 400');
      s.note('layers of a white page', await layerNames());
      if ((await layerNames()).join() !== 'Sketch,Background') throw new Error('layers ' + (await layerNames()));
      // close again without a change: nothing to save, so no question
      await ed().getByTestId('sketch-close').click();
      await ed().waitFor({ state: 'detached' });
    });

    await s.step('Square, clear background: one Sketch layer, 800 × 800; Close', async () => {
      await dlg().getByRole('button', { name: 'Sketch', exact: true }).click();
      const nd = p.getByRole('dialog', { name: 'New sketch' });
      await nd.getByTestId('sketch-size-square').click();
      await nd.getByTestId('sketch-bg-clear').click();
      await nd.getByRole('button', { name: 'Start drawing' }).click();
      await dims('800 × 800');
      if ((await layerNames()).join() !== 'Sketch') throw new Error('layers ' + (await layerNames()));
      await ed().getByTestId('sketch-close').click();
      await ed().waitFor({ state: 'detached' });
    });

    let map;
    let sk; // the sketch the session works on
    await s.step('Wide, clear: hex colour and the pencil draw a red line; Save a copy stores it', async () => {
      await dlg().getByRole('button', { name: 'Sketch', exact: true }).click();
      const nd = p.getByRole('dialog', { name: 'New sketch' });
      await nd.getByTestId('sketch-bg-clear').click();
      await nd.getByRole('button', { name: 'Start drawing' }).click();
      await dims('840 × 500');
      await ed().getByRole('textbox', { name: 'Name of the sketch' }).fill('Tool tour');
      await setColour('#ff0000');
      await tool('pencil');
      await opts().getByTestId('sketch-size').fill('8');
      await opts().getByText('8 px').waitFor();
      map = await mapper();
      await stroke(map, [[100, 100], [300, 100]]);
      sk = await saveCopy();
      s.note('first save', { id: sk.id, w: sk.width, h: sk.height, layers: sk.layer_count, title: sk.title });
      await expectPix(sk.id, 200, 100, [255, 0, 0, 255], 'red pencil line');
      await expectPix(sk.id, 200, 160, [0, 0, 0, 0], 'clear background');
    });

    await s.step('swatch: a palette colour becomes the colour; the brush draws it', async () => {
      const sw = colourPanel().getByRole('button', { name: /^Colour #/ }).nth(3);
      const hex = (await sw.getAttribute('aria-label')).replace('Colour ', '');
      await sw.click();
      await sw.and(p.locator('[aria-pressed="true"]')).waitFor();
      await p.waitForFunction((h) => document.querySelector('[data-testid="sketch-hex"]').value.toLowerCase() === h, hex);
      await tool('brush');
      await opts().getByTestId('sketch-size').fill('20');
      await opts().getByLabel('Softness').fill('0');
      await opts().getByLabel('Opacity').fill('100');
      await opts().getByLabel('Smoothing').fill('0');
      await opts().getByText('20 px').waitFor();
      await stroke(map, [[100, 160], [300, 160]]);
      sk = await saveCopy();
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      await expectPix(sk.id, 200, 160, [r, g, b, 255], 'brush with the swatch colour');
    });

    await s.step('brush options: pen pressure switch and what it changes, smoothing, softness', async () => {
      const sw = opts().getByTestId('sketch-pressure');
      await sw.click();
      await sw.and(p.locator('[aria-checked="true"]')).waitFor();
      const grp = opts().getByRole('radiogroup', { name: 'Pressure changes' });
      await grp.getByRole('radio', { name: 'Opacity' }).click();
      await grp.getByRole('radio', { name: 'Opacity' }).and(p.locator('[aria-checked="true"]')).waitFor();
      await grp.getByRole('radio', { name: 'Size' }).click();
      await sw.click();
      await grp.waitFor({ state: 'detached' });
      await opts().getByLabel('Smoothing').fill('60');
      await opts().getByLabel('Softness').fill('40');
      await opts().getByText('60%').first().waitFor();
      await opts().getByText('40%').first().waitFor();
      await opts().getByLabel('Opacity').fill('50');
      await stroke(map, [[100, 220], [300, 220]]);
      sk = await saveCopy();
      const px = await pix(sk.id, 200, 220);
      if (!(px[3] > 40 && px[3] < 200)) throw new Error('a 50% brush should be half opaque: ' + px);
      await opts().getByLabel('Opacity').fill('100');
    });

    await s.step('colour picker input and the Recent colours', async () => {
      await colourPanel().getByLabel('Colour picker').fill('#00ff00');
      await colourPanel().getByLabel('Colour picker').blur();
      await colourPanel().getByText('Recent', { exact: true }).waitFor();
      const recent = colourPanel().getByRole('button', { name: /^Recent colour / });
      await recent.first().waitFor();
      s.note('recent', await recent.evaluateAll((l) => l.map((b) => b.getAttribute('aria-label'))));
      await recent.filter({ hasText: '' }).nth(1).click(); // an older colour comes back
      await p.waitForFunction(() => document.querySelector('[data-testid="sketch-hex"]').value.toLowerCase() !== '#00ff00');
      const hex = (await colourPanel().getByRole('textbox', { name: 'Colour as hex' }).inputValue()).toLowerCase();
      await colourPanel().getByRole('textbox', { name: 'Colour as hex' }).fill('nonsense');
      await colourPanel().getByRole('textbox', { name: 'Colour as hex' }).blur();
      const back = (await colourPanel().getByRole('textbox', { name: 'Colour as hex' }).inputValue()).toLowerCase();
      if (back !== hex) throw new Error('a bad hex should go back to ' + hex + ', is ' + back);
    });

    await s.step('rectangle and ellipse tool: outline and filled shapes land on the layer', async () => {
      await setColour('#0000ff');
      await tool('shape');
      await opts().getByRole('radio', { name: 'Rectangle' }).and(p.locator('[aria-checked="true"]')).waitFor();
      await opts().getByTestId('sketch-size').fill('6');
      await stroke(map, [[400, 80], [600, 220]]);
      await opts().getByRole('radio', { name: 'Ellipse' }).click();
      await opts().getByRole('radio', { name: 'Ellipse' }).and(p.locator('[aria-checked="true"]')).waitFor();
      await stroke(map, [[650, 80], [800, 220]]);
      await opts().getByRole('radio', { name: 'Filled' }).click();
      await opts().getByTestId('sketch-size').waitFor({ state: 'detached' }); // a filled shape has no outline width
      await opts().getByRole('radio', { name: 'Rectangle' }).click();
      await setColour('#ffa500');
      await stroke(map, [[400, 260], [500, 340]]);
      sk = await saveCopy();
      await expectPix(sk.id, 400, 150, [0, 0, 255, 255], 'left edge of the blue rectangle');
      await expectPix(sk.id, 500, 150, [0, 0, 0, 0], 'inside the outline is empty');
      await expectPix(sk.id, 450, 300, [255, 165, 0, 255], 'filled orange rectangle');
      await expectPix(sk.id, 725, 80, [0, 0, 255, 255], 'top of the ellipse');
    });

    await s.step('fill tool and tolerance: the empty inside of the rectangle takes the colour', async () => {
      await setColour('#ff00ff');
      await tool('fill');
      await opts().getByTestId('sketch-tolerance').fill('10');
      await opts().getByText('10%').first().waitFor();
      await opts().getByLabel('Opacity').fill('100');
      const [x, y] = map.at(500, 150);
      await p.mouse.click(x, y);
      sk = await saveCopy();
      await expectPix(sk.id, 500, 150, [255, 0, 255, 255], 'filled inside');
      await expectPix(sk.id, 500, 40, [0, 0, 0, 0], 'outside stays empty');
      await opts().getByTestId('sketch-tolerance').fill('60');
    });

    await s.step('line tool with an arrow head, then without', async () => {
      await setColour('#222222');
      await tool('line');
      await opts().getByTestId('sketch-size').fill('6');
      const arrow = opts().getByTestId('sketch-arrow');
      await arrow.click();
      await arrow.and(p.locator('[aria-checked="true"]')).waitFor();
      await stroke(map, [[100, 400], [400, 400]]);
      await arrow.click();
      await arrow.and(p.locator('[aria-checked="false"]')).waitFor();
      await stroke(map, [[100, 450], [400, 450]]);
      sk = await saveCopy();
      await expectPix(sk.id, 250, 400, [34, 34, 34, 255], 'arrow shaft');
      await expectPix(sk.id, 250, 450, [34, 34, 34, 255], 'plain line');
      // an arrow head is wider than the shaft near its tip; the plain line stays as thin as the shaft
      const head = await inked(sk.id, 370, 380, 30, 40);
      const plain = await inked(sk.id, 370, 430, 30, 40);
      s.note('ink near the tips', { head, plain });
      if (head <= plain + 20) throw new Error(`the arrow has no head: ${head} vs ${plain} pixels`);
    });

    await s.step('text tool: type a label; it stays editable text in the saved source', async () => {
      await setColour('#008000');
      await tool('text');
      await opts().getByLabel('Font').fill('32');
      const bold = opts().getByRole('switch', { name: 'Bold' });
      await bold.click();
      await bold.and(p.locator('[aria-checked="true"]')).waitFor();
      const [x, y] = map.at(500, 400);
      await p.mouse.click(x, y);
      const box = ed().getByTestId('sketch-text');
      await box.waitFor();
      await box.fill('Hello sketch');
      await p.keyboard.press('Control+Enter');
      await box.waitFor({ state: 'detached' });
      sk = await saveCopy();
      const src = await sourceOf(sk.id);
      const texts = src.layers.flatMap((l) => l.texts);
      s.note('texts', texts);
      if (!texts.some((t) => t.text === 'Hello sketch' && t.bold && t.size === 32)) throw new Error('text not stored');
    });

    await s.step('eraser: rubs out part of the red line (softness and pressure switch shown)', async () => {
      await tool('eraser');
      await opts().getByTestId('sketch-size').fill('30');
      await opts().getByLabel('Softness').fill('0');
      await opts().getByRole('switch', { name: 'Pen pressure' }).click();
      await opts().getByRole('switch', { name: 'Pen pressure' }).click();
      await stroke(map, [[150, 90], [150, 110]]);
      sk = await saveCopy();
      await expectPix(sk.id, 150, 100, [0, 0, 0, 0], 'erased part of the red line');
      await expectPix(sk.id, 250, 100, [255, 0, 0, 255], 'the rest of the red line');
    });

    await s.step('pick-colour tool: a click on the red line makes red the colour', async () => {
      await setColour('#123456');
      await tool('picker');
      await opts().getByText(/Click any pixel/).waitFor();
      const [x, y] = map.at(250, 100);
      await p.mouse.click(x, y);
      await p.waitForFunction(() => document.querySelector('[data-testid="sketch-hex"]').value.toLowerCase() === '#ff0000');
    });

    await s.step('undo and redo: the eraser step goes back and returns', async () => {
      await tool('select');
      const n = saves.length;
      await ed().getByRole('button', { name: 'Undo' }).click();
      sk = await saveCopy();
      await expectPix(sk.id, 150, 100, [255, 0, 0, 255], 'undo of the erase');
      await ed().getByRole('button', { name: 'Redo' }).click();
      sk = await saveCopy();
      await expectPix(sk.id, 150, 100, [0, 0, 0, 0], 'redo of the erase');
      if (saves.length <= n) throw new Error('no saves');
    });
    await s.step('select tool: drag a box round the red line, move it, Put down; the old place is empty', async () => {
      await tool('select');
      await stroke(map, [[90, 85], [310, 115]]);
      const put = opts().getByRole('button', { name: 'Put down (Enter)' });
      await put.waitFor();
      await opts().getByTestId('sketch-delete-selection').waitFor();
      await stroke(map, [[200, 100], [200, 180]], 12);
      await put.click();
      await put.waitFor({ state: 'detached' });
      sk = await saveCopy();
      await expectPix(sk.id, 250, 180, [255, 0, 0, 255], 'the moved red line');
      await expectPix(sk.id, 250, 100, [0, 0, 0, 0], 'the place it left');
    });

    await s.step('select tool: Delete removes what is inside the box', async () => {
      await stroke(map, [[90, 170], [310, 190]]);
      await opts().getByTestId('sketch-delete-selection').click();
      await opts().getByTestId('sketch-delete-selection').waitFor({ state: 'detached' });
      sk = await saveCopy();
      await expectPix(sk.id, 250, 180, [0, 0, 0, 0], 'deleted selection');
    });

    await s.step('layers: Add layer puts "Layer 2" on top and makes it the active one', async () => {
      await layers().getByTestId('sketch-add-layer').click();
      await rows().nth(1).waitFor();
      await p.waitForFunction(() => document.querySelectorAll('[data-testid="sketch-layer"]').length === 2);
      if ((await layerNames()).join() !== 'Layer 2,Sketch') throw new Error('layers ' + (await layerNames()));
      await layers().getByText('2/', { exact: false }).first().waitFor();
      await rows().first().locator('button[title="Double-click to rename"]').and(p.locator('[aria-pressed="true"]')).waitFor();
    });

    await s.step('layers: double-click renames a layer (Esc, then Enter)', async () => {
      await rows().first().locator('button[title="Double-click to rename"]').dblclick();
      const name = rows().first().getByRole('textbox', { name: 'Layer name' });
      await name.fill('Dropped');
      await p.keyboard.press('Escape');
      await name.waitFor({ state: 'detached' });
      // Esc in the name box keeps the old name and stays in the editor (it used to rename the layer to what was typed,
      // the field losing focus as it went, and to reach the editor's own Esc: "Save your drawing?")
      await rows().first().locator('button[title="Double-click to rename"]').filter({ hasText: 'Layer 2' }).waitFor();
      if (await p.getByRole('alertdialog', { name: 'Save your drawing?' }).count()) throw new Error('Esc in the name box asked to save');
      await rows().first().locator('button[title="Double-click to rename"]').dblclick();
      await rows().first().getByRole('textbox', { name: 'Layer name' }).fill('Notes');
      await p.keyboard.press('Enter');
      await rows().first().locator('button[title="Double-click to rename"]').filter({ hasText: 'Notes' }).waitFor();
    });

    await s.step('layers: a stroke on Notes, its opacity slider makes it half see-through', async () => {
      await setColour('#000000');
      await tool('pencil');
      await opts().getByTestId('sketch-size').fill('10');
      await stroke(map, [[100, 300], [300, 300]]);
      await layers().getByLabel('Layer opacity').fill('50');
      await layers().getByText('50%').waitFor();
      sk = await saveCopy();
      const px = await pix(sk.id, 200, 300);
      if (!(px[3] > 100 && px[3] < 160)) throw new Error('layer at 50% should give about half alpha: ' + px);
      const src = await sourceOf(sk.id);
      s.note('layers in the source', src.layers.map((l) => ({ n: l.name, o: l.opacity, v: l.visible, l: l.locked })));
      const notes = src.layers.find((l) => l.name === 'Notes');
      if (!notes || Math.abs(notes.opacity - 0.5) > 0.01) throw new Error('opacity not stored');
    });

    await s.step('layers: hide and show Notes; a hidden layer is not in the picture', async () => {
      await rows().first().getByRole('button', { name: 'Hide Notes' }).click();
      await rows().first().getByRole('button', { name: 'Show Notes' }).waitFor();
      sk = await saveCopy();
      await expectPix(sk.id, 200, 300, [0, 0, 0, 0], 'hidden layer');
      if ((await sourceOf(sk.id)).layers.find((l) => l.name === 'Notes').visible !== false) throw new Error('hidden flag not stored');
      await rows().first().getByRole('button', { name: 'Show Notes' }).click();
      await rows().first().getByRole('button', { name: 'Hide Notes' }).waitFor();
    });

    await s.step('layers: lock Notes; a stroke on a locked layer changes nothing', async () => {
      await rows().first().getByRole('button', { name: 'Lock Notes' }).click();
      await rows().first().getByRole('button', { name: 'Unlock Notes' }).waitFor();
      await stroke(map, [[100, 350], [300, 350]]);
      s.note('notice on a locked layer', await ed().getByTestId('sketch-notice').innerText().catch(() => '(none)'));
      sk = await saveCopy();
      await expectPix(sk.id, 200, 350, [0, 0, 0, 0], 'nothing on the locked layer');
      if ((await sourceOf(sk.id)).layers.find((l) => l.name === 'Notes').locked !== true) throw new Error('locked flag not stored');
      await rows().first().getByRole('button', { name: 'Unlock Notes' }).click();
      await rows().first().getByRole('button', { name: 'Lock Notes' }).waitFor();
    });

    await s.step('layers: Move layer down and up change the order', async () => {
      await layers().getByRole('button', { name: 'Move layer down' }).click();
      await p.waitForFunction(() => /Sketch/.test(document.querySelector('[data-testid="sketch-layer"]').textContent));
      if ((await layerNames()).join() !== 'Sketch,Notes') throw new Error('order ' + (await layerNames()));
      await layers().getByRole('button', { name: 'Move layer up' }).click();
      await p.waitForFunction(() => /Notes/.test(document.querySelector('[data-testid="sketch-layer"]').textContent));
      if ((await layerNames()).join() !== 'Notes,Sketch') throw new Error('order ' + (await layerNames()));
    });

    await s.step('layers: Merge down joins Notes into Sketch (one layer, both strokes in it)', async () => {
      await layers().getByRole('button', { name: 'Merge down' }).click();
      await p.waitForFunction(() => document.querySelectorAll('[data-testid="sketch-layer"]').length === 1);
      if ((await layerNames()).join() !== 'Sketch') throw new Error('layers ' + (await layerNames()));
      sk = await saveCopy();
      const px = await pix(sk.id, 200, 300);
      if (px[3] < 100) throw new Error('the merged stroke is missing: ' + px);
      await expectPix(sk.id, 450, 300, [255, 165, 0, 255], 'the old content of Sketch');
      if ((await sourceOf(sk.id)).layers.length !== 1) throw new Error('layers in the source');
    });

    await s.step('layers: Delete layer removes the active layer with what is on it', async () => {
      await layers().getByTestId('sketch-add-layer').click();
      await p.waitForFunction(() => document.querySelectorAll('[data-testid="sketch-layer"]').length === 2);
      await setColour('#ff0000');
      await stroke(map, [[600, 300], [780, 300]]);
      await layers().getByRole('button', { name: 'Delete layer' }).click();
      await p.waitForFunction(() => document.querySelectorAll('[data-testid="sketch-layer"]').length === 1);
      sk = await saveCopy();
      await expectPix(sk.id, 700, 300, [0, 0, 0, 0], 'the deleted layer');
    });

    await s.step('zoom: out, in, Fit to window, and 100% put the drawing back', async () => {
      const z = () => p.getByTestId('sketch-zoom').innerText().then((t) => parseInt(t, 10));
      const z0 = await z();
      await ed().getByRole('button', { name: 'Zoom out' }).click();
      await p.waitForFunction((z0) => parseInt(document.querySelector('[data-testid="sketch-zoom"]').textContent, 10) < z0, z0);
      await ed().getByRole('button', { name: 'Zoom in' }).click();
      await ed().getByRole('button', { name: 'Fit to window' }).click();
      await p.getByTestId('sketch-zoom').click();
      await p.getByTestId('sketch-zoom').filter({ hasText: '100%' }).waitFor();
      map = await mapper();
    });

    await s.step('crop tool: a size that is too large is refused, then Resize canvas to 700 × 450', async () => {
      await tool('crop');
      const w = opts().getByRole('textbox', { name: 'Width' });
      const h = opts().getByRole('textbox', { name: 'Height' });
      await opts().getByRole('button', { name: 'Crop to box' }).and(p.locator('[disabled]')).waitFor();
      await w.fill('99999');
      await opts().getByText(/Too large\. The limit is/).waitFor();
      await w.fill('700');
      await h.fill('450');
      await opts().getByRole('button', { name: 'Resize canvas' }).click();
      await dims('700 × 450');
    });

    await s.step('crop tool: Scale drawing to 350 × 225 keeps the picture, smaller', async () => {
      await opts().getByRole('textbox', { name: 'Width' }).fill('350');
      await opts().getByRole('textbox', { name: 'Height' }).fill('225');
      await opts().getByRole('button', { name: 'Scale drawing' }).click();
      await dims('350 × 225');
    });

    await s.step('crop tool: Trim to content cuts the empty edges; undo brings the size back', async () => {
      await opts().getByRole('button', { name: 'Trim to content' }).click();
      await p.waitForFunction(() => !/350 × 225/.test(document.querySelector('[data-testid="sketch-dims"]').textContent));
      const t = await ed().getByTestId('sketch-dims').innerText();
      s.note('trimmed to', t);
      await ed().getByRole('button', { name: 'Undo' }).click();
      await dims('350 × 225');
    });

    await s.step('crop tool: drag a box, Crop to box makes the canvas that size', async () => {
      map = await mapper();
      await stroke(map, [[20, 20], [220, 140]]);
      const crop = opts().getByRole('button', { name: 'Crop to box' });
      await p.waitForFunction(() => !document.querySelector('[data-testid="sketch-crop-box"]').disabled);
      await crop.click();
      await p.waitForFunction(() => !/350 × 225/.test(document.querySelector('[data-testid="sketch-dims"]').textContent));
      const t = await ed().getByTestId('sketch-dims').innerText();
      s.note('cropped to', t);
      const m = t.match(/(\d+) × (\d+)/);
      if (Math.abs(Number(m[1]) - 200) > 4 || Math.abs(Number(m[2]) - 120) > 4) throw new Error('the box was about 200 × 120, got ' + t);
    });

    const embed = () => p.getByTestId('sketch-embed');
    const sketchId = () => embed().first().getAttribute('data-sketch');
    const editFromEmbed = async () => {
      await embed().first().hover();
      await embed().first().getByTestId('sketch-edit').click();
      await ed().waitFor();
      await p.getByTestId('sketch-canvas').waitFor();
      await ed().getByTestId('sketch-dims').waitFor();
      await ed().getByRole('region', { name: 'Layers' }).waitFor();
    };
    const drawMark = async (hex, from, to) => {
      await setColour(hex);
      await tool('pencil');
      await opts().getByTestId('sketch-size').fill('6');
      const m = await mapper();
      await stroke(m, [from, to]);
      return m;
    };

    await s.step('Done saves the sketch, closes the editor and the description shows it', async () => {
      await ed().getByTestId('sketch-done').click();
      await ed().waitFor({ state: 'detached' });
      await dlg().getByRole('heading', { level: 2 }).click();
      await s.settle(2500);
      await embed().first().waitFor();
      const id = await sketchId();
      const meta = await getJson(`/sketches/${id}`);
      s.note('saved sketch', { id, w: meta.width, h: meta.height, v: meta.version, layers: meta.layerCount, title: meta.title });
      if (Math.abs(meta.width - 200) > 4 || Math.abs(meta.height - 120) > 4) throw new Error(`size ${meta.width} × ${meta.height}`);
      const src = await getJson(`/sketches/${id}/source`);
      if (src.format !== 'kanban-sketch' || src.width !== meta.width) throw new Error('source does not match');
    });

    await s.step('embed: the toolbar has Edit sketch and View large; the footer says what and who', async () => {
      const e = embed().first();
      await e.hover();
      const bar = e.getByRole('toolbar', { name: 'Sketch actions' });
      await bar.getByRole('button', { name: 'Edit sketch' }).waitFor();
      await bar.getByRole('button', { name: 'View large' }).waitFor();
      await e.getByText('Sketch', { exact: true }).waitFor();
      await e.getByText(/\d+ × \d+ · (Added|Edited) by /).waitFor();
      await e.locator('img').waitFor();
    });

    await s.step('View large: the picture opens big, Download PNG points at the file, Close and Esc shut it', async () => {
      const id = await sketchId();
      const title = (await getJson(`/sketches/${id}`)).title;
      await embed().first().hover();
      await embed().first().getByRole('button', { name: 'View large' }).click();
      const v = p.getByTestId('sketch-viewer');
      await v.waitFor();
      const dl = v.getByRole('link', { name: 'Download PNG' });
      const href = await dl.getAttribute('href');
      if (!new RegExp(`/sketches/${id}/png\\?download=true$`).test(href)) throw new Error('download link ' + href);
      await v.getByRole('img', { name: title }).waitFor();
      const r = await p.request.get(new URL(href, s.server.base).href);
      if (r.status() !== 200 || !/attachment/.test(r.headers()['content-disposition'] || '')) throw new Error('download answer ' + r.status() + ' ' + r.headers()['content-disposition']);
      await v.getByRole('button', { name: 'Close' }).click();
      await v.waitFor({ state: 'detached' });
      await embed().first().getByRole('img').click(); // clicking the picture opens it too
      await v.waitFor();
      await p.keyboard.press('Escape');
      await v.waitFor({ state: 'detached' });
    });

    await s.step('Edit sketch reopens it; a change and Close ask "Save your drawing?"; Keep editing stays', async () => {
      await editFromEmbed();
      await drawMark('#ff0000', [20, 30], [150, 30]);
      await ed().getByTestId('sketch-saved-status').filter({ hasText: /Not yet saved/ }).waitFor();
      await ed().getByTestId('sketch-close').click();
      const q = p.getByRole('alertdialog', { name: 'Save your drawing?' });
      await q.waitFor();
      await q.getByText(/You have changes that are not saved to the ticket/).waitFor();
      await q.getByRole('button', { name: 'Keep editing' }).click();
      await q.waitFor({ state: 'detached' });
      await ed().waitFor();
    });

    await s.step('"Save your drawing?" Discard closes without saving: the stored sketch is unchanged', async () => {
      const id = await sketchId();
      const before = (await getJson(`/sketches/${id}`)).version;
      await ed().getByTestId('sketch-close').click();
      const q = p.getByRole('alertdialog', { name: 'Save your drawing?' });
      await q.getByRole('button', { name: 'Discard' }).click();
      await ed().waitFor({ state: 'detached' });
      const after = (await getJson(`/sketches/${id}`)).version;
      if (after !== before) throw new Error(`version ${before} -> ${after}`);
      await expectPix(id, 80, 30, [0, 0, 0, 0], 'the discarded stroke');
    });

    await s.step('"Save your drawing?" Save stores the change and closes', async () => {
      const id = await sketchId();
      const before = (await getJson(`/sketches/${id}`)).version;
      await editFromEmbed();
      await drawMark('#ff0000', [20, 30], [150, 30]);
      await ed().getByTestId('sketch-close').click();
      await p.getByRole('alertdialog', { name: 'Save your drawing?' }).getByRole('button', { name: 'Save', exact: true }).click();
      await ed().waitFor({ state: 'detached' });
      const meta = await getJson(`/sketches/${id}`);
      if (meta.version !== before + 1) throw new Error(`version ${before} -> ${meta.version}`);
      await expectPix(id, 80, 30, [255, 0, 0, 255], 'the saved stroke');
    });

    await s.step('a failed save keeps the drawing and shows "Could not save"; Try again saves it', async () => {
      await editFromEmbed();
      await drawMark('#0000ff', [20, 60], [150, 60]);
      await p.route('**/sketches/*', (r) => (r.request().method() === 'PUT' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"detail":"disk on fire"}' }) : r.continue()));
      await ed().getByTestId('sketch-done').click();
      const b = ed().getByTestId('sketch-save-failed');
      await b.waitFor();
      await b.getByText('Could not save').waitFor();
      await b.getByText(/Your drawing is safe in a draft on this computer/).waitFor();
      await p.unroute('**/sketches/*');
      await b.getByRole('button', { name: 'Try again' }).click();
      await b.waitFor({ state: 'detached' });
      await ed().getByTestId('sketch-saved-status').filter({ hasText: /^Saved$/ }).waitFor();
      await expectPix(await sketchId(), 80, 60, [0, 0, 255, 255], 'the stroke after Try again');
      await ed().getByTestId('sketch-done').click();
      await ed().waitFor({ state: 'detached' });
    }, { expectConsole: true });

    // somebody else saves a new version of the sketch (what a second browser would do)
    const savedByOther = async (id) => {
      const meta = await getJson(`/sketches/${id}`);
      const png = await (await p.request.get(`${s.server.base}/sketches/${id}/png`)).body();
      const source = await (await p.request.get(`${s.server.base}/sketches/${id}/source`)).body();
      const r = await p.request.put(`${s.server.base}/sketches/${id}`, {
        multipart: {
          png: { name: 'drawing.png', mimeType: 'image/png', buffer: png },
          source: { name: 'drawing.sketch.json', mimeType: 'application/json', buffer: source },
          title: meta.title,
          base_version: String(meta.version),
        },
      });
      if (!r.ok()) throw new Error('the other save failed: ' + r.status());
    };

    await s.step('conflict: someone saved meanwhile; "Save a copy" keeps my version as a second sketch', async () => {
      const id = await sketchId();
      await editFromEmbed();
      await drawMark('#00aa00', [20, 90], [150, 90]);
      await savedByOther(id);
      const n = saves.length;
      await ed().getByTestId('sketch-done').click();
      const c = ed().getByTestId('sketch-conflict');
      await c.waitFor();
      await c.getByText(/saved this drawing while you were drawing/).waitFor();
      await c.getByText(/Your version has not been lost/).waitFor();
      await c.getByTestId('sketch-conflict-copy').click();
      await c.waitFor({ state: 'detached' });
      await expectCount(() => saves.length > n);
      const copy = saves[saves.length - 1];
      if (copy.id === id) throw new Error('no copy was made');
      await expectPix(copy.id, 80, 90, [0, 170, 0, 255], 'my stroke in the copy');
      if (near(await pix(id, 80, 90), [0, 170, 0, 255])) throw new Error('the original has my stroke');
      await ed().getByTestId('sketch-close').click();
      await ed().waitFor({ state: 'detached' });
      await s.settle(1500);
    });

    await s.step('conflict: "Replace theirs" saves my version over the newer one', async () => {
      await embed().first().waitFor();
      const id = await sketchId();
      await editFromEmbed();
      await drawMark('#aa00aa', [20, 100], [150, 100]);
      await savedByOther(id);
      await ed().getByTestId('sketch-done').click();
      const c = ed().getByTestId('sketch-conflict');
      await c.waitFor();
      await c.getByTestId('sketch-conflict-replace').click();
      await c.waitFor({ state: 'detached' });
      await ed().getByTestId('sketch-saved-status').filter({ hasText: /^Saved$/ }).waitFor();
      await expectPix(id, 80, 100, [170, 0, 170, 255], 'my stroke replaced theirs');
      await ed().getByTestId('sketch-close').click();
      await ed().waitFor({ state: 'detached' });
    });

    await s.step('Ask AI on the embed opens the editor with the AI panel and its welcome', async () => {
      await embed().first().hover();
      await embed().first().getByTestId('sketch-ask-ai').click();
      await ed().waitFor();
      const panel = p.getByTestId('sketch-ai-panel');
      await panel.waitFor();
      await panel.getByTestId('sketch-ai-welcome').waitFor();
      await panel.getByTestId('sketch-ai-reading').waitFor();
      await panel.getByText('AI help', { exact: true }).first().waitFor();
      s.note('starting points', await panel.locator('[data-testid^="sketch-ai-start-"]').allInnerTexts());
    });

    await s.step('AI panel: "What will be sent" lists the pieces; attach a text file and a picture, remove one', async () => {
      const panel = p.getByTestId('sketch-ai-panel');
      await panel.getByTestId('sketch-ai-input').fill('Which shapes would make this clearer?');
      await panel.getByTestId('sketch-ai-sent-toggle').click();
      const sent = panel.getByTestId('sketch-ai-sent');
      await sent.waitFor();
      await sent.getByText(/Never sent/).waitFor();
      await sent.getByRole('listitem').first().waitFor();
      s.note('what will be sent', await sent.getByRole('listitem').allInnerTexts());
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      await panel.getByTestId('sketch-ai-file').setInputFiles([
        { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('The error banner sits at the top.') },
        { name: 'dot.png', mimeType: 'image/png', buffer: png },
      ]);
      await p.getByTestId('sketch-ai-pending').nth(1).waitFor();
      await sent.getByText(/Attached file: notes\.txt/).waitFor().catch(() => {});
      await panel.getByRole('button', { name: 'Remove notes.txt' }).click();
      await panel.getByTestId('sketch-ai-pending').nth(1).waitFor({ state: 'detached' });
      await panel.getByLabel('Send the drawing').uncheck();
      await panel.getByLabel('Send the drawing').check();
      await panel.getByTestId('sketch-ai-attach').waitFor();
    });

    await s.step('AI panel: Send gets an answer from the stand-in; its ideas show, Add as label puts one on the drawing', async () => {
      const panel = p.getByTestId('sketch-ai-panel');
      await panel.getByTestId('sketch-ai-send').click();
      const a = panel.getByTestId('sketch-ai-answer');
      await a.getByText('Try a retry button next to the error.').waitFor({ timeout: 30000 });
      await panel.getByTestId('sketch-ai-question').getByText('Which shapes would make this clearer?').waitFor();
      await panel.getByTestId('sketch-ai-question').getByText(/Drawing \d+ × \d+/).waitFor();
      // the ideas come with the answer's message and show as a list with "Add as label" (the panel used to read them
      // from the chat's list of drafts, empty since AI v2, so they never showed)
      const ideasList = panel.getByRole('list', { name: 'Ideas' });
      await ideasList.getByText('Retry button').waitFor();
      await ideasList.getByText('Offline banner').waitFor();
      const before = await rows().count();
      await ideasList.getByRole('button', { name: 'Add as label' }).first().click();
      await ideasList.getByRole('button', { name: 'Added' }).first().waitFor();
      s.note('layers after Add as label', { before, after: await rows().count() });
      await panel.getByRole('region', { name: 'Conversation about this drawing' }).or(panel.getByTestId('sketch-ai-thread')).waitFor();
    });

    await s.step('AI panel: "Put on the drawing" adds the attached picture as a new layer', async () => {
      const panel = p.getByTestId('sketch-ai-panel');
      const before = await rows().count();
      await panel.getByTestId('sketch-ai-put-on').click();
      await p.waitForFunction((n) => document.querySelectorAll('[data-testid="sketch-layer"]').length === n + 1, before);
      s.note('layers now', await layerNames());
    });

    await s.step('AI panel: New chat starts empty again; Close AI help hides the panel; the AI button brings it back', async () => {
      const panel = p.getByTestId('sketch-ai-panel');
      await panel.getByTestId('sketch-ai-new-chat').click();
      await panel.getByTestId('sketch-ai-welcome').waitFor();
      await panel.getByRole('button', { name: 'Close AI help' }).click();
      await panel.waitFor({ state: 'detached' });
      await ed().getByTestId('sketch-ai-button').click();
      await p.getByTestId('sketch-ai-panel').waitFor();
      await ed().getByTestId('sketch-ai-button').click();
      await p.getByTestId('sketch-ai-panel').waitFor({ state: 'detached' });
    });

    await s.step('Done: the picture layer is in the stored source', async () => {
      const id = await sketchId();
      await ed().getByTestId('sketch-done').click();
      await ed().waitFor({ state: 'detached' });
      const src = await getJson(`/sketches/${id}/source`);
      s.note('stored layers', src.layers.map((l) => l.name));
      if (src.layers.length < 2) throw new Error('the picture layer is not stored');
    });

  },
};
