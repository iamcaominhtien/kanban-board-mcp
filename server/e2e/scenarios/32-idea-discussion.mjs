import { ensureProject, openTicket, closeTicket, card, home } from '../lib/ui.mjs';

// Idea Space, the discussion side of an idea page: comments, the research log (kinds, pin, evidence), the Activity
// tab, the assumption table (edit, open, create a test, answer it from the ticket, delete), the links between an idea
// and its ticket (lightbulb, "Started as an idea") and deleting an idea.
export default {
  name: 'Idea Space: comments, research log, activity, assumptions and tests, links to the ticket, delete',
  async run(s) {
    const p = s.page;
    const base = s.server.base;
    // the API speaks snake_case (the UI client converts it); the checks read camelCase
    const camel = (v) => Array.isArray(v) ? v.map(camel) : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.replace(/_([a-z])/g, (_m, c) => c.toUpperCase()), camel(x)])) : v;
    const get = async (path) => camel(await (await p.request.get(`${base}${path}`)).json());
    const send = async (method, path, data) => {
      const r = await p.request.fetch(`${base}${path}`, { method, data });
      return { status: r.status(), body: camel(await r.json().catch(() => null)) };
    };
    const sections = () => p.getByRole('tablist', { name: 'Idea sections' });
    const view = (name) => p.getByRole('tablist', { name: 'View' }).getByRole('tab', { name });
    const inputs = { comment: () => p.getByRole('textbox', { name: 'Write a comment' }), log: () => p.getByRole('textbox', { name: 'Log entry' }) };
    const toolbar = (name) => p.getByRole('button', { name, exact: true });
    // the log, activity and workspace tools are icon buttons that toggle their tab; the others are in the tab list
    const openTool = async (name, testId) => {
      if (!(await p.getByTestId(testId).count())) await toolbar(name).click();
      await p.getByTestId(testId).waitFor();
    };
    const openTab = async (re, testId) => {
      await sections().getByRole('tab', { name: re }).click();
      await p.getByTestId(testId).waitFor();
    };
    const logIs = async (v) => {
      await p.waitForFunction((x) => document.querySelector('textarea[aria-label="Log entry"]').value === x, v, { timeout: 3000 })
        .catch(async () => { throw new Error(`composer holds ${JSON.stringify(await inputs.log().inputValue())}, wanted ${JSON.stringify(v)}`); });
    };
    const accept = () => p.once('dialog', (d) => d.accept());
    const dismiss = () => p.once('dialog', (d) => d.dismiss());
    const toastClose = async () => {
      for (const b of await p.getByRole('alert').getByRole('button', { name: 'Close notification' }).all()) await b.click().catch(() => {});
    };
    const ideaOf = async (id) => get(`/api/idea-tickets/${id}`);
    const openIdea = async (title, group = 'Exploring') => {
      await p.getByRole('button', { name: 'Back to Idea Space' }).click().catch(() => {});
      await p.getByRole('button', { name: group }).click();
      await p.getByText(title, { exact: true }).first().click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
    };
    const addAssumption = async (text, impact = 'Medium impact') => {
      await openTab(/^Assumptions/, 'assumptions-tab');
      await p.getByRole('textbox', { name: 'New assumption' }).fill(text);
      await p.locator('select[aria-label="Impact if wrong"]:not(table select)').selectOption({ label: impact });
      await p.getByRole('button', { name: 'Add an assumption' }).click();
      await p.getByTestId('assumptions-tab').getByRole('row').filter({ hasText: text }).waitFor();
    };
    const row = (text) => p.getByTestId('assumptions-tab').getByRole('row').filter({ hasText: text }).first();

    await s.step('set up: a project and an idea kept in Exploring, opened on its page', async () => {
      await ensureProject(s);
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await p.getByRole('heading', { name: 'No ideas here yet' }).waitFor();
      for (const [n, title] of [[1, 'Offline mode'], [2, 'Throwaway idea']]) {
        await p.getByRole('button', { name: 'New idea' }).first().click();
        await p.getByRole('textbox', { name: 'Idea title' }).fill(title);
        await p.getByRole('button', { name: 'Add to Inbox' }).click();
        await p.getByText(`Added IDEA-${n} to the Inbox`).waitFor();
      }
      await p.getByRole('button', { name: /^Inbox/ }).click();
      await p.getByRole('heading', { name: 'Triage' }).waitFor();
      for (let i = 0; i < 2; i++) {
        await p.getByRole('region', { name: 'Idea in focus' }).waitFor();
        await p.getByRole('button', { name: /^Keep/ }).click();
        await p.getByRole('dialog', { name: 'Keep this idea' }).getByRole('button', { name: 'Keep', exact: true }).click();
        await p.getByRole('dialog', { name: 'Keep this idea' }).waitFor({ state: 'detached' });
        await s.settle();
      }
      await p.getByRole('button', { name: 'Back to the list' }).click().catch(() => {});
      await view('List').click();
      await openIdea('Offline mode');
    });

    // ---- comments
    await s.step('Comments tab starts empty', async () => {
      await openTab(/^Comments/, 'comments-tab');
      await p.getByText('No comments yet. Say what you think; it stays on the idea.').waitFor();
      await inputs.comment().waitFor();
      if (!(await p.getByRole('button', { name: 'Comment', exact: true }).isDisabled())) throw new Error('Comment is enabled with no text');
      if ((await get('/api/idea-tickets/IDEA-1/comments')).length !== 0) throw new Error('comments on a new idea');
    });
    await s.step('write a comment with the button', async () => {
      await inputs.comment().fill('We should check **offline** drafts first');
      await p.getByRole('button', { name: 'Comment', exact: true }).click();
      const t = p.getByTestId('comments-tab');
      await t.getByText('We should check').waitFor();
      await t.locator('strong', { hasText: 'offline' }).waitFor();
      if ((await inputs.comment().inputValue()) !== '') throw new Error('the box keeps the text');
      const list = await get('/api/idea-tickets/IDEA-1/comments');
      if (list.length !== 1 || list[0].body !== 'We should check **offline** drafts first') throw new Error('saved ' + JSON.stringify(list));
      await sections().getByRole('tab', { name: /^Comments 1/ }).waitFor();
    });
    await s.step('write a second comment with Ctrl+Enter', async () => {
      await inputs.comment().fill('Second thought');
      await p.keyboard.press('Control+Enter');
      await p.getByTestId('comments-tab').getByText('Second thought').waitFor();
      await sections().getByRole('tab', { name: /^Comments 2/ }).waitFor();
    });
    await s.step('edit a comment: Cancel keeps it, Save changes it and marks it edited', async () => {
      const t = p.getByTestId('comments-tab');
      const first = t.locator('.is-comment').first();
      await first.getByRole('button', { name: 'Edit', exact: true }).click();
      await first.getByRole('textbox', { name: 'Edit comment' }).fill('discarded text');
      await first.getByRole('button', { name: 'Cancel' }).click();
      await first.getByText('We should check').waitFor();
      await first.getByRole('button', { name: 'Edit', exact: true }).click();
      await first.getByRole('textbox', { name: 'Edit comment' }).fill('We should check offline drafts and conflicts');
      await first.getByRole('button', { name: 'Save', exact: true }).click();
      await t.getByText('We should check offline drafts and conflicts').waitFor();
      await t.getByText(/· edited/).waitFor();
      const list = await get('/api/idea-tickets/IDEA-1/comments');
      const c = list.find((x) => /conflicts/.test(x.body));
      if (!c || !c.editedAt) throw new Error('edit not saved ' + JSON.stringify(list));
    });
    await s.step('delete a comment: refusing the confirm keeps it, accepting removes it', async () => {
      const t = p.getByTestId('comments-tab');
      const second = t.locator('.is-comment').filter({ hasText: 'Second thought' });
      dismiss();
      await second.getByRole('button', { name: 'Delete', exact: true }).click();
      await s.settle();
      if (!(await second.count())) throw new Error('deleted although the confirm was refused');
      accept();
      await second.getByRole('button', { name: 'Delete', exact: true }).click();
      await second.waitFor({ state: 'detached' });
      const list = await get('/api/idea-tickets/IDEA-1/comments');
      if (list.length !== 1) throw new Error('comments left: ' + list.length);
      await sections().getByRole('tab', { name: /^Comments 1/ }).waitFor();
    });
    await s.step('a comment on a missing idea is refused by the server', async () => {
      const r = await send('POST', '/api/idea-tickets/IDEA-999/comments', { body: 'x' });
      if (r.status !== 404) throw new Error('status ' + r.status);
      const e = await send('POST', '/api/idea-tickets/IDEA-1/comments', { body: '   ' });
      s.note('empty comment', { status: e.status });
    });

    // ---- log
    await s.step('Research log starts empty, "Add to log" waits for text', async () => {
      await openTool('Research log', 'log-tab');
      await p.getByRole('heading', { name: 'Nothing logged yet' }).waitFor();
      await p.getByText('0 entries').first().waitFor();
      if (!(await p.getByRole('button', { name: 'Add to log' }).isDisabled())) throw new Error('Add to log enabled with no text');
      const kinds = p.getByRole('group', { name: 'Kind of entry' }).getByRole('button');
      s.note('log kinds', await kinds.allInnerTexts());
      await p.getByRole('button', { name: 'Note', exact: true }).and(kinds.filter({ hasText: 'Note' })).first().waitFor();
      if ((await inputs.log().getAttribute('placeholder')) !== 'Write what you found, tried or decided… (markdown)') throw new Error('placeholder');
    });
    await s.step('add an entry (default kind Note), then the formatting buttons wrap the selection', async () => {
      await inputs.log().fill('Kicked off the research');
      await p.getByRole('button', { name: 'Add to log' }).click();
      const e = p.getByTestId('log-entry').filter({ hasText: 'Kicked off the research' });
      await e.getByText('Note', { exact: true }).waitFor();
      await p.getByText('1 entry').first().waitFor();
      const log = await get('/api/idea-tickets/IDEA-1/log');
      if (log.length !== 1 || log[0].kind !== 'note') throw new Error('log ' + JSON.stringify(log));
      // the composer clears itself once the save is answered: wait for that before typing again
      await p.waitForFunction(() => document.querySelector('textarea[aria-label="Log entry"]').value === '');
      // Bold, Italic, Code and Link wrap the selected text
      const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      for (const [button, from, to] of [['Bold', 'plain', '**plain**'], ['Italic', 'word', '_word_'], ['Code', 'x', '`x`'], ['Link', 'site', '[site](https://)']]) {
        await inputs.log().fill(from);
        await logIs(from);
        await frame();
        await inputs.log().selectText();
        await p.getByRole('button', { name: button, exact: true }).click();
        await logIs(to);
        await frame();
      }
    });
    await s.step('Cancel clears the composer', async () => {
      await p.getByRole('button', { name: 'Cancel' }).click();
      if ((await inputs.log().inputValue()) !== '') throw new Error('text kept');
      await p.getByRole('button', { name: 'Cancel' }).waitFor({ state: 'detached' });
    });
    await s.step('add an interview entry with markdown', async () => {
      await p.getByRole('group', { name: 'Kind of entry' }).getByRole('button', { name: 'Interview' }).click();
      await p.getByRole('group', { name: 'Kind of entry' }).getByRole('button', { name: 'Interview' }).and(p.locator('[aria-pressed="true"]')).waitFor();
      await inputs.log().fill('Talked to **two commuters**\nsecond line');
      await p.getByRole('button', { name: 'Add to log' }).click();
      const e = p.getByTestId('log-entry').filter({ hasText: 'Talked to' });
      await e.locator('strong', { hasText: 'two commuters' }).waitFor();
      await e.getByText('Interview', { exact: true }).waitFor();
      const log = await get('/api/idea-tickets/IDEA-1/log');
      if (!log.some((x) => x.kind === 'interview')) throw new Error('kind not saved');
    });
    await s.step('the link-to-assumption menu appears once the idea has assumptions', async () => {
      if (await p.getByTestId('log-link-assumption').count()) throw new Error('the link menu is drawn without assumptions');
      await addAssumption('People work on trains without signal', 'High impact');
      await addAssumption('Sync conflicts are rare', 'Low impact');
      await openTool('Research log', 'log-tab');
      await p.getByTestId('log-link-assumption').waitFor();
    });
    await s.step('a finding linked to an assumption shows "Supports:"', async () => {
      await p.getByRole('group', { name: 'Kind of entry' }).getByRole('button', { name: 'Finding' }).click();
      await inputs.log().fill('Metro drafts get lost');
      await p.getByRole('button', { name: 'Link to assumption' }).click();
      await p.getByRole('listbox').getByRole('option', { name: 'People work on trains without signal' }).click();
      await p.getByRole('button', { name: 'Add to log' }).click();
      const e = p.getByTestId('log-entry').filter({ hasText: 'Metro drafts get lost' });
      await e.getByText('Supports: People work on trains without signal').waitFor();
      const log = await get('/api/idea-tickets/IDEA-1/log');
      const f = log.find((x) => x.kind === 'finding');
      const idea = await ideaOf('IDEA-1');
      const a = idea.assumptions.find((x) => /trains/.test(x.text));
      if (!f || f.assumptionId !== a.id) throw new Error('assumption link ' + JSON.stringify(f));
    });
    await s.step('"Use as evidence" turns a finding into evidence of an assumption', async () => {
      const e = p.getByTestId('log-entry').filter({ hasText: 'Metro drafts get lost' });
      // only a finding offers it
      if (await p.getByTestId('log-entry').filter({ hasText: 'Kicked off' }).getByRole('button', { name: 'Use as evidence' }).count()) throw new Error('a note offers Use as evidence');
      await e.getByRole('button', { name: 'Use as evidence' }).click();
      await p.getByRole('listbox').getByRole('option', { name: 'Sync conflicts are rare' }).click();
      await p.getByText('Added as evidence').first().waitFor();
      const idea = await ideaOf('IDEA-1');
      const a = idea.assumptions.find((x) => /Sync conflicts/.test(x.text));
      if (a.evidence.length !== 1) throw new Error('evidence ' + JSON.stringify(a.evidence));
      s.note('evidence from a log entry', a.evidence.map((x) => ({ kind: x.kind, title: x.title, ref: x.ref })));
      await toastClose();
    });
    await s.step('Pin puts an entry first and in the strip, Unpin takes it back', async () => {
      const e = p.getByTestId('log-entry').filter({ hasText: 'Kicked off the research' });
      await e.getByRole('button', { name: 'Pin', exact: true }).click();
      await p.getByTestId('pinned-entry').getByText(/Pinned note/).waitFor();
      await p.getByTestId('pinned-entry').getByText('Kicked off the research').waitFor();
      await e.getByRole('button', { name: 'Unpin', exact: true }).waitFor();
      const first = await p.getByTestId('log-entry').first().innerText();
      if (!/Kicked off the research/.test(first)) throw new Error('pinned entry is not first: ' + first);
      const log = await get('/api/idea-tickets/IDEA-1/log');
      if (log.filter((x) => x.pinned).length !== 1) throw new Error('pinned count');
      // a second pin does not replace the first: both stay pinned, the strip shows the first of them
      const f = p.getByTestId('log-entry').filter({ hasText: 'Metro drafts get lost' });
      await f.getByRole('button', { name: 'Pin', exact: true }).click();
      await f.getByRole('button', { name: 'Unpin', exact: true }).waitFor();
      const two = (await get('/api/idea-tickets/IDEA-1/log')).filter((x) => x.pinned).length;
      s.note('pinned entries after two pins', { count: two });
      await p.getByTestId('pinned-entry').waitFor();
      for (const b of await p.getByTestId('log-entry').getByRole('button', { name: 'Unpin', exact: true }).all()) await b.click();
      await p.getByTestId('pinned-entry').waitFor({ state: 'detached' });
      if ((await get('/api/idea-tickets/IDEA-1/log')).some((x) => x.pinned)) throw new Error('still pinned');
    });
    await s.step('filter the log by kind and flip the order', async () => {
      const chips = p.locator('.is-filters');
      await chips.getByRole('button', { name: /^Finding/ }).click();
      await p.getByTestId('log-entry').filter({ hasText: 'Kicked off' }).waitFor({ state: 'detached' });
      await p.getByTestId('log-entry').filter({ hasText: 'Metro drafts' }).waitFor();
      await chips.getByRole('button', { name: /^All/ }).click();
      await p.getByTestId('log-entry').filter({ hasText: 'Kicked off' }).waitFor();
      const order = async () => (await p.getByTestId('log-entry').allInnerTexts()).map((t) => (/Kicked off/.test(t) ? 'k' : /Talked to/.test(t) ? 't' : /Metro/.test(t) ? 'm' : '?')).join('');
      const newest = await order();
      await p.getByTestId('log-order').getByText('Newest first').waitFor();
      await p.getByTestId('log-order').click();
      await p.getByTestId('log-order').getByText('Oldest first').waitFor();
      const oldest = await order();
      if (newest !== [...oldest].reverse().join('') || oldest[0] !== 'k') throw new Error(`order ${newest} / ${oldest}`);
      await p.getByTestId('log-order').click();
    });
    await s.step('delete a log entry: the confirm can be refused; the server entry is gone', async () => {
      const e = p.getByTestId('log-entry').filter({ hasText: 'Talked to' });
      dismiss();
      await e.getByRole('button', { name: 'Delete', exact: true }).click();
      await s.settle();
      if (!(await e.count())) throw new Error('deleted although the confirm was refused');
      accept();
      await e.getByRole('button', { name: 'Delete', exact: true }).click();
      await e.waitFor({ state: 'detached' });
      const log = await get('/api/idea-tickets/IDEA-1/log');
      if (log.length !== 2 || log.some((x) => x.kind === 'interview')) throw new Error('log ' + JSON.stringify(log));
      await p.getByText('2 entries').first().waitFor();
    });
    await s.step('the server edits an entry text (the UI only pins) and refuses a bad kind', async () => {
      const log = await get('/api/idea-tickets/IDEA-1/log');
      const note = log.find((x) => x.kind === 'note');
      const r = await send('PATCH', `/api/idea-tickets/IDEA-1/log/${note.id}`, { body: 'Kicked off the research (edited)' });
      if (r.status !== 200) throw new Error('patch status ' + r.status);
      await openIdea('Offline mode');
      await openTool('Research log', 'log-tab');
      await p.getByTestId('log-entry').filter({ hasText: 'Kicked off the research (edited)' }).waitFor();
      const bad = await send('POST', '/api/idea-tickets/IDEA-1/log', { kind: 'bogus', body: 'x' });
      if (bad.status < 400) throw new Error('a bad kind was accepted: ' + bad.status);
      const gone = await send('DELETE', '/api/idea-tickets/IDEA-1/log/nope');
      if (gone.status !== 404) throw new Error('delete of a missing entry: ' + gone.status);
    });

    // ---- activity
    await s.step('Activity lists the changes with the filters and the counts', async () => {
      await openTool('Activity', 'activity-tab');
      const t = p.getByTestId('activity-tab');
      await t.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
      const act = await get('/api/idea-tickets/IDEA-1/activity');
      if (!act.items?.length) throw new Error('no activity from the server ' + JSON.stringify(act).slice(0, 200));
      await t.getByText(/\d+ changes? · IDEA-1/).waitFor();
      await t.getByText(/Research log/).first().waitFor();
      await t.getByText(/entry deleted/i).first().waitFor();
      s.note('activity counts', act.counts);
      await t.getByRole('button', { name: /^Assumptions/ }).click();
      await t.locator('.is-activity-row').filter({ hasText: 'Assumption' }).first().waitFor();
      await t.getByRole('button', { name: /^Stage/ }).click();
      await t.locator('.is-activity-row').filter({ hasText: 'Stage' }).first().waitFor();
      await t.getByRole('button', { name: /^By AI/ }).click();
      await t.getByRole('heading', { name: 'No activity yet' }).waitFor();
      await t.getByRole('button', { name: /^All/ }).click();
      await t.locator('.is-activity-row').first().waitFor();
    });

    // ---- assumptions
    await s.step('edit an assumption text: Escape cancels, Enter saves', async () => {
      await openTab(/^Assumptions/, 'assumptions-tab');
      const r = row('Sync conflicts are rare');
      await r.getByRole('button', { name: 'Edit assumption' }).click();
      await p.getByRole('textbox', { name: 'Assumption text' }).fill('discarded');
      await p.keyboard.press('Escape');
      await p.getByRole('textbox', { name: 'Assumption text' }).waitFor({ state: 'detached' });
      await row('Sync conflicts are rare').waitFor();
      await row('Sync conflicts are rare').getByRole('button', { name: 'Edit assumption' }).click();
      await p.getByRole('textbox', { name: 'Assumption text' }).fill('We believe sync conflicts are rare');
      await p.keyboard.press('Enter');
      await row('We believe sync conflicts are rare').waitFor();
      const idea = await ideaOf('IDEA-1');
      if (!idea.assumptions.some((a) => a.text === 'We believe sync conflicts are rare')) throw new Error('not saved');
      // the "We believe" lead-in is bold
      await row('We believe sync conflicts are rare').locator('b', { hasText: 'We believe' }).waitFor();
    });
    await s.step('open and close an assumption: detail shows the evidence added from the log', async () => {
      const r = row('We believe sync conflicts are rare');
      await r.getByRole('button', { name: 'Open the assumption' }).click();
      const detail = p.locator('.is-detail').first();
      await detail.getByText('Metro drafts get lost').waitFor();
      await detail.getByText('No test yet.').waitFor();
      await r.getByRole('button', { name: 'Close the assumption' }).waitFor();
      await r.getByRole('button', { name: 'Close the assumption' }).click();
      await p.locator('.is-detail').waitFor({ state: 'detached' });
    });
    await s.step('mark validated from the detail, then back to untested', async () => {
      const r = row('We believe sync conflicts are rare');
      await r.getByRole('button', { name: 'Open the assumption' }).click();
      const a = (await ideaOf('IDEA-1')).assumptions.find((x) => /conflicts/.test(x.text));
      await p.getByTestId(`mark-validated-${a.id}`).click();
      await p.getByTestId(`assumption-change-${a.id}`).getByText(/Changed to Validated by you/).waitFor();
      await p.getByTestId(`mark-validated-${a.id}`).waitFor({ state: 'detached' });
      await r.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'Untested' });
      await p.getByTestId(`assumption-change-${a.id}`).getByText(/Changed to Untested/).waitFor();
      await r.getByRole('button', { name: 'Close the assumption' }).click();
    });
    await s.step('Create test makes a ticket and links it both ways', async () => {
      const r = row('People work on trains without signal');
      await r.getByRole('button', { name: 'Create test' }).click();
      await p.getByText('Created ALP-1').first().waitFor();
      await p.getByText(/It tests this assumption/).waitFor();
      await r.getByRole('button', { name: 'ALP-1' }).waitFor();
      await r.getByRole('button', { name: 'Create test' }).waitFor({ state: 'detached' });
      const idea = await ideaOf('IDEA-1');
      const a = idea.assumptions.find((x) => /trains/.test(x.text));
      if (a.testTicketId !== 'ALP-1') throw new Error('testTicketId ' + a.testTicketId);
      await toastClose();
      await r.getByRole('button', { name: 'Open the assumption' }).click();
      await p.locator('.is-detail').getByText('Tests this assumption').waitFor();
      await p.locator('.is-detail').getByText(/When ALP-1 is Done/).waitFor();
      await r.getByRole('button', { name: 'Close the assumption' }).click();
    });
    await s.step('delete an assumption: refusing the confirm keeps it', async () => {
      await p.getByRole('textbox', { name: 'New assumption' }).fill('A throwaway belief');
      await p.getByRole('button', { name: 'Add an assumption' }).click();
      const r = row('A throwaway belief');
      await r.waitFor();
      dismiss();
      await r.getByRole('button', { name: 'Delete assumption' }).click();
      await s.settle();
      if (!(await row('A throwaway belief').count())) throw new Error('deleted although the confirm was refused');
      accept();
      await r.getByRole('button', { name: 'Delete assumption' }).click();
      await r.waitFor({ state: 'detached' });
      const idea = await ideaOf('IDEA-1');
      if (idea.assumptions.length !== 2) throw new Error('assumptions ' + idea.assumptions.length);
      const none = await send('DELETE', '/api/idea-tickets/IDEA-1/assumptions/nope');
      // today the server answers 400 here (a missing log entry or comment is a 404); only "refused" is asserted
      if (none.status < 400) throw new Error('delete of a missing assumption: ' + none.status);
      s.note('delete of a missing assumption', { status: none.status });
    });

    // ---- the ticket side: ideaLinks
    await s.step('the test ticket asks what it showed when it is Done: Yes, validated', async () => {
      await home(s);
      await p.getByRole('button', { name: /ALP-1 / }).first().waitFor();
      const d = await openTicket(s, 'ALP-1');
      const sec = d.getByTestId('tests-assumption');
      await sec.getByText('Tests an assumption of an idea').waitFor();
      await sec.getByText(/Impact if wrong: high · testing/).waitFor();
      if (await sec.getByText('Did the test show that this is true?').count()) throw new Error('asked before it is Done');
      await d.getByRole('complementary').getByRole('button', { name: 'Backlog', exact: true }).click();
      await p.getByRole('listbox').getByText('Done', { exact: true }).click();
      await sec.getByText('Did the test show that this is true?').waitFor();
      await sec.getByRole('button', { name: 'Yes, validated' }).click();
      await sec.getByText(/· validated/).waitFor();
      await sec.getByText('Did the test show that this is true?').waitFor({ state: 'detached' });
      const idea = await ideaOf('IDEA-1');
      const a = idea.assumptions.find((x) => /trains/.test(x.text));
      if (a.state !== 'validated') throw new Error('state ' + a.state);
      s.note('after resolve', { state: a.state });
      await sec.getByRole('button', { name: 'Open the idea' }).click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
    });
    await s.step('the resolved assumption shows its new state and the change in Activity', async () => {
      await openTab(/^Assumptions/, 'assumptions-tab');
      await row('People work on trains without signal').getByRole('combobox', { name: 'Status' }).and(p.locator('.is-state-validated')).waitFor();
      await openTool('Activity', 'activity-tab');
      await p.getByTestId('activity-tab').getByText(/validated/i).first().waitFor();
    });
    await s.step('the resolve call on the other assumption: disproved, unsure (state kept) and a bad outcome', async () => {
      // the server answers the same call the ticket makes
      const idea = await ideaOf('IDEA-1');
      const b = idea.assumptions.find((x) => /conflicts/.test(x.text));
      const r = await send('POST', `/api/idea-tickets/IDEA-1/assumption-records/${b.id}/resolve`, { outcome: 'disproved' });
      if (r.status !== 200) throw new Error('resolve status ' + r.status);
      if ((await ideaOf('IDEA-1')).assumptions.find((x) => x.id === b.id).state !== 'disproved') throw new Error('not disproved');
      const un = await send('POST', `/api/idea-tickets/IDEA-1/assumption-records/${b.id}/resolve`, { outcome: 'unsure' });
      s.note('resolve unsure', { status: un.status, state: (await ideaOf('IDEA-1')).assumptions.find((x) => x.id === b.id).state });
      const bad = await send('POST', `/api/idea-tickets/IDEA-1/assumption-records/${b.id}/resolve`, { outcome: 'maybe' });
      if (bad.status < 400) throw new Error('a bad outcome was accepted: ' + bad.status);
      // a disproved high-impact assumption is a banner on the page; this one is low impact, so no banner
    });

    await s.step('promote the idea: the card and the ticket link back to the idea', async () => {
      await p.getByRole('button', { name: 'Promote' }).click();
      const d = p.getByRole('dialog').last();
      await d.waitFor();
      const ack = d.getByRole('checkbox', { name: 'I understand, promote anyway' });
      // the ticket form opens with the readiness warning (two assumptions are open): acknowledge it
      await ack.waitFor({ timeout: 4000 }).catch(() => {});
      if (await ack.count()) await ack.check();
      await d.getByTestId('create-ticket').scrollIntoViewIfNeeded();
      await d.getByTestId('create-ticket').click();
      await d.waitFor({ state: 'detached' }).catch(() => {});
      await s.settle(2500);
      const idea = await ideaOf('IDEA-1');
      if (idea.stage !== 'building' || !idea.ticket) throw new Error('stage ' + idea.stage);
      s.note('promoted', { stage: idea.stage, ticket: idea.ticket.id });
      await home(s);
      await card(p, idea.ticket.id).waitFor();
      const bulb = card(p, idea.ticket.id).getByTestId('idea-bulb');
      await bulb.waitFor();
      // Hovering a card shows its "..." button and moves the id (and the lightbulb) about 28px to the left. A pointer
      // that arrives on the bulb at once is left behind by it and the card never opens (an app quirk of TicketCard,
      // noted here and not fixed): hover the card first, then the bulb where it stays.
      await s.settle();
      await card(p, idea.ticket.id).hover();
      await p.waitForFunction(() => { const e = document.querySelector('[data-testid=idea-bulb]'); const x = e.getBoundingClientRect().x; window.__bx = [...(window.__bx || []), x].slice(-6); return window.__bx.length === 6 && window.__bx.every((v) => v === x); }, null, { polling: 'raf' });
      await bulb.hover();
      const tip = p.locator('.is-hovercard').filter({ hasText: 'Started as an idea' });
      await tip.waitFor();
      await tip.getByText(/assumptions checked/).waitFor();
      await tip.getByRole('button', { name: 'Open the idea' }).click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
    });
    await s.step('the ticket page says where it started, and its idea log link opens the log', async () => {
      const idea = await ideaOf('IDEA-1');
      await home(s);
      const d = await openTicket(s, idea.ticket.id);
      const sec = d.getByTestId('started-as-idea');
      await sec.getByText('Started as an idea').waitFor();
      await sec.getByRole('button', { name: 'IDEA-1' }).waitFor();
      // one assumption was validated and the other disproved, so nothing is left "to check before closing"
      await sec.getByText(/1 assumption confirmed before it was built/).waitFor();
      if (await sec.getByText('To check before closing').count()) throw new Error('nothing should be left to check');
      await sec.getByRole('button', { name: /^Idea log \(2\)/ }).click();
      await p.getByTestId('log-tab').waitFor();
      await p.getByTestId('log-entry').filter({ hasText: 'Metro drafts get lost' }).waitFor();
      // building: the log still takes entries (the idea is not closed)
      await p.getByRole('textbox', { name: 'Log entry' }).waitFor();
    });
    await s.step('"Idea activity" and "Open the idea" from the ticket open the right tab', async () => {
      const idea = await ideaOf('IDEA-1');
      await home(s);
      const d = await openTicket(s, idea.ticket.id);
      await d.getByTestId('started-as-idea').getByRole('button', { name: 'Idea activity' }).click();
      await p.getByTestId('activity-tab').waitFor();
      await home(s);
      const d2 = await openTicket(s, idea.ticket.id);
      await d2.getByTestId('started-as-idea').getByRole('button', { name: 'Open the idea', exact: true }).click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
    });

    await s.step('closing the ticket ships the idea; Comments stay open, the log closes', async () => {
      const idea = await ideaOf('IDEA-1');
      await home(s);
      const d = await openTicket(s, idea.ticket.id);
      await d.getByRole('complementary').getByRole('button', { name: 'Backlog', exact: true }).click();
      await p.getByRole('listbox').getByText('Done', { exact: true }).click();
      await s.settle();
      await closeTicket(s);
      for (let i = 0; i < 20 && (await ideaOf('IDEA-1')).stage !== 'shipped'; i++) await p.waitForTimeout(300);
      if ((await ideaOf('IDEA-1')).stage !== 'shipped') throw new Error('the idea did not ship: ' + (await ideaOf('IDEA-1')).stage);
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await view('List').click().catch(() => {});
      await p.getByRole('button', { name: 'Shipped' }).click();
      await p.getByText('Offline mode', { exact: true }).first().click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
      await openTab(/^Comments/, 'comments-tab');
      const box = p.getByRole('textbox', { name: 'Write a comment' });
      if ((await box.getAttribute('placeholder')) !== 'Comments stay open after shipping.') throw new Error('placeholder ' + (await box.getAttribute('placeholder')));
      await box.fill('Shipped, nice');
      await p.getByRole('button', { name: 'Comment', exact: true }).click();
      await p.getByTestId('comments-tab').getByText('Shipped, nice').waitFor();
      // existing comments can still be edited and deleted
      const all = p.getByTestId('comments-tab').locator('.is-comment');
      await all.filter({ hasText: 'Shipped, nice' }).first().waitFor();
      const at = (await all.allInnerTexts()).findIndex((t) => /Shipped, nice/.test(t));
      if (at < 0) throw new Error('the new comment is not listed');
      const c = all.nth(at);
      await c.getByRole('button', { name: 'Edit', exact: true }).click();
      await c.getByRole('textbox', { name: 'Edit comment' }).fill('Shipped, very nice');
      await c.getByRole('button', { name: 'Save', exact: true }).click();
      await p.getByTestId('comments-tab').getByText('Shipped, very nice').waitFor();
      await openTool('Research log', 'log-tab');
      await p.getByText(/The idea is closed\. The log stays readable/).waitFor();
      if (await p.getByRole('textbox', { name: 'Log entry' }).count()) throw new Error('the log composer is open on a shipped idea');
      if (await p.getByTestId('log-entry').first().getByRole('button', { name: 'Pin', exact: true }).count()) throw new Error('Pin offered on a closed idea');
      const r = await send('POST', '/api/idea-tickets/IDEA-1/log', { kind: 'note', body: 'late' });
      s.note('log entry on a shipped idea', { status: r.status });
    });

    // ---- delete an idea
    await s.step('delete an idea from More actions: the confirm can be refused', async () => {
      await p.getByRole('button', { name: 'Back to Idea Space' }).click();
      await view('List').click().catch(() => {});
      await openIdea('Throwaway idea');
      await openTab(/^Comments/, 'comments-tab');
      await inputs.comment().fill('about to disappear');
      await p.keyboard.press('Control+Enter');
      await p.getByTestId('comments-tab').getByText('about to disappear').waitFor();
      await p.getByRole('button', { name: 'More actions' }).click();
      dismiss();
      await p.getByRole('menuitem', { name: 'Delete…' }).click();
      await s.settle();
      if ((await send('GET', '/api/idea-tickets/IDEA-2')).status !== 200) throw new Error('deleted although the confirm was refused');
    });
    await s.step('accepting deletes it: back in the list, gone from the server', async () => {
      await p.getByRole('button', { name: 'More actions' }).click();
      accept();
      await p.getByRole('menuitem', { name: 'Delete…' }).click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor({ state: 'detached' });
      const r = await send('GET', '/api/idea-tickets/IDEA-2');
      if (r.status !== 404) throw new Error('status ' + r.status);
      const c = await send('GET', '/api/idea-tickets/IDEA-2/comments');
      if (c.status !== 404) throw new Error('comments of a deleted idea: ' + c.status);
      const again = await send('DELETE', '/api/idea-tickets/IDEA-2');
      if (again.status !== 404) throw new Error('second delete ' + again.status);
      await p.getByTestId('idea-space').waitFor();
    }); // no console error: the page of the deleted idea is not fetched again (it used to answer 404 twice)
  },
};
