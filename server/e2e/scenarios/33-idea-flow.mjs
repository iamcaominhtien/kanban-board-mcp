import { ensureProject, createTicket, card as card_ } from '../lib/ui.mjs';

// Idea Space flows beyond 08 and 21: Quick idea (details, picture, sketch, canvas, duplicate), Triage with every
// dialog and Undo, merge and undo-merge, park-many, Assign, Choose a project, the Stages board (drag), the Evidence
// tab (ticket, note, sketch), Promote (split, edits), the idea seen from its ticket, and the outcome of a shipped idea.
export default {
  name: 'Idea flow: quick idea, triage, merge, undo, park many, assign, stages, evidence, promote, outcome',
  group: 'core',
  async run(s) {
    const p = s.page;
    const nav = () => p.getByRole('complementary', { name: 'Project navigation' });
    const view = (name) => p.getByRole('tablist', { name: 'View' }).getByRole('tab', { name });
    const sections = () => p.getByRole('tablist', { name: 'Idea sections' });
    const quick = () => p.getByTestId('quick-add');
    // One call to the REST API from the page, as the UI itself does.
    const api = (method, path, body) => p.evaluate(async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    }, [method, path, body]);
    const idea = async (id) => (await api('GET', `/api/idea-tickets/${id}`)).body;
    const fail = (m) => { throw new Error(m); };
    const expect = (cond, m) => { if (!cond) fail(m); };
    const mk = async (title, extra = {}) => {
      const r = await api('POST', '/api/idea-tickets', { title, project_id: await projectId('ALP'), ...extra });
      expect(r.status < 300, `create ${title}: ${r.status}`);
      return r.body;
    };
    const toastClose = async () => {
      // a toast covers footers and stops its own timer while the pointer is over it: close every one that is open
      for (const b of await p.getByRole('button', { name: 'Close notification' }).all()) await b.click().catch(() => {});
    };
    const openSpace = async (scope) => {
      if (!(await p.getByTestId('idea-space').count())) await p.getByRole('button', { name: 'Idea Space' }).click();
      await p.getByTestId('idea-space').waitFor();
      if (await p.getByTestId('triage').count()) await p.getByTestId('triage-back').click();
      if (await p.getByTestId('idea-page').count()) await p.getByRole('button', { name: 'Back to Idea Space' }).click();
      await view('List').click();
      if (scope) {
        await p.getByTestId('idea-switcher').click();
        await p.getByRole('menuitemradio', { name: new RegExp(`^${scope}`) }).click();
      }
    };
    const filter = async (name) => { await p.getByRole('button', { name: new RegExp(`^${name}`) }).first().click(); };
    const dateIn = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
    const inbox = () => p.getByRole('complementary', { name: 'Inbox' });
    const focus = () => p.getByRole('region', { name: 'Idea in focus' });
    const pick = async (title) => {
      await inbox().getByRole('button', { name: new RegExp(`^${title}\\s+(?:No project\\s+)?(You|from|just|\\d)`) }).click();
      await focus().getByRole('heading', { name: title, exact: true }).waitFor();
    };
    const dialog = (name) => p.getByRole('dialog', { name });
    const projectId = async (prefix) => (await api('GET', '/projects')).body.find((x) => x.prefix === prefix).id;
    const reload = async () => {
      await p.reload();
      await p.getByRole('complementary', { name: 'Project navigation' }).waitFor({ timeout: 20000 });
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await p.getByTestId('idea-space').waitFor();
    };
    const col = (stage) => p.getByTestId(`stage-col-${stage}`);
    const card = (id) => p.getByTestId(`idea-card-${id}`);
    const drag = async (id, stage) => { await card(id).dragTo(col(stage)); };
    const stageOf = async (id) => (await idea(id)).stage;
    const waitStage = (id, stage) => p.waitForFunction(async ([i, st]) => (await (await fetch(`/api/idea-tickets/${i}`)).json()).stage === st, [id, stage]);
    const row = (id) => p.getByTestId(`idea-row-${id}`);

    await s.step('set up: projects Alpha and Beta, the Idea Space is empty', async () => {
      await ensureProject(s);
      await nav().getByRole('button', { name: 'New Project' }).click();
      await p.getByPlaceholder('Project name').fill('Beta Project');
      await p.getByPlaceholder('Prefix (e.g. PROJ)').fill('bet');
      await p.getByRole('button', { name: 'Create', exact: true }).click();
      await nav().getByRole('button', { name: 'Beta Project BET' }).waitFor();
      await nav().getByRole('button', { name: 'Alpha ALP' }).click();
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await p.getByRole('heading', { name: 'No ideas here yet' }).waitFor();
    });

    // ---- Quick idea
    await s.step('Quick idea: the Markdown hint appears with "Add details or paste a picture"; the idea keeps its details', async () => {
      await p.getByTestId('new-idea').click();
      await quick().waitFor();
      expect(!(await quick().getByRole('textbox', { name: 'Details' }).count()) && !(await quick().locator('textarea').count()), 'details should start closed');
      await quick().getByRole('textbox', { name: 'Idea title' }).fill('Offline mode for the board');
      await quick().getByRole('button', { name: 'Add details or paste a picture' }).click();
      const box = quick().locator('textarea');
      await box.waitFor();
      expect((await box.getAttribute('placeholder')) === 'Markdown. Paste a screenshot with Ctrl+V.', 'the Markdown hint is missing');
      await quick().getByRole('button', { name: 'Add details or paste a picture' }).waitFor({ state: 'detached' });
      await box.fill('Work on a train without signal.\n\n- queue edits\n- sync later');
      await quick().getByRole('button', { name: 'Add to Inbox' }).click();
      await p.getByText('Added IDEA-1 to the Inbox').waitFor();
      const i = await idea('IDEA-1');
      expect(i.stage === 'inbox' && /queue edits/.test(i.description || i.body), 'details not saved: ' + JSON.stringify(i.description));
      expect(i.project_id, 'the idea should start in the project you are in: ' + JSON.stringify(i));
      await toastClose();
    });
    await s.step('Quick idea: a similar idea shows "Add to it instead", which adds a comment and a +1', async () => {
      await p.getByTestId('new-idea').click();
      await quick().waitFor();
      await quick().getByRole('textbox', { name: 'Idea title' }).fill('Offline mode for the board');
      const hint = quick().getByRole('status');
      await hint.getByText(/Looks like/).waitFor();
      await hint.getByText(/Offline mode for the board/).waitFor();
      await hint.getByRole('button', { name: 'Add to it instead' }).click();
      await p.getByText('Added to IDEA-1').waitFor();
      await quick().waitFor({ state: 'detached' });
      const c = (await api('GET', '/api/idea-tickets/IDEA-1/comments')).body;
      expect(c.length === 1 && /Offline mode for the board/.test(c[0].body), 'the text should be a comment: ' + JSON.stringify(c));
      expect((await idea('IDEA-1')).voters.length === 1, 'the +1 is missing');
      expect((await api('GET', '/api/idea-tickets/space?scope=all')).body.length === 1, 'no second idea may be created');
      await toastClose();
    });

    await s.step('Quick idea: "Start with a sketch" draws in the editor and puts the sketch in the details; the source becomes picture', async () => {
      await p.getByTestId('new-idea').click();
      await quick().getByRole('textbox', { name: 'Idea title' }).fill('Sketch of the sync screen');
      await quick().getByRole('button', { name: 'Start with a sketch' }).click();
      await p.getByRole('button', { name: 'Start drawing' }).click();
      const cv = p.locator('[data-testid="sketch-editor"] canvas').first();
      await cv.waitFor();
      const bb = await cv.boundingBox();
      await p.mouse.move(bb.x + 120, bb.y + 140);
      await p.mouse.down();
      await p.mouse.move(bb.x + 320, bb.y + 240, { steps: 10 });
      await p.mouse.move(bb.x + 220, bb.y + 340, { steps: 10 });
      await p.mouse.up();
      const ed = p.getByTestId('sketch-editor');
      await ed.getByRole('textbox', { name: 'Name of the sketch' }).fill('Sync screen');
      await ed.getByRole('button', { name: 'Done' }).click();
      await ed.waitFor({ state: 'detached' });
      const box = quick().locator('textarea');
      await box.waitFor();
      await p.waitForFunction(() => /sketch:sk_[0-9a-f]{8}/.test(document.querySelector('[data-testid="quick-add"] textarea')?.value || ''));
      expect(/Sync screen/.test(await box.inputValue()), 'the sketch line should carry its name');
      await quick().getByRole('button', { name: 'Add to Inbox' }).click();
      await p.getByText(/Added IDEA-2 to the Inbox/).waitFor();
      const i = await idea('IDEA-2');
      expect(i.source === 'picture', 'source should be picture, got ' + i.source);
      expect(/sketch:sk_/.test(i.description), 'the sketch is not in the idea');
      await toastClose();
    });
    await s.step('Quick idea: "Start with a canvas" makes a board and puts it in the details', async () => {
      await p.getByTestId('new-idea').click();
      await quick().getByRole('textbox', { name: 'Idea title' }).fill('Canvas of the sharing flow');
      await quick().getByRole('button', { name: 'Start with a canvas' }).click();
      await p.getByPlaceholder('Login redesign').fill('Share flow');
      await p.getByRole('button', { name: 'Create canvas' }).click();
      const cv = p.getByRole('dialog', { name: 'Canvas Share flow' });
      await cv.waitFor();
      await cv.getByRole('button', { name: 'Done' }).click();
      await cv.waitFor({ state: 'detached' });
      await p.waitForFunction(() => /canvas:cv_[0-9a-f]{8}/.test(document.querySelector('[data-testid="quick-add"] textarea')?.value || ''));
      await quick().getByRole('button', { name: 'Add to Inbox' }).click();
      await p.getByText(/Added IDEA-3 to the Inbox/).waitFor();
      const i = await idea('IDEA-3');
      expect(i.source === 'picture' && /canvas:cv_/.test(i.description), 'canvas idea: ' + i.source);
      await toastClose();
    });
    await s.step('Quick idea: pasting a picture uploads it into the details', async () => {
      await p.getByTestId('new-idea').click();
      await quick().getByRole('textbox', { name: 'Idea title' }).fill('Screenshot of the slow board');
      await quick().getByRole('button', { name: 'Add details or paste a picture' }).click();
      const box = quick().locator('textarea');
      await box.waitFor();
      await box.evaluate(async (el) => {
        const c = document.createElement('canvas');
        c.width = 8; c.height = 8;
        const g = c.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 8, 8);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'slow.png', { type: 'image/png' }));
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      await p.waitForFunction(() => /\]\(.+\)/.test(document.querySelector('[data-testid="quick-add"] textarea')?.value || ''));
      await quick().getByRole('button', { name: 'Add to Inbox' }).click();
      await p.getByText(/Added IDEA-4 to the Inbox/).waitFor();
      const i = await idea('IDEA-4');
      expect(i.source === 'picture' && /!\[/.test(i.description), 'picture idea: ' + i.source + ' ' + i.description);
      await toastClose();
    });

    // ---- Triage
    await s.step('more ideas for the Inbox: one without a project, one close to the first', async () => {
      await mk('Dark theme for the editor', { project_id: null });
      await mk('Weekly digest email of what changed');
      await mk('Offline mode for the board app');
      // ideas made by a direct call are not announced to this page: reload to read them
      await reload();
      await openSpace('All projects');
      await p.getByTestId('inbox-button').click();
      await p.getByRole('heading', { name: 'Triage' }).waitFor();
      await inbox().getByText('7 to sort').waitFor();
    });
    await s.step('Triage: a possible duplicate offers "Merge into it"; the merge dialog finds the target by search', async () => {
      await pick('Offline mode for the board app');
      // two ideas carry this title (IDEA-1 and the new IDEA-7): the focus is the newest
      const dup = p.getByTestId('duplicate');
      await dup.getByText(/Possible duplicate · \d+% similar/).waitFor();
      await dup.getByRole('button', { name: 'Merge into it' }).click();
      const d = dialog('Merge into another idea');
      await d.waitFor();
      await d.getByRole('button', { name: 'Merge', exact: true }).isDisabled();
      expect(await d.getByRole('button', { name: 'Merge', exact: true }).isDisabled(), 'Merge needs a target');
      await d.getByRole('textbox', { name: 'Search ideas' }).fill('Offline');
      const choices = d.getByRole('radiogroup', { name: 'Idea to merge into' }).getByRole('radio');
      await choices.first().waitFor();
      await choices.filter({ hasText: /Offline mode for the board(?! app)/ }).first().click();
      await d.getByRole('button', { name: 'Merge', exact: true }).click();
      await p.getByText(/^Merged “Offline mode for the board app” into IDEA-/).waitFor();
      const merged = (await api('GET', '/api/idea-tickets/IDEA-7')).body;
      expect(merged.stage === 'archived' && merged.merged_into_id === 'IDEA-1', 'IDEA-7 should be merged into IDEA-1: ' + merged.stage + ' ' + merged.merged_into_id);
    });
    await s.step('the toast\'s Undo undoes the merge: the idea is back in the Inbox', async () => {
      await p.getByRole('alert').filter({ hasText: /^Merged/ }).getByRole('button', { name: 'Undo' }).click();
      await inbox().getByText(/\d+ to sort/).waitFor();
      await p.waitForFunction(async () => (await (await fetch('/api/idea-tickets/IDEA-7')).json()).stage === 'inbox');
      const back = await idea('IDEA-7');
      expect(!back.merged_into_id, 'merged_into_id should be cleared');
      await toastClose();
    });
    await s.step('Triage: Archive IDEA-7 as "Already exists", with a note; Z undoes it', async () => {
      await pick('Offline mode for the board app');
      await p.getByTestId('decide-archive').click();
      const d = dialog('Archive this idea');
      await d.getByRole('button', { name: 'Archive', exact: true }).isDisabled();
      expect(await d.getByRole('button', { name: 'Archive', exact: true }).isDisabled(), 'Archive needs a reason');
      await d.getByRole('radio', { name: 'Already exists' }).click();
      await d.getByRole('textbox').fill('Same as IDEA-1');
      await d.getByRole('button', { name: 'Archive', exact: true }).click();
      await p.getByText('Archived “Offline mode for the board app”').waitFor();
      let i = await idea('IDEA-7');
      expect(i.stage === 'archived' && i.archive_reason === 'already_exists' && i.archive_note === 'Same as IDEA-1', 'archive: ' + JSON.stringify([i.stage, i.archive_reason, i.archive_note]));
      await toastClose();
      await p.getByRole('region', { name: 'Idea in focus' }).click({ position: { x: 5, y: 5 } });
      await p.keyboard.press('z');
      await p.getByText('Undone').waitFor();
      await p.waitForFunction(async () => (await (await fetch('/api/idea-tickets/IDEA-7')).json()).stage === 'inbox');
      i = await idea('IDEA-7');
      expect(!i.archive_reason, 'the reason should be cleared after undo');
      await toastClose();
    });
    await s.step('Triage: Park with "Next week", then Undo from the toast; park again with a picked date', async () => {
      await pick('Weekly digest email of what changed');
      await p.getByTestId('decide-park').click();
      let d = dialog('Park this idea');
      await d.getByRole('button', { name: 'Next week' }).click();
      await d.getByRole('textbox', { name: 'Why now is a bad time' }).or(d.getByPlaceholder('Why now is a bad time')).fill('After the release');
      await d.getByRole('button', { name: 'Park', exact: true }).click();
      await p.getByText(`Parked “Weekly digest email of what changed” until ${dateIn(7)}`).waitFor();
      let i = await idea('IDEA-6');
      expect(i.stage === 'parked' && String(i.park_until).startsWith(dateIn(7)), 'park: ' + i.stage + ' ' + i.park_until);
      await p.getByRole('alert').filter({ hasText: /^Parked/ }).getByRole('button', { name: 'Undo' }).click();
      await p.waitForFunction(async () => (await (await fetch('/api/idea-tickets/IDEA-6')).json()).stage === 'inbox');
      await toastClose();
      await pick('Weekly digest email of what changed');
      await p.getByTestId('decide-park').click();
      d = dialog('Park this idea');
      await d.getByTestId('park-pick-date').click();
      await d.getByLabel('Pick a date').fill(dateIn(45));
      await d.getByRole('button', { name: 'Park', exact: true }).click();
      await p.getByText(`Parked “Weekly digest email of what changed” until ${dateIn(45)}`).waitFor();
      i = await idea('IDEA-6');
      expect(i.stage === 'parked' && String(i.park_until).startsWith(dateIn(45)), 'park: ' + i.stage + ' ' + i.park_until);
      await toastClose();
    });
    await s.step('Triage: Keep with another project and a tag; the idea moves to Exploring there', async () => {
      await pick('Sketch of the sync screen');
      await p.getByTestId('decide-keep').click();
      const d = dialog('Keep this idea');
      await d.getByLabel('Project', { exact: true }).selectOption({ label: 'Beta Project (BET)' });
      await d.getByRole('textbox', { name: 'Add a tag' }).fill('sync');
      await d.getByRole('textbox', { name: 'Add a tag' }).press('Enter');
      await d.getByRole('button', { name: 'Keep', exact: true }).click();
      await p.getByText(/^Kept “Sketch of the sync screen”/).waitFor();
      const i = await idea('IDEA-2');
      expect(i.stage === 'exploring' && i.project_id === (await projectId('BET')) && i.tags.includes('sync'), 'keep: ' + JSON.stringify([i.stage, i.project_id, i.tags]));
      await toastClose();
    });
    await s.step('Triage: keep the rest by the K key; the two without a project stay without one', async () => {
      for (const title of ['Dark theme for the editor', 'Canvas of the sharing flow', 'Screenshot of the slow board', 'Offline mode for the board app', 'Offline mode for the board']) {
        await pick(title);
        await p.getByRole('heading', { name: 'Triage' }).click();
        await p.keyboard.press('k');
        const d = dialog('Keep this idea');
        await d.waitFor();
        await d.getByRole('button', { name: 'Keep', exact: true }).click();
        await d.waitFor({ state: 'detached' });
        await toastClose();
      }
      await p.getByTestId('inbox-empty').waitFor();
      await p.getByTestId('inbox-empty').getByText(/You sorted \d+ ideas this week: .*kept/).waitFor();
      const all = (await api('GET', '/api/idea-tickets/space?scope=all')).body;
      expect(all.filter((x) => x.stage === 'exploring').length === 6, 'six ideas should be exploring: ' + all.map((x) => x.id + x.stage));
    });

    await s.step('Triage: ideas waiting more than 14 days: "Park all for a month" parks them in one call', async () => {
      await mk('Old idea about export');
      await mk('Old idea about import');
      // the page runs 20 days ahead of the server, so what was just made has been waiting for three weeks
      // (the clock belongs to a browser context, so this page gets a context of its own)
      const ctx = await s.browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-US', timezoneId: 'UTC' });
      ctx.setDefaultTimeout(8000);
      const q = await ctx.newPage();
      try {
        await q.clock.setFixedTime(new Date(Date.now() + 20 * 86400000));
        await q.goto(s.server.base);
        await q.getByRole('button', { name: 'Idea Space' }).click();
        await q.getByTestId('idea-space').waitFor();
        await q.getByTestId('inbox-button').click();
        const banner = q.getByRole('status').filter({ hasText: /have been waiting more than 14 days/ });
        await banner.getByText('2 ideas').waitFor();
        const calls = [];
        q.on('request', (r) => { if (/park-many/.test(r.url())) calls.push(r.postData()); });
        await banner.getByRole('button', { name: 'Park all for a month' }).click();
        await q.getByText('Parked 2 ideas for a month').waitFor();
        expect(calls.length === 1 && /Old idea|IDEA-/.test(calls[0] || '') && /park_until/.test(calls[0]), 'one park-many call expected: ' + JSON.stringify(calls));
        await q.getByTestId('inbox-empty').waitFor();
      } finally { await ctx.close(); }
      const all = (await api('GET', '/api/idea-tickets/space?scope=all&stage=parked')).body;
      const old = all.filter((x) => /^Old idea/.test(x.title));
      expect(old.length === 2 && old.every((x) => x.stage === 'parked' && x.park_until), 'both old ideas should be parked: ' + JSON.stringify(old.map((x) => [x.id, x.stage, x.park_until])));
    });

    // ---- the list, the idea page
    await s.step('List, All projects: "Assign" puts an idea without a project into one', async () => {
      const i = await mk('Billing by seat', { project_id: null });
      expect((await api('POST', `/api/idea-tickets/${i.id}/stage`, { to: 'exploring', via: 'Keep' })).status < 300, 'move to Exploring');
      await reload();
      await openSpace('All projects');
      await filter('Exploring');
      const r = row(i.id);
      await r.waitFor();
      await r.getByRole('button', { name: 'Assign' }).click();
      await r.getByLabel('Project', { exact: true }).selectOption({ label: 'Beta Project (BET)' });
      await r.getByText('Beta Project', { exact: true }).waitFor();
      await r.getByRole('button', { name: 'Assign' }).waitFor({ state: 'detached' });
      expect((await idea(i.id)).project_id === (await projectId('BET')), 'the idea should be in Beta now');
      // the one that is already in a project has no Assign
      await row('IDEA-1').getByText('Alpha', { exact: true }).waitFor();
      expect(!(await row('IDEA-1').getByRole('button', { name: 'Assign' }).count()), 'Assign only for ideas without a project');
      // the other one without a project still offers it
      await row('IDEA-5').getByRole('button', { name: 'Assign' }).waitFor();
    });
    await s.step('idea page: "Choose a project" for an idea that is in none', async () => {
      await openSpace('No project');
      await filter('Exploring');
      await row('IDEA-5').click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
      await p.getByText('This idea is not in a project').waitFor();
      await p.getByText('Choose a project, then promote.').waitFor();
      await p.getByRole('button', { name: 'Choose a project', exact: true }).click();
      await p.getByRole('combobox', { name: 'Choose a project' }).selectOption({ label: 'Alpha' });
      await p.getByText('This idea is not in a project').waitFor({ state: 'detached' });
      expect((await idea('IDEA-5')).project_id === (await projectId('ALP')), 'IDEA-5 should be in Alpha');
      await p.getByText(/Promote creates one in Alpha/).waitFor();
    });
    await s.step('idea page: "Merge into another idea…" from More actions, then Undo from the toast', async () => {
      await p.getByRole('button', { name: 'Back to Idea Space' }).click();
      await openSpace('Alpha');
      await filter('Exploring');
      await row('IDEA-7').click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
      await p.getByRole('button', { name: 'More actions' }).click();
      await p.getByRole('menuitem', { name: 'Merge into another idea…' }).click();
      const d = dialog('Merge into another idea');
      await d.getByRole('textbox', { name: 'Search ideas' }).fill('Offline');
      const choices = d.getByRole('radiogroup', { name: 'Idea to merge into' }).getByRole('radio');
      await choices.filter({ hasText: /Offline mode for the board(?! app)/ }).first().click();
      await d.getByRole('button', { name: 'Merge', exact: true }).click();
      await p.getByText('Merged “Offline mode for the board app” into IDEA-1').waitFor();
      let i = await idea('IDEA-7');
      expect(i.stage === 'archived' && i.merged_into_id === 'IDEA-1', 'merge from the page: ' + i.stage + ' ' + i.merged_into_id);
      await p.getByText('merged into', { exact: true }).waitFor();
      expect((await idea('IDEA-1')).voters.length >= 1, 'merging counts as a +1');
      await p.getByRole('alert').filter({ hasText: /^Merged/ }).getByRole('button', { name: 'Undo' }).click();
      await p.waitForFunction(async () => (await (await fetch('/api/idea-tickets/IDEA-7')).json()).stage === 'exploring');
      i = await idea('IDEA-7');
      expect(!i.merged_into_id, 'undo-merge clears merged_into_id');
      await p.getByText('merged into', { exact: true }).waitFor({ state: 'detached' });
      await toastClose();
    });

    // ---- the Stages board
    await s.step('Stages: the columns hold the ideas by stage; drag to Parked opens the Park dialog, Undo brings it back', async () => {
      await p.getByRole('button', { name: 'Back to Idea Space' }).click().catch(() => {});
      await openSpace('Alpha');
      await view('Stages').click();
      await p.getByRole('list', { name: 'Stages' }).waitFor();
      await col('exploring').getByTestId('idea-card-IDEA-3').waitFor();
      await col('parked').getByTestId('idea-card-IDEA-6').waitFor();
      await col('building').getByText('Promoted. Follows the ticket.').waitFor();
      expect(!(await col('building').getByText('Drop an idea here').count()), 'Building cannot take a dropped idea by hand');
      await drag('IDEA-3', 'parked');
      const d = dialog('Park this idea');
      await d.waitFor();
      await d.getByRole('button', { name: 'In a month' }).click();
      await d.getByRole('button', { name: 'Park', exact: true }).click();
      await col('parked').getByTestId('idea-card-IDEA-3').waitFor();
      { const pu = String((await idea('IDEA-3')).park_until); expect(pu.startsWith(dateIn(30)), 'parked for a month: ' + pu + ' vs ' + dateIn(30)); }
      await col('parked').getByTestId('idea-card-IDEA-3').getByText(/^Back /).waitFor();
      await p.getByRole('alert').filter({ hasText: /^Parked/ }).getByRole('button', { name: 'Undo' }).click();
      await col('exploring').getByTestId('idea-card-IDEA-3').waitFor();
      expect((await stageOf('IDEA-3')) === 'exploring', 'Undo moves it back');
      await toastClose();
    });
    await s.step('Stages: Building and Shipped refuse a drop; Shipped says why', async () => {
      await drag('IDEA-3', 'shipped');
      await p.getByText('Shipped follows the ticket').waitFor();
      expect((await stageOf('IDEA-3')) === 'exploring', 'still exploring');
      await toastClose();
      // Building is reached by Promote: the dialog opens, nothing is created until Create
      await drag('IDEA-3', 'building');
      const d = dialog('Promote to ticket');
      await d.waitFor();
      await d.getByRole('button', { name: 'Cancel' }).click();
      await d.waitFor({ state: 'detached' });
      expect((await stageOf('IDEA-3')) === 'exploring', 'Cancel keeps it');
    });
    await s.step('Stages: a parked idea dropped on Exploring comes back at once', async () => {
      await drag('IDEA-6', 'exploring');
      await col('exploring').getByTestId('idea-card-IDEA-6').waitFor();
      expect((await stageOf('IDEA-6')) === 'exploring', 'IDEA-6 exploring');
      await p.getByText('Moved “Weekly digest email of what changed” to Exploring').waitFor();
      await toastClose();
    });
    await s.step('Stages: a move to Ready with an open high-impact assumption asks first; Cancel, then Move anyway, then Undo', async () => {
      const a = await api('POST', '/api/idea-tickets/IDEA-4/assumption-records', { text: 'The picture really is slow', impact: 'high' });
      expect(a.status < 300, 'assumption: ' + a.status);
      await reload();
      await openSpace('Alpha');
      await view('Stages').click();
      await card('IDEA-4').waitFor();
      await drag('IDEA-4', 'ready');
      const d = dialog('Move without the checks');
      await d.getByText(/Not every high-impact assumption/).waitFor();
      await d.getByRole('button', { name: 'Cancel' }).click();
      await d.waitFor({ state: 'detached' });
      expect((await stageOf('IDEA-4')) === 'exploring', 'Cancel keeps it exploring');
      await drag('IDEA-4', 'ready');
      await d.getByRole('button', { name: 'Move anyway' }).click();
      await col('ready').getByTestId('idea-card-IDEA-4').waitFor();
      expect((await stageOf('IDEA-4')) === 'ready', 'forced to ready');
      const log = (await api('GET', '/api/idea-tickets/IDEA-4/activity')).body;
      expect(JSON.stringify(log).includes('exploring → ready without the checks'), 'the move is recorded in the history: ' + JSON.stringify(log).slice(0, 600));
      await p.getByRole('alert').filter({ hasText: /to Ready/ }).getByRole('button', { name: 'Undo' }).click();
      await col('exploring').getByTestId('idea-card-IDEA-4').waitFor();
      expect((await stageOf('IDEA-4')) === 'exploring', 'Undo of a move');
      await toastClose();
    }, { expectConsole: true }); // the first move is refused (409): the idea has an open high-impact assumption

    // ---- evidence
    await s.step('Evidence: a ticket as evidence for an assumption', async () => {
      // the Idea Space entry of the sidebar toggles: a second click goes back to the board
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
      await createTicket(s, { title: 'Measure the board load time' });
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await p.getByTestId('idea-space').waitFor();
      if (await p.getByTestId('idea-page').count()) await p.getByRole('button', { name: 'Back to Idea Space' }).click();
      await view('List').click();
      await filter('Exploring');
      await row('IDEA-4').click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
      await sections().getByRole('tab', { name: /^Evidence/ }).click();
      const tab = p.getByTestId('evidence-tab');
      await tab.getByRole('heading', { name: 'No evidence yet' }).waitFor();
      const form = tab.getByTestId('evidence-form');
      // one assumption only: it is chosen for you, there are no checkboxes
      expect(!(await form.getByRole('checkbox').count()), 'a single assumption needs no checkbox');
      await form.getByRole('combobox', { name: 'Kind of evidence' }).selectOption({ label: 'Ticket' });
      expect((await form.getByRole('textbox', { name: 'Evidence' }).getAttribute('placeholder')) === 'KAN-198', 'the ticket placeholder');
      await form.getByRole('textbox', { name: 'Evidence' }).fill('ALP-1');
      await form.getByRole('textbox', { name: 'Title' }).fill('Load time measurement');
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      const item = tab.getByRole('list', { name: 'Evidence' }).getByRole('listitem').filter({ hasText: 'Load time measurement' });
      await item.getByText(/Ticket · used by 1 assumption/).waitFor();
      await item.getByText('Supports: The picture really is slow').waitFor();
      const ev = (await api('GET', '/api/idea-tickets/IDEA-4/evidence')).body;
      expect(ev.length === 1 && ev[0].kind === 'ticket' && ev[0].ref === 'ALP-1', 'ticket evidence: ' + JSON.stringify(ev));
      await sections().getByRole('tab', { name: /^Evidence 1/ }).waitFor();
    });
    await s.step('Evidence: a note, then "Draw a sketch" adds a sketch as evidence with a thumbnail', async () => {
      const tab = p.getByTestId('evidence-tab');
      const form = tab.getByTestId('evidence-form');
      await form.getByRole('combobox', { name: 'Kind of evidence' }).selectOption({ label: 'Note' });
      expect(!(await form.getByRole('button', { name: 'Draw a sketch' }).count()), 'Draw a sketch is for the Sketch kind');
      await form.getByRole('textbox', { name: 'Evidence' }).fill('Support says the board takes ten seconds');
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      await tab.getByRole('listitem').filter({ hasText: 'Support says the board takes ten seconds' }).getByText(/Note · used by 1 assumption/).waitFor();
      await form.getByRole('combobox', { name: 'Kind of evidence' }).selectOption({ label: 'Sketch' });
      await form.getByRole('button', { name: 'Draw a sketch' }).click();
      await p.getByRole('button', { name: 'Start drawing' }).click();
      const cv = p.locator('[data-testid="sketch-editor"] canvas').first();
      await cv.waitFor();
      const bb = await cv.boundingBox();
      await p.mouse.move(bb.x + 100, bb.y + 120);
      await p.mouse.down();
      await p.mouse.move(bb.x + 300, bb.y + 200, { steps: 10 });
      await p.mouse.up();
      const ed = p.getByTestId('sketch-editor');
      await ed.getByRole('textbox', { name: 'Name of the sketch' }).fill('Slow board timeline');
      await ed.getByRole('button', { name: 'Done' }).click();
      await ed.waitFor({ state: 'detached' });
      const thumb = tab.getByRole('img', { name: 'Slow board timeline' });
      await thumb.waitFor();
      await tab.getByRole('listitem').filter({ has: p.getByRole('img', { name: 'Slow board timeline' }) }).getByText(/Sketch · used by 1 assumption/).waitFor();
      const ev = (await api('GET', '/api/idea-tickets/IDEA-4/evidence')).body;
      expect(ev.length === 3 && ev.some((e) => e.kind === 'sketch' && /sketch:sk_/.test(e.ref)), 'sketch evidence: ' + JSON.stringify(ev.map((e) => e.kind)));
      await sections().getByRole('tab', { name: /^Evidence 3/ }).waitFor();
    });

    // ---- Promote
    await s.step('Promote from the idea page: carried items, the not-fully-tested check, one ticket with two sub-tickets', async () => {
      await p.getByRole('tab', { name: 'Page', exact: true }).click().catch(() => {});
      await p.getByTestId('promote').click();
      const d = dialog('Promote to ticket');
      await d.waitFor();
      await d.getByText('What comes with it').waitFor();
      await d.getByText(/^Open assumptions \(1\)/).waitFor();
      await d.getByText(/^Evidence \(3\)/).waitFor();
      await d.getByText('Still to check (becomes the ticket’s checklist)').waitFor();
      await d.getByText('The picture really is slow').waitFor();
      // not fully tested: Create stays off until the box is ticked
      const create = d.getByTestId('create-ticket');
      await d.getByTestId('not-ready').getByText(/Not fully tested\./).waitFor();
      expect(await create.isDisabled(), 'Create ticket should wait for the acknowledgement');
      await d.getByText('Tick this to turn on Create ticket.').waitFor();
      await d.getByRole('button', { name: 'Ticket with sub-tickets' }).click();
      expect(await create.isDisabled(), 'a split needs a sub-ticket title');
      await d.getByRole('textbox', { name: 'Sub-ticket 1' }).fill('Profile the board');
      await d.getByRole('button', { name: '+ Add a sub-ticket' }).click();
      await d.getByRole('textbox', { name: 'Sub-ticket 2' }).fill('Cache the images');
      await d.getByRole('textbox', { name: 'Ticket title' }).fill('Make the board fast');
      await d.locator('.is-promote-row select').nth(0).selectOption('bug');
      await d.locator('.is-promote-row select').nth(1).selectOption('high');
      await d.locator('.is-promote-row select').nth(2).selectOption('todo');
      await d.getByTestId('description-edit').click();
      const desc = d.getByRole('textbox', { name: 'Ticket description' });
      await desc.press('Control+End');
      await desc.pressSequentially('\n\nAcceptance: under two seconds.');
      await d.getByTestId('description-edit').click();
      await d.getByTestId('description-preview').getByText('Acceptance: under two seconds.').waitFor();
      await d.getByRole('checkbox', { name: 'I understand, promote anyway' }).check();
      expect(!(await create.isDisabled()), 'Create ticket should be on');
      await d.getByText('Creates a ticket in Alpha · To do').waitFor();
      await create.scrollIntoViewIfNeeded();
      await create.click();
      await p.getByText('Created ALP-2').waitFor();
      await d.waitFor({ state: 'detached' });
      const t = (await api('GET', '/tickets/ALP-2')).body;
      expect(t.title === 'Make the board fast' && t.type === 'bug' && t.priority === 'high' && t.status === 'todo', 'ticket: ' + JSON.stringify([t.title, t.type, t.priority, t.status]));
      expect(/Acceptance: under two seconds\./.test(t.description), 'the edited description is used');
      expect((await api('GET', '/tickets/ALP-3')).body.title === 'Profile the board' && (await api('GET', '/tickets/ALP-4')).body.title === 'Cache the images', 'sub-tickets exist');
      const i = await idea('IDEA-4');
      expect(i.stage === 'building', 'the idea is Building: ' + i.stage);
      await toastClose();
      await p.getByTestId('promoted-card').getByText('ALP-2', { exact: true }).waitFor();
    });
    await s.step('the idea is shown on its ticket: "Started as an idea" in the modal, and the bulb on the card', async () => {
      await p.getByTestId('promoted-card').getByRole('button', { name: 'Open ticket' }).click();
      const m = p.getByRole('dialog', { name: 'Ticket ALP-2' });
      await m.waitFor();
      const box = m.getByTestId('started-as-idea');
      await box.waitFor();
      await box.getByRole('button', { name: 'IDEA-4', exact: true }).waitFor();
      await box.getByText('To check before closing').waitFor();
      await box.getByText('The picture really is slow').waitFor();
      await box.getByText(/no test yet/).waitFor();
      const byTicket = (await api('GET', '/api/idea-tickets/by-ticket/ALP-2')).body;
      expect(byTicket.from_idea && byTicket.from_idea.id === 'IDEA-4', 'by-ticket: ' + JSON.stringify(byTicket).slice(0, 300));
      await box.getByRole('button', { name: /^Idea log/ }).click();
      await p.getByTestId('idea-page').waitFor();
      await p.getByTestId('tab-log').waitFor();
      await p.getByRole('tab', { name: 'Page', exact: true }).waitFor();
    });
    await s.step('the lightbulb on a board card says where the ticket came from and opens the idea', async () => {
      await nav().getByRole('button', { name: 'Idea Space' }).click();
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
      const c = p.getByRole('button', { name: /ALP-2 / }).first();
      await c.waitFor();
      const bulb = c.getByTestId('idea-bulb');
      // a hovered card makes room for its "..." button (the ID slides 28 px left, over 0.15 s): hover the card first,
      // and the bulb only once it has stopped moving, as a person does
      await c.hover({ position: { x: 20, y: 40 } });
      await p.waitForFunction(() => {
        const r = document.querySelector('[data-testid="idea-bulb"]').getBoundingClientRect();
        const k = `${r.x},${r.y}`;
        const same = window.__bulb === k;
        window.__bulb = k;
        return same;
      }, null, { polling: 100 });
      await bulb.hover();
      const tip = p.getByRole('tooltip').filter({ hasText: 'Started as an idea' });
      await tip.waitFor();
      await tip.getByText(/0 of 1 assumptions checked/).waitFor();
      await tip.getByRole('button', { name: 'Open the idea' }).click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
      expect((await p.getByRole('textbox', { name: 'Idea title' }).inputValue()) === 'Screenshot of the slow board', 'IDEA-4 should open');
    });

    await s.step('Stages: Promote on a Ready card makes one ticket; the card moves to Building with the ticket on it', async () => {
      await p.getByRole('button', { name: 'Back to Idea Space' }).click();
      await openSpace('Alpha');
      await view('Stages').click();
      await card('IDEA-3').waitFor();
      await drag('IDEA-3', 'ready');
      // an idea without any assumption is not "tested" either: the move asks first
      await dialog('Move without the checks').getByRole('button', { name: 'Move anyway' }).click();
      await col('ready').getByTestId('idea-card-IDEA-3').waitFor();
      await toastClose();
      await p.getByTestId('stage-promote-IDEA-3').click();
      const d = dialog('Promote to ticket');
      await d.waitFor();
      await d.getByRole('textbox', { name: 'Ticket title' }).waitFor();
      expect((await d.getByRole('textbox', { name: 'Ticket title' }).inputValue()) === 'Canvas of the sharing flow', 'the title starts as the idea title');
      await d.getByText('Open assumptions (0)').waitFor();
      await d.getByRole('button', { name: 'One ticket' }).click();
      const create = d.getByTestId('create-ticket');
      await d.getByText(/no assumptions were written/).waitFor();
      expect(await create.isDisabled(), 'no assumptions: Create waits for the acknowledgement');
      await d.getByRole('checkbox', { name: 'I understand, promote anyway' }).check();
      await toastClose();
      await create.scrollIntoViewIfNeeded();
      await create.click();
      await p.getByText('Created ALP-5').waitFor();
      await d.waitFor({ state: 'detached' });
      await col('building').getByTestId('idea-card-IDEA-3').getByText('ALP-5', { exact: true }).waitFor();
      expect((await stageOf('IDEA-3')) === 'building', 'IDEA-3 is Building');
      // a Building idea cannot be dragged away by hand
      await drag('IDEA-3', 'parked');
      await p.getByText('Not allowed while the ticket is open').waitFor();
      expect((await stageOf('IDEA-3')) === 'building', 'still Building');
      await toastClose();
    }, { expectConsole: true }); // the move to Ready is refused first (409): nothing was tested
    await s.step('closing the ticket ships the idea; "Did it work as expected?" records an outcome', async () => {
      await nav().getByRole('button', { name: 'Idea Space' }).click();
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
      await card_(p, 'ALP-5').click();
      const m = p.getByRole('dialog', { name: 'Ticket ALP-5' });
      await m.waitFor();
      await m.getByRole('complementary').getByRole('button', { name: 'To Do', exact: true }).or(m.getByRole('complementary').getByRole('button', { name: 'Backlog', exact: true })).first().click();
      await p.getByRole('listbox').getByText('Done', { exact: true }).click();
      await m.getByRole('button', { name: 'Done', exact: true }).first().waitFor();
      await p.waitForFunction(async () => (await (await fetch('/api/idea-tickets/IDEA-3')).json()).stage === 'shipped');
      await m.getByRole('button', { name: 'Close', exact: true }).click();
      await m.waitFor({ state: 'detached' });
      await nav().getByRole('button', { name: 'Idea Space' }).click();
      await p.getByTestId('idea-space').waitFor();
      if (await p.getByTestId('idea-page').count()) await p.getByRole('button', { name: 'Back to Idea Space' }).click();
      await view('List').click();
      await filter('Shipped');
      await row('IDEA-3').click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
      await p.getByText('Shipped as ALP-5').waitFor();
      await p.getByText('Did it work as expected?').waitFor();
      await p.getByRole('button', { name: 'Partly', exact: true }).click();
      await p.getByText('Outcome: partly').waitFor();
      await p.getByText('Did it work as expected?').waitFor({ state: 'detached' });
      const i = await idea('IDEA-3');
      expect(i.outcome === 'partly', 'outcome: ' + i.outcome);
    });

    await s.step('Promote an idea that is in no project: Create waits for a project, choosing one assigns the idea to it', async () => {
      const i = await mk('Spike: export a board to PDF', { project_id: null });
      expect((await api('POST', `/api/idea-tickets/${i.id}/stage`, { to: 'exploring', via: 'Keep' })).status < 300, 'to Exploring');
      await reload();
      await openSpace('No project');
      await filter('Exploring');
      await row(i.id).click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
      await p.getByTestId('promote').click();
      const d = dialog('Promote to ticket');
      await d.getByText(/does not belong to a project yet/).waitFor();
      await d.getByText('Choose a project to promote').waitFor();
      const create = d.getByTestId('create-ticket');
      await d.getByRole('checkbox', { name: 'I understand, promote anyway' }).check();
      expect(await create.isDisabled(), 'Create needs a project');
      await d.getByLabel('Project', { exact: true }).selectOption({ label: 'Beta Project (BET)' });
      await d.getByText('Creates a ticket in Beta Project · Backlog').waitFor();
      await create.scrollIntoViewIfNeeded();
      await create.click();
      await p.getByText('Created BET-1').waitFor();
      await d.waitFor({ state: 'detached' });
      const got = await idea(i.id);
      expect(got.stage === 'building' && got.project_id === (await projectId('BET')), 'promoted into Beta: ' + got.stage + ' ' + got.project_id);
      await toastClose();
    });

    // ---- the Idea Space itself
    await s.step('Idea Space: "/" searches, the stage chips, source and tag filters narrow the list; "No idea matches" says so', async () => {
      await p.getByRole('button', { name: 'Back to Idea Space' }).click().catch(() => {});
      await openSpace('All projects');
      await filter('Active');
      await row('IDEA-1').waitFor();
      await p.getByTestId('idea-space').click({ position: { x: 600, y: 700 } });
      await p.keyboard.press('/');
      await p.getByRole('textbox', { name: 'Search ideas' }).waitFor();
      expect(await p.getByRole('textbox', { name: 'Search ideas' }).evaluate((e) => e === document.activeElement), '/ focuses the search');
      await p.keyboard.type('Offline');
      await row('IDEA-1').waitFor();
      await row('IDEA-7').waitFor();
      await row('IDEA-5').waitFor({ state: 'detached' });
      await p.keyboard.press('Control+a');
      await p.keyboard.type('zzzz-nothing');
      await p.getByRole('heading', { name: 'No idea matches' }).waitFor();
      await p.getByRole('textbox', { name: 'Search ideas' }).fill('');
      await row('IDEA-5').waitFor();
      await filter('Exploring');
      await p.getByLabel('Source', { exact: true }).selectOption({ label: 'Picture' });
      await row('IDEA-2').waitFor();
      await row('IDEA-1').waitFor({ state: 'detached' });
      await p.getByLabel('Source', { exact: true }).selectOption({ label: 'Source: all' });
      await p.getByLabel('Tag', { exact: true }).selectOption('sync');
      await row('IDEA-2').waitFor();
      await row('IDEA-7').waitFor({ state: 'detached' });
      await p.getByLabel('Tag', { exact: true }).selectOption({ label: 'Tag: all' });
      await filter('Parked');
      await row('IDEA-8').waitFor();
      await row('IDEA-8').getByText(/^Back /).waitFor();
      await filter('Building');
      await row('IDEA-4').getByRole('button', { name: 'ALP-2' }).waitFor();
      await row('IDEA-4').getByRole('button', { name: 'ALP-2' }).click();
      await p.getByRole('dialog', { name: 'Ticket ALP-2' }).waitFor();
      await p.getByRole('dialog', { name: 'Ticket ALP-2' }).getByRole('button', { name: 'Close', exact: true }).click();
    });
    await s.step('Idea Space: sort by title, J and Enter pick and open a row, C and Alt+N open Quick idea', async () => {
      await p.getByRole('dialog', { name: 'Ticket ALP-2' }).waitFor({ state: 'detached' });
      // opening a ticket leaves the Idea Space for the board: go back
      await openSpace();
      await filter('Exploring');
      await p.getByLabel('Sort', { exact: true }).selectOption({ label: 'Sort: title' });
      await p.waitForFunction(() => {
        const titles = [...document.querySelectorAll('table[aria-label="Ideas"] .is-row-title > span:first-child')].map((e) => e.textContent);
        return titles.length >= 3 && JSON.stringify(titles) === JSON.stringify([...titles].sort((a, b) => a.localeCompare(b)));
      });
      const titles = await p.getByRole('table', { name: 'Ideas' }).locator('.is-row-title > span:first-child').allInnerTexts();
      expect(titles.length >= 3 && JSON.stringify(titles) === JSON.stringify([...titles].sort((a, b) => a.localeCompare(b))), 'sorted by title: ' + titles.join(' | '));
      await p.getByTestId('idea-space').click({ position: { x: 600, y: 700 } });
      await p.keyboard.press('j');
      await p.keyboard.press('j');
      const selected = p.getByRole('row', { selected: true });
      await selected.waitFor();
      const key = await selected.getAttribute('data-testid');
      await p.keyboard.press('Enter');
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
      await p.getByText(key.replace('idea-row-', ''), { exact: true }).first().waitFor();
      await p.getByRole('button', { name: 'Back to Idea Space' }).click();
      await p.getByTestId('idea-space').click({ position: { x: 600, y: 700 } });
      await p.keyboard.press('c');
      await quick().waitFor();
      await quick().getByRole('button', { name: 'Cancel' }).click();
      await quick().waitFor({ state: 'detached' });
      await p.keyboard.press('Alt+n');
      await quick().waitFor();
      await p.keyboard.press('Escape');
      await quick().waitFor({ state: 'detached' });
    });

    await s.step('Triage: arrow keys move between ideas, "Open" and "Open the page" leave Triage, M merges into a suggested idea', async () => {
      await mk('Measure how long the board takes to load');
      await mk('Measure how long the board takes to load on slow networks');
      await reload();
      await openSpace('Alpha');
      await p.getByTestId('inbox-button').click();
      await focus().getByRole('heading', { name: 'Measure how long the board takes to load on slow networks', exact: true }).waitFor();
      const dup = p.getByTestId('duplicate');
      await dup.getByText('Measure how long the board takes to load', { exact: true }).waitFor();
      await dup.getByRole('button', { name: 'Open', exact: true }).click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
      expect((await p.getByRole('textbox', { name: 'Idea title' }).inputValue()) === 'Measure how long the board takes to load', 'Open shows the other idea');
      await p.getByRole('button', { name: 'Back to Idea Space' }).click();
      await p.getByTestId('inbox-button').click();
      await focus().waitFor();
      await p.getByRole('heading', { name: 'Triage' }).click();
      await p.keyboard.press('ArrowDown');
      await focus().getByRole('heading', { name: 'Measure how long the board takes to load', exact: true }).waitFor();
      await p.keyboard.press('ArrowUp');
      await focus().getByRole('heading', { name: 'Measure how long the board takes to load on slow networks', exact: true }).waitFor();
      await focus().getByRole('button', { name: 'Open the page' }).click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
      expect((await p.getByRole('textbox', { name: 'Idea title' }).inputValue()).endsWith('slow networks'), 'Open the page');
      await p.getByRole('button', { name: 'Back to Idea Space' }).click();
      await p.getByTestId('inbox-button').click();
      await p.getByRole('heading', { name: 'Triage' }).click();
      await p.keyboard.press('m');
      const d = dialog('Merge into another idea');
      const choice = d.getByRole('radiogroup', { name: 'Idea to merge into' }).getByRole('radio', { name: /Measure how long the board takes to load\s*Inbox\s*\d+% similar/ });
      await choice.waitFor();
      await choice.click();
      await d.getByRole('button', { name: 'Merge', exact: true }).click();
      await p.getByText(/^Merged “Measure how long the board takes to load on slow networks” into IDEA-/).waitFor();
      await toastClose();
    });
    await s.step('Triage: a related ticket is offered as a link and opens; X archives with a reason; the empty Inbox counts the pass', async () => {
      // the idea left in the Inbox is close to the ticket ALP-1
      await focus().getByRole('heading', { name: 'Measure how long the board takes to load', exact: true }).waitFor();
      await focus().getByRole('button', { name: 'ALP-1', exact: true }).click();
      const m = p.getByRole('dialog', { name: 'Ticket ALP-1' });
      await m.waitFor();
      await m.getByRole('button', { name: 'Close', exact: true }).click();
      await m.waitFor({ state: 'detached' });
      await openSpace();
      await p.getByTestId('inbox-button').click();
      await focus().waitFor();
      await p.getByRole('heading', { name: 'Triage' }).click();
      await p.keyboard.press('x');
      const d = dialog('Archive this idea');
      await d.getByRole('radio', { name: 'Too big' }).click();
      await d.getByRole('button', { name: 'Archive', exact: true }).click();
      await p.getByTestId('inbox-empty').waitFor();
      await p.getByTestId('inbox-empty').getByText(/You sorted \d+ ideas? this week: .*archived/).waitFor();
      await p.getByRole('button', { name: 'Back to the list' }).click();
      await filter('Archived');
      const r = row((await api('GET', '/api/idea-tickets/space?scope=all&stage=archived')).body.find((x) => /^Measure how long the board takes to load$/.test(x.title)).id);
      await r.getByText('too big').waitFor();
      await toastClose();
    });

    await s.step('Stages: with the Archived filter the board has an Archived column; a drop asks for a reason, Reopen brings it back', async () => {
      await p.getByRole('button', { name: 'Back to Idea Space' }).click().catch(() => {});
      await openSpace();
      await view('Stages').click();
      await p.getByRole('list', { name: 'Stages' }).waitFor();
      await filter('Active');
      await col('exploring').waitFor();
      expect(!(await col('archived').count()), 'no Archived column unless the filter is on');
      await filter('Archived');
      await col('archived').getByText('Kept with their reason.').waitFor();
      await card('IDEA-5').waitFor();
      // six columns do not fit: the source and the target cannot both be on screen, so the drag is sent as events
      const dt = await p.evaluateHandle(() => new DataTransfer());
      await card('IDEA-5').dispatchEvent('dragstart', { dataTransfer: dt });
      await col('archived').dispatchEvent('dragover', { dataTransfer: dt });
      await col('archived').dispatchEvent('drop', { dataTransfer: dt });
      const d = dialog('Archive this idea');
      await d.getByRole('radio', { name: 'Not now' }).click();
      await d.getByRole('textbox').fill('After the redesign');
      await d.getByRole('button', { name: 'Archive', exact: true }).click();
      await col('archived').getByTestId('idea-card-IDEA-5').waitFor();
      const i = await idea('IDEA-5');
      expect(i.stage === 'archived' && i.archive_reason === 'not_now', 'archived: ' + i.stage + ' ' + i.archive_reason);
      await toastClose();
      await card('IDEA-5').click();
      await p.getByText('This idea is archived (not now)').waitFor();
      await p.getByRole('button', { name: 'Reopen', exact: true }).click();
      await p.getByText('This idea is archived (not now)').waitFor({ state: 'detached' });
      expect((await stageOf('IDEA-5')) === 'exploring', 'Reopen goes to Exploring');
      await toastClose();
    });
  },
};
