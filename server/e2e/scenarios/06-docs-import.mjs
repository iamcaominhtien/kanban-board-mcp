import { makeFixtures, cleanFixtures } from '../lib/fixtures.mjs';
import { ensureProject, openDocs } from '../lib/ui.mjs';

export default {
  name: 'Docs: import Markdown files into an empty space',
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
    } finally {
      cleanFixtures(fx);
    }
  },
};
