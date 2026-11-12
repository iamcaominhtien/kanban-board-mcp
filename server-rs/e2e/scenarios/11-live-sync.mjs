import { ensureProject, createTicket, card, openTicket, dragCard, columnOf, openDocs, newDocPage, setMarkdown, publishDoc } from '../lib/ui.mjs';

// Two browser pages on one server: a change in A shows in B without a reload (the /events stream).
export default {
  name: 'Live sync: two pages, changes appear without reload',
  async run(s) {
    const a = s.page;
    let b;
    const boardTextOfB = async () => (await b.locator('body').innerText()).split('\n').map((l) => l.trim()).filter(Boolean);
    await s.step('page A: project with a ticket', async () => {
      await ensureProject(s);
      await createTicket(s, { title: 'Shared ticket' });
    });
    await s.step('page B opens the same board', async () => {
      b = await s.newPage();
      await b.goto(s.server.base);
      await b.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor({ timeout: 15000 });
      await card(b, 'ALP-1').waitFor();
      await b.waitForTimeout(1500);
    });
    await s.step('a new ticket made in A appears in B', async () => {
      await createTicket(s, { title: 'Made in A', type: 'Bug' });
      await card(b, 'ALP-2').waitFor({ timeout: 10000 });
      s.note('page B shows the new card', await b.getByRole('button', { name: /ALP-2 / }).first().innerText());
    });
    await s.step('moving a card in A moves it in B', async () => {
      await dragCard(a, 'ALP-2', 'In Progress');
      await columnOf(b, 'In Progress').getByRole('button', { name: /ALP-2/ }).waitFor({ timeout: 10000 });
    });
    await s.step('renaming a ticket in A updates B', async () => {
      const d = await openTicket(s, 'ALP-1');
      await d.getByRole('heading', { name: 'Shared ticket', level: 2 }).click();
      const input = d.locator('input[class*="titleInputEdit"]');
      await input.fill('Renamed in A');
      await input.press('Enter');
      await b.getByText('Renamed in A').first().waitFor({ timeout: 10000 });
      await d.getByRole('button', { name: 'Close', exact: true }).click();
    });
    await s.step('deleting a ticket in A removes it in B', async () => {
      const d = await openTicket(s, 'ALP-2');
      a.once('dialog', (x) => x.accept());
      await d.getByRole('button', { name: 'Delete ticket' }).click();
      await card(b, 'ALP-2').waitFor({ state: 'detached', timeout: 10000 });
    }, { expectConsole: true });
    await s.step('a new project made in A appears in B', async () => {
      await a.getByRole('button', { name: 'New Project' }).click();
      await a.getByPlaceholder('Project name').fill('Second');
      await a.getByPlaceholder('Prefix (e.g. PROJ)').fill('SEC');
      await a.getByRole('button', { name: 'Create', exact: true }).click();
      await b.getByRole('button', { name: 'Second SEC' }).waitFor({ timeout: 10000 });
    });
    await s.step('a page published in A shows in the Docs tree of B', async () => {
      await a.getByRole('button', { name: 'Alpha ALP' }).click();
      await b.getByRole('button', { name: 'Docs', exact: true }).click();
      await b.getByRole('complementary', { name: /^Docs space/ }).waitFor();
      await openDocs(s);
      await newDocPage(s, 'Live page');
      await setMarkdown(s, '# Live\n\nHello.\n');
      await publishDoc(s, 'live');
      await b.getByRole('tree').getByText('Live page').first().waitFor({ timeout: 10000 });
    });
    await s.step('B summary of its screen', async () => {
      s.note('page B tree', (await boardTextOfB()).filter((l) => /Live page|Docs space/.test(l)));
    });
  },
};
