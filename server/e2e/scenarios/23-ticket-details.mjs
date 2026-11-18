import { ensureProject, createTicket, openTicket, closeTicket, addMember, card, columnOf } from '../lib/ui.mjs';

export default {
  name: 'Ticket details: comments, link types, edits, Debug Space, fullscreen, estimate, Review by, restore, undo reopen, tags, bin',
  async run(s) {
    const p = s.page;
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    const back = async (key) => {
      await dlg().getByRole('button', { name: key, exact: true }).click();
      await dlg().getByRole('heading', { level: 2 }).waitFor();
    };
    const setStatus = async (from, to) => {
      await dlg().getByRole('complementary').getByRole('button', { name: from, exact: true }).click();
      await p.getByRole('listbox').getByText(to, { exact: true }).click();
    };
    // Local helper: one call to the REST API from the page, as the UI itself does.
    const api = (method, path, body) => p.evaluate(async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, [method, path, body]);

    const LINK_TARGETS = [
      ['Blocks', 'Target blocks'],
      ['Blocked by', 'Target blocked'],
      ['Relates to', 'Target relates'],
      ['Causes', 'Target causes'],
      ['Caused by', 'Target caused'],
      ['Duplicates', 'Target duplicates'],
      ['Duplicated by', 'Target duplicated'],
    ];

    await s.step('set up: project, member, a main ticket and seven link targets', async () => {
      await ensureProject(s);
      await addMember(s, 'Ada Lovelace');
      await createTicket(s, { title: 'Main ticket' });
      for (const [, t] of LINK_TARGETS) await createTicket(s, { title: t });
      await card(p, 'ALP-8').waitFor();
      await openTicket(s, 'ALP-1');
    });

    // ---- comments
    await s.step('add a comment, then edit it', async () => {
      await dlg().getByRole('button', { name: 'Add a comment…' }).click();
      await p.getByPlaceholder('Add a comment…').fill('First draft of the comment');
      await p.keyboard.press('Control+Enter');
      const row = dlg().getByTestId('comment').filter({ hasText: 'First draft of the comment' });
      await row.waitFor();
      await row.hover();
      await row.getByTestId('comment-edit').click({ force: true });
      const box = dlg().getByRole('textbox').filter({ hasText: 'First draft of the comment' }).or(dlg().locator('textarea').filter({ hasText: 'First draft of the comment' })).first();
      await box.fill('Second draft of the comment');
      await dlg().getByRole('button', { name: 'Save', exact: true }).click();
      await dlg().getByText('Second draft of the comment').waitFor();
      await dlg().getByText('First draft of the comment').waitFor({ state: 'detached' });
      await dlg().getByTestId('comment-edited').waitFor();
    });
    await s.step('delete the comment and cancel, then delete it for real', async () => {
      const row = dlg().getByTestId('comment').filter({ hasText: 'Second draft of the comment' });
      await row.hover();
      await row.getByTestId('comment-delete').click({ force: true });
      await dlg().getByText('Delete this comment?').waitFor();
      await dlg().getByTestId('comment-delete-confirm').getByRole('button', { name: 'Cancel' }).click();
      await dlg().getByText('Delete this comment?').waitFor({ state: 'detached' });
      await row.hover();
      await row.getByTestId('comment-delete').click({ force: true });
      await dlg().getByTestId('comment-delete-confirm-yes').click();
      await dlg().getByTestId('comment-deleted-rule').waitFor();
      await dlg().getByText('Second draft of the comment').waitFor({ state: 'detached' });
    });
    await s.step('Undo restores the deleted comment', async () => {
      await dlg().getByTestId('comment-undo').click();
      await dlg().getByText('Second draft of the comment').waitFor();
      await dlg().getByTestId('comment-deleted-rule').waitFor({ state: 'detached' });
      await dlg().getByTestId('comments-count').getByText('1', { exact: true }).waitFor();
    });

    // ---- relations: every type, seen from both tickets
    await s.step('add a link of every type from the main ticket', async () => {
      for (const [type, title] of LINK_TARGETS) {
        await dlg().getByRole('button', { name: 'Add link' }).click();
        await dlg().locator('select[class*="typeSelect"]').selectOption({ label: type });
        await p.getByPlaceholder('Search tickets to link…').fill(title);
        await dlg().getByRole('button', { name: new RegExp(title) }).click();
        await dlg().locator('[class*="groupLabel"]').filter({ hasText: new RegExp(`^${type}$`) }).waitFor();
        await dlg().getByText(title, { exact: true }).waitFor();
      }
      await dlg().getByRole('button', { name: 'Remove relation' }).nth(6).waitFor();
    });
    // what each target shows back to the main ticket (the inverse of the type)
    const INVERSE = {
      Blocks: 'Blocked by',
      'Blocked by': 'Blocks',
      'Relates to': 'Relates to',
      Causes: 'Caused by',
      'Caused by': 'Causes',
      Duplicates: 'Duplicated by',
      'Duplicated by': 'Duplicates',
    };
    await s.step('each link shows as its inverse on the other ticket', async () => {
      await closeTicket(s);
      for (const [i, [type, title]] of LINK_TARGETS.entries()) {
        await openTicket(s, `ALP-${i + 2}`);
        await dlg().getByRole('heading', { name: title, level: 2 }).waitFor();
        await dlg().locator('[class*="groupLabel"]').filter({ hasText: new RegExp(`^${INVERSE[type]}$`) }).waitFor();
        await dlg().getByText('Main ticket', { exact: true }).waitFor();
        await closeTicket(s);
      }
    });

    // ---- sub-tasks and criteria
    await s.step('add a sub-task with the Save sub-task button', async () => {
      await openTicket(s, 'ALP-1');
      await dlg().getByRole('button', { name: 'Add sub-task' }).click();
      await p.getByPlaceholder('New sub-task…').fill('Write the changelog');
      await dlg().getByRole('button', { name: 'Save sub-task' }).click();
      await dlg().getByText('Write the changelog', { exact: true }).waitFor();
      await p.keyboard.press('Escape');
    });
    await s.step('tick a sub-task and untick it again', async () => {
      await dlg().getByRole('button', { name: 'Mark complete' }).first().click();
      await dlg().getByRole('button', { name: 'Mark incomplete' }).waitFor();
      await dlg().getByText('1/1').waitFor();
      await dlg().getByRole('button', { name: 'Mark incomplete' }).click();
      await dlg().getByRole('button', { name: 'Mark complete' }).waitFor();
      await dlg().getByText('0/1').waitFor();
    });
    await s.step('edit a criterion and save it with the Save criterion button', async () => {
      await dlg().getByRole('button', { name: 'Add criterion' }).click();
      await p.getByPlaceholder('New criterion…').fill('Notes written');
      await p.keyboard.press('Enter');
      await dlg().getByText('Notes written', { exact: true }).waitFor();
      await p.keyboard.press('Escape');
      await dlg().getByRole('button', { name: 'Edit criterion' }).click({ force: true });
      const input = dlg().locator('input[class*="inputField"]');
      await input.fill('Notes written and reviewed');
      await dlg().getByRole('button', { name: 'Save criterion' }).click();
      await dlg().getByText('Notes written and reviewed', { exact: true }).waitFor();
      await dlg().getByText('Notes written', { exact: true }).waitFor({ state: 'detached' });
    });

    // ---- Debug Space
    await s.step('Debug Space: log an entry with a role and a linked test case', async () => {
      await dlg().getByRole('button', { name: 'Test Cases' }).click();
      await dlg().getByRole('button', { name: 'Add test case' }).click();
      await p.getByPlaceholder('Test case title…').fill('Login works');
      await p.getByRole('button', { name: 'Add', exact: true }).click();
      await dlg().getByText('Login works', { exact: true }).waitFor();
      await back('ALP-1');
      await dlg().getByRole('button', { name: 'Debug Space' }).click();
      await dlg().getByRole('button', { name: 'Log entry' }).first().click();
      await p.getByRole('button', { name: 'Investigation', exact: true }).last().click();
      await p.getByLabel('Author').fill('Ada Lovelace');
      await p.getByLabel('Role').selectOption('Tester');
      await p.getByLabel('Note').fill('Reproduced on the staging build');
      await p.getByLabel('Linked test case').selectOption({ index: 1 });
      await p.getByRole('button', { name: 'Log entry' }).last().click();
      await dlg().getByTestId('debug-form-add').waitFor({ state: 'detached' });
      const e = dlg().getByTestId('debug-entry').filter({ hasText: 'Reproduced on the staging build' });
      await e.waitFor();
      await e.getByText('Tester', { exact: true }).waitFor();
      await e.getByText(/^TC-\d+$/).waitFor();
    });
    await s.step('Debug Space: pin an entry and unpin it', async () => {
      const e = dlg().getByTestId('debug-entry').filter({ hasText: 'Reproduced on the staging build' });
      await e.hover();
      await e.getByRole('button', { name: 'Pin entry' }).click({ force: true });
      await e.getByRole('button', { name: 'Unpin entry' }).waitFor({ state: 'attached' });
      await e.hover();
      await e.getByRole('button', { name: 'Unpin entry' }).click({ force: true });
      await e.getByRole('button', { name: 'Pin entry' }).waitFor({ state: 'attached' });
    });
    await s.step('Debug Space: delete the entry through Confirm delete', async () => {
      const e = dlg().getByTestId('debug-entry').filter({ hasText: 'Reproduced on the staging build' });
      await e.hover();
      await e.getByRole('button', { name: 'Delete entry' }).click({ force: true });
      const c = p.getByRole('dialog', { name: 'Confirm delete' });
      await c.getByText('Delete this entry?').waitFor();
      await c.getByRole('button', { name: 'Cancel' }).click();
      await c.waitFor({ state: 'detached' });
      await e.hover();
      await e.getByRole('button', { name: 'Delete entry' }).click({ force: true });
      await c.getByRole('button', { name: /^Delete/ }).click();
      await c.waitFor({ state: 'detached' });
      await dlg().getByText('Reproduced on the staging build').waitFor({ state: 'detached' });
      await back('ALP-1');
    });

    // ---- modal chrome
    await s.step('Fullscreen and Exit fullscreen', async () => {
      await dlg().getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await dlg().getByRole('button', { name: 'Exit fullscreen', exact: true }).waitFor();
      await dlg().getByRole('heading', { name: 'Main ticket', level: 2 }).waitFor();
      await dlg().getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
      await dlg().getByRole('button', { name: 'Fullscreen', exact: true }).waitFor();
    });
    await s.step('priority back to Medium from the sidebar', async () => {
      const sel = dlg().getByRole('combobox').filter({ has: p.getByRole('option', { name: 'Critical' }) });
      await sel.selectOption({ label: 'High' });
      await dlg().getByText('high', { exact: true }).waitFor();
      await sel.selectOption({ label: 'Medium' });
      await dlg().getByText('medium', { exact: true }).waitFor();
    });
    await s.step('Review by: ask Ada, then Nobody', async () => {
      await setStatus('Backlog', 'Review');
      const row = dlg().getByTestId('review-requested-row');
      await row.waitFor();
      await row.getByLabel('Review by').selectOption({ label: 'Ada Lovelace' });
      await row.getByText('Ada Lovelace', { exact: true }).first().waitFor();
      await row.getByLabel('Review by').selectOption({ label: 'Nobody' });
      await row.getByText('Nobody asked yet').waitFor();
      await closeTicket(s);
    });

    // ---- New Ticket form: estimate and priority
    await s.step('New Ticket: story points 1, 2, 3, 5, 8, 13 and No estimate', async () => {
      await p.getByRole('button', { name: 'New Ticket' }).click();
      await p.getByPlaceholder('Ticket title…').fill('Sized ticket');
      const active = () => p.locator('[class*="ntEstBtnActive"]');
      for (const pt of ['1', '2', '3', '5', '8', '13']) {
        await p.getByRole('button', { name: pt, exact: true }).click();
        await active().getByText(pt, { exact: true }).waitFor();
      }
      await p.getByRole('button', { name: 'No estimate' }).click();
      await p.getByRole('button', { name: 'No estimate' }).and(p.locator('[class*="ntEstBtnActive"]')).waitFor();
      await p.getByRole('button', { name: '13', exact: true }).click();
      await p.getByRole('radio', { name: /^low$/i }).check({ force: true });
      await p.getByRole('radio', { name: /^medium$/i }).check({ force: true });
      await p.getByRole('radio', { name: /^medium$/i }).and(p.locator('[aria-checked="true"]')).waitFor();
      await p.getByRole('button', { name: 'Create Ticket' }).click();
      await p.getByRole('button', { name: 'Create Ticket' }).waitFor({ state: 'detached' });
      await s.settle();
      await openTicket(s, 'ALP-9');
      await dlg().getByTestId('sidebar-estimate').getByText('13 pt').waitFor();
      await closeTicket(s);
    });

    // ---- Won't Do -> Restore to Backlog
    await s.step("Restore to Backlog from a Won't Do ticket", async () => {
      await openTicket(s, 'ALP-8');
      await setStatus('Backlog', "Won't Do");
      const w = p.getByRole('dialog', { name: "Mark ticket as Won't Do" });
      await w.getByRole('textbox', { name: /^Reason/ }).fill('Not needed');
      await w.getByRole('button', { name: 'Mark as Won’t Do' }).click();
      await w.waitFor({ state: 'detached' });
      await dlg().getByText("This ticket is marked as Won't Do").waitFor();
      await dlg().getByRole('button', { name: 'Restore to Backlog' }).click();
      await dlg().getByText("This ticket is marked as Won't Do").waitFor({ state: 'detached' });
      await dlg().getByRole('button', { name: 'Backlog', exact: true }).first().waitFor();
      await closeTicket(s);
      await columnOf(p, 'Backlog').getByRole('button', { name: /ALP-8/ }).waitFor();
    });

    // ---- pending on a ticket that is then done: Keep pending
    await s.step('mark a ticket pending on another one, finish the blocker, Keep pending', async () => {
      await openTicket(s, 'ALP-2');
      await dlg().getByRole('button', { name: /^Pending/ }).click();
      const d = p.getByRole('dialog', { name: 'Mark ALP-2 as pending' });
      await d.getByRole('textbox', { name: 'Search tickets by key or title...' }).fill('Target relates');
      await d.getByText('Target relates').first().click();
      await d.getByRole('button', { name: 'Mark pending' }).click();
      await d.waitFor({ state: 'detached' });
      await dlg().getByText(/Pending since/).waitFor();
      await closeTicket(s);
      await openTicket(s, 'ALP-4');
      await setStatus('Backlog', 'Done');
      await dlg().getByRole('button', { name: /^Reopen/ }).first().waitFor();
      await closeTicket(s);
      // the card's own "Waiting on" chip toggles the Pending filter, so open the ticket by its title
      await p.getByText('Target blocks', { exact: true }).click();
      await dlg().waitFor();
      await dlg().getByText(/is done\. Resume/).waitFor();
      await dlg().getByRole('button', { name: 'Keep pending' }).click();
      await dlg().getByText(/is done\. Resume/).waitFor({ state: 'detached' });
      await dlg().getByText(/Pending since/).waitFor();
      await closeTicket(s);
    });

    // ---- undo a reopen
    await s.step('reopen a Done ticket and undo it from the toast', async () => {
      // ALP-2's card also names ALP-4 ("Waiting on ALP-4"), so pick the card in the Done column
      await columnOf(p, 'Done').getByRole('button', { name: /ALP-4 / }).first().click();
      await dlg().waitFor();
      await dlg().getByRole('button', { name: /^Reopen/ }).first().click();
      const r = p.getByRole('dialog', { name: 'Reopen ALP-4?' });
      await r.getByRole('textbox', { name: 'Why is this being reopened?' }).fill('Found a regression');
      await r.getByRole('button', { name: 'Reopen', exact: true }).click();
      await r.waitFor({ state: 'detached' });
      await dlg().getByRole('button', { name: 'To Do', exact: true }).first().waitFor();
      await p.getByText('ALP-4 reopened').waitFor();
      // an older toast ("ALP-2 marked pending") can still carry its own Undo: take the one of this toast
      await p.getByText('ALP-4 reopened').locator('xpath=ancestor::*[.//button[normalize-space()="Undo"]][1]').getByRole('button', { name: 'Undo', exact: true }).click();
      await dlg().getByRole('button', { name: 'Done', exact: true }).first().waitFor();
      await closeTicket(s);
      await columnOf(p, 'Done').getByRole('button', { name: /ALP-4/ }).waitFor();
    });

    // ---- board and cards
    await s.step('card options: Open ticket and Copy link', async () => {
      await card(p, 'ALP-3').hover();
      await card(p, 'ALP-3').getByRole('button', { name: 'Card options' }).click({ force: true });
      await p.getByRole('button', { name: 'Copy link' }).click();
      // the card's Copy link says so with a toast, as the comment's does (it used to copy silently)
      await p.getByText('Link copied').first().waitFor();
      await p.getByRole('button', { name: 'Open ticket' }).waitFor({ state: 'detached' });
      await p.waitForFunction(async () => /#ticket-ALP-3$/.test(await navigator.clipboard.readText()));
      await card(p, 'ALP-3').getByRole('button', { name: 'Card options' }).click({ force: true });
      await p.getByRole('button', { name: 'Open ticket' }).click();
      // "Open ticket" opens the ticket (on the board it used to do nothing: the draggable card passed no handler)
      await dlg().getByText('ALP-3', { exact: true }).first().waitFor();
    });
    await s.step('create a brand-new tag from the tag picker and see it on the card', async () => {
      await dlg().getByRole('button', { name: 'Add tag' }).click();
      await p.getByLabel('Tag name').fill('brand-new');
      await p.getByRole('listbox', { name: 'Tags' }).getByRole('option', { name: /Create/ }).click();
      await dlg().getByText('brand-new', { exact: true }).waitFor();
      await closeTicket(s);
      await card(p, 'ALP-3').getByText('brand-new', { exact: true }).waitFor();
    });
    await s.step('the column badge counts active tickets', async () => {
      await columnOf(p, 'Done').getByLabel('1 active tickets').waitFor();
    });
    await s.step('a filter chip shows Clear and turns off', async () => {
      await p.getByRole('button', { name: /^Pending/ }).click();
      await p.getByLabel('Clear').first().waitFor();
      await card(p, 'ALP-2').waitFor();
      await card(p, 'ALP-3').waitFor({ state: 'hidden' });
      await p.getByLabel('Clear').first().click();
      await card(p, 'ALP-3').waitFor();
    });
    await s.step('Recycle Bin: Empty bin removes deleted pages', async () => {
      const pid = (await api('GET', '/projects')).body[0].id;
      const pg = await api('POST', `/projects/${pid}/docs/pages`, { title: 'Scratch page', content: 'x' });
      if (pg.status >= 300) throw new Error(`page create answered ${pg.status}`);
      const del = await api('DELETE', `/docs/pages/${pg.body.id}`);
      if (del.status >= 300) throw new Error(`page delete answered ${del.status}`);
      await p.getByRole('button', { name: /^Recycle Bin/ }).click();
      const bin = p.getByRole('dialog', { name: 'Recycle Bin' });
      await bin.getByText('Scratch page').waitFor();
      await bin.getByRole('button', { name: 'Empty bin' }).click();
      await bin.getByText(/Delete 1 deleted page forever/).waitFor();
      await bin.getByRole('button', { name: 'Empty bin' }).last().click();
      await bin.getByText('Scratch page').waitFor({ state: 'detached' });
      await bin.getByRole('button', { name: 'Close' }).click();
      await bin.waitFor({ state: 'detached' });
    });
  },
};
