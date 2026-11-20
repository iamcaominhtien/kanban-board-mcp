import fs from 'node:fs';
import path from 'node:path';
import { makeFixtures, cleanFixtures } from '../lib/fixtures.mjs';
import { ensureProject, openDocs } from '../lib/ui.mjs';

export default {
  name: 'Docs: import Markdown, Word, HTML and pasted text',
  async run(s) {
    const p = s.page;
    const fx = makeFixtures();
    const dlg = () => p.getByRole('dialog', { name: 'Import Markdown' });
    try {
      await s.step('open Docs of a new project', async () => {
        await ensureProject(s);
        await openDocs(s);
        await p.getByRole('heading', { name: 'Write down how Alpha works' }).waitFor();
      });
      await s.step('files dragged over the space: the drop zone covers the page, not the tree, with a chip per file (Start 4)', async () => {
        await p.evaluate(() => {
          const dt = new DataTransfer();
          dt.items.add(new File(['# Plan'], 'plan.md', { type: 'text/markdown' }));
          dt.items.add(new File(['<p>x</p>'], 'notes.html', { type: 'text/html' }));
          window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
        });
        const zone = p.getByTestId('docs-dropzone');
        await zone.getByText('Drop to add 2 files').waitFor();
        await zone.getByText('Markdown', { exact: true }).waitFor();
        await zone.getByText('HTML', { exact: true }).waitFor();
        const tree = await p.getByText('No pages yet').boundingBox();
        const box = await zone.boundingBox();
        if (!tree || !box || box.x < tree.x + tree.width) throw new Error('the drop zone covers the tree');
        await p.evaluate(() => {
          const dt = new DataTransfer();
          dt.items.add(new File(['# Plan'], 'plan.md', { type: 'text/markdown' }));
          window.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true }));
        });
        await zone.waitFor({ state: 'detached' });
      });
      await s.step('phone: Import is a full-screen sheet titled Import, with Place under and one Import button (Start 33)', async () => {
        const size = p.viewportSize();
        await p.setViewportSize({ width: 390, height: 760 });
        try {
          const rows = p.getByTestId('hero-import-rows');
          await rows.getByRole('button', { name: /Import Markdown/ }).click();
          await dlg().getByText('Choose from your device').waitFor();
          await dlg().getByText('Import', { exact: true }).first().waitFor();
          await dlg().getByRole('combobox', { name: 'Place under' }).waitFor();
          if (!(await dlg().getByTestId('import-phone-go').isDisabled())) throw new Error('Import is on before any file');
          await dlg().getByRole('button', { name: 'Close' }).click();
          await dlg().waitFor({ state: 'detached' });
        } finally {
          await p.setViewportSize(size);
        }
      });
      await s.step('open the import dialog and choose two files', async () => {
        await p.getByRole('button', { name: 'Import Markdown' }).click();
        await dlg().waitFor();
        await dlg().locator('input[type="file"]').first().setInputFiles([fx.md1, fx.md2]);
        await dlg().getByText(/Alpha guide/).first().waitFor();
        await dlg().getByText(/Beta guide/).first().waitFor();
      });
      await s.step('confirm the import', async () => {
        await dlg().getByRole('button', { name: /^Import/ }).last().click();
        await s.settle(3000);
      });
      await s.step('the imported pages are in the tree', async () => {
        const close = p.getByRole('dialog', { name: 'Import Markdown' }).getByRole('button', { name: /Close|Done/ });
        if (await close.count()) await close.first().click();
        await p.getByRole('tree').getByText('Alpha guide').first().waitFor();
        await p.getByRole('tree').getByText('Beta guide').first().waitFor();
      });
      await s.step('open an imported page and read it', async () => {
        await p.getByRole('tree').getByText('Beta guide').first().click();
        await p.getByRole('heading', { name: 'Beta guide', level: 1 }).first().waitFor();
        await p.getByRole('link', { name: 'link', exact: true }).waitFor();
      });
      // Word, HTML and Paste are converted in the browser and saved as draft pages (design "Starting and shaping a page", E)
      const openImport = async () => {
        await p.getByTestId('tree-new-page-menu').click();
        await p.getByRole('menu', { name: 'New page' }).getByTestId('new-menu-import').click();
        await dlg().waitFor();
      };
      await s.step('the tree\'s New page menu has From template, Import and Paste', async () => {
        await p.getByTestId('tree-new-page-menu').click();
        const menu = p.getByRole('menu', { name: 'New page' });
        for (const t of ['Blank page', 'From template…', 'Import…', 'Paste from the clipboard']) await menu.getByRole('menuitem', { name: new RegExp(t) }).waitFor();
        await p.keyboard.press('Escape');
      });
      await s.step('a file that cannot be imported says why, and Import stays off', async () => {
        const pages = path.join(fx.dir, 'notes.pages');
        fs.writeFileSync(pages, 'not a document');
        await openImport();
        await dlg().getByTestId('import-source-html').click();
        const d = p.getByRole('dialog', { name: 'Import HTML' });
        await d.getByTestId('import-notes-html').getByText(/Left out: Scripts, forms, frames/).waitFor();
        await d.getByTestId('import-file-input').setInputFiles(pages);
        await d.getByText('Not supported').waitFor();
        await d.getByText('Export it from Pages as Word (.docx) and import that.').waitFor();
        if (!(await d.getByTestId('import-go').isDisabled())) throw new Error('Import should be off with only a refused file');
        await d.getByRole('button', { name: 'Remove notes.pages' }).click();
        await d.getByRole('button', { name: 'Close' }).click();
      });
      await s.step('import an HTML file: scripts are left out, the page arrives as a draft', async () => {
        const html = path.join(fx.dir, 'gamma.html');
        fs.writeFileSync(html, '<!doctype html><html><head><title>x</title><script>window.hacked=1</script></head><body><h1>Gamma notes</h1><p>Hello <b>world</b>.</p><ul><li>one</li></ul></body></html>');
        await openImport();
        await dlg().getByTestId('import-source-html').click();
        const d = p.getByRole('dialog', { name: 'Import HTML' });
        await d.getByTestId('import-file-input').setInputFiles(html);
        await d.getByText('gamma.html').waitFor();
        await d.getByRole('button', { name: 'Import 1 file' }).click();
        await d.waitFor({ state: 'detached', timeout: 20000 });
        await p.getByRole('tree').getByText('Gamma notes').first().waitFor();
        if (await p.evaluate(() => window.hacked)) throw new Error('a script of the imported HTML ran');
      });
      await s.step('import a Word file (converted in the browser with mammoth)', async () => {
        await openImport();
        await dlg().getByTestId('import-source-word').click();
        const d = p.getByRole('dialog', { name: 'Import Word' });
        await d.getByTestId('import-notes-word').getByText(/Left out: Comments, tracked changes/).waitFor();
        await d.getByTestId('import-file-input').setInputFiles(fx.previews.docx);
        await d.getByRole('button', { name: 'Import 1 file' }).click();
        await d.waitFor({ state: 'detached', timeout: 20000 });
        await p.getByRole('tree').getByText('notes', { exact: true }).first().waitFor();
      });
      await s.step('paste Markdown: the guess is shown and can be switched', async () => {
        await openImport();
        await dlg().getByTestId('import-source-paste').click();
        const d = p.getByRole('dialog', { name: 'Import pasted text' });
        await d.getByRole('textbox', { name: 'Pasted text' }).fill('# Delta page\n\n- one\n- **two**\n');
        await d.getByTestId('paste-guess').getByText('Looks like Markdown').waitFor();
        await d.getByRole('button', { name: 'Treat as HTML' }).click();
        await d.getByTestId('paste-guess').getByText('Looks like HTML').waitFor();
        await d.getByRole('button', { name: 'Treat as Markdown' }).click();
        // the title follows the guess once React has applied it
        await p.waitForFunction(() => document.querySelector('#docs-paste-title')?.value === 'Delta page', null, { timeout: 5000 })
          .catch(() => { throw new Error('the paste title comes from its heading'); });
        await d.getByRole('button', { name: 'Import', exact: true }).click();
        await d.waitFor({ state: 'detached', timeout: 20000 });
        await p.getByRole('tree').getByText('Delta page').first().waitFor();
      });
    } finally {
      cleanFixtures(fx);
    }
  },
};
