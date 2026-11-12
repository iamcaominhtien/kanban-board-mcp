import { ensureProject, createTicket, openTicket, closeTicket, openDocs, newDocPage, setMarkdown, publishDoc } from '../lib/ui.mjs';

export default {
  name: 'Docs: pages, publish, versions, search, links, comments, bin, import',
  async run(s) {
    const p = s.page;
    {
    const tree = () => p.getByRole('tree');
    const item = (name) => tree().getByRole('treeitem', { name: new RegExp(`(^|Expand |Collapse )${name}( \\d+)? ?(Add child|Page actions|$)`) }).first();
    await s.step('set up: project with a ticket, open Docs (empty state)', async () => {
      await ensureProject(s);
      await createTicket(s, { title: 'Write the handbook' });
      await openDocs(s);
      await p.getByRole('heading', { name: 'Write down how Alpha works' }).waitFor();
    });
    await s.step('create the first page Handbook (draft)', async () => {
      await newDocPage(s, 'Handbook');
      await p.getByText('Draft', { exact: true }).first().waitFor();
    });
    await s.step('write Markdown, it autosaves', async () => {
      await setMarkdown(s, '# Intro\n\nWelcome to the **handbook**.\n\n## Setup\n\n- step one\n- step two\n');
      await p.getByRole('textbox', { name: 'Page content' }).getByRole('heading', { name: 'Setup' }).waitFor();
    });
    await s.step('publish v1 with a note', async () => {
      await publishDoc(s, 'First version');
      await p.getByText('Published · v1').waitFor();
      await p.getByRole('heading', { name: 'Setup', level: 2 }).waitFor();
    });
    await s.step('create a child page under Handbook and publish it', async () => {
      await newDocPage(s, 'Install guide', { parent: 'Handbook' });
      await setMarkdown(s, '# Install guide\n\nRun the installer.\n');
      await publishDoc(s);
      await item('Handbook').waitFor();
    });
    await s.step('create a second top-level page and publish it', async () => {
      await newDocPage(s, 'Release notes');
      await setMarkdown(s, 'Notes for the next release, mentioning the quarterly roadmap.\n');
      await publishDoc(s);
    });
    await s.step('page tree shows both roots and the child', async () => {
      await item('Release notes').waitFor();
      const exp = tree().getByRole('button', { name: 'Expand', exact: true });
      if (await exp.count()) await exp.first().click();
      await item('Install guide').waitFor();
    });
    await s.step('edit Handbook and publish v2', async () => {
      await item('Handbook').click();
      await p.getByRole('button', { name: 'Edit', exact: true }).click();
      await setMarkdown(s, '# Intro\n\nWelcome to the **handbook**, second edition.\n\n## Setup\n\n- step one\n- step two\n- step three\n');
      await publishDoc(s, 'Added step three');
      await p.getByText('Published · v2').waitFor();
    });
    await s.step('page history lists both versions', async () => {
      await p.getByRole('button', { name: 'Page actions' }).click();
      await p.getByRole('menuitem', { name: /Page history/ }).click();
      await p.getByText('First version').first().waitFor();
      await p.getByText('Added step three').first().waitFor();
    });
    await s.step('open version 1 and restore it', async () => {
      await p.getByText('First version').first().click();
      await p.getByRole('button', { name: /Restore/ }).first().click();
      const confirm = p.getByRole('dialog').getByRole('button', { name: /Restore/ });
      if (await confirm.count()) await confirm.last().click();
      await s.settle(2500);
    });
    await s.step('the restored page is v3 with the old text', async () => {
      await p.getByText('Published · v3').waitFor();
      await p.getByText('step three').waitFor({ state: 'detached' });
    });
    await s.step('filter the page tree', async () => {
      await p.getByRole('textbox', { name: 'Filter pages' }).fill('Release');
      await item('Release notes').waitFor();
      await item('Handbook').waitFor({ state: 'detached' });
      await p.getByRole('textbox', { name: 'Filter pages' }).fill('');
      await item('Handbook').waitFor();
    });
    await s.step('link the ticket ALP-1 and the page Handbook from Release notes', async () => {
      await item('Release notes').click();
      await p.getByRole('button', { name: 'Edit', exact: true }).click();
      await setMarkdown(s, 'Notes for the next release, mentioning the quarterly roadmap.\n\nTracked in ALP-1 and described in [[Handbook]].\n');
      await publishDoc(s, 'Linked ticket and page');
      await p.getByText('Published · v2').waitFor();
    });
    await s.step('the page shows chips for the ticket and the page', async () => {
      await p.getByRole('heading', { name: 'Release notes', level: 1 }).waitFor();
      await p.getByText('Write the handbook').first().waitFor();
    });
    await s.step('Handbook lists the back link', async () => {
      await item('Handbook').click();
      const refs = p.getByRole('region', { name: 'Referenced by' });
      await refs.getByText('Release notes').first().waitFor();
    });
    await s.step('the ticket lists the page under Linked docs', async () => {
      await p.getByRole('button', { name: 'Board', exact: true }).click();
      await openTicket(s, 'ALP-1');
      await p.getByRole('dialog', { name: /^Ticket / }).getByText('Release notes').first().waitFor();
      await closeTicket(s);
    });
    await s.step('comment on a quote, reply, resolve', async () => {
      await openDocs(s);
      await item('Handbook').click();
      const li = p.getByRole('listitem').filter({ hasText: 'step one' }).first();
      await li.scrollIntoViewIfNeeded();
      const box = await li.boundingBox();
      await p.mouse.move(box.x + 2, box.y + box.height / 2);
      await p.mouse.down();
      await p.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 6 });
      await p.mouse.up();
      await p.waitForTimeout(300);
      await p.getByTestId('selection-comment').click();
      await p.getByRole('dialog', { name: 'New comment' }).waitFor();
      await p.getByRole('dialog', { name: 'New comment' }).getByPlaceholder('Write a comment…').fill('Is this step still needed?');
      await Promise.all([
        p.waitForResponse((r) => r.request().method() === 'POST' && /comments/.test(r.url()), { timeout: 8000 }),
        p.keyboard.press('Control+Enter'),
      ]);
      await p.getByText('Is this step still needed?').first().waitFor();
      await p.getByTestId('reply-field').first().click();
      await p.keyboard.type('Yes, keep it.');
      await Promise.all([
        p.waitForResponse((r) => r.request().method() === 'POST' && /comments/.test(r.url()), { timeout: 8000 }),
        p.keyboard.press('Control+Enter'),
      ]);
      await s.settle();
      await p.getByRole('button', { name: 'Resolve thread' }).first().click();
      await s.settle();
    });
    await s.step('move Install guide to the bin', async () => {
      await item('Install guide').click();
      await p.getByRole('button', { name: 'Page actions', exact: true }).click();
      await p.getByRole('menuitem', { name: /Delete page/ }).click();
      await p.getByRole('dialog').getByRole('button', { name: /^Delete page/ }).click();
      await item('Install guide').waitFor({ state: 'detached' });
    }, { expectConsole: true }); // the open page is fetched once more after it is gone (410)
    await s.step('restore it from the Recycle Bin', async () => {
      await p.getByRole('button', { name: 'Recycle Bin' }).click();
      await p.getByRole('button', { name: 'Restore' }).first().click();
      await s.settle(2000);
    });
    await s.step('the restored page is back in the Docs tree', async () => {
      await p.keyboard.press('Escape');
      await openDocs(s).catch(() => {});
      await item('Install guide').waitFor();
    });
    await s.step('search with Ctrl+K', async () => {
      await p.keyboard.press('Control+k');
      await p.getByRole('dialog').getByRole('combobox').or(p.getByRole('dialog').getByRole('textbox')).first().fill('quarterly roadmap');
      await p.getByRole('dialog').getByText('Release notes').first().waitFor();
      await p.keyboard.press('Escape');
    });
    }
  },
};
