import { ensureProject, createTicket, openTicket, closeTicket, addMember } from '../lib/ui.mjs';

export default {
  name: 'Ticket items: criteria, sub-tasks, test cases, work log, links, activity',
  async run(s) {
    const p = s.page;
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    const back = async (key) => {
      await dlg().getByRole('button', { name: key, exact: true }).click();
      await dlg().getByRole('heading', { level: 2 }).waitFor();
    };

    await s.step('set up: project, member, three tickets', async () => {
      await ensureProject(s);
      await addMember(s, 'Ada Lovelace');
      await createTicket(s, { title: 'Release checklist' });
      await createTicket(s, { title: 'Blocking work' });
      await createTicket(s, { title: 'Related work' });
      await openTicket(s, 'ALP-1');
    });

    // ---- acceptance criteria
    await s.step('add three acceptance criteria', async () => {
      await dlg().getByRole('button', { name: 'Add criterion' }).click();
      for (const t of ['Notes written', 'Version tagged', 'Docs updated']) {
        await p.getByPlaceholder('New criterion…').fill(t);
        await p.keyboard.press('Enter');
        await dlg().getByText(t, { exact: true }).waitFor();
      }
      await p.keyboard.press('Escape');
    });
    await s.step('edit a criterion', async () => {
      await dlg().getByRole('button', { name: 'Edit criterion' }).nth(1).click({ force: true });
      const input = dlg().locator('input[class*="inputField"]');
      await input.fill('Version tagged v2');
      await input.press('Enter');
      await dlg().getByText('Version tagged v2', { exact: true }).waitFor();
      await dlg().getByText('Version tagged', { exact: true }).waitFor({ state: 'detached' });
    });
    await s.step('cancel an edit and tick a criterion', async () => {
      await dlg().getByRole('button', { name: 'Edit criterion' }).first().click({ force: true });
      await dlg().getByRole('button', { name: 'Cancel edit' }).click();
      await dlg().getByText('Notes written', { exact: true }).waitFor();
      await dlg().getByRole('button', { name: 'Mark complete' }).first().click();
      await dlg().getByRole('button', { name: 'Mark incomplete' }).waitFor();
    });
    await s.step('delete a criterion', async () => {
      // an edit re-adds the criterion at the end of the list (the old server deletes and creates it), so 'Docs updated' is second
      await dlg().getByRole('button', { name: 'Delete criterion' }).nth(1).click({ force: true });
      await dlg().getByText('Docs updated', { exact: true }).waitFor({ state: 'detached' });
      await dlg().getByText('Version tagged v2', { exact: true }).waitFor();
    });

    // ---- sub-tasks
    await s.step('add sub-tasks, tick one, delete one', async () => {
      await dlg().getByRole('button', { name: 'Add sub-task' }).click();
      for (const t of ['Write changelog', 'Bump version']) {
        await p.getByPlaceholder('New sub-task…').fill(t);
        await p.keyboard.press('Enter');
        await dlg().getByText(t, { exact: true }).waitFor();
      }
      await p.keyboard.press('Escape');
      await dlg().getByRole('button', { name: 'Mark complete' }).last().click();
      await dlg().getByRole('button', { name: 'Mark incomplete' }).nth(1).waitFor();
      await dlg().getByRole('button', { name: 'Delete sub-task' }).first().click({ force: true });
      await dlg().getByText('Write changelog', { exact: true }).waitFor({ state: 'detached' });
      await dlg().getByText('Bump version', { exact: true }).waitFor();
    });

    // ---- test cases
    await s.step('add test cases', async () => {
      await dlg().getByRole('button', { name: 'Test Cases' }).click();
      await dlg().getByRole('button', { name: 'Add test case' }).click();
      for (const t of ['Builds on a clean machine', 'Upgrade keeps data']) {
        await p.getByPlaceholder('Test case title…').fill(t);
        await p.getByRole('button', { name: 'Add', exact: true }).click();
        await dlg().getByText(t, { exact: true }).waitFor();
      }
    });
    await s.step('cycle a test case status', async () => {
      const first = dlg().getByRole('button', { name: /^Status: / }).first();
      const seen = [];
      for (let i = 0; i < 4; i++) {
        const before = await first.getAttribute('aria-label');
        seen.push(before);
        await first.click();
        await dlg().getByRole('button', { name: /^Status: / }).first().and(p.locator(`:not([aria-label="${before}"])`)).waitFor();
      }
      s.note('status cycle', seen);
      // the cycle comes back to where it began
      await dlg().getByRole('button', { name: seen[0] }).first().waitFor();
    });
    await s.step('set a test case to pass and another to fail', async () => {
      const btn = (i) => dlg().getByRole('button', { name: /^Status: / }).nth(i);
      for (const [i, want] of [[0, 'pass'], [1, 'fail']]) {
        for (let k = 0; k < 4 && !(await btn(i).getAttribute('aria-label')).includes(want); k++) await btn(i).click();
        await dlg().getByRole('button', { name: new RegExp(`^Status: ${want}`) }).first().waitFor();
      }
      await dlg().getByRole('button', { name: /^Status: pass/ }).waitFor();
      await dlg().getByRole('button', { name: /^Status: fail/ }).waitFor();
    });
    await s.step('expand a test case and delete it', async () => {
      await dlg().getByRole('button', { name: 'Expand details' }).first().click();
      await dlg().getByText('Expected result').first().waitFor();
      await dlg().getByRole('button', { name: 'Collapse details' }).first().click();
      await dlg().getByRole('button', { name: 'Delete test case' }).last().click();
      await dlg().getByText('Upgrade keeps data', { exact: true }).waitFor({ state: 'detached' });
      await dlg().getByText('Builds on a clean machine', { exact: true }).waitFor();
    });

    // ---- work log (Debug Space)
    await s.step('log work entries of several kinds', async () => {
      await dlg().getByRole('button', { name: 'Debug Space' }).click();
      const entries = [['Root cause', 'The cache key ignores the locale'], ['Fix attempt', 'Tried adding the locale to the key'], ['Blocked', 'Waiting for the staging data'], ['Resolved', 'Key fixed in the cache layer']];
      for (const [kind, note] of entries) {
        await dlg().getByRole('button', { name: 'Log entry' }).first().click();
        await p.getByRole('button', { name: kind, exact: true }).last().click();
        await p.getByLabel('Author').fill('Ada Lovelace');
        await p.getByLabel('Note').fill(note);
        await p.getByRole('button', { name: 'Log entry' }).last().click();
        await dlg().getByText(note).waitFor();
      }
    });
    await s.step('filter the work log by kind', async () => {
      await dlg().getByRole('button', { name: /^Blocked \(1\)/ }).click();
      await dlg().getByText('Waiting for the staging data').waitFor();
      await dlg().getByText('The cache key ignores the locale').waitFor({ state: 'detached' });
      await dlg().getByRole('button', { name: /^All/ }).click();
      await dlg().getByText('The cache key ignores the locale').waitFor();
    });
    await s.step('edit a work-log entry', async () => {
      const entry = dlg().locator('[class*="entry"]').filter({ hasText: 'Waiting for the staging data' }).last();
      await entry.hover();
      await entry.getByRole('button', { name: 'Edit entry' }).click({ force: true });
      await p.getByLabel('Note').fill('Waiting for the staging data (ETA Friday)');
      await p.getByRole('button', { name: 'Save changes' }).click();
      await dlg().getByText('Waiting for the staging data (ETA Friday)').waitFor();
    });
    await s.step('delete a work-log entry', async () => {
      const entry = dlg().locator('[class*="entry"]').filter({ hasText: 'Tried adding the locale to the key' }).last();
      await entry.hover();
      await entry.getByRole('button', { name: 'Delete entry' }).click({ force: true });
      const c = p.getByRole('dialog', { name: 'Confirm delete' });
      await c.getByText('Delete this entry?').waitFor();
      await c.getByRole('button', { name: /^Delete/ }).click();
      await dlg().getByText('Tried adding the locale to the key').waitFor({ state: 'detached' });
    });
    await s.step('back to the ticket', async () => { await back('ALP-1'); });

    // ---- links
    await s.step('add a Blocks link and a Blocked by link', async () => {
      await dlg().getByRole('button', { name: 'Add link' }).click();
      await dlg().locator('select[class*="typeSelect"]').selectOption({ label: 'Blocked by' });
      await p.getByPlaceholder('Search tickets to link…').fill('Blocking');
      await dlg().getByRole('button', { name: /Blocking work/ }).click();
      await dlg().getByText('Blocking work').first().waitFor();
      await dlg().getByRole('button', { name: 'Add link' }).click();
      await dlg().locator('select[class*="typeSelect"]').selectOption({ label: 'Relates to' });
      await p.getByPlaceholder('Search tickets to link…').fill('Related');
      await dlg().getByRole('button', { name: /Related work/ }).click();
      await dlg().getByText('Related work').first().waitFor();
    });
    await s.step('remove the blocked-by and the link', async () => {
      await dlg().getByRole('button', { name: 'Remove relation' }).first().click({ force: true });
      await dlg().getByRole('button', { name: 'Remove relation' }).first().click({ force: true });
      await dlg().getByText('No links').waitFor();
    });

    // ---- activity
    await s.step('read the ticket activity', async () => {
      await dlg().getByRole('button', { name: /^Activity/ }).click();
      await dlg().getByText(/Test case|criterion|link/i).first().waitFor();
    });
    await s.step('back and close', async () => {
      await back('ALP-1');
      await closeTicket(s);
    });
  },
};
