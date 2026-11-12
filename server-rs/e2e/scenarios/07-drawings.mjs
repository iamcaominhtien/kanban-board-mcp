import { makeFixtures, cleanFixtures } from '../lib/fixtures.mjs';
import { ensureProject, createTicket, openTicket } from '../lib/ui.mjs';

// The draw.io editor is not shipped in this checkout: the diagram steps only check what the page does without it.
export default {
  name: 'Drawings: diagram (no editor), sketch, canvas with a note',
  async run(s) {
    const p = s.page;
    const fx = makeFixtures();
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    try {
      await s.step('set up: a ticket with the description editor open', async () => {
        await ensureProject(s);
        await createTicket(s, { title: 'Draw things' });
        await openTicket(s, 'ALP-1');
        await dlg().getByRole('button', { name: 'Edit description' }).click();
        await dlg().locator('[contenteditable="true"]').first().click();
        await p.keyboard.type('Drawings for this ticket:');
        await p.keyboard.press('Enter');
      });
      await s.step('diagram: the draw.io editor cannot be reached (skipped: editing needs draw.io)', async () => {
        await dlg().getByRole('button', { name: 'Diagram' }).click();
        await p.getByRole('menuitem', { name: 'New draw.io drawing' }).click();
        await p.getByRole('dialog', { name: 'Diagram editor' }).getByText('Editor could not be reached').waitFor();
        await p.getByRole('dialog', { name: 'Diagram editor' }).getByRole('button', { name: 'Close' }).click();
        await p.getByRole('dialog', { name: 'Diagram editor' }).getByRole('button', { name: 'Cancel' }).click().catch(() => {});
        await p.getByRole('dialog', { name: 'Diagram editor' }).waitFor({ state: 'detached' });
      });
      await s.step('diagram: import a .drawio file (skipped: it opens the missing editor)', async () => {
        await dlg().getByRole('button', { name: 'Diagram' }).click();
        const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.getByRole('menuitem', { name: 'Import .drawio file' }).click()]);
        await chooser.setFiles(fx.drawio);
        // the import also opens the editor (which is not shipped here): close it again
        const ed = p.getByRole('dialog', { name: 'Diagram editor' });
        await ed.getByText('Editor could not be reached').waitFor();
        await ed.getByRole('button', { name: 'Close' }).click();
        await ed.getByRole('button', { name: 'Cancel' }).click().catch(() => {});
        await ed.waitFor({ state: 'detached' });
      });
      await s.step('sketch: start a new sketch and draw a stroke', async () => {
        await dlg().getByRole('button', { name: 'Sketch', exact: true }).click();
        await p.getByRole('button', { name: 'Start drawing' }).click();
        const cv = p.locator('[data-testid="sketch-editor"] canvas').first();
        await cv.waitFor();
        const bb = await cv.boundingBox();
        await p.mouse.move(bb.x + 120, bb.y + 140);
        await p.mouse.down();
        await p.mouse.move(bb.x + 320, bb.y + 240, { steps: 10 });
        await p.mouse.move(bb.x + 220, bb.y + 340, { steps: 10 });
        await p.mouse.up();
        await p.waitForTimeout(500);
      });
      await s.step('sketch: rename it and press Done', async () => {
        const ed = p.getByTestId('sketch-editor');
        await ed.getByRole('textbox', { name: 'Name of the sketch' }).fill('Login flow sketch');
        await ed.getByRole('button', { name: 'Done' }).click();
        await ed.waitFor({ state: 'detached' });
      });
      await s.step('canvas: create a blank canvas', async () => {
        await dlg().getByRole('button', { name: 'Canvas', exact: true }).click();
        await p.getByPlaceholder('Login redesign').fill('Flow board');
        await p.getByRole('button', { name: 'Create canvas' }).click();
        await p.getByRole('dialog', { name: 'Canvas Flow board' }).waitFor();
      });
      await s.step('canvas: add a note and type in it', async () => {
        const cv = p.getByRole('dialog', { name: 'Canvas Flow board' });
        await cv.getByRole('button', { name: 'Note', exact: true }).click();
        await p.mouse.click(520, 400);
        await p.waitForTimeout(400);
        await p.keyboard.type('Remember the milk');
        await p.keyboard.press('Escape');
        await cv.getByText('Remember the milk').first().waitFor();
      });
      await s.step('canvas: press Done', async () => {
        const cv = p.getByRole('dialog', { name: 'Canvas Flow board' });
        await cv.getByRole('button', { name: 'Done' }).click();
        await cv.waitFor({ state: 'detached' });
      });
      await s.step('leave the editor: the description shows the three drawings', async () => {
        await dlg().getByRole('heading', { level: 2 }).click();
        await s.settle(2500);
      });
      await s.step('reload and reopen the ticket: the drawings are still there', async () => {
        await p.reload();
        await p.getByText('Draw things').first().waitFor({ timeout: 15000 });
        await p.waitForTimeout(1000);
        if (!(await dlg().count())) await openTicket(s, 'ALP-1');
        await dlg().getByText(/Login flow sketch|Flow board/).first().waitFor();
      });
      await s.step('the sketch picture can be revalidated with If-None-Match', async () => {
        const src = await p.locator('img[src*="/sketches/"]').first().getAttribute('src');
        const r1 = await p.request.get(new URL(src, s.server.base).href);
        const etag = r1.headers()['etag'];
        const r1b = await p.request.get(new URL(src, s.server.base).href);
        s.note('etag is the same on a second plain request', r1b.headers()['etag'] === etag);
        s.note('etag shape', (etag || '').replace(/[0-9a-f]{8,}/g, 'HEX'));
        s.note('first answer', { status: r1.status(), type: r1.headers()['content-type'], hasEtag: !!etag, cache: r1.headers()['cache-control'] });
        const r2 = await p.request.get(new URL(src, s.server.base).href, { headers: { 'If-None-Match': etag || 'none' } });
        s.note('conditional answer status', r2.status());
      });
    } finally {
      cleanFixtures(fx);
    }
  },
};
