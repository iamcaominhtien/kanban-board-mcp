import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureProject, createTicket, openDocs, openTicket, closeTicket, openMembers, publishDoc, setMarkdown } from '../lib/ui.mjs';

// Docs page actions and the page tree: the Hero's file pickers and the import dialog, the tree (add child, collapse,
// filter, resize, drag, rail), the page menu (Duplicate, Move to, Rename, Delete, Give to an AI team), page info,
// Share, Discard and Publish, the Recycle Bin, Follow, Linked docs on a ticket, and the no-access screen.
export default {
  name: 'Docs pages: import pickers, tree, menu actions (duplicate, move, rename, delete, give), info, share, discard, bin, follow, ticket links',
  async run(s) {
    const p = s.page;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-e2e-pages-'));
    const write = (rel, text) => {
      const f = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
      return f;
    };
    const tree = () => p.getByRole('tree');
    // a row of the page tree by its title (the accessible name carries "Expand " / "Collapse " and the counts)
    const row = (name) => tree().getByRole('treeitem', { name: new RegExp(`(^|Expand |Collapse )${name}( \\d+)?( Draft)? ?(Add child|Page actions|$)`) }).first();
    const rowTitles = async () => (await tree().getByRole('treeitem').allInnerTexts()).map((t) => t.split('\n')[0].trim());
    const clip = () => p.evaluate(() => navigator.clipboard.readText());
    const toast = (text) => p.getByText(text).first();
    const menuOf = async (title) => {
      await row(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).hover();
      await p.getByRole('button', { name: `Page actions for ${title}` }).click();
      return p.getByRole('menu', { name: 'Page actions' });
    };
    // opens a page by its row and waits for its title
    const openPage = async (title) => {
      await row(title).click();
      await p.getByRole('heading', { name: title, level: 1 }).waitFor();
    };
    const expandAll = async () => {
      for (let i = 0; i < 4; i++) {
        const b = tree().getByRole('button', { name: 'Expand', exact: true });
        if (!(await b.count())) break;
        await b.first().click();
      }
    };

    try {
      const handbook = write('handbook.md', '# Handbook\n\nWelcome to the handbook. It has a few words to count.\n');
      const release = write('release.md', '# Release notes\n\nSee [[Handbook]] for the basics, tracked in ALP-1.\n');
      const scratch = write('scratch.md', '# Scratch\n\nA throw-away page, see [[Release notes]].\n');
      write('Ops/runbook.md', '# Runbook\n\nHow to restart things.\n');

      await s.step('set up: a project with a ticket, Docs is empty', async () => {
        await ensureProject(s);
        await createTicket(s, { title: 'Plan the launch' });
        await openDocs(s);
        await p.getByRole('heading', { name: 'Write down how Alpha works' }).waitFor();
      });

      await s.step('Hero: "Choose folder…" opens the import dialog with the pages of the folder, which is closed again', async () => {
        const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.getByTestId('docs-choose-folder').click()]);
        await chooser.setFiles(path.join(tmp, 'Ops'));
        const d = p.getByRole('dialog', { name: 'Import Markdown' });
        await d.getByText(/Runbook/).first().waitFor();
        await d.getByRole('button', { name: 'Close' }).click();
        await d.waitFor({ state: 'detached' });
        await p.getByRole('heading', { name: 'Write down how Alpha works' }).waitFor();
      });

      await s.step('Hero: "Choose files…" opens the import dialog with the chosen files', async () => {
        const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.getByTestId('docs-choose-files').click()]);
        await chooser.setFiles([handbook, release, scratch]);
        const d = p.getByRole('dialog', { name: 'Import Markdown' });
        await d.waitFor();
        await d.getByText(/Handbook/).first().waitFor();
        await d.getByText(/Release notes/).first().waitFor();
        await d.getByText(/Scratch/).first().waitFor();
      });

      await s.step('import dialog: "Files…" adds none, "Folder…" adds a folder of pages', async () => {
        const d = p.getByRole('dialog', { name: 'Import Markdown' });
        const [folder] = await Promise.all([p.waitForEvent('filechooser'), d.getByRole('button', { name: 'Folder…' }).click()]);
        await folder.setFiles(path.join(tmp, 'Ops'));
        await d.getByText(/Runbook/).first().waitFor();
        // the picker for single files opens and is dismissed without a choice
        const [files] = await Promise.all([p.waitForEvent('filechooser'), d.getByRole('button', { name: 'Files…' }).click()]);
        await files.setFiles([]);
      });

      await s.step('import everything: the pages are in the tree as drafts', async () => {
        const d = p.getByRole('dialog', { name: 'Import Markdown' });
        await d.getByRole('button', { name: /^Import/ }).last().click();
        await d.getByRole('button', { name: /Close|Done/ }).first().click({ timeout: 6000 }).catch(() => {});
        await row('Handbook').waitFor();
        await row('Release notes').waitFor();
        await row('Scratch').waitFor();
        await row('Runbook').waitFor();
        await tree().getByTitle('Draft').first().waitFor();
      });

      await s.step('publish Handbook, Release notes and Scratch so their links resolve', async () => {
        for (const title of ['Handbook', 'Release notes', 'Scratch']) {
          await row(title).click();
          await p.getByTestId('edit-page').click();
          await p.getByRole('textbox', { name: 'Page title' }).waitFor();
          await publishDoc(s);
          await p.getByRole('heading', { name: title, level: 1 }).waitFor();
        }
      });

      await s.step('the "+" on a row adds a child page from a template', async () => {
        await row('Handbook').hover();
        await p.getByRole('button', { name: 'Add child page under Handbook' }).click();
        const d = p.getByRole('dialog', { name: 'New page' });
        await d.getByRole('button', { name: 'Parent page' }).getByText('Handbook').waitFor();
        await d.getByRole('radiogroup', { name: 'Template' }).waitFor();
        await d.getByTestId('template-meeting-notes').click();
        await d.getByTestId('template-meeting-notes').and(p.locator('[aria-checked="true"]')).waitFor();
        await d.getByRole('textbox', { name: 'Title' }).fill('Install guide');
        await d.getByRole('button', { name: 'Create page' }).click();
        await d.waitFor({ state: 'detached' });
        await p.getByRole('textbox', { name: 'Page title' }).waitFor();
        await toast('Page created');
        // the rich editor opens with the template's headings in the page
        await p.getByRole('heading', { name: 'Attendees' }).first().waitFor();
        await p.getByRole('heading', { name: 'Action items' }).first().waitFor();
        await publishDoc(s);
        await row('Handbook').getByRole('button', { name: 'Collapse' }).waitFor();
      });

      await s.step('New page: pick the parent with "Find a page…"', async () => {
        await p.getByTestId('tree-new-page').click();
        const d = p.getByRole('dialog', { name: 'New page' });
        await d.getByRole('textbox', { name: 'Title' }).fill('Roadmap');
        await d.getByRole('button', { name: 'Parent page' }).click();
        await p.getByRole('textbox', { name: 'Find a page' }).fill('Scrat');
        await p.getByRole('option', { name: /Scratch/ }).click();
        await d.getByRole('button', { name: 'Parent page' }).getByText('Scratch').waitFor();
        await d.getByRole('button', { name: 'Create page' }).click();
        await d.waitFor({ state: 'detached' });
        await p.getByRole('textbox', { name: 'Page title' }).waitFor();
        await p.getByRole('button', { name: 'Discard' }).click();
        await p.getByRole('dialog', { name: 'Discard draft' }).getByRole('button', { name: 'Discard draft' }).click();
        await row('Roadmap').waitFor();
      });

      await s.step('tree: Collapse hides the children and shows their count, Expand brings them back', async () => {
        await openPage('Handbook');
        await row('Handbook').getByRole('button', { name: 'Collapse' }).click();
        await row('Install guide').waitFor({ state: 'detached' });
        await row('Handbook').getByRole('button', { name: 'Expand' }).waitFor();
        await row('Handbook').getByRole('button', { name: 'Expand' }).click();
        await row('Install guide').waitFor();
        await expandAll();
      });

      await s.step('tree filter: no match offers "Clear filter", the x button clears too', async () => {
        const f = p.getByRole('textbox', { name: 'Filter pages' });
        await f.fill('zzzz');
        await p.getByText('No pages match “zzzz”').waitFor();
        await p.getByRole('button', { name: 'Clear filter' }).last().click();
        await row('Handbook').waitFor();
        await f.fill('Hand');
        await row('Install guide').waitFor({ state: 'detached' });
        await p.getByRole('button', { name: 'Clear filter' }).click();
        await row('Install guide').waitFor();
        if ((await f.inputValue()) !== '') throw new Error('the filter should be empty');
      });

      await s.step('resize the page tree with the keys, by dragging, and reset it by a double click', async () => {
        const handle = p.getByRole('separator', { name: 'Resize page tree' });
        const width = async () => Number(await handle.getAttribute('aria-valuenow'));
        const w0 = await width();
        await handle.focus();
        await p.keyboard.press('ArrowRight');
        await p.keyboard.press('ArrowRight');
        if ((await width()) !== w0 + 32) throw new Error(`two arrow keys should widen by 32, ${w0} -> ${await width()}`);
        const b = await handle.boundingBox();
        await p.mouse.move(b.x + b.width / 2, b.y + 200);
        await p.mouse.down();
        await p.mouse.move(b.x + b.width / 2 + 60, b.y + 200, { steps: 6 });
        await p.mouse.up();
        if ((await width()) <= w0 + 32) throw new Error('dragging right should widen the tree');
        await handle.dblclick();
        if ((await width()) !== 272) throw new Error('a double click should reset the width to 272');
      });

      await s.step('page info: who, version, words and links', async () => {
        await openPage('Handbook');
        await p.getByTestId('page-info').click();
        const d = p.getByRole('dialog', { name: 'Page info' });
        for (const label of ['Created by', 'Last edited', 'Version', 'Words', 'Linked tickets', 'Inbound links']) await d.getByText(label, { exact: true }).waitFor();
        await d.getByText('v1').waitFor();
        await d.getByText(/about 1 min read/).waitFor();
        await d.getByText('1 page, 0 tickets').waitFor();
        await d.getByRole('button', { name: 'Referenced by' }).click();
        await d.waitFor({ state: 'detached' });
        await p.getByRole('region', { name: 'Referenced by' }).getByText('Release notes').first().waitFor();
      });

      await s.step('Share: the link is copied, then the page-id link and the reference', async () => {
        await p.getByTestId('share').click();
        const d = p.getByRole('dialog', { name: 'Share page' });
        await d.getByRole('button', { name: 'Copied' }).waitFor();
        if (!/\?docs=handbook&proj=/.test(await clip())) throw new Error(`the link should be the slug link: ${await clip()}`);
        await d.getByText('Anyone with project access can view').waitFor();
        await d.getByTestId('share-id-link').click();
        await d.getByText('Copied the link by page id').waitFor();
        if (!/\?docs=[0-9a-f-]{36}$/.test(await clip())) throw new Error(`the id link: ${await clip()}`);
        await d.getByRole('button', { name: 'Copy reference' }).click();
        if ((await clip()) !== '[[Handbook]]') throw new Error(`the reference: ${await clip()}`);
        await p.keyboard.press('Escape');
        await d.waitFor({ state: 'detached' });
      });

      await s.step('page menu: Copy as Markdown puts the page on the clipboard', async () => {
        await p.getByRole('button', { name: 'Page actions', exact: true }).click();
        await p.getByRole('menuitem', { name: /Copy as Markdown/ }).click();
        await toast('Markdown copied');
        if (!(await clip()).startsWith('# Handbook')) throw new Error('the clipboard should hold the page as Markdown');
      });

      await s.step('Duplicate with the child pages: the dialog lists what will be created', async () => {
        await (await menuOf('Handbook')).getByRole('menuitem', { name: /Duplicate/ }).click();
        const d = p.getByRole('dialog', { name: 'Duplicate “Handbook”' });
        await d.getByRole('textbox', { name: 'Title' }).and(p.locator('[value="Handbook (copy)"]')).waitFor();
        await d.getByText('1 child page').waitFor();
        const sw = d.getByRole('switch', { name: 'Include child pages' });
        await sw.click();
        const list = d.getByRole('list', { name: 'Pages that will be created' });
        await list.getByText('Install guide', { exact: true }).waitFor();
        await d.getByRole('button', { name: 'Duplicate', exact: true }).click();
        await d.waitFor({ state: 'detached' });
        await toast('Duplicated “Handbook”');
        await p.getByRole('heading', { name: 'Handbook (copy)', level: 1 }).waitFor();
        await expandAll();
        await row('Handbook \\(copy\\)').waitFor();
        if ((await tree().getByRole('treeitem', { name: /^Install guide/ }).count()) < 2) throw new Error('the copy should have its own Install guide');
      });

      await s.step('Move to: find a page, see the new place, confirm, then undo', async () => {
        await (await menuOf('Roadmap')).getByRole('menuitem', { name: /Move to/ }).click();
        const d = p.getByRole('dialog', { name: 'Move “Roadmap”' });
        await d.getByText('Currently under Scratch').waitFor();
        await d.getByRole('textbox', { name: 'Find a page' }).fill('Release');
        await d.getByRole('option', { name: /Release notes/ }).click();
        await d.getByText(/Will be placed/).getByText('Release notes').waitFor();
        await d.getByTestId('confirm-move').click();
        await d.waitFor({ state: 'detached' });
        await toast('Moved “Roadmap” under Release notes');
        await row('Release notes').getByRole('button', { name: 'Collapse' }).waitFor();
        await p.getByRole('button', { name: 'Undo' }).click();
        await toast('Moved “Roadmap” back');
        await row('Scratch').getByRole('button', { name: 'Collapse' }).waitFor();
      });

      await s.step('Move to: a gap between pages ("Place here") picks the position', async () => {
        await (await menuOf('Runbook')).getByRole('menuitem', { name: /Move to/ }).click();
        const d = p.getByRole('dialog', { name: 'Move “Runbook”' });
        await d.getByText('Currently at the top level').waitFor();
        await d.getByText('Choose where to move this page.').waitFor();
        await d.getByRole('separator', { name: 'Place here' }).nth(2).click({ force: true });
        await d.getByText(/Will be placed/).waitFor();
        await d.getByTestId('confirm-move').click();
        await d.waitFor({ state: 'detached' });
        await toast('Moved “Runbook”');
      });

      await s.step('drag a page in the tree: the line shows where it lands, a spinner while it is saved', async () => {
        const order0 = await rowTitles();
        // the answer of the move is slow enough to see "Saving move"
        await p.route(/\/docs\/pages\/[^/]+\/move$/, async (r) => { await new Promise((res) => setTimeout(res, 900)); await r.continue().catch(() => {}); });
        const from = await row('Scratch').boundingBox();
        const top = await row('Handbook').boundingBox();
        await p.mouse.move(from.x + 60, from.y + from.height / 2);
        await p.mouse.down();
        await p.mouse.move(from.x + 70, from.y + from.height / 2 - 12, { steps: 4 });
        await p.mouse.move(top.x + 70, top.y + top.height * 0.1, { steps: 10 });
        await p.getByTestId('drop-line').waitFor({ state: 'attached' });
        await p.mouse.up();
        await p.getByRole('status', { name: 'Saving move' }).waitFor();
        await p.getByRole('status', { name: 'Saving move' }).waitFor({ state: 'detached' });
        await p.unroute(/\/docs\/pages\/[^/]+\/move$/);
        const order1 = await rowTitles();
        if (order1.join() === order0.join()) throw new Error(`the page should have moved: ${order1}`);
        if (!/^Scratch/.test(order1[0])) throw new Error(`Scratch should be the first page now: ${order1}`);
      });

      await s.step('drag a page onto another: it nests under it', async () => {
        const from = await row('Runbook').boundingBox();
        const to = await row('Release notes').boundingBox();
        await p.mouse.move(from.x + 60, from.y + from.height / 2);
        await p.mouse.down();
        await p.mouse.move(from.x + 70, from.y + from.height / 2 + 12, { steps: 4 });
        await p.mouse.move(to.x + 70, to.y + to.height / 2, { steps: 10 });
        await p.getByText('Nest under').waitFor();
        await p.mouse.up();
        await row('Release notes').getByRole('button', { name: 'Collapse' }).waitFor();
        await tree().getByRole('treeitem', { name: /^Runbook/ }).and(p.locator('[aria-level="2"]')).waitFor();
      });

      await s.step('Rename (F2) a page others link to: the dialog offers to update the links', async () => {
        await openPage('Handbook');
        await p.keyboard.press('F2');
        const input = tree().getByRole('textbox', { name: 'Page title' });
        await input.fill('Team handbook');
        await input.press('Enter');
        const d = p.getByRole('dialog', { name: 'Rename page' });
        // links point at the page, not at its title: they follow by themselves (no "Rename only" choice any more)
        await d.getByText('Links follow by themselves').waitFor();
        await d.getByText(/1 link · 1 page/).waitFor();
        await d.getByTestId('confirm-rename').click();
        await d.waitFor({ state: 'detached' });
        await toast('Renamed to “Team handbook”');
        await row('Team handbook').waitFor();
        await p.getByRole('heading', { name: 'Team handbook', level: 1 }).waitFor();
      });

      await s.step('the page that linked it now says Team handbook (a new version)', async () => {
        await openPage('Release notes');
        await p.getByText('Published · v2').waitFor();
        await p.getByRole('link', { name: 'Team handbook' }).or(p.getByText('Team handbook', { exact: true })).first().waitFor();
      });

      await s.step('Rename from the row menu: the Rename page dialog, and the links follow the page', async () => {
        // the row menu opens the dialog (F2 on a row renames inline); a link to the page keeps working under the new
        // title, and the dialog says so before the rename
        await (await menuOf('Release notes')).getByRole('menuitem', { name: /^Rename/ }).click();
        const d = p.getByRole('dialog', { name: 'Rename page' });
        await d.getByLabel('New title').fill('Releases');
        await d.getByText(/link/).first().waitFor();
        await d.getByTestId('confirm-rename').click();
        await d.waitFor({ state: 'detached' });
        await toast('Renamed to “Releases”');
        await row('Releases').waitFor();
      });

      await s.step('Rename a page nobody links to: no dialog, a toast with Undo', async () => {
        await openPage('Roadmap');
        await p.keyboard.press('F2');
        const input = tree().getByRole('textbox', { name: 'Page title' });
        await input.fill('Product roadmap');
        await input.press('Enter');
        await toast('Renamed to “Product roadmap”');
        await row('Product roadmap').waitFor();
        await p.getByRole('dialog', { name: 'Rename page' }).waitFor({ state: 'detached' });
      });

      await s.step('Discard a draft: Keep editing leaves it, Discard draft throws it away', async () => {
        await openPage('Releases');
        await p.getByTestId('edit-page').click();
        await p.getByRole('textbox', { name: 'Page title' }).waitFor();
        await setMarkdown(s, '# Release notes\n\nA change nobody wants.\n');
        await p.getByTestId('discard').click();
        const d = p.getByRole('dialog', { name: 'Discard draft' });
        await d.getByText('Discard your changes?').waitFor();
        await d.getByRole('button', { name: 'Keep editing' }).click();
        await d.waitFor({ state: 'detached' });
        await p.getByRole('textbox', { name: 'Page title' }).waitFor();
        await p.getByTestId('discard').click();
        await d.getByTestId('confirm-discard').click();
        await d.waitFor({ state: 'detached' });
        await p.getByTestId('edit-page').and(p.getByText('Edit', { exact: true })).waitFor();
        await p.getByText('A change nobody wants.').waitFor({ state: 'detached' });
      });

      await s.step('Publish dialog: Go to marker, Review changes, Notify members off', async () => {
        await openPage('Team handbook');
        await p.getByTestId('edit-page').click();
        await p.getByRole('textbox', { name: 'Page title' }).waitFor();
        await setMarkdown(s, '# Handbook\n\nWelcome to the handbook.\n\nOwner: [Needs input: who owns this page]\n');
        await p.getByTestId('publish').click();
        const d = p.getByRole('dialog', { name: 'Publish page' });
        await d.getByTestId('markers-warning').getByText(/1 Needs input marker is still in this draft/).waitFor();
        await d.getByRole('button', { name: 'Go to marker' }).click();
        await d.waitFor({ state: 'detached' });
        await p.getByTestId('publish').click();
        await d.getByRole('button', { name: 'Review changes' }).click();
        await toast('Open Page history to compare your draft with the published version.');
        await d.waitFor({ state: 'detached' });
        await p.getByTestId('publish').click();
        const notify = d.getByRole('switch', { name: 'Notify members' });
        await notify.waitFor();
        await notify.click();
        await d.getByRole('switch', { name: 'Notify members', checked: false }).waitFor();
        await d.getByRole('button', { name: 'Publish anyway' }).click();
        await d.waitFor({ state: 'detached' });
        await p.getByText('Published · v2').waitFor();
      });

      await s.step('the Docs follow switch turns on and off', async () => {
        const sw = p.getByRole('switch', { name: /(Follow|Following) this space/ });
        const was = (await sw.getAttribute('aria-checked')) === 'true';
        await sw.click();
        await p.getByRole('switch', { name: was ? 'Follow this space' : 'Following this space' }).waitFor();
        await p.getByRole('switch', { name: was ? 'Follow this space' : 'Following this space' }).click();
        await p.getByRole('switch', { name: was ? 'Following this space' : 'Follow this space' }).waitFor();
      });

      await s.step('collapse the tree to the rail: search, new page, a page, and the folder flyout', async () => {
        await p.getByRole('button', { name: 'Collapse page tree' }).click();
        const rail = p.getByRole('complementary', { name: 'Docs space (collapsed)' });
        await rail.waitFor();
        await rail.getByRole('button', { name: 'New page' }).click();
        await p.getByRole('dialog', { name: 'New page' }).waitFor();
        await p.keyboard.press('Escape');
        await p.getByRole('dialog', { name: 'New page' }).waitFor({ state: 'detached' });
        await rail.getByRole('button', { name: 'Search pages' }).click();
        await p.getByRole('dialog').getByRole('combobox').or(p.getByRole('dialog').getByRole('textbox')).first().waitFor();
        await p.keyboard.press('Escape');
        await rail.getByRole('button', { name: 'Releases' }).hover();
        await p.getByRole('menu', { name: 'Releases' }).getByRole('menuitem', { name: /Add child page/ }).waitFor();
        await rail.getByRole('button', { name: 'Handbook (copy)' }).click();
        await p.getByRole('heading', { name: 'Handbook (copy)', level: 1 }).waitFor();
        await rail.getByRole('button', { name: 'Expand page tree' }).click();
        await p.getByRole('complementary', { name: 'Docs space' }).waitFor();
        await row('Handbook \\(copy\\)').waitFor();
      });

      // From here on a deleted page must not be asked for again: neither the open page's own queries right after its
      // delete (they used to answer 410 six times) nor later (its id stayed stored and was fetched again: 404).
      const askedGone = [];
      const onGone = (r) => { if (/\/docs\/pages\//.test(r.url()) && [404, 410].includes(r.status())) askedGone.push(`${r.status()} ${new URL(r.url()).pathname}`); };
      p.on('response', onGone);
      await s.step('Delete the copy and its child: the dialog counts both pages', async () => {
        await (await menuOf('Handbook (copy)')).getByRole('menuitem', { name: 'Delete page' }).click();
        const d = p.getByRole('dialog', { name: 'Delete page' });
        await d.getByText('this page', { exact: true }).waitFor();
        await d.getByText('child page', { exact: true }).waitFor();
        await d.getByRole('button', { name: 'Delete 2 pages' }).click();
        await d.waitFor({ state: 'detached' });
        await toast('Moved “Handbook (copy)” to the Recycle Bin');
        await row('Handbook \\(copy\\)').waitFor({ state: 'detached' });
      });

      await s.step('Delete from the menu: Scratch and its page go to the bin', async () => {
        await (await menuOf('Scratch')).getByRole('menuitem', { name: 'Delete page' }).click();
        const d = p.getByRole('dialog', { name: 'Delete page' });
        await d.getByRole('button', { name: /^Delete (page|\d+ pages)/ }).click();
        await d.waitFor({ state: 'detached' });
        await toast('Moved “Scratch” to the Recycle Bin');
        await row('Scratch').waitFor({ state: 'detached' });
      });

      await s.step('Recycle Bin: Cancel the "Delete forever" question, then delete forever', async () => {
        await p.getByTestId('tree-recycle-bin').click(); // the Docs tree's own bin, not the app sidebar's
        const bin = p.getByRole('dialog', { name: 'Recycle Bin' });
        const scratch = bin.getByTestId('bin-row-page').filter({ hasText: 'Scratch' });
        // the question is a dialog of its own, over the bin: it names the page and says it cannot be undone
        const ask = p.getByRole('dialog', { name: 'Delete forever' });
        await scratch.getByRole('button', { name: 'Delete forever' }).click();
        await ask.getByText('Delete “Scratch” forever?').waitFor();
        await ask.getByText(/This can’t be undone\./).waitFor();
        await ask.getByRole('button', { name: 'Cancel' }).click();
        await ask.waitFor({ state: 'detached' });
        await scratch.getByRole('button', { name: 'Delete forever' }).click();
        await ask.getByTestId('purge-confirm').click();
        await toast('Deleted “Scratch” forever');
        await scratch.waitFor({ state: 'detached' });
      });

      await s.step('Recycle Bin: "Empty bin" removes what is left', async () => {
        const bin = p.getByRole('dialog', { name: 'Recycle Bin' });
        await bin.getByTestId('bin-row-page').filter({ hasText: 'Handbook (copy)' }).waitFor();
        await bin.getByRole('button', { name: 'Empty bin' }).click();
        await p.getByRole('dialog', { name: 'Empty the Recycle Bin' }).getByTestId('empty-bin-confirm').click();
        await toast('Recycle Bin emptied');
        await bin.getByText('No deleted pages.').or(bin.getByText('The Recycle Bin is empty.')).waitFor();
        await p.keyboard.press('Escape');
        await bin.waitFor({ state: 'detached' });
        p.off('response', onGone);
        if (askedGone.length) throw new Error(`deleted pages were asked for again: ${askedGone.join(', ')}`);
        await openPage('Team handbook');
      });

      await s.step('ticket: "Link a doc" finds a page and lists it under Linked manually', async () => {
        await p.getByRole('button', { name: 'Board', exact: true }).click();
        const d = await openTicket(s, 'ALP-1');
        await d.getByTestId('ticket-docs').getByText('Releases').first().waitFor();
        await d.getByRole('button', { name: 'Link a doc' }).click();
        const pop = d.getByRole('dialog', { name: 'Link a doc' });
        await pop.getByRole('textbox', { name: 'Search pages and sections' }).fill('Team');
        await pop.getByText('Team handbook').first().waitFor();
        await p.keyboard.press('Enter');
        await pop.waitFor({ state: 'detached' });
        await d.getByTestId('ticket-doc-manual').getByText('Team handbook').waitFor();
        await d.getByText('Linked manually').waitFor();
      });

      await s.step('ticket: "Remove link" unlinks the page again', async () => {
        const d = p.getByRole('dialog', { name: 'Ticket ALP-1' });
        const manual = d.getByTestId('ticket-doc-manual');
        await manual.hover();
        await manual.getByRole('button', { name: 'Remove link' }).click();
        await manual.waitFor({ state: 'detached' });
        await d.getByTestId('ticket-docs').getByText('Releases').first().waitFor();
        await closeTicket(s);
      });

      await s.step('Give to an AI team: a project without a team says so', async () => {
        await openDocs(s);
        await (await menuOf('Team handbook')).getByRole('menuitem', { name: /Give to an AI team/ }).click();
        const d = p.getByRole('dialog', { name: 'Give the page to an AI team' });
        await d.getByText('This project has no AI team yet.').waitFor();
        await d.getByRole('button', { name: 'Give the page' }).and(p.locator(':disabled')).waitFor();
        await d.getByRole('button', { name: 'Cancel' }).click();
        await d.waitFor({ state: 'detached' });
      });

      await s.step('add an AI team to the project', async () => {
        s.server.signIn();
        s.server.fake({ FAKE_CLAUDE_MODE: 'v2_ask' }); // the run waits for an answer, so the page shows the work
        await openMembers(s);
        await p.getByTestId('members-tab-ai').click();
        await p.getByRole('button', { name: /Add AI team/ }).first().click();
        const d = p.getByRole('dialog', { name: 'Add AI team' });
        await d.getByTestId('team-name').fill('Docs helper');
        await d.getByTestId('team-working-dir').fill(s.server.dirs.repo);
        await d.getByTestId('add-team-submit').click();
        await p.getByRole('button', { name: 'Pause', exact: true }).waitFor();
        await p.getByRole('button', { name: 'Close' }).first().click().catch(() => {});
      });

      await s.step('Give the page to the team to write it: a ticket is made and the page shows the work', async () => {
        await p.goto(s.server.base);
        await p.getByRole('button', { name: /^Alpha ALP/ }).click();
        await openDocs(s);
        await openPage('Team handbook');
        await (await menuOf('Team handbook')).getByRole('menuitem', { name: /Give to an AI team/ }).click();
        const d = p.getByRole('dialog', { name: 'Give the page to an AI team' });
        await d.getByRole('radio', { name: 'Docs helper' }).and(p.locator(':checked')).waitFor();
        await d.getByRole('radio', { name: /Review it/ }).and(p.locator(':checked')).waitFor();
        await d.getByRole('radio', { name: /Write it/ }).click();
        await d.getByRole('textbox').fill('Add a section on onboarding');
        await d.getByRole('button', { name: 'Give the page' }).click();
        await d.waitFor({ state: 'detached' });
        await toast('Docs helper has the page');
        await toast('ALP-2 is linked to it');
        await p.getByTestId('docs-page-work').getByText(/ALP-2/).first().waitFor();
      });

      await s.step('slow connection: the tree and the page show their loading states', async () => {
        const slow = async (r) => { await new Promise((res) => setTimeout(res, 1500)); await r.continue().catch(() => {}); };
        await p.route(/\/projects\/[^/]+\/docs\/tree$/, slow);
        await p.route(/\/docs\/pages\/[0-9a-f-]{36}$/, slow);
        await p.goto(s.server.base);
        await p.getByRole('button', { name: /^Alpha ALP/ }).click();
        await p.getByRole('button', { name: 'Docs', exact: true }).click();
        await p.getByLabel('Loading pages').waitFor();
        await p.getByLabel('Loading page', { exact: true }).first().waitFor();
        await p.getByRole('heading', { name: 'Team handbook', level: 1 }).waitFor();
        await p.unroute(/\/projects\/[^/]+\/docs\/tree$/);
        await p.unroute(/\/docs\/pages\/[0-9a-f-]{36}$/);
      });

      await s.step('someone outside the project sees "no access" and asks the admins', async () => {
        await p.evaluate(() => localStorage.setItem('kanbanActor', 'Stranger'));
        await p.goto(s.server.base);
        await p.getByRole('button', { name: /^Alpha ALP/ }).click();
        await p.getByRole('button', { name: 'Docs', exact: true }).click();
        await p.getByText(/don.t have access to Docs/).first().waitFor();
        await p.getByPlaceholder('I need to read the API docs').fill('Please let me read the handbook');
        await p.getByRole('button', { name: 'Request access' }).click();
        await p.getByText(/Request sent\./).waitFor();
      }, { expectConsole: true }); // the tree, the bin and the page answer 403 to someone who is not a member

      await s.step('back as the board user, Docs opens again', async () => {
        await p.evaluate(() => localStorage.removeItem('kanbanActor'));
        await p.goto(s.server.base);
        await p.getByRole('button', { name: /^Alpha ALP/ }).click();
        await openDocs(s);
        await row('Team handbook').waitFor();
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  },
};
