import { openBoard } from '../lib/ui.mjs';

export default {
  name: 'First start: empty board, create projects',
  async run(s) {
    const p = s.page;
    await s.step('open the app on an empty database', async () => {
      await openBoard(s);
      await p.getByRole('heading', { name: 'Create your first project' }).waitFor();
    });
    await s.step('prefix validation keeps the button disabled', async () => {
      await p.getByLabel('Project name').fill('Alpha');
      await p.getByLabel('Prefix', { exact: true }).fill('a1');
      await p.getByText('Prefix: 2 to 5 letters').waitFor();
      if (!(await p.getByRole('button', { name: 'Create project' }).isDisabled())) throw new Error('create button should be disabled for prefix "A1"');
    });
    await s.step('create the first project', async () => {
      await p.getByLabel('Prefix', { exact: true }).fill('alp');
      await p.getByRole('button', { name: 'Create project' }).click();
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
      await p.getByText('No tickets').first().waitFor();
    });
    await s.step('empty board shows six columns', async () => {
      for (const c of ['Backlog', 'To Do', 'In Progress', 'Review', 'Testing', 'Done']) await p.getByText(c, { exact: true }).first().waitFor();
    });
    await s.step('create a second project with name, prefix and colour', async () => {
      await p.getByRole('button', { name: 'New Project' }).click();
      await p.getByPlaceholder('Project name').fill('Beta Project');
      await p.getByPlaceholder('Prefix (e.g. PROJ)').fill('bet');
      await p.getByRole('button', { name: /^Color / }).nth(2).click();
      await p.getByRole('button', { name: 'Create', exact: true }).click();
      await p.getByRole('button', { name: 'Beta Project BET' }).waitFor();
    });
    await s.step('both projects are in the switcher; open the second', async () => {
      await p.getByRole('button', { name: 'Alpha ALP' }).waitFor();
      await p.getByRole('button', { name: 'Beta Project BET' }).click();
      await p.getByRole('heading', { name: 'Beta Project', level: 1 }).waitFor();
    });
    await s.step('switch back to the first project', async () => {
      await p.getByRole('button', { name: 'Alpha ALP' }).click();
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
    });
    await s.step('duplicate prefix is refused', async () => {
      await p.getByRole('button', { name: 'New Project' }).click();
      await p.getByPlaceholder('Project name').fill('Gamma');
      await p.getByPlaceholder('Prefix (e.g. PROJ)').fill('ALP');
      await p.getByRole('button', { name: 'Create', exact: true }).click();
      await p.getByText('A project with this prefix already exists.').waitFor();
      await p.getByRole('button', { name: 'Cancel' }).click();
    });
    await s.step('reload keeps the projects', async () => {
      await p.reload();
      await p.getByRole('button', { name: 'Beta Project BET' }).waitFor({ timeout: 15000 });
    });
  },
};
