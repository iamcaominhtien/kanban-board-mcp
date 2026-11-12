import fs from 'node:fs';
import { ensureProject, createTicket, openTicket } from '../lib/ui.mjs';
import { makeFixtures, cleanFixtures } from '../lib/fixtures.mjs';

export default {
  name: 'Attachments: pictures in a description, file upload and download',
  async run(s) {
    const p = s.page;
    const fx = makeFixtures();
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    try {
      await s.step('set up: a ticket with a description', async () => {
        await ensureProject(s);
        await createTicket(s, { title: 'Needs pictures' });
        await openTicket(s, 'ALP-1');
        await dlg().getByRole('button', { name: 'Edit description' }).click();
        await dlg().locator('[contenteditable="true"]').first().click();
        await p.keyboard.type('Screenshot below:');
        await p.keyboard.press('Enter');
      });
      await s.step('upload a picture through the Image button', async () => {
        await dlg().locator('input[type="file"]').first().setInputFiles(fx.png);
        await dlg().locator('[contenteditable="true"] img').first().waitFor();
      });
      await s.step('paste a second picture from the clipboard', async () => {
        const bytes = [...fs.readFileSync(fx.png2)];
        await dlg().locator('[contenteditable="true"]').first().click();
        await p.evaluate((arr) => {
          const ed = document.querySelector('[role="dialog"] [contenteditable="true"]');
          const dt = new DataTransfer();
          dt.items.add(new File([new Uint8Array(arr)], 'pasted.png', { type: 'image/png' }));
          ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        }, bytes);
        await p.waitForFunction(() => document.querySelectorAll('[role="dialog"] [contenteditable="true"] img').length >= 2);
      });
      await s.step('attach a text file', async () => {
        await dlg().locator('input[type="file"][accept="*/*"]').first().setInputFiles(fx.txt);
        await dlg().getByText('notes.txt').first().waitFor();
      });
      await s.step('leave the editor: the description renders the pictures', async () => {
        await dlg().getByRole('heading', { level: 2 }).click();
        await s.settle(2500);
        await p.waitForFunction(() => {
          const imgs = [...document.querySelectorAll('[role="dialog"] img')].filter((i) => i.naturalWidth > 0 && i.src.includes('/uploads/'));
          return imgs.length >= 2;
        }, null, { timeout: 8000 });
      });
      await s.step('the pictures loaded with their real size', async () => {
        const sizes = await p.evaluate(() => [...document.querySelectorAll('[role="dialog"] img')].filter((i) => i.src.includes('/uploads/')).map((i) => `${i.naturalWidth}x${i.naturalHeight}`).sort());
        if ([...new Set(sizes)].join() !== '24x24,48x32') throw new Error('unexpected picture sizes: ' + sizes.join());
      });
      await s.step('download the attached file and compare its bytes', async () => {
        const link = dlg().getByRole('link', { name: 'Download', exact: true });
        const [dl] = await Promise.all([p.waitForEvent('download'), link.click()]);
        const got = fs.readFileSync(await dl.path(), 'utf8');
        s.note('suggested file name', dl.suggestedFilename());
        const href = await link.getAttribute('href');
        const res = await p.request.get(href);
        const h = res.headers();
        s.note('download headers', { status: res.status(), type: h['content-type'], disposition: h['content-disposition'], length: h['content-length'] });
        const pic = await p.request.get(await dlg().locator('img[src*="/uploads/"]').first().getAttribute('src'));
        const ph = pic.headers();
        s.note('picture headers', { status: pic.status(), type: ph['content-type'], length: ph['content-length'], cache: ph['cache-control'] });
        if (got !== fx.txtBody) throw new Error(`downloaded content differs: ${JSON.stringify(got)}`);
      });
      await s.step('reload: pictures and file are still there', async () => {
        await p.reload();
        await p.getByText('Needs pictures').first().waitFor({ timeout: 15000 });
        await p.waitForTimeout(1000);
        if (!(await dlg().count())) await openTicket(s, 'ALP-1');
        await dlg().getByText('notes.txt').first().waitFor();
        await p.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] img')].filter((i) => i.naturalWidth > 0 && i.src.includes('/uploads/')).length >= 2);
      });
    } finally {
      cleanFixtures(fx);
    }
  },
};
