import { ensureProject, createTicket, openTicket, closeTicket, addMember, card, columnOf } from '../lib/ui.mjs';

export default {
  name: "Ticket lifecycle: Won't Do, Reopen, Pending, Resume, Recycle Bin, sub-tickets",
  async run(s) {
    const p = s.page;
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    
    const setStatus = async (from, to) => {
      // the sidebar's status menu (a relation row can hold a status menu of its own, so look in the sidebar only)
      await dlg().getByRole('complementary').getByRole('button', { name: from, exact: true }).click();
      await p.getByRole('listbox').getByText(to, { exact: true }).click();
    };
    // Local helper (the harness has none): one call to the REST API from the page, as the UI itself does.
    const api = (method, path, body) => p.evaluate(async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, [method, path, body]);
    const cycleTo = async (want) => {
      const order = ['pending', 'running', 'pass', 'fail'];
      const btn = () => dlg().getByRole('button', { name: /^Status: / }).first();
      let cur = /^Status: (\w+)/.exec(await btn().getAttribute('aria-label'))[1];
      while (cur !== want) {
        const next = order[(order.indexOf(cur) + 1) % order.length];
        await btn().click();
        await dlg().getByRole('button', { name: `Status: ${next}. Click to cycle.` }).waitFor();
        cur = next;
      }
    };

    await s.step('set up: project, a member and seven tickets', async () => {
      await ensureProject(s);
      await addMember(s, 'Ada Lovelace');
      for (const t of ['Ship v2', 'Old idea', 'Waiting on design', 'Dependency', 'Delete me', 'Dropped scope', 'Parent task']) {
        await createTicket(s, { title: t });
      }
      for (const k of ['ALP-1', 'ALP-2', 'ALP-3', 'ALP-4', 'ALP-5', 'ALP-6', 'ALP-7']) await card(p, k).waitFor();
    });

    // ---- Won't Do
    await s.step("Won't Do asks for a reason and can be cancelled", async () => {
      await openTicket(s, 'ALP-2');
      await setStatus('Backlog', "Won't Do");
      const w = p.getByRole('dialog', { name: "Mark ticket as Won't Do" });
      await w.getByText('Mark ALP-2 as Won’t Do?').waitFor();
      await w.getByRole('button', { name: 'Mark as Won’t Do' }).isDisabled().then((d) => { if (!d) throw new Error('confirm must wait for a reason'); });
      await w.getByRole('textbox', { name: /^Reason/ }).fill('   ');
      await w.getByRole('button', { name: 'Mark as Won’t Do' }).isDisabled().then((d) => { if (!d) throw new Error('a blank reason must not count'); });
      await w.getByRole('button', { name: 'Cancel' }).click();
      await w.waitFor({ state: 'detached' });
      await dlg().getByRole('button', { name: 'Backlog', exact: true }).first().waitFor();
    });
    await s.step("mark a ticket Won't Do with a reason", async () => {
      await setStatus('Backlog', "Won't Do");
      const w = p.getByRole('dialog', { name: "Mark ticket as Won't Do" });
      await w.getByRole('textbox', { name: /^Reason/ }).fill('Out of scope for v2');
      await w.getByRole('button', { name: 'Mark as Won’t Do' }).click();
      await w.waitFor({ state: 'detached' });
      await dlg().getByText("This ticket is marked as Won't Do").waitFor();
      await dlg().getByText('Out of scope for v2').first().waitFor();
      await p.getByText("Marked as Won't Do").first().waitFor();
    });
    await s.step("a Won't Do ticket leaves the board and sits in the Recycle Bin", async () => {
      await closeTicket(s);
      await card(p, 'ALP-2').waitFor({ state: 'detached' });
      await p.getByRole('button', { name: /^Recycle Bin 1/ }).click();
      const bin = p.getByRole('dialog', { name: 'Recycle Bin' });
      await bin.getByText('Old idea').waitFor();
      await bin.getByText('Won’t do: Out of scope for v2').waitFor();
      await bin.getByRole('button', { name: /^Tickets · 1/ }).click();
      await bin.getByText('Old idea').waitFor();
      await bin.getByRole('button', { name: /^Pages · 0/ }).click();
      await bin.getByText('Old idea').waitFor({ state: 'detached' });
      await bin.getByRole('button', { name: /^All · 1/ }).click();
      await bin.getByText('Old idea').waitFor();
    });
    await s.step('restore the ticket from the Recycle Bin', async () => {
      const bin = p.getByRole('dialog', { name: 'Recycle Bin' });
      await bin.getByRole('button', { name: 'Restore' }).click();
      await bin.getByText('Old idea').waitFor({ state: 'detached' });
      await bin.getByRole('button', { name: 'Close' }).click();
      await bin.waitFor({ state: 'detached' });
      await columnOf(p, 'Backlog').getByRole('button', { name: /ALP-2/ }).waitFor();
    });
    await s.step("Won't Do again, then Reopen it from the banner", async () => {
      await openTicket(s, 'ALP-6');
      await setStatus('Backlog', "Won't Do");
      const w = p.getByRole('dialog', { name: "Mark ticket as Won't Do" });
      await w.getByRole('textbox', { name: /^Reason/ }).fill('Duplicate of ALP-1');
      await w.getByRole('button', { name: 'Mark as Won’t Do' }).click();
      await dlg().getByText("This ticket is marked as Won't Do").waitFor();
      await dlg().getByRole('button', { name: /^Reopen/ }).first().click();
      const r = p.getByRole('dialog', { name: 'Reopen ALP-6?' });
      await r.getByText('The Won\'t Do decision').waitFor();
      await r.getByRole('textbox', { name: 'Why is this being reopened?' }).fill('Needed after all');
      await r.getByRole('button', { name: 'Reopen', exact: true }).click();
      await r.waitFor({ state: 'detached' });
      await dlg().getByText("This ticket is marked as Won't Do").waitFor({ state: 'detached' });
      await dlg().getByRole('button', { name: 'To Do', exact: true }).first().waitFor();
      await closeTicket(s);
      await columnOf(p, 'To Do').getByRole('button', { name: /ALP-6/ }).waitFor();
    });

    // ---- Done and Reopen with its options
    await s.step('prepare ALP-1: assignee, a criterion, a test case, move to Done', async () => {
      await openTicket(s, 'ALP-1');
      await dlg().getByRole('button', { name: 'Unassigned' }).click();
      await p.getByRole('menu').getByRole('button', { name: /Ada Lovelace/ }).click();
      await dlg().getByRole('button', { name: 'Add criterion' }).click();
      await p.getByPlaceholder('New criterion…').fill('Release notes written');
      await p.keyboard.press('Enter');
      await dlg().getByText('Release notes written').waitFor();
      await p.keyboard.press('Escape');
      await dlg().getByRole('button', { name: 'Mark complete' }).first().click();
      await dlg().getByRole('button', { name: 'Mark incomplete' }).waitFor();
      await dlg().getByRole('button', { name: 'Test Cases' }).click();
      await dlg().getByRole('button', { name: 'Add test case' }).click();
      await p.getByPlaceholder('Test case title…').fill('Smoke test passes');
      await p.getByRole('button', { name: 'Add', exact: true }).click();
      await dlg().getByText('Smoke test passes').waitFor();
      await cycleTo('pass');
      await dlg().getByRole('button', { name: 'ALP-1', exact: true }).click();
      await setStatus('Backlog', 'Done');
      await dlg().getByRole('button', { name: /^Reopen/ }).first().waitFor();
    });
    await s.step('Reopen a Done ticket: choose the options and read the summary', async () => {
      await dlg().getByRole('button', { name: /^Reopen/ }).first().click();
      const r = p.getByRole('dialog', { name: 'Reopen ALP-1?' });
      await r.getByText('Moves to To Do; keeps assignee and tags').waitFor();
      await r.getByText('Uncheck acceptance criteria').click();
      await r.getByText('Reset test results to pending').click();
      await r.getByRole('button', { name: 'Unassign' }).click();
      await r.getByRole('textbox', { name: 'Why is this being reopened?' }).fill('Regression found in the smoke test');
      await r.getByText('34 / 240').waitFor();
      await r.getByRole('button', { name: 'Reopen', exact: true }).click();
      await r.waitFor({ state: 'detached' });
    });
    await s.step('the reopened ticket is in To Do with a clean slate and a history', async () => {
      await dlg().getByRole('button', { name: 'To Do', exact: true }).first().waitFor();
      await dlg().getByRole('button', { name: 'Mark complete' }).waitFor();
      await dlg().getByRole('button', { name: 'Unassigned' }).waitFor();
      await dlg().getByRole('region', { name: 'Reopen History' }).or(dlg().getByLabel('Reopen History')).first().waitFor();
      await dlg().getByText('Regression found in the smoke test').first().waitFor();
      await dlg().getByRole('button', { name: 'Test Cases' }).click();
      await dlg().getByRole('button', { name: 'Status: pending. Click to cycle.' }).waitFor();
      await dlg().getByRole('button', { name: 'ALP-1', exact: true }).click();
      await closeTicket(s);
      await columnOf(p, 'To Do').getByRole('button', { name: /ALP-1/ }).waitFor();
    });
    await s.step('the Reopened filter shows only reopened tickets', async () => {
      await p.getByRole('button', { name: /^Reopened/ }).click();
      await card(p, 'ALP-1').waitFor();
      await card(p, 'ALP-2').waitFor({ state: 'hidden' });
      await p.getByRole('button', { name: /^Reopened/ }).click();
      await card(p, 'ALP-2').waitFor();
    });

    // ---- Pending and Resume
    await s.step('mark a ticket pending on another ticket', async () => {
      await openTicket(s, 'ALP-3');
      await dlg().getByRole('button', { name: /^Pending/ }).click();
      const d = p.getByRole('dialog', { name: 'Mark ALP-3 as pending' });
      await d.getByRole('button', { name: 'Mark pending' }).isDisabled().then((x) => { if (!x) throw new Error('needs a ticket first'); });
      await d.getByRole('textbox', { name: 'Search tickets by key or title...' }).fill('Dependency');
      await d.getByText('Dependency').first().click();
      await d.getByRole('textbox', { name: 'What is it waiting for?' }).fill('Needs the dependency first');
      await d.getByRole('button', { name: 'Mark pending' }).click();
      await d.waitFor({ state: 'detached' });
      await dlg().getByText(/Pending since/).waitFor();
      await dlg().getByText('Needs the dependency first').first().waitFor();
      await dlg().getByText('Blocked by').first().waitFor();
    });
    await s.step('change the pending reason to a person', async () => {
      await dlg().getByRole('button', { name: 'Change reason' }).click();
      const d = p.getByRole('dialog', { name: 'Change pending reason for ALP-3' });
      await d.getByRole('button', { name: 'Waiting on a person or party' }).click();
      await d.getByText('Ada Lovelace').first().click();
      await d.getByRole('textbox', { name: 'What is it waiting for?' }).fill('Mockups from Ada');
      await d.getByRole('button', { name: 'Save changes' }).click();
      await d.waitFor({ state: 'detached' });
      await dlg().getByText('Mockups from Ada').first().waitFor();
      await dlg().getByRole('status').getByText('Ada Lovelace').waitFor();
    });
    await s.step('change the reason to a party typed in (not a member)', async () => {
      // 4.0.3 sent reason_type "person" with the typed name and the server refused it (400, "member_id is required
      // when reason_type is 'person'"); a typed name is a "party"
      await dlg().getByRole('button', { name: 'Change reason' }).click();
      const d = p.getByRole('dialog', { name: 'Change pending reason for ALP-3' });
      await d.getByRole('button', { name: 'Waiting on a person or party' }).click();
      await d.getByPlaceholder('Customer, Design team, vendor name...').fill('Design team');
      await d.getByRole('button', { name: 'Save changes' }).click();
      await d.waitFor({ state: 'detached' });
      await dlg().getByRole('status').getByText('Design team').waitFor();
    });
    await s.step('the card shows the pending state and the Pending filter finds it', async () => {
      await closeTicket(s);
      await p.getByRole('button', { name: /^Pending/ }).click();
      await card(p, 'ALP-3').waitFor();
      await card(p, 'ALP-1').waitFor({ state: 'hidden' });
      await p.getByRole('button', { name: /^Pending/ }).click();
      await card(p, 'ALP-1').waitFor();
    });
    await s.step('closing a pending ticket asks first; Resume first', async () => {
      await openTicket(s, 'ALP-3');
      await setStatus('Backlog', 'Done');
      const c = p.getByRole('dialog', { name: 'ALP-3 is pending' });
      await c.getByText('It is waiting on Design team. Marking it done also clears Pending.').waitFor();
      await c.getByRole('button', { name: 'Cancel' }).click();
      await c.waitFor({ state: 'detached' });
      await dlg().getByRole('button', { name: 'Backlog', exact: true }).first().waitFor();
    });
    await s.step('Resume with a reason and a comment', async () => {
      await dlg().getByRole('button', { name: 'Resume', exact: true }).click();
      const r = p.getByRole('dialog', { name: 'Resume ALP-3?' });
      await r.getByText('Removes the Pending flag. It stays in Backlog.').waitFor();
      await r.getByRole('textbox', { name: 'e.g. Blocker is resolved, or work can continue' }).fill('Mockups arrived');
      await r.getByRole('button', { name: 'Resume', exact: true }).click();
      await r.waitFor({ state: 'detached' });
      await dlg().getByText(/Pending since/).waitFor({ state: 'detached' });
      await dlg().getByText('Mockups arrived').first().waitFor();
    });
    await s.step('pending on a person, then close it with Mark done anyway', async () => {
      // ALP-3 is still blocked by ALP-4 (added with the first pending); the board would refuse Done, so drop the link
      await dlg().getByRole('button', { name: 'Remove relation' }).click({ force: true });
      await dlg().getByText('No links').waitFor();
      await dlg().getByRole('button', { name: /^Pending/ }).click();
      const d = p.getByRole('dialog', { name: 'Mark ALP-3 as pending' });
      await d.getByRole('button', { name: 'Waiting on a person or party' }).click();
      await d.getByText('Ada Lovelace').first().click();
      await d.getByRole('button', { name: 'Mark pending' }).click();
      await d.waitFor({ state: 'detached' });
      await dlg().getByText(/Pending since/).waitFor();
      await setStatus('Backlog', 'Done');
      const c = p.getByRole('dialog', { name: 'ALP-3 is pending' });
      await c.getByRole('button', { name: 'Mark done anyway' }).click();
      await c.waitFor({ state: 'detached' });
      await dlg().getByText(/Pending since/).waitFor({ state: 'detached' });
      await dlg().getByRole('button', { name: 'Done', exact: true }).first().waitFor();
      await closeTicket(s);
      await columnOf(p, 'Done').getByRole('button', { name: /ALP-3/ }).waitFor();
    });

    // ---- delete
    await s.step('delete a ticket for good (it does not go to the Recycle Bin)', async () => {
      await openTicket(s, 'ALP-5');
      p.once('dialog', (d) => d.accept());
      await dlg().getByRole('button', { name: 'Delete ticket' }).click();
      await card(p, 'ALP-5').waitFor({ state: 'detached' });
      await p.getByRole('button', { name: /^Recycle Bin/ }).click();
      const bin = p.getByRole('dialog', { name: 'Recycle Bin' });
      await bin.getByText('Delete me').waitFor({ state: 'detached' });
      await bin.getByRole('button', { name: 'Close' }).click();
      await bin.waitFor({ state: 'detached' });
    }, { expectConsole: true });

    // ---- sub-tickets, Story page, group links
    await s.step('add sub-tickets (new and existing) to a ticket', async () => {
      await openTicket(s, 'ALP-7');
      await dlg().getByRole('button', { name: 'Add sub-ticket' }).click();
      await dlg().getByRole('button', { name: 'New', exact: true }).click();
      await p.getByPlaceholder('Sub-ticket title…').fill('Child one');
      await p.keyboard.press('Enter');
      await dlg().getByText('Child one').first().waitFor();
      // the form stays open to add another; switch it to "Existing"
      await dlg().getByRole('button', { name: 'Existing', exact: true }).click();
      await p.getByPlaceholder('Search tickets…').last().fill('Old idea');
      await dlg().getByRole('button', { name: /Old idea/ }).click();
      await dlg().getByText('Old idea').first().waitFor();
    });
    await s.step('remove a sub-ticket from its parent', async () => {
      await dlg().getByRole('button', { name: 'Remove sub-ticket' }).first().click({ force: true });
      await dlg().getByText('Old idea').waitFor({ state: 'detached' });
      await dlg().getByText('Child one').first().waitFor();
    });
    await s.step('hover the parent card to see its group links', async () => {
      await closeTicket(s);
      await card(p, 'ALP-8').waitFor();
      await card(p, 'ALP-7').hover();
      await p.getByTestId('parent-group-links').waitFor({ state: 'attached' });
      await p.mouse.move(700, 880);
      await p.getByTestId('parent-group-links').waitFor({ state: 'detached' });
    });

    await s.step('a Story (made through the API) opens as a Story page', async () => {
      const pid = (await api('GET', '/projects')).body[0].id;
      const r = await api('POST', `/projects/${pid}/tickets`, { title: 'Checkout story', type: 'story' });
      if (r.status !== 201) throw new Error(`story create answered ${r.status}`);
      await p.reload();
      await card(p, r.body.id).click();
      const sp = p.getByRole('dialog', { name: `Story ${r.body.id}` });
      await sp.getByRole('heading', { name: 'Checkout story', level: 2 }).waitFor();
      await sp.getByText('No sub-tickets yet.').waitFor();
      s.storyId = r.body.id;
    });
    await s.step('give the Story a sub-ticket from its ticket view', async () => {
      const sp = p.getByRole('dialog', { name: `Story ${s.storyId}` });
      await sp.getByRole('button', { name: 'More' }).click();
      await p.getByRole('menuitem', { name: 'Open as ticket' }).click();
      await dlg().getByRole('button', { name: 'Add sub-ticket' }).click();
      await dlg().getByRole('button', { name: 'New', exact: true }).click();
      await p.getByPlaceholder('Sub-ticket title…').fill('Pay with card');
      await p.keyboard.press('Enter');
      await dlg().getByText('Pay with card').first().waitFor();
      await dlg().getByRole('button', { name: 'Cancel', exact: true }).click();
      await closeTicket(s);
    });
    await s.step('the Story page lists its sub-ticket', async () => {
      await card(p, s.storyId).click();
      const sp = p.getByRole('dialog', { name: `Story ${s.storyId}` });
      await sp.getByRole('table', { name: 'Sub-tickets' }).getByText('Pay with card').waitFor();
      await sp.getByRole('navigation', { name: 'Where you are' }).getByRole('button', { name: 'Board' }).click();
      await sp.waitFor({ state: 'detached' });
    });
  },
};
