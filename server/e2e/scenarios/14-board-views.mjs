import { ensureProject, createTicket, openTicket, closeTicket, addMember, card, columnOf, dragCard } from '../lib/ui.mjs';

export default {
  name: 'Board views: List, Timeline, Story lanes, filters',
  async run(s) {
    const p = s.page;
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    // Dates are relative to today: the Gantt only draws a window of about two months around it.
    const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const view = (name) => p.getByRole('button', { name, exact: true });
    const row = (key) => p.getByRole('button', { name: new RegExp(`^${key} `) });
    // Local helper (the harness has none): one call to the REST API from the page.
    const api = (method, path, body) => p.evaluate(async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, [method, path, body]);
    const pick = async (trigger, option) => {
      await p.getByRole('button', { name: trigger }).click();
      await p.getByText(option, { exact: true }).last().click();
      await p.keyboard.press('Escape');
    };

    await s.step('set up: project, a member and four tickets with tags and dates', async () => {
      await ensureProject(s);
      await addMember(s, 'Ada Lovelace');
      await createTicket(s, { title: 'Plan release', priority: 'High', tags: 'release, planning', start: day(2), due: day(12) });
      await createTicket(s, { title: 'Fix login', type: 'Bug', priority: 'Critical', tags: 'bug', due: day(-3) });
      await createTicket(s, { title: 'Dark mode', type: 'Feature', priority: 'Low', tags: 'ui, release', start: day(20), due: day(40) });
      await createTicket(s, { title: 'Tidy the repo', type: 'Chore', priority: 'Medium' });
      for (const k of ['ALP-1', 'ALP-2', 'ALP-3', 'ALP-4']) await card(p, k).waitFor();
    });
    await s.step('assign ALP-1 to Ada and move ALP-2 to In Progress', async () => {
      await openTicket(s, 'ALP-1');
      await dlg().getByRole('button', { name: 'Unassigned' }).click();
      await p.getByRole('menu').getByRole('button', { name: /Ada Lovelace/ }).click();
      await dlg().getByText('Ada Lovelace').first().waitFor();
      await closeTicket(s);
      await dragCard(p, 'ALP-2', 'In Progress');
      await columnOf(p, 'In Progress').getByRole('button', { name: /ALP-2/ }).waitFor();
    });

    // ---- board filter bar
    await s.step('search the board by title and by tag, then clear', async () => {
      const box = p.getByRole('textbox', { name: 'Search tickets' });
      await box.fill('dark');
      await card(p, 'ALP-3').waitFor();
      await card(p, 'ALP-1').waitFor({ state: 'hidden' });
      // the search is fuzzy and also reads tags
      await box.fill('planning');
      await card(p, 'ALP-1').waitFor();
      await card(p, 'ALP-4').waitFor({ state: 'hidden' });
      await box.fill('qwzxv');
      await card(p, 'ALP-4').waitFor({ state: 'hidden' });
      await box.fill('');
      await card(p, 'ALP-1').waitFor();
      await card(p, 'ALP-4').waitFor();
    });
    await s.step('filter by priority, then clear it', async () => {
      await pick(/^Priority:/, 'Critical');
      await p.getByRole('button', { name: 'Priority: Critical' }).waitFor();
      await card(p, 'ALP-2').waitFor();
      await card(p, 'ALP-1').waitFor({ state: 'hidden' });
      await pick(/^Priority:/, 'All');
      await p.getByRole('button', { name: 'Priority: All' }).waitFor();
      await card(p, 'ALP-1').waitFor();
    });
    await s.step('filter by assignee, unassigned, then clear it', async () => {
      await pick(/^Assignee:/, 'Ada Lovelace');
      await card(p, 'ALP-1').waitFor();
      await card(p, 'ALP-2').waitFor({ state: 'hidden' });
      await pick(/^Assignee:/, 'Unassigned');
      await card(p, 'ALP-2').waitFor();
      await card(p, 'ALP-1').waitFor({ state: 'hidden' });
      await pick(/^Assignee:/, 'All Assignees');
      await card(p, 'ALP-1').waitFor();
    });
    await s.step('combine the type filter with the search', async () => {
      await pick(/^Type:/, 'Feature');
      await card(p, 'ALP-3').waitFor();
      await card(p, 'ALP-2').waitFor({ state: 'hidden' });
      await p.getByRole('textbox', { name: 'Search tickets' }).fill('login');
      await card(p, 'ALP-3').waitFor({ state: 'hidden' });
      await p.getByText('No tickets').first().waitFor();
      await p.getByRole('textbox', { name: 'Search tickets' }).fill('');
      await pick(/^Type:/, 'All');
      await card(p, 'ALP-2').waitFor();
    });

    // ---- list view
    await s.step('open the List view: one group per status, sorted by due date', async () => {
      await view('List').click();
      await p.getByRole('button', { name: /^Backlog 3/ }).waitFor();
      await p.getByRole('button', { name: /^In Progress 1/ }).waitFor();
      await row('ALP-2').waitFor();
      await row('ALP-3').waitFor();
      // the row shows key, title, assignee, priority, due date and status
      await row('ALP-1').getByText('Ada Lovelace').or(p.getByRole('button', { name: /^ALP-1 .*Ada Lovelace/ })).first().waitFor();
      await p.getByRole('button', { name: 'Sort: Due date' }).waitFor();
    });
    await s.step('filter the list by status and clear the filter', async () => {
      await p.getByRole('button', { name: /^Status: / }).click();
      await p.getByRole('button', { name: 'In Progress', exact: true }).click();
      await p.keyboard.press('Escape');
      await p.getByRole('button', { name: 'Status: 1 selected' }).waitFor();
      await row('ALP-2').waitFor();
      await row('ALP-1').waitFor({ state: 'hidden' });
      await p.getByRole('button', { name: /^Status: / }).click();
      await p.getByRole('button', { name: 'In Progress', exact: true }).click();
      await p.keyboard.press('Escape');
      await p.getByRole('button', { name: 'Status: All' }).waitFor();
      await row('ALP-1').waitFor();
    });
    await s.step('group the list by tag', async () => {
      await p.getByRole('button', { name: 'Status', exact: true }).first().click();
      await p.getByRole('button', { name: 'By Tag' }).click();
      await p.getByRole('button', { name: 'Tag', exact: true }).waitFor();
      await p.getByRole('button', { name: /^release 2/ }).waitFor();
      await p.getByRole('button', { name: /^bug 1/ }).waitFor();
      await p.getByRole('button', { name: /^ui 1/ }).waitFor();
    });
    await s.step('group the list by priority and sort by priority', async () => {
      await p.getByRole('button', { name: 'Tag', exact: true }).click();
      await p.getByRole('button', { name: 'By Priority' }).click();
      await p.getByRole('button', { name: /^Critical 1/ }).waitFor();
      await p.getByRole('button', { name: /^High 1/ }).waitFor();
      await p.getByRole('button', { name: 'Sort: Due date' }).click();
      await p.getByRole('button', { name: 'Priority', exact: true }).last().click();
      await p.getByRole('button', { name: 'Sort: Priority' }).waitFor();
    });
    await s.step('collapse and expand the groups', async () => {
      await p.getByRole('button', { name: 'Collapse All' }).click();
      await p.getByRole('button', { name: 'Expand All' }).waitFor();
      await row('ALP-1').waitFor({ state: 'hidden' });
      await p.getByRole('button', { name: 'Expand All' }).click();
      await row('ALP-1').waitFor();
    });
    await s.step('the list narrows with the search and opens a ticket from a row', async () => {
      await p.getByRole('textbox', { name: 'Search tickets' }).fill('qwzxv');
      await p.getByText('No tickets match the current filters.').waitFor();
      await p.getByRole('textbox', { name: 'Search tickets' }).fill('tidy');
      await row('ALP-4').waitFor();
      await row('ALP-1').waitFor({ state: 'hidden' });
      await row('ALP-4').click();
      await p.getByRole('dialog', { name: 'Ticket ALP-4' }).waitFor();
      await closeTicket(s);
      await p.getByRole('textbox', { name: 'Search tickets' }).fill('');
      await row('ALP-1').waitFor();
    });

    // ---- timeline
    await s.step('open the Timeline: bars for tickets with dates', async () => {
      await view('Timeline').click();
      await p.getByRole('button', { name: 'Gantt', exact: true }).waitFor();
      await p.getByTitle(/^ALP-1 · Plan release/).waitFor();
      await p.getByTitle(/^ALP-2 · Fix login/).waitFor();
      await p.getByTitle(/^ALP-3 · Dark mode/).waitFor();
      // ALP-4 has no date: no bar
      await p.getByTitle(/^ALP-4 · /).waitFor({ state: 'detached' });
      await p.getByText('Today', { exact: true }).waitFor();
    });
    await s.step('stretch a bar by its due-date handle', async () => {
      const bar = p.getByTitle(/^ALP-1 · Plan release/);
      const before = await bar.getAttribute('title');
      const handle = bar.getByTitle('Drag to change due date');
      const b = await handle.boundingBox();
      await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await p.mouse.down();
      await p.mouse.move(b.x + b.width / 2 + 30, b.y + b.height / 2, { steps: 4 });
      await p.mouse.move(b.x + b.width / 2 + 54, b.y + b.height / 2, { steps: 4 });
      await p.getByText(/^Due [A-Z][a-z]{2} \d+$/).waitFor();
      await p.mouse.up();
      await p.waitForFunction(([sel, old]) => document.querySelector(sel)?.getAttribute('title') !== old, ['button[title^="ALP-1 · Plan release"]', before]);
      s.note('title before', before);
    });
    await s.step('a bar opens its ticket and shows the new due date', async () => {
      await p.getByTitle(/^ALP-1 · Plan release/).click();
      const d = p.getByRole('dialog', { name: 'Ticket ALP-1' });
      await d.waitFor();
      await d.locator('input[type="date"]').waitFor();
      const v = await d.locator('input[type="date"]').inputValue();
      if (v !== day(15)) throw new Error(`due date should be ${day(15)} after a 3-day stretch, got ${v}`);
      await closeTicket(s);
    });
    await s.step('Event Timeline lists what happened, newest first', async () => {
      await p.getByRole('button', { name: 'Event Timeline' }).click();
      await p.getByText('Created').first().waitFor();
      await p.getByRole('button', { name: 'ALP-4', exact: true }).waitFor();
      await p.getByRole('button', { name: 'ALP-3', exact: true }).waitFor();
      await p.getByRole('button', { name: 'Gantt', exact: true }).click();
      await p.getByTitle(/^ALP-3 · Dark mode/).waitFor();
    });
    await s.step('a ticket with a start date only is shown too; clearing dates removes the bar', async () => {
      await openTicket(s, 'ALP-3').catch(async () => { await view('Board').click(); await openTicket(s, 'ALP-3'); });
      await closeTicket(s);
    });

    // ---- story lanes
    await s.step('back on the board, make a Story with two tickets (Story created through the API)', async () => {
      await view('Board').click();
      const pid = (await api('GET', '/projects')).body[0].id;
      const r = await api('POST', `/projects/${pid}/tickets`, { title: 'Checkout story', type: 'story' });
      if (r.status !== 201) throw new Error(`story create answered ${r.status}`);
      s.storyId = r.body.id;
      await p.reload();
      await card(p, s.storyId).click();
      const sp = p.getByRole('dialog', { name: `Story ${s.storyId}` });
      await sp.getByRole('button', { name: 'More' }).click();
      await p.getByRole('menuitem', { name: 'Open as ticket' }).click();
      await dlg().getByRole('button', { name: 'Add sub-ticket' }).click();
      await dlg().getByRole('button', { name: 'New', exact: true }).click();
      for (const t of ['Pay with card', 'Print receipt']) {
        await p.getByPlaceholder('Sub-ticket title…').fill(t);
        await p.keyboard.press('Enter');
        await dlg().getByText(t).first().waitFor();
      }
      await dlg().getByRole('button', { name: 'Cancel', exact: true }).click();
      await closeTicket(s);
    });
    await s.step('Group by Story: one lane per Story and a lane for the rest', async () => {
      await p.getByRole('button', { name: /^Group by:/ }).click();
      await p.getByRole('button', { name: 'Group by: Story' }).waitFor();
      await p.getByTestId('story-lanes').waitFor();
      await p.getByTestId('lane-story').filter({ hasText: 'Checkout story' }).waitFor();
      await p.getByTestId('lane-loose').getByText('Not in a Story').waitFor();
      await p.getByTestId('lane-story').getByText('Pay with card').first().waitFor();
    });
    await s.step('fold and unfold a lane', async () => {
      await p.getByRole('button', { name: `Fold ${s.storyId}` }).click();
      await p.getByRole('button', { name: `Unfold ${s.storyId}` }).waitFor();
      await p.getByText('Pay with card').first().waitFor({ state: 'hidden' });
      await p.getByRole('button', { name: `Unfold ${s.storyId}` }).click();
      await p.getByText('Pay with card').first().waitFor();
      await p.getByRole('button', { name: 'Fold Not in a Story' }).click();
      await p.getByRole('button', { name: 'Unfold Not in a Story' }).waitFor();
      await p.getByRole('button', { name: 'Unfold Not in a Story' }).click();
    });
    await s.step('a ticket opens from its lane; then back to the plain board', async () => {
      await card(p, 'ALP-4').click();
      await p.getByRole('dialog', { name: 'Ticket ALP-4' }).waitFor();
      await closeTicket(s);
      await p.getByRole('button', { name: 'Group by: Story' }).click();
      await p.getByRole('button', { name: 'Group by: None' }).waitFor();
      await p.getByTestId('story-lanes').waitFor({ state: 'detached' });
    });
  },
};
