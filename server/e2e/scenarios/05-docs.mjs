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
    await s.step('reader settings: Aa changes the page for this reader only, and stays on this device', async () => {
      await p.getByRole('button', { name: 'Reading settings' }).click();
      const panel = p.getByRole('dialog', { name: 'Reading settings' });
      await panel.getByRole('button', { name: /Sepia/ }).click();
      await p.locator('.dk-page-scroll.dk-rt-sepia').waitFor();
      const stored = await p.evaluate(() => localStorage.getItem('docsReaderPrefs'));
      if (!stored || !stored.includes('sepia')) throw new Error('the reader settings were not stored: ' + stored);
      await panel.getByRole('button', { name: 'Reset' }).click();
      await p.locator('.dk-page-scroll.dk-rt-sepia').waitFor({ state: 'detached' });
      await p.keyboard.press('Escape');
    });
    await s.step('the Published badge opens its version, and History reads an older version read-only', async () => {
      await p.getByTestId('status-badge').click();
      await p.getByRole('dialog', { name: 'Version 3' }).getByRole('button', { name: /Page history/ }).click();
      // a row's buttons show on hover
      await p.locator('.hd-row', { has: p.getByTestId('read-version-2') }).hover();
      await p.getByTestId('read-version-2').click();
      await p.getByText('You are reading v2.').waitFor();
      if (!(await p.getByTestId('edit-page').isDisabled())) throw new Error('Edit must be off on an older version');
      await p.getByRole('button', { name: 'Back to the latest' }).click();
      await p.getByTestId('older-version-bar').waitFor({ state: 'detached' });
    });
    await s.step('print: a short options panel, then only the page goes to the printer', async () => {
      await p.evaluate(() => {
        window.print = () => {
          window.__printed = {
            sheet: document.querySelector('.dk-print-sheet')?.textContent ?? '',
            hidden: document.body.classList.contains('dk-printing'),
          };
          window.dispatchEvent(new Event('afterprint'));
        };
      });
      const direct = p.getByTestId('print-button');
      if (await direct.count()) await direct.click();
      else {
        await p.getByRole('button', { name: 'Page actions' }).click();
        await p.getByRole('menuitem', { name: /^Print/ }).click();
      }
      const dialog = p.getByRole('dialog', { name: 'Print' });
      if ((await dialog.getByRole('switch', { name: 'Include highlights' }).getAttribute('aria-checked')) !== 'false')
        throw new Error('highlights must be off by default');
      await dialog.getByRole('button', { name: 'Print', exact: true }).click();
      const printed = await p.evaluate(() => window.__printed);
      s.note('printed', JSON.stringify(printed));
      if (!printed?.hidden || !printed.sheet.includes('Handbook') || !printed.sheet.includes('step one'))
        throw new Error('the print sheet lacks the page: ' + JSON.stringify(printed));
      if (await p.locator('.dk-print-sheet').count()) throw new Error('the print sheet stayed after printing');
    });
    await s.step('share publicly: asked first, the link opens a public page with no app, and stops at once', async () => {
      await p.getByTestId('share').click();
      await p.getByTestId('public-link-toggle').click();
      await p.getByText('Make this page public?').waitFor();
      await p.getByRole('button', { name: 'Make public' }).click();
      const shown = (await p.getByTestId('public-url').textContent()).trim();
      const url = new URL('http://' + shown).href;
      s.note('public link', url);
      const reader = await p.context().newPage();
      await reader.goto(url);
      await reader.getByRole('heading', { name: 'Handbook', level: 1 }).waitFor();
      await reader.getByText('Public page', { exact: true }).waitFor();
      if (await reader.getByRole('button', { name: /Edit|Comments|Share/ }).count())
        throw new Error('the public page must not offer Edit, Comments or Share');
      const robots = await reader.locator('meta[name="robots"]').getAttribute('content');
      if (robots !== 'noindex') throw new Error('the public page must not be indexed: ' + robots);
      await p.getByTestId('public-stop').click();
      await p.getByTestId('public-url').waitFor({ state: 'detached' });
      await reader.reload();
      await reader.getByRole('heading', { name: 'This link is no longer public.' }).waitFor();
      await reader.close();
      await p.keyboard.press('Escape');
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
      await p.waitForTimeout(500);
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
