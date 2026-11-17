import { ensureProject, createTicket, openTicket, closeTicket, card, columnOf } from '../lib/ui.mjs';

export default {
  name: 'Projects and Stories: delete a project, Story page, sub-tickets, waves, lanes',
  async run(s) {
    const p = s.page;
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    const storyPage = () => p.getByRole('dialog', { name: /^Story / });
    const nav = () => p.getByRole('complementary', { name: 'Project navigation' });
    const api = (method, path, body) => p.evaluate(async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, [method, path, body]);
    const setStatus = async (from, to) => {
      await dlg().getByRole('complementary').getByRole('button', { name: from, exact: true }).click();
      await p.getByRole('listbox').getByText(to, { exact: true }).click();
    };
    const subRow = (title) => dlg().locator('[class*="_row_"]').filter({ hasText: title });
    // the delete control is drawn only on hover, so it is found by its label, not by role
    const del = (name) => nav().locator(`[aria-label="Delete ${name}"]`);
    const story = 'Checkout story';
    const subs = ['Pay with card', 'Print receipt', 'Send email'];

    // ---- projects
    await s.step('set up: first project Alpha, its row offers Edit and Delete (even as the only, open project)', async () => {
      await ensureProject(s);
      await nav().getByRole('button', { name: 'Alpha ALP' }).waitFor();
      await nav().locator('[aria-label="Edit Alpha"]').waitFor({ state: 'attached' });
      await del('Alpha').waitFor({ state: 'attached' });
    });
    await s.step('create Beta with a ticket in it', async () => {
      await nav().getByRole('button', { name: 'New Project' }).click();
      await p.getByPlaceholder('Project name').fill('Beta Project');
      await p.getByPlaceholder('Prefix (e.g. PROJ)').fill('bet');
      await p.getByRole('button', { name: /^Color / }).nth(3).click();
      await p.getByRole('button', { name: 'Create', exact: true }).click();
      await nav().getByRole('button', { name: 'Beta Project BET' }).click();
      await p.getByRole('heading', { name: 'Beta Project', level: 1 }).waitFor();
      await createTicket(s, { title: 'Beta only ticket' });
      await card(p, 'BET-1').waitFor();
    });
    await s.step('both projects offer Delete, the one being viewed too', async () => {
      await del('Beta Project').waitFor({ state: 'attached' });
      await del('Alpha').waitFor({ state: 'attached' });
    });
    await s.step('declining the confirmation keeps the project with its tickets', async () => {
      let msg = '';
      p.once('dialog', (d) => { msg = d.message(); d.dismiss(); });
      await nav().getByTitle('Beta Project (BET)').hover();
      await del('Beta Project').click();
      if (!/Delete project "Beta Project"\? All its tickets will be lost\./.test(msg)) throw new Error(`unexpected confirm text: ${msg}`);
      await nav().getByRole('button', { name: 'Beta Project BET' }).waitFor();
      const projects = (await api('GET', '/projects')).body;
      if (projects.length !== 2) throw new Error(`2 projects expected, got ${projects.length}`);
    });
    await s.step('deleting the project being viewed (Beta) takes its ticket and moves the board to Alpha; a reload keeps it gone', async () => {
      const betaId = (await api('GET', '/projects')).body.find((x) => x.prefix === 'BET').id;
      p.once('dialog', (d) => d.accept());
      const gone = p.waitForResponse((r) => r.request().method() === 'DELETE' && r.url().endsWith(`/projects/${betaId}`));
      await p.getByRole('heading', { name: 'Beta Project', level: 1 }).waitFor();
      await nav().getByTitle('Beta Project (BET)').hover();
      await del('Beta Project').click();
      if ((await gone).status() >= 300) throw new Error('DELETE /projects/:id failed');
      await nav().getByRole('button', { name: 'Beta Project BET' }).waitFor({ state: 'detached' });
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
      await p.reload();
      await nav().getByRole('button', { name: 'Alpha ALP' }).waitFor({ timeout: 15000 });
      await nav().getByRole('button', { name: 'Beta Project BET' }).waitFor({ state: 'detached' });
      const r = await api('GET', `/projects/${betaId}`);
      if (r.status !== 404) throw new Error(`deleted project should answer 404, got ${r.status}`);
      await del('Alpha').waitFor({ state: 'attached' }); // the last project can be deleted too (at the end)
      // the 404 of the check above is logged by the browser
    }, { expectConsole: true });

    // ---- a Story through the UI
    await s.step('make a Story from New Ticket (the type it used to leave out)', async () => {
      await createTicket(s, { title: story, type: 'Story' });
      await card(p, 'ALP-1').waitFor();
      const t = (await api('GET', '/tickets/ALP-1')).body;
      if (t.type !== 'story') throw new Error(`ALP-1 should be a Story, got ${t.type}`);
    });
    await s.step('the Story card opens the Story page with no sub-tickets yet', async () => {
      await card(p, 'ALP-1').click();
      await storyPage().getByRole('heading', { name: story, level: 2 }).waitFor();
      await storyPage().getByText('No sub-tickets yet.').waitFor();
      await storyPage().getByText('0 of 0 met').waitFor();
    });
    await s.step('the Story page: "Where you are" leads back to the board', async () => {
      const crumb = storyPage().getByRole('navigation', { name: 'Where you are' });
      await crumb.getByRole('button', { name: 'Alpha' }).waitFor();
      await crumb.getByText('ALP-1').waitFor();
      await crumb.getByRole('button', { name: 'Board' }).click();
      await storyPage().waitFor({ state: 'detached' });
    });
    await s.step('Create sub-ticket: add three sub-tickets to the Story', async () => {
      await card(p, 'ALP-1').click();
      await storyPage().getByRole('button', { name: 'More' }).click();
      await p.getByRole('menuitem', { name: 'Open as ticket' }).click();
      await dlg().getByRole('button', { name: 'Add sub-ticket' }).click();
      await dlg().getByRole('button', { name: 'New', exact: true }).click();
      for (const t of subs) {
        await p.getByPlaceholder('Sub-ticket title…').fill(t);
        await p.getByRole('button', { name: 'Create sub-ticket' }).click();
        await dlg().getByText(t).first().waitFor();
      }
      await dlg().getByRole('button', { name: 'Cancel', exact: true }).click();
      await dlg().getByText('SUB-TICKETS · 3').waitFor();
      await dlg().getByText('0/3 done').waitFor();
    });
    await s.step('sub-tickets start in wave 1 each', async () => {
      for (const k of ['ALP-2', 'ALP-3', 'ALP-4']) {
        const b = dlg().getByRole('button', { name: `Execution wave 1 of ${k}, change` });
        await b.waitFor();
      }
    });
    await s.step('Wave of ALP-3: Later wave moves it after the others', async () => {
      await dlg().getByRole('button', { name: 'Execution wave 1 of ALP-3, change' }).click();
      const pop = p.getByRole('dialog', { name: 'Wave of ALP-3' });
      await pop.getByTestId('wave-value').getByText('1', { exact: true }).waitFor();
      if (!(await pop.getByRole('button', { name: 'Earlier wave' }).isDisabled())) throw new Error('Earlier wave should be disabled in wave 1');
      await pop.getByRole('button', { name: 'Later wave' }).click();
      await pop.getByTestId('wave-value').getByText('2', { exact: true }).waitFor();
      await pop.getByRole('checkbox', { name: 'Auto-set from Blocked by' }).waitFor();
      if (await pop.getByRole('checkbox', { name: 'Auto-set from Blocked by' }).isChecked()) throw new Error('a pinned wave should uncheck Auto-set');
      await p.keyboard.press('Escape');
      await pop.waitFor({ state: 'detached' });
      await dlg().getByRole('button', { name: 'Execution wave 2 of ALP-3, change' }).waitFor();
    });
    await s.step('Earlier wave and Auto-set bring it back to wave 1', async () => {
      await dlg().getByRole('button', { name: 'Execution wave 2 of ALP-3, change' }).click();
      const pop = p.getByRole('dialog', { name: 'Wave of ALP-3' });
      await pop.getByRole('button', { name: 'Later wave' }).click();
      await pop.getByTestId('wave-value').getByText('3', { exact: true }).waitFor();
      await pop.getByRole('button', { name: 'Earlier wave' }).click();
      await pop.getByTestId('wave-value').getByText('2', { exact: true }).waitFor();
      await pop.getByRole('checkbox', { name: 'Auto-set from Blocked by' }).click();
      await pop.getByTestId('wave-value').getByText('1', { exact: true }).waitFor();
      await p.keyboard.press('Escape');
      await dlg().getByRole('button', { name: 'Execution wave 1 of ALP-3, change' }).waitFor();
    });
    await s.step('pin ALP-4 to wave 2: the list orders by wave', async () => {
      await dlg().getByRole('button', { name: 'Execution wave 1 of ALP-4, change' }).click();
      const pop = p.getByRole('dialog', { name: 'Wave of ALP-4' });
      await pop.getByRole('button', { name: 'Later wave' }).click();
      await pop.getByTestId('wave-value').getByText('2', { exact: true }).waitFor();
      await p.keyboard.press('Escape');
      await dlg().getByRole('button', { name: 'Execution wave 2 of ALP-4, change' }).waitFor();
      const ids = (await dlg().locator('[class*="ticketId"]').allInnerTexts()).map((t) => t.trim());
      s.note('sub-ticket order', ids);
      if (ids.indexOf('ALP-4') !== ids.length - 1) throw new Error(`ALP-4 (wave 2) should be last, got ${ids.join(',')}`);
    });
    await s.step('a sub-ticket shows its Story as parent and opens it', async () => {
      await closeTicket(s);
      await openTicket(s, 'ALP-2');
      const parent = dlg().getByTitle(`Parent: ${story}`);
      await parent.waitFor();
      await parent.getByText('ALP-1').waitFor();
      await parent.click();
      await storyPage().getByRole('heading', { name: story, level: 2 }).waitFor();
    });
    await s.step('the Story page lists the sub-tickets in wave order with 0 of 3 done', async () => {
      const table = storyPage().getByRole('table', { name: 'Sub-tickets' });
      await table.getByText('Pay with card').waitFor();
      const ids = await table.locator('[data-testid="story-child"]').allInnerTexts();
      if (ids.length !== 3) throw new Error(`3 rows expected, got ${ids.length}`);
      if (!/ALP-4/.test(ids[2])) throw new Error(`ALP-4 (wave 2) should be the last row, got: ${ids.join(' | ')}`);
      await storyPage().getByText('0 of 3').first().waitFor();
      await storyPage().getByText('3 sub-tickets · in the order of their waves').waitFor();
    });
    await s.step('a sub-ticket opens from the Story page', async () => {
      await storyPage().getByRole('button', { name: 'Pay with card' }).click();
      await p.getByRole('dialog', { name: 'Ticket ALP-2' }).waitFor();
      await closeTicket(s);
    });
    await s.step('moving a sub-ticket to Done updates the Story page progress', async () => {
      await openTicket(s, 'ALP-2');
      await setStatus('Backlog', 'Done');
      await dlg().getByRole('button', { name: 'Done', exact: true }).first().waitFor();
      await closeTicket(s);
      await card(p, 'ALP-1').click();
      await storyPage().getByText('1 of 3').first().waitFor();
      await storyPage().getByRole('navigation', { name: 'Where you are' }).getByRole('button', { name: 'Board' }).click();
    });
    await s.step('hover the Story card: no parent group links (a Story is not a group)', async () => {
      await card(p, 'ALP-2').waitFor();
      await p.mouse.move(700, 880);
      await p.getByTestId('parent-group-links').waitFor({ state: 'detached' });
    });

    // ---- sub-ticket progress in the ticket view and removing a sub-ticket
    await s.step('the ticket view shows 1/3 done after the move', async () => {
      await card(p, 'ALP-1').click();
      await storyPage().getByRole('button', { name: 'More' }).click();
      await p.getByRole('menuitem', { name: 'Open as ticket' }).click();
      await dlg().getByText('1/3 done').waitFor();
    });
    await s.step('Remove sub-ticket detaches ALP-4 from the Story', async () => {
      await subRow('Send email').getByRole('button', { name: 'Remove sub-ticket' }).click();
      await dlg().getByText('SUB-TICKETS · 2').waitFor();
      await dlg().getByText('1/2 done').waitFor();
      await dlg().getByText('Send email').waitFor({ state: 'detached' });
    });
    await s.step('the detached ticket is on the board again, with no parent', async () => {
      await closeTicket(s);
      await openTicket(s, 'ALP-4');
      await dlg().getByTitle(`Parent: ${story}`).waitFor({ state: 'detached' });
      await closeTicket(s);
    });
    await s.step('the Story page lists only the two remaining sub-tickets', async () => {
      await card(p, 'ALP-1').click();
      const table = storyPage().getByRole('table', { name: 'Sub-tickets' });
      await table.getByText('Print receipt').waitFor();
      await table.getByText('Send email').waitFor({ state: 'detached' });
      await storyPage().getByText('1 of 2').first().waitFor();
      await storyPage().getByRole('navigation', { name: 'Where you are' }).getByRole('button', { name: 'Board' }).click();
    });

    // ---- story lanes
    await s.step('Group by Story: the lane shows 50% done', async () => {
      await p.getByRole('button', { name: /^Group by:/ }).click();
      await p.getByRole('button', { name: 'Group by: Story' }).waitFor();
      const lane = p.getByTestId('lane-story').filter({ hasText: story });
      await lane.waitFor();
      await lane.getByRole('img', { name: '50% done' }).waitFor();
      await lane.getByText('1 of 2 done').waitFor();
    });
    await s.step('drag the Done sub-ticket to To Do in its lane: the reopen popover opens', async () => {
      const src = card(p, 'ALP-2');
      const cell = p.locator('[data-status="todo"]').first();
      await src.scrollIntoViewIfNeeded();
      const a = await src.boundingBox();
      const c = await cell.boundingBox();
      await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await p.mouse.down();
      await p.mouse.move(a.x + 12, a.y + 12, { steps: 4 });
      await p.mouse.move(c.x + c.width / 2, c.y + Math.min(40, c.height / 2), { steps: 14 });
      await p.mouse.up();
      await p.getByRole('dialog', { name: 'Reopen ALP-2?' }).waitFor();
    });
    await s.step('More options on the lane popover opens the full Reopen dialog', async () => {
      await p.getByRole('dialog', { name: 'Reopen ALP-2?' }).getByRole('textbox', { name: 'Why is this being reopened?' }).or(
        p.getByPlaceholder('Why is this being reopened?')).first().fill('Receipt layout broke');
      await p.getByRole('button', { name: 'More options' }).click();
      const r = p.getByRole('dialog', { name: 'Reopen ALP-2?' });
      await r.getByText('Moves to To Do; keeps assignee and tags').waitFor();
      await r.getByRole('button', { name: 'Reopen', exact: true }).click();
      await r.waitFor({ state: 'detached' });
    });
    await s.step('the reopened sub-ticket drops the lane to 0% done', async () => {
      const lane = p.getByTestId('lane-story').filter({ hasText: story });
      await lane.getByRole('img', { name: '0% done' }).waitFor();
      await lane.getByText('0 of 2 done').waitFor();
      await p.getByRole('button', { name: 'Group by: Story' }).click();
      await p.getByRole('button', { name: 'Group by: None' }).waitFor();
    });
    await s.step('complete both sub-tickets: the Story page reaches 2 of 2', async () => {
      for (const k of ['ALP-2', 'ALP-3']) {
        await openTicket(s, k);
        const from = await dlg().getByRole('complementary').getByRole('button', { name: /^(Backlog|To Do)$/ }).first().innerText();
        await setStatus(from.trim(), 'Done');
        await dlg().getByRole('button', { name: 'Done', exact: true }).first().waitFor();
        await closeTicket(s);
      }
      await card(p, 'ALP-1').click();
      await storyPage().getByText('2 of 2').first().waitFor();
      await storyPage().getByRole('navigation', { name: 'Where you are' }).getByRole('button', { name: 'Board' }).click();
    });

    // ---- the last project
    await s.step('Edit a project: a new name and colour, the prefix stays, a reload keeps them', async () => {
      await nav().getByTitle('Alpha (ALP)').hover();
      await nav().locator('[aria-label="Edit Alpha"]').click();
      await p.getByText('Edit Project').waitFor();
      if (!(await p.getByPlaceholder('Prefix (e.g. PROJ)').isDisabled())) throw new Error('the prefix should not be editable');
      await p.getByPlaceholder('Project name').fill('Alpha Prime');
      await p.getByRole('button', { name: 'Color #5BB8F5' }).click();
      await p.getByRole('button', { name: 'Save', exact: true }).click();
      await p.getByText('Edit Project').waitFor({ state: 'detached' });
      await p.getByRole('heading', { name: 'Alpha Prime', level: 1 }).waitFor();
      const pr = (await api('GET', '/projects')).body[0];
      if (pr.name !== 'Alpha Prime' || pr.color !== '#5BB8F5' || pr.prefix !== 'ALP') throw new Error(`project not saved: ${JSON.stringify(pr)}`);
      await p.reload();
      await nav().getByRole('button', { name: 'Alpha Prime ALP' }).waitFor({ timeout: 15000 });
      await card(p, 'ALP-1').waitFor();
    });
    await s.step('delete the last project from the sidebar: the app starts over with "Create your first project"', async () => {
      const pid = (await api('GET', '/projects')).body[0].id;
      p.once('dialog', (d) => d.accept());
      await nav().getByTitle('Alpha Prime (ALP)').hover();
      await del('Alpha Prime').click();
      await p.getByRole('heading', { name: 'Create your first project' }).waitFor({ timeout: 15000 });
      // After a reload the page must not ask for the deleted project (it used to keep it as the active one in
      // localStorage and ask for its members, AI teams, Docs tree… all 404).
      // Only what the reloaded page asks for counts: the open page may still refetch once when the delete event
      // arrives (the page was showing that project), so let that settle before listening.
      await s.settle();
      const gone = [];
      const onRequest = (req) => { if (req.url().includes(`/projects/${pid}`)) gone.push(new URL(req.url()).pathname); };
      p.on('request', onRequest);
      await p.reload();
      await p.getByRole('heading', { name: 'Create your first project' }).waitFor({ timeout: 15000 });
      await s.settle();
      p.off('request', onRequest);
      if (gone.length) throw new Error(`the reloaded page asked for the deleted project: ${gone.join(', ')}`);
      if ((await api('GET', '/projects')).body.length !== 0) throw new Error('no project should be left');
    });
  },
};
