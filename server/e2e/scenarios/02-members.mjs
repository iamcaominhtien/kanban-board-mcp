import { ensureProject, createTicket, openTicket, closeTicket, openMembers, closeMembers } from '../lib/ui.mjs';

export default {
  name: 'Members: add, assign, role, remove',
  async run(s) {
    const p = s.page;
    await s.step('open the board with a project and one ticket', async () => {
      await ensureProject(s);
      await createTicket(s, { title: 'Assign me' });
    });
    await s.step('open the Members panel (only the default Admin)', async () => {
      await openMembers(s);
      await p.getByText('Admin', { exact: true }).first().waitFor();
    });
    await s.step('add member Ada', async () => {
      await p.getByPlaceholder('Member name…').fill('Ada Lovelace');
      await p.getByRole('button', { name: /^Color / }).nth(1).click();
      await p.getByRole('button', { name: 'Add', exact: true }).click();
      await p.getByText('Ada Lovelace', { exact: true }).waitFor();
    });
    await s.step('add member Bob', async () => {
      await p.getByPlaceholder('Member name…').fill('Bob Builder');
      await p.getByRole('button', { name: 'Add', exact: true }).click();
      await p.getByText('Bob Builder', { exact: true }).waitFor();
    });
    await s.step('a duplicate name is refused', async () => {
      await p.getByPlaceholder('Member name…').fill('Ada Lovelace');
      await p.getByRole('button', { name: 'Add', exact: true }).click();
      await p.locator('[class*="errorText"]').waitFor();
    }, { expectConsole: true });
    await s.step('change the Docs role of Bob to Admin', async () => {
      await p.getByPlaceholder('Member name…').fill('');
      await p.getByTestId('member-role-Bob Builder').click();
      await p.getByRole('menuitem', { name: /Admin/ }).or(p.getByRole('option', { name: /Admin/ })).first().click();
      await p.getByTestId('member-role-Bob Builder').getByText('Admin').waitFor();
    });
    await s.step('close the panel', async () => {
      await closeMembers(s);
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
    });
    await s.step('assign the ticket to Ada from the ticket', async () => {
      const d = await openTicket(s, 'ALP-1');
      await d.getByRole('button', { name: 'Unassigned' }).click();
      await p.getByRole('menu').getByRole('button', { name: /Ada Lovelace/ }).click();
      await d.getByText('Ada Lovelace').first().waitFor();
      await closeTicket(s);
      await p.getByRole('button', { name: /ALP-1/ }).getByText('AL', { exact: true }).waitFor();
    });
    await s.step('removing a member who has an open ticket is refused', async () => {
      await openMembers(s);
      await p.getByRole('button', { name: 'Remove Ada Lovelace' }).click();
      await p.getByTestId('member-remove-error').waitFor();
    }, { expectConsole: true });
    await s.step('remove Bob (no tickets)', async () => {
      await p.getByRole('button', { name: 'Remove Bob Builder' }).click();
      await p.getByText('Bob Builder', { exact: true }).waitFor({ state: 'detached' });
      await closeMembers(s);
    });
    await s.step('filter the board by assignee', async () => {
      await p.getByRole('button', { name: /^Assignee:/ }).click();
      await p.getByText('Ada Lovelace').last().click();
      await p.keyboard.press('Escape');
    });
  },
};
