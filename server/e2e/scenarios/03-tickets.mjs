import { dragCard, columnOf, ensureProject, createTicket, openTicket, closeTicket, addMember, card } from '../lib/ui.mjs';

export default {
  name: 'Tickets: create, edit, parts, relations, move, filter, delete',
  async run(s) {
    const p = s.page;
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });

    await s.step('set up: project and a member', async () => {
      await ensureProject(s);
      await addMember(s, 'Ada Lovelace');
    });
    await s.step('create tickets of every type', async () => {
      await createTicket(s, { title: 'Plan the release', type: 'Task', description: 'First **draft** of the plan', priority: 'High', tags: 'release, planning' });
      await createTicket(s, { title: 'Login button broken', type: 'Bug', priority: 'Critical', due: '2030-01-15' });
      await createTicket(s, { title: 'Dark mode', type: 'Feature', priority: 'Low' });
      await createTicket(s, { title: 'Tidy the repo', type: 'Chore' });
      for (const k of ['ALP-1', 'ALP-2', 'ALP-3', 'ALP-4']) await card(p, k).waitFor();
    });
    await s.step('open ticket ALP-1', async () => {
      await openTicket(s, 'ALP-1');
      await dlg().getByRole('heading', { name: 'Plan the release', level: 2 }).waitFor();
    });
    await s.step('edit the title', async () => {
      await dlg().getByRole('heading', { name: 'Plan the release', level: 2 }).click();
      const input = dlg().locator('input[class*="titleInputEdit"]');
      await input.fill('Plan the 2030 release');
      await input.press('Enter');
      await dlg().getByRole('heading', { name: 'Plan the 2030 release', level: 2 }).waitFor();
    });
    await s.step('edit the description in Markdown', async () => {
      await dlg().getByRole('button', { name: 'Edit description' }).click();
      const ed = dlg().locator('[contenteditable="true"]').first();
      await ed.click();
      await p.keyboard.press('Control+A');
      await p.keyboard.type('## Goals');
      await p.keyboard.press('Enter');
      await p.keyboard.type('- ship it');
      await p.keyboard.press('Enter');
      await p.keyboard.type('- celebrate');
      await p.keyboard.press('Enter');
      await p.keyboard.press('Enter');
      await p.keyboard.type('Visit https://example.com for **details**.');
      // leave the editor so the description is saved
      await dlg().getByRole('heading', { name: 'Plan the 2030 release' }).click();
      await s.settle(2500);
      await dlg().getByRole('heading', { name: 'Goals', level: 2 }).waitFor();
    });
    await s.step('change the priority', async () => {
      await dlg().getByRole('combobox').filter({ has: p.getByRole('option', { name: 'Critical' }) }).selectOption({ label: 'Critical' });
      await dlg().getByText('critical', { exact: true }).waitFor();
    });
    await s.step('assign to Ada', async () => {
      await dlg().getByRole('button', { name: 'Unassigned' }).click();
      await p.getByRole('menu').getByRole('button', { name: /Ada Lovelace/ }).click();
      await dlg().getByText('Ada Lovelace').first().waitFor();
    });
    await s.step('add and remove tags', async () => {
      await dlg().getByRole('button', { name: 'Add tag' }).click();
      await p.getByLabel('Tag name').fill('urgent');
      await p.keyboard.press('Enter');
      await dlg().getByText('urgent', { exact: true }).waitFor();
      await dlg().getByRole('button', { name: 'Remove tag planning' }).click();
      await dlg().getByText('planning', { exact: true }).waitFor({ state: 'detached' });
    });
    await s.step('set the due date and the estimate', async () => {
      await dlg().locator('input[type="date"]').fill('2030-06-30');
      await dlg().locator('input[type="date"]').blur();
      await dlg().getByRole('combobox').filter({ has: p.getByRole('option', { name: '5 pt' }) }).selectOption({ label: '5 pt' });
      await s.settle();
    });
    await s.step('add acceptance criteria and tick one', async () => {
      await dlg().getByRole('button', { name: 'Add criterion' }).click();
      await p.getByPlaceholder('New criterion…').fill('Release notes are written');
      await p.keyboard.press('Enter');
      await dlg().getByText('Release notes are written').waitFor();
      await p.getByPlaceholder('New criterion…').fill('Version is tagged');
      await p.keyboard.press('Enter');
      await dlg().getByText('Version is tagged').waitFor();
      await p.keyboard.press('Escape');
      await dlg().getByRole('button', { name: 'Mark complete' }).first().click();
      await dlg().getByRole('button', { name: 'Mark incomplete' }).first().waitFor();
    });
    await s.step('add sub-tasks and tick one', async () => {
      await dlg().getByRole('button', { name: 'Add sub-task' }).click();
      await p.getByPlaceholder('New sub-task…').fill('Write changelog');
      await p.keyboard.press('Enter');
      await dlg().getByText('Write changelog').waitFor();
      await p.getByPlaceholder('New sub-task…').fill('Bump version');
      await p.keyboard.press('Enter');
      await dlg().getByText('Bump version').waitFor();
      await p.keyboard.press('Escape');
      await dlg().getByRole('button', { name: 'Mark complete' }).last().click();
      await s.settle();
    });
    await s.step('add a comment', async () => {
      await dlg().getByRole('button', { name: 'Add a comment…' }).click();
      await p.getByPlaceholder('Add a comment…').fill('Looks good to me');
      await p.keyboard.press('Control+Enter');
      await dlg().getByText('Looks good to me').first().waitFor();
    });
    await s.step('log a debug-space entry (work log)', async () => {
      await dlg().getByRole('button', { name: 'Debug Space' }).click();
      await dlg().getByRole('button', { name: 'Log entry' }).click();
      await p.getByRole('button', { name: 'Investigation', exact: true }).last().click();
      await p.getByLabel('Author').fill('Ada Lovelace');
      await p.getByLabel('Note').fill('Checked the build, all green');
      await p.getByRole('button', { name: 'Log entry' }).last().click();
      await dlg().getByText('Checked the build, all green').waitFor();
    });
    await s.step('add a test case', async () => {
      await dlg().getByRole('button', { name: 'Test Cases' }).click();
      await dlg().getByRole('button', { name: 'Add test case' }).click();
      await p.getByPlaceholder('Test case title…').fill('Release builds on a clean machine');
      await p.getByRole('button', { name: 'Add', exact: true }).click();
      await dlg().getByText('Release builds on a clean machine').waitFor();
    });
    await s.step('back to the ticket', async () => {
      await dlg().getByRole('button', { name: 'ALP-1', exact: true }).click();
      await dlg().getByRole('heading', { name: 'Plan the 2030 release', level: 2 }).waitFor();
    });
    await s.step('block ALP-1 by ALP-2', async () => {
      await dlg().getByRole('button', { name: 'Add link' }).click();
      await dlg().locator('select[class*="typeSelect"]').selectOption({ label: 'Blocked by' });
      await p.getByPlaceholder('Search tickets to link…').fill('Login');
      await dlg().getByRole('button', { name: /Login button broken/ }).click();
      await dlg().getByText('Login button broken').first().waitFor();
    });
    await s.step('link ALP-1 to ALP-3 (relates to)', async () => {
      await dlg().getByRole('button', { name: 'Add link' }).click();
      await dlg().locator('select[class*="typeSelect"]').selectOption({ label: 'Relates to' });
      await p.getByPlaceholder('Search tickets to link…').fill('Dark');
      await dlg().getByRole('button', { name: /Dark mode/ }).click();
      await dlg().getByText('Dark mode').first().waitFor();
    });
    await s.step('close the ticket and see the card', async () => {
      await closeTicket(s);
      await card(p, 'ALP-1').waitFor();
    });
    await s.step('drag ALP-3 from Backlog to To Do', async () => {
      await dragCard(p, 'ALP-3', 'To Do');
      await p.waitForTimeout(600);
      const col = columnOf(p, 'To Do');
      await col.getByRole('button', { name: /ALP-3/ }).waitFor();
    });
    await s.step('drag ALP-3 on to In Progress', async () => {
      await dragCard(p, 'ALP-3', 'In Progress');
      await columnOf(p, 'In Progress').getByRole('button', { name: /ALP-3/ }).waitFor();
    });
    await s.step('moving a blocked ticket asks for confirmation', async () => {
      await dragCard(p, 'ALP-1', 'In Progress');
      await p.getByRole('alertdialog', { name: 'Blocked ticket' }).waitFor();
    });
    await s.step('cancel the blocked move', async () => {
      await p.getByRole('alertdialog', { name: 'Blocked ticket' }).getByRole('button', { name: /Cancel|Keep|Close/ }).first().click();
      await p.getByRole('alertdialog', { name: 'Blocked ticket' }).waitFor({ state: 'detached' });
    });
    await s.step('change a status from the ticket', async () => {
      await openTicket(s, 'ALP-4');
      await dlg().getByRole('button', { name: 'Backlog' }).click();
      await p.getByRole('menuitem', { name: /To Do/ }).or(p.getByRole('option', { name: /To Do/ })).or(p.getByRole('button', { name: /^To Do/ })).first().click();
      await dlg().getByRole('button', { name: 'To Do' }).first().waitFor();
      await closeTicket(s);
    });
    await s.step('search the board', async () => {
      await p.getByPlaceholder('Search tickets…').fill('dark');
      await card(p, 'ALP-3').waitFor();
      await card(p, 'ALP-1').waitFor({ state: 'hidden' });
    });
    await s.step('clear the search, filter by type Bug', async () => {
      await p.getByPlaceholder('Search tickets…').fill('');
      await p.getByRole('button', { name: /^Type:/ }).click();
      await p.getByText('Bug', { exact: true }).last().click();
      await p.keyboard.press('Escape');
      await card(p, 'ALP-2').waitFor();
      await card(p, 'ALP-3').waitFor({ state: 'hidden' });
    });
    await s.step('filter by priority Critical on top', async () => {
      await p.getByRole('button', { name: /^Type:/ }).click();
      await p.getByText('All', { exact: true }).last().click();
      await p.keyboard.press('Escape');
      await p.getByRole('button', { name: /^Priority:/ }).click();
      await p.getByText('Critical', { exact: true }).last().click();
      await p.keyboard.press('Escape');
      await card(p, 'ALP-1').waitFor();
    });
    await s.step('delete ticket ALP-4', async () => {
      await p.getByRole('button', { name: /^Priority:/ }).click();
      await p.getByText('All', { exact: true }).last().click();
      await p.keyboard.press('Escape');
      await openTicket(s, 'ALP-4');
      p.once('dialog', (d) => d.accept());
      await dlg().getByRole('button', { name: 'Delete ticket' }).click();
      await card(p, 'ALP-4').waitFor({ state: 'detached' });
    }, { expectConsole: true }); // the open ticket is fetched once more after it is gone (404)
  },
};
