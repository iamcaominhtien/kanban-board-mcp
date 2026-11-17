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
    await s.step('history: each row counts the blocks it changed, and Compare shows them block by block', async () => {
      await p.getByTestId('version-count-2').getByText(/\d+ blocks? (edited|added|removed)/).waitFor();
      await p.getByLabel('Select version 1').check({ force: true });
      await p.getByLabel('Select version 2').check({ force: true });
      await p.getByRole('button', { name: 'Compare', exact: true }).click();
      const cmp = p.getByTestId('history-compare');
      await cmp.getByTestId('hx-label').filter({ hasText: 'Text edited' }).first().waitFor();
      await cmp.getByRole('navigation', { name: 'Jump to a change' }).waitFor();
      // any two versions: swapping them compares the other way round
      await cmp.getByTestId('hx-swap').click();
      await cmp.getByLabel('From version').locator('option:checked').filter({ hasText: 'v2' }).waitFor({ state: 'attached' });
      await cmp.getByRole('button', { name: 'Back to page' }).click();
      await p.getByTestId('history-drawer').waitFor();
      await p.getByLabel('Select version 1').uncheck({ force: true });
      await p.getByLabel('Select version 2').uncheck({ force: true });
    });
    await s.step('history: Copy as new page makes a draft from version 1', async () => {
      // on desktop a row's actions show on hover; the rows keep their height, so a click is not moved onto another row
      // when the row that had focus (version 2, whose box was just cleared) hides its buttons
      await p.getByTestId('version-row-1').hover();
      await p.getByTestId('copy-version-1').click();
      const d = p.getByRole('dialog', { name: 'Copy v1 as a new page' });
      await d.getByLabel('Title').fill('Handbook first draft');
      await Promise.all([
        p.waitForResponse((r) => r.request().method() === 'PUT' && /\/draft$/.test(r.url()), { timeout: 8000 }),
        d.getByTestId('hx-copy-confirm').click(),
      ]);
      await p.getByText('Created a draft').waitFor();
      await item('Handbook first draft').waitFor();
    });
    await s.step('open version 1 and restore it', async () => {
      await p.getByText('First version').first().click();
      await p.getByRole('button', { name: /Restore/ }).first().click();
      // restore asks first: it makes a new version and says what happens to comments
      await p.getByTestId('hx-restore').getByText('Restoring creates v3.').waitFor();
      await p.getByTestId('hx-restore-comments').getByText('Comments stay with the page, not with a version.').waitFor();
      const confirm = p.getByRole('dialog').getByRole('button', { name: /Restore/ });
      if (await confirm.count()) await confirm.last().click();
      await s.settle(2500);
    });
    await s.step('the restored page is v3 with the old text', async () => {
      await p.getByText('Published · v3').waitFor();
      await p.getByText('step three').waitFor({ state: 'detached' });
    });
    await s.step('the read view: a 60 px bar of 32 px actions, a progress bar under it, the status under the title', async () => {
      const bar = p.getByTestId('page-bar');
      await bar.waitFor();
      await p.getByTestId('read-progress').waitFor({ state: 'attached' });
      const m = await p.evaluate(() => {
        const box = (sel) => document.querySelector(sel)?.getBoundingClientRect();
        const title = document.querySelector('[data-testid="page-title"]');
        const status = document.querySelector('[data-testid="status-badge"]');
        return {
          bar: box('[data-testid="page-bar"]')?.height,
          edit: box('[data-testid="edit-page"]')?.height,
          more: box('[data-testid="page-menu"]')?.height,
          progress: box('[data-testid="read-progress"]')?.height,
          // the status line follows the title (Reader boards, D)
          statusAfterTitle: !!(title && status && title.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING),
        };
      });
      s.note('read view', JSON.stringify(m));
      if (Math.round(m.bar) !== 60 || Math.round(m.edit) !== 32 || Math.round(m.more) !== 32 || Math.round(m.progress) !== 3)
        throw new Error('the page bar does not match the Reader boards: ' + JSON.stringify(m));
      if (!m.statusAfterTitle) throw new Error('the status line must sit under the title');
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
    await s.step('a comment carries its block, and with the panel closed its mark sits in the margin', async () => {
      const li = p.getByRole('listitem').filter({ hasText: 'step two' }).first();
      await li.scrollIntoViewIfNeeded();
      const box = await li.boundingBox();
      await p.mouse.move(box.x + 2, box.y + box.height / 2);
      await p.mouse.down();
      await p.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 6 });
      await p.mouse.up();
      await p.waitForTimeout(300);
      await p.getByTestId('selection-comment').click();
      const dlg = p.getByRole('dialog', { name: 'New comment' });
      await dlg.getByPlaceholder('Write a comment…').fill('Say which tool this step needs.');
      const [req] = await Promise.all([
        p.waitForRequest((r) => r.method() === 'POST' && /\/comments$/.test(r.url()), { timeout: 8000 }),
        p.keyboard.press('Control+Enter'),
      ]);
      const sent = JSON.parse(req.postData() ?? '{}');
      if (!sent.anchor?.block_id) throw new Error('the comment must carry its block id: ' + req.postData());
      await p.getByTestId('comments-close').click();
      const mark = p.getByTestId('margin-mark').first();
      await mark.waitFor();
      await mark.click();
      await p.getByTestId('comments-panel').getByText('Say which tool this step needs.').waitFor();
    });
    await s.step('move Install guide to the bin', async () => {
      await item('Install guide').click();
      await p.getByRole('button', { name: 'Page actions', exact: true }).click();
      await p.getByRole('menuitem', { name: /Delete page/ }).click();
      await p.getByRole('dialog').getByRole('button', { name: /^Delete page/ }).click();
      await item('Install guide').waitFor({ state: 'detached' });
    }, { expectConsole: true }); // the open page is fetched once more after it is gone (410)
    await s.step('restore it from the Recycle Bin (the row under the tree opens it); its days left are shown', async () => {
      // the sidebar and the row under the page tree both open the bin
      await p.getByTestId('tree-recycle-bin').click();
      await p.getByRole('dialog', { name: 'Recycle Bin' }).getByTestId('bin-days-left').first().waitFor();
      await p.getByRole('button', { name: 'Restore' }).first().click();
      await s.settle(2000);
    });
    await s.step('the restored page is back in the Docs tree', async () => {
      await p.keyboard.press('Escape');
      await openDocs(s).catch(() => {});
      await item('Install guide').waitFor();
    });
    // Organising pages: icons, views, filters, moving, several pages (design "Rich Docs — organising pages")
    await s.step('row menu › Page icon…: the emoji shows in the tree row', async () => {
      await item('Release notes').hover();
      await tree().getByRole('button', { name: 'Page actions for Release notes' }).click();
      await p.getByRole('menuitem', { name: /Page icon/ }).click();
      const picker = p.getByRole('dialog', { name: 'Page icon' });
      await picker.getByRole('option', { name: '📖' }).click();
      await picker.waitFor({ state: 'detached' });
      await p.getByTestId('tree-row-release-notes').getByText('📖').waitFor();
    });
    await s.step('Gallery: top-level pages as cards; a card with pages inside opens as a folder', async () => {
      await p.getByTestId('tree-view-gallery').click();
      const g = p.getByTestId('docs-gallery');
      await g.getByTestId('gallery-card-handbook').getByRole('button', { name: 'Handbook', exact: true }).click();
      await g.getByText('1 page inside').waitFor();
      await g.getByRole('button', { name: 'Open page' }).click();
      await g.waitFor({ state: 'detached' });
      await p.getByTestId('page-title').getByText('Handbook', { exact: true }).waitFor();
    });
    await s.step('Recent: the newest edits grouped by day', async () => {
      await p.getByTestId('tree-view-recent').click();
      const r = p.getByTestId('docs-recent');
      await r.getByRole('group', { name: 'Today' }).waitFor();
      await r.getByRole('button', { name: /Release notes/ }).first().click();
      await r.waitFor({ state: 'detached' });
    });
    await s.step('filters combine and say which are on when nothing matches', async () => {
      await p.getByTestId('tree-filter').click();
      await p.getByTestId('tree-filter-outdated').click();
      await p.getByTestId('tree-filter-show').click();
      await p.getByTestId('tree-no-match').getByText('None of the pages may be outdated.').waitFor();
      await p.getByTestId('tree-no-match').getByRole('button', { name: 'Clear filters' }).click();
      await item('Handbook').waitFor();
    });
    await s.step('Alt+Shift+↑ moves a page up; the toast offers Undo', async () => {
      await p.getByTestId('tree-row-release-notes').focus();
      await p.keyboard.press('Alt+Shift+ArrowUp');
      await p.getByText(/Moved “Release notes” to the top level/).waitFor();
      await p.getByRole('button', { name: 'Undo' }).first().click();
      await p.getByText('Moved “Release notes” back').waitFor();
    });
    await s.step('several pages: a picked parent brings its child page; Done ends it', async () => {
      await p.getByTestId('tree-row-handbook').click({ modifiers: ['Control'] });
      await p.getByTestId('tree-selection-bar').getByText('1 selected · 2 pages').waitFor();
      await p.getByTestId('tree-selection-done').click();
      await p.getByTestId('tree-selection-bar').waitFor({ state: 'detached' });
    });
    await s.step('row menu › Turn into a book… opens Page settings on its Book tab', async () => {
      await item('Handbook').hover();
      await tree().getByRole('button', { name: 'Page actions for Handbook' }).click();
      await p.getByRole('menuitem', { name: /Turn into a book/ }).click();
      await p.getByTestId('ps-book').click();
      await p.getByTestId('ps-done').click();
      // a book reads in order: the side shows its chapters, numbered, and the footer leads to chapter 1
      const ch = p.getByTestId('chapter-list');
      await ch.getByText('1 chapter').waitFor();
      await ch.getByRole('listitem').filter({ hasText: 'Install guide' }).getByText('1', { exact: true }).waitFor();
      await p.getByTestId('reading-footer').getByText('1. Install guide').waitFor();
      // a book's pages read in focus, the tree folded to its rail; a page outside the book brings the tree back
      await p.getByRole('button', { name: 'Release notes', exact: true }).first().click();
      await item('Release notes').waitFor();
    });
    await s.step('search with Ctrl+K', async () => {
      await p.keyboard.press('Control+k');
      await p.getByRole('dialog').getByRole('combobox').or(p.getByRole('dialog').getByRole('textbox')).first().fill('quarterly roadmap');
      await p.getByRole('dialog').getByText('Release notes').first().waitFor();
      await p.keyboard.press('Escape');
    });
    // Starting and shaping a page: Save as template, then the New page gallery
    await s.step('save Release notes as a template from its page menu; the gallery shows it under Yours', async () => {
      await item('Release notes').click();
      await p.getByTestId('page-title').getByText('Release notes', { exact: true }).waitFor();
      await p.getByRole('button', { name: 'Page actions', exact: true }).click();
      await p.getByRole('menuitem', { name: /Save as template/ }).click();
      const d = p.getByRole('dialog', { name: 'Save as a template' });
      await d.getByLabel('Name').fill('x'.repeat(61));
      await d.getByTestId('name-too-long').getByText('61 / 60').waitFor();
      if (!(await d.getByTestId('save-template').isDisabled())) throw new Error('Save should be off while the name is too long');
      await d.getByLabel('Name').fill('Release notes template');
      await d.getByRole('button', { name: 'This project' }).click();
      await d.getByTestId('save-template').click();
      await d.waitFor({ state: 'detached' });
      await p.getByRole('button', { name: 'Open the gallery' }).click();
      const g = p.getByRole('dialog', { name: 'New page' });
      await g.getByRole('radio', { name: /Release notes template/ }).waitFor();
      await g.getByText('Yours · this project').waitFor();
      await g.getByRole('button', { name: 'Close' }).click();
    });
    await s.step('save it again under the same name: it says so and offers Replace', async () => {
      await p.getByRole('button', { name: 'Page actions', exact: true }).click();
      await p.getByRole('menuitem', { name: /Save as template/ }).click();
      const d = p.getByRole('dialog', { name: 'Save as a template' });
      await d.getByLabel('Name').fill('Release notes template');
      await d.getByTestId('save-template').click();
      await d.getByTestId('name-taken').waitFor();
      await d.getByRole('button', { name: 'Replace' }).click();
      await d.waitFor({ state: 'detached' });
    });
    await s.step('the New page gallery: chips, a search with no match, then a page from Blog post', async () => {
      await p.getByRole('button', { name: 'New page' }).first().click();
      const g = p.getByRole('dialog', { name: 'New page' });
      await g.getByTestId('chip-writing').click();
      await g.getByTestId('template-blog-post').waitFor();
      await g.getByTestId('chip-all').click();
      await g.getByLabel('Find a template').fill('pitch deck');
      await g.getByText('No templates match “pitch deck”').waitFor();
      await g.getByRole('button', { name: 'Clear search' }).click();
      await g.getByTestId('template-blog-post').click();
      await g.getByTestId('template-preview').getByText(/Preview · Blog post/).waitFor();
      await g.getByRole('textbox', { name: 'Title' }).fill('');
      await g.getByRole('button', { name: 'Create page' }).click();
      await g.getByText('Give the page a title to create it.').waitFor();
      await g.getByRole('textbox', { name: 'Title' }).fill('Field notes');
      await g.getByRole('button', { name: 'Create page' }).click();
      await g.waitFor({ state: 'detached' });
      await p.getByRole('textbox', { name: 'Page title' }).waitFor();
      // the editor folds the tree to its rail: the new page shows in the breadcrumb, with the template's style
      await p.getByText('Field notes', { exact: true }).first().waitFor();
      await p.getByRole('heading', { name: 'What happened' }).waitFor();
    });
    }
  },
};
