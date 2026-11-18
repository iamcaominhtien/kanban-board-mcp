import fs from 'node:fs';
import path from 'node:path';
import { home, ensureProject, openMembers } from '../lib/ui.mjs';

// Idea Space AI helpers: triage advice in the Inbox (get, ask again, accept, ignore, bulk accept), "Shape with AI" on
// an idea page (the starters, a question, Stop, applying the drafts) and "Prepare the ticket" in the Promote dialog.
// The stand-in AI answers by skill (FAKE_CLAUDE_ASSISTANT_BY_SKILL: idea-triage, idea-shape, idea-prepare-ticket).
export default {
  name: 'Idea Space AI: triage advice, Shape with AI, prepare a ticket',
  group: 'ai',
  async run(s) {
    const p = s.page;
    const base = s.server.base;
    const api = async (path) => (await p.request.get(`${base}${path}`)).json();
    const view = (name) => p.getByRole('tablist', { name: 'View' }).getByRole('tab', { name });
    const answers = (by, extra = {}) => s.server.fake({ FAKE_CLAUDE_MODE: 'assistant', FAKE_CLAUDE_ASSISTANT_BY_SKILL: JSON.stringify(by), ...extra });
    const ideaIds = {};
    const openInbox = async () => {
      await p.getByRole('button', { name: /^Inbox/ }).click();
      await p.getByRole('heading', { name: 'Triage' }).waitFor();
    };
    const row = (title) => p.locator('.is-inbox-row').filter({ hasText: title });

    await s.step('set up: a project with an AI team and three ideas in the Inbox', async () => {
      s.server.signIn();
      answers({});
      await ensureProject(s);
      await openMembers(s);
      await p.getByTestId('members-tab-ai').click();
      await p.getByRole('button', { name: /Add AI team/ }).first().click();
      const d = p.getByRole('dialog', { name: 'Add AI team' });
      await d.getByTestId('team-name').fill('Idea helper');
      await d.getByTestId('team-working-dir').fill(s.server.dirs.repo);
      await d.getByTestId('add-team-submit').click();
      await p.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      await home(s);
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await p.getByRole('heading', { name: 'No ideas here yet' }).waitFor();
      for (const [n, title] of [[1, 'Offline mode'], [2, 'Night theme'], [3, 'Dark theme']]) {
        await p.getByRole('button', { name: 'New idea' }).first().click();
        await p.getByRole('textbox', { name: 'Idea title' }).fill(title);
        await p.getByRole('button', { name: 'Add to Inbox' }).click();
        await p.getByText(`Added IDEA-${n} to the Inbox`).waitFor();
      }
      Object.assign(ideaIds, { 'Offline mode': 'IDEA-1', 'Night theme': 'IDEA-2', 'Dark theme': 'IDEA-3' });
      s.note('ideas', ideaIds);
    });
    await s.step('Inbox: the advice bar offers "Get advice" and the switch is on', async () => {
      await openInbox();
      const bar = p.getByTestId('advice-bar');
      await bar.getByRole('button', { name: 'Get advice' }).waitFor();
      await bar.getByText(/can read the 3 new ideas and suggest Keep, Park, Merge or Archive/).waitFor();
      const sw = p.getByRole('switch', { name: 'AI advice in triage' });
      if (!(await sw.isChecked())) throw new Error('triage advice should be on by default');
      const st = await api('/api/idea-ai/status');
      s.note('status', st);
    });
    const PARK = { action: 'park', reason: 'Not a priority this quarter.', confidence: 'medium', park_days: 14 };
    const KEEP = { action: 'keep', reason: 'Worth exploring now.', confidence: 'high' };
    const NONE = { action: 'none', reason: 'Too vague to judge.', confidence: 'low' };
    const adviceOf = async (...ids) => api('/api/idea-ai/advice?' + ids.map((i) => `idea_ids=${i}`).join('&') + '&include_none=true');

    await s.step('Get advice: every Inbox idea gets a Park suggestion, nothing is applied', async () => {
      answers({ 'idea-triage': PARK });
      const bar = p.getByTestId('advice-bar');
      const posted = p.waitForResponse((r) => r.url().endsWith('/api/idea-ai/advice') && r.request().method() === 'POST');
      await bar.getByRole('button', { name: 'Get advice' }).click();
      const res = await posted;
      if (res.status() !== 200) throw new Error('advice POST ' + res.status());
      await p.getByText('3 suggestions', { exact: true }).first().waitFor();
      await bar.getByText(/Idea AI read the 3 new ideas\. You decide/).waitFor();
      await bar.getByRole('button', { name: 'Ask again' }).waitFor();
      await bar.getByTestId('bulk-accept').getByText('Accept Park').waitFor();
      for (const t of ['Offline mode', 'Night theme', 'Dark theme']) {
        const r = row(t);
        await r.getByText('Not a priority this quarter.').waitFor();
        await r.getByText('Confidence:').waitFor();
        await r.getByRole('button', { name: 'Accept' }).waitFor();
        await r.getByRole('button', { name: 'Ignore' }).waitFor();
      }
      const adv = await adviceOf('IDEA-1', 'IDEA-2', 'IDEA-3');
      if (adv.length !== 3 || adv.some((a) => a.action !== 'park' || a.parkDays !== 14 && a.park_days !== 14)) throw new Error('advice ' + JSON.stringify(adv));
      const inbox = await api('/api/idea-ai/status');
      s.note('spent', inbox.spentToday);
      // the ideas are untouched
      await p.getByText('3 to sort').waitFor();
    });
    await s.step('Ignore the advice of one row: it goes, and the server marks it ignored', async () => {
      const before = await adviceOf('IDEA-3');
      if (before.length !== 1) throw new Error('expected one advice: ' + JSON.stringify(before));
      await row('Dark theme').getByRole('button', { name: 'Ignore' }).click();
      await row('Dark theme').getByText('Not a priority this quarter.').waitFor({ state: 'detached' });
      await p.getByText('2 suggestions', { exact: true }).first().waitFor().catch(() => {});
      const after = await adviceOf('IDEA-3');
      if (after.length) throw new Error('ignored advice still listed: ' + JSON.stringify(after));
    });
    await s.step('Accept the Park advice of a row: the Park dialog opens, the idea is parked', async () => {
      await row('Offline mode').getByRole('button', { name: 'Accept' }).click();
      const d = p.getByRole('dialog', { name: /Park/ });
      await d.waitFor();
      s.note('park dialog', (await d.innerText()).slice(0, 300));
      // the dialog opens on the advice's 14 days, not on its own "Next week" (it used to drop the advice)
      const in14 = new Date(Date.now() + 14 * 864e5);
      const want = `${in14.getFullYear()}-${String(in14.getMonth() + 1).padStart(2, '0')}-${String(in14.getDate()).padStart(2, '0')}`;
      if (await d.getByRole('button', { name: 'Next week' }).getAttribute('aria-pressed') === 'true') throw new Error('Park opened on Next week');
      const accepted = p.waitForRequest((r) => /\/api\/idea-ai\/advice\/[^/]+\/state$/.test(r.url()) && (r.postData() || '').includes('accepted'));
      await d.getByRole('button', { name: /^Park/ }).last().click();
      await d.waitFor({ state: 'detached' });
      await p.getByText('2 to sort').waitFor();
      const idea = await api('/api/idea-tickets/IDEA-1');
      if (idea.stage !== 'parked') throw new Error('stage ' + idea.stage);
      const until = idea.parkUntil ?? idea.park_until ?? '';
      if (!String(until).startsWith(want)) throw new Error(`parked until ${until}, advice said ${want}`);
      // once the move is done the advice is marked accepted (it used to stay open)
      await accepted;
    });
    await s.step('Ask again with a different answer: the advice is replaced', async () => {
      answers({ 'idea-triage': KEEP });
      const bar = p.getByTestId('advice-bar');
      await bar.getByRole('button', { name: /Ask again|Get advice/ }).click();
      await row('Night theme').getByText('Worth exploring now.').waitFor();
      await row('Dark theme').getByText('Worth exploring now.').waitFor();
      await row('Night theme').getByText('Not a priority this quarter.').waitFor({ state: 'detached' });
      await bar.getByTestId('bulk-accept').getByText('Accept Keep').waitFor();
    });
    await s.step('the idea in focus shows the advice card with Why', async () => {
      const card = p.getByTestId('advice-card');
      await card.waitFor();
      await card.getByText('Worth exploring now.').first().waitFor();
      await card.getByRole('button', { name: /^Why .* suggests Keep/ }).click();
      await card.getByText(/ago|just now|now/i).first().waitFor();
    });
    await s.step('an idea edited after the advice makes it stale: no Accept, Ask again on the card', async () => {
      const r = await p.request.patch(`${base}/api/idea-tickets/IDEA-3/page`, { data: { body: 'Edited after the AI read it.' } });
      if (!r.ok()) throw new Error('patch ' + r.status() + await r.text());
      await p.reload();
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await openInbox();
      await row('Dark theme').getByText('Worth exploring now.').waitFor();
      await row('Dark theme').getByRole('button', { name: 'Accept' }).waitFor({ state: 'detached' });
      // the bulk button takes only the fresh one
      await p.getByTestId('bulk-accept').getByText('Accept Keep').waitFor();
    });
    await s.step('stale advice on the focus card: Ask again with "not sure" leaves the idea to you', async () => {
      await p.getByRole('button', { name: /^Dark theme/ }).first().click();
      const card = p.getByTestId('advice-card');
      await card.getByText('This idea changed since the advice.').waitFor();
      if (await card.getByRole('button', { name: 'Accept' }).count()) throw new Error('stale advice must not be acceptable');
      answers({ 'idea-triage': NONE });
      const posted = p.waitForResponse((r) => r.url().endsWith('/api/idea-ai/advice') && r.request().method() === 'POST');
      await card.getByRole('button', { name: 'Ask again' }).click();
      await posted;
      await p.getByTestId('row-not-sure-IDEA-3').waitFor();
      await card.waitFor({ state: 'detached' });
      const t = await p.getByTestId('row-not-sure-IDEA-3').getAttribute('title');
      if (t !== 'Too vague to judge.') throw new Error('title ' + t);
      const adv = await adviceOf('IDEA-3');
      if (adv.length !== 1 || adv[0].action !== 'none') throw new Error(JSON.stringify(adv));
      // the advice "none" is listed only on request
      const quiet = await api('/api/idea-ai/advice?idea_ids=IDEA-3');
      if (quiet.length) throw new Error('none advice listed without include_none');
    });
    await s.step('Accept Keep: one confirmation lists the move, then the idea is Exploring', async () => {
      const bar = p.getByTestId('advice-bar');
      await bar.getByTestId('bulk-accept').click();
      const d = p.getByRole('dialog', { name: 'Accept these suggestions' });
      await d.getByText('Accept Keep?', { exact: true }).waitFor();
      await d.getByTestId('bulk-accept-moves').getByText('Keep “Night theme”: it moves to Exploring').waitFor();
      await d.getByTestId('bulk-accept-confirm').getByText('Accept 1 move').waitFor();
      await d.getByTestId('bulk-accept-confirm').click();
      await p.getByText('Accepted 1 suggestion').waitFor();
      await d.waitFor({ state: 'detached' });
      const idea = await api('/api/idea-tickets/IDEA-2');
      if (idea.stage !== 'exploring') throw new Error('stage ' + idea.stage);
      await p.getByText('1 to sort').waitFor();
      await bar.getByTestId('bulk-accept').waitFor({ state: 'detached' });
    });
    await s.step('"AI advice in triage" switch off hides the bar and the rows, on brings them back', async () => {
      const sw = p.getByRole('switch', { name: 'AI advice in triage' });
      await sw.click();
      await p.getByText('AI advice is off for this project').waitFor();
      await p.getByTestId('advice-bar').waitFor({ state: 'detached' });
      const pid = (await api('/projects'))[0].id;
      await p.waitForFunction(async ([u]) => (await (await fetch(u)).json()).settings.triage_advice === false, [`${base}/api/idea-ai/status?project_id=${pid}`]);
      await sw.click();
      await p.getByText('AI advice is on for this project').waitFor();
      await p.getByTestId('advice-bar').getByRole('button', { name: /Get advice|Ask again/ }).waitFor();
    });

    // ---- Shape with AI on the idea page
    const SHAPE = {
      problem: 'Commuters lose drafts when the signal drops.',
      idea: 'Queue the edits on the device and sync them later.',
      assumptions: [
        { text: 'People edit on trains', impact: 'high', cheapest_test: 'Ask five commuters' },
        { text: 'Sync conflicts are rare', impact: 'low', cheapest_test: 'Count conflicts in the edit logs' },
      ],
      effort: 'M',
      why: 'It touches the sync layer and the editor.',
      files: ['server/sync.rs'],
      summary: 'One similar idea exists.',
      items: [{ kind: 'idea', id: 'IDEA-3', title: 'Dark theme', score: 0.42, why: 'Also a switch in the settings.' }],
      answer: 'Start with the commuter interviews.',
    };
    const panel = p.getByTestId('shape-panel');
    const openIdea = async (title) => {
      await p.getByRole('button', { name: 'Back to Idea Space' }).click().catch(() => {});
      await view('List').click();
      await p.getByRole('button', { name: 'Exploring' }).click();
      await p.getByText(title, { exact: true }).first().click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
    };
    const openPanel = async () => {
      if (await panel.count()) return;
      await p.getByTestId('shape-button').click();
      await panel.waitFor();
    };
    const closePanel = async () => {
      await panel.getByRole('button', { name: 'Close', exact: true }).click();
      await panel.waitFor({ state: 'detached' });
    };
    const starter = (name) => panel.getByRole('button', { name, exact: true });
    // POST /shape: the body that was sent and the status that came back
    const shapeCall = (go) => Promise.all([
      p.waitForResponse((r) => /\/api\/idea-ai\/shape$/.test(r.url()) && r.request().method() === 'POST'),
      go(),
    ]).then(([r]) => ({ status: r.status(), body: r.request().postDataJSON() }));
    // how many stand-in AI processes of THIS server are alive (found by the folder in their environment)
    const aiProcesses = () => {
      const marker = path.join(path.dirname(s.server.dirs.uploads), 'fake.env');
      let n = 0;
      for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x))) {
        try {
          if (fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim() === 'fake-claude' && fs.readFileSync(`/proc/${pid}/environ`, 'utf8').includes(marker)) n += 1;
        } catch {}
      }
      return n;
    };
    const idea2 = () => api('/api/idea-tickets/IDEA-2');

    await s.step('the idea page offers Shape with AI: the panel says what it reads and lists the starters', async () => {
      answers({ 'idea-shape': SHAPE });
      await openIdea('Night theme');
      await p.getByTestId('ai-rail-card').getByRole('button', { name: 'Open chat' }).waitFor();
      await p.getByTestId('shape-button').click();
      await panel.waitFor();
      await panel.getByText('Idea AI', { exact: true }).waitFor();
      await panel.getByTestId('shape-reading').getByText('This idea').waitFor();
      await panel.getByTestId('shape-reading').getByText('related Docs and tickets').waitFor();
      await panel.getByTestId('shape-empty').waitFor();
      for (const l of ['Draft the problem and the idea', 'Suggest assumptions and cheapest tests', 'Check what already exists', 'Guess the effort from the code']) await starter(l).waitFor();
      // no assumption yet: no "Cheapest test" starter
      if (await panel.getByText('Cheapest test for each assumption', { exact: true }).count()) throw new Error('tests starter without assumptions');
      await panel.getByRole('button', { name: 'Send' }).isDisabled().then((d) => { if (!d) throw new Error('Send should be disabled while empty'); });
    });
    await s.step('Draft the problem: a draft comes back and "Add to the page" writes it into the idea', async () => {
      const call = await shapeCall(() => starter('Draft the problem and the idea').click());
      if (call.status !== 200 || call.body.kind !== 'problem' || call.body.idea_id !== 'IDEA-2' || !/^shape-/.test(call.body.request_id || '')) throw new Error('shape call ' + JSON.stringify(call));
      await panel.getByText('Draft · problem and idea').waitFor();
      await panel.getByText(SHAPE.problem).waitFor();
      await panel.getByText(SHAPE.idea).waitFor();
      await panel.getByText(/Idea AI .* suggestions are drafts/).waitFor();
      // nothing was written yet
      if ((await idea2()).body?.includes('## Problem')) throw new Error('written before Add');
      await panel.getByRole('button', { name: 'Add to the page' }).click();
      await panel.getByRole('button', { name: 'Added', exact: true }).waitFor();
      const body = (await idea2()).body;
      if (!body.includes('## Problem') || !body.includes(SHAPE.problem) || !body.includes('## Idea')) throw new Error('body ' + body);
      // starters are gone once the chat has a turn
      if (await starter('Check what already exists').count()) throw new Error('starters should hide after the first turn');
    });
    await s.step('Suggest assumptions: add one, then "Add all" skips it', async () => {
      await closePanel();
      await openPanel();
      const call = await shapeCall(() => starter('Suggest assumptions and cheapest tests').click());
      if (call.body.kind !== 'assumptions') throw new Error('kind ' + call.body.kind);
      await panel.getByText('Draft · 2 assumptions').waitFor();
      await panel.getByText('Cheapest test: Ask five commuters').waitFor();
      await panel.getByText('Cheapest test: Count conflicts in the edit logs').waitFor();
      const first = panel.locator('.is-draft-item').filter({ hasText: 'People edit on trains' });
      await first.getByRole('button', { name: 'Add', exact: true }).click();
      await first.getByRole('button', { name: 'Added', exact: true }).waitFor();
      let a = (await idea2()).assumptions;
      if (a.length !== 1 || a[0].text !== 'People edit on trains' || a[0].impact !== 'high') throw new Error('after one ' + JSON.stringify(a));
      await panel.getByRole('button', { name: 'Add all 2' }).click();
      await panel.locator('.is-draft-item').filter({ hasText: 'Sync conflicts are rare' }).getByRole('button', { name: 'Added', exact: true }).waitFor();
      a = (await idea2()).assumptions;
      if (a.length !== 2) throw new Error('Add all duplicated or missed: ' + JSON.stringify(a.map((x) => x.text)));
      if (a.some((x) => x.ai !== true)) throw new Error('assumptions added from a draft should carry the AI mark: ' + JSON.stringify(a.map((x) => x.ai)));
    });
    await s.step('Cheapest test for each assumption: create a test ticket and post one to the comments', async () => {
      const a = (await idea2()).assumptions;
      const byText = Object.fromEntries(a.map((x) => [x.text, x.id]));
      answers({ 'idea-shape': { ...SHAPE, tests: [
        { assumption_id: byText['People edit on trains'], test: 'Interview five commuters about editing offline' },
        { assumption_id: byText['Sync conflicts are rare'], test: 'Count the conflicts in last month\'s edit logs' },
      ] } });
      await closePanel();
      await openPanel();
      const call = await shapeCall(() => starter('Cheapest test for each assumption').click());
      if (call.body.kind !== 'tests') throw new Error('kind ' + call.body.kind);
      await panel.getByText('Draft · cheapest test for each').waitFor();
      const one = panel.locator('.is-draft-item').filter({ hasText: 'Interview five commuters' });
      await one.getByText('People edit on trains').waitFor();
      await one.getByRole('button', { name: 'Create test ticket' }).click();
      await p.getByText(/^Created ALP-\d+$/).first().waitFor();
      await one.getByRole('button', { name: 'Created', exact: true }).waitFor();
      const after = (await idea2()).assumptions.find((x) => x.id === byText['People edit on trains']);
      if (after.state !== 'testing' || !/^ALP-\d+$/.test(after.test_ticket_id || '')) throw new Error('assumption after the test ticket ' + JSON.stringify(after));
      const two = panel.locator('.is-draft-item').filter({ hasText: 'Count the conflicts' });
      await two.getByRole('button', { name: 'Post to comments' }).click();
      await p.getByText('Posted to comments').first().waitFor();
      const comments = await api('/api/idea-tickets/IDEA-2/comments');
      if (!comments.some((c) => c.body.includes('Cheapest test for “Sync conflicts are rare”'))) throw new Error('comment missing ' + JSON.stringify(comments));
    });
    await s.step('Guess the effort: "Use as effort guess" saves it on the idea', async () => {
      await closePanel();
      await openPanel();
      const call = await shapeCall(() => starter('Guess the effort from the code').click());
      if (call.body.kind !== 'effort') throw new Error('kind ' + call.body.kind);
      await panel.getByText('Draft · effort guess').waitFor();
      await panel.getByText('(AI estimate)').first().waitFor();
      await panel.getByText('It touches the sync layer and the editor.').waitFor();
      await panel.getByText('Based on: server/sync.rs').waitFor();
      await panel.getByRole('button', { name: 'Use as effort guess' }).click();
      await panel.getByRole('button', { name: 'Saved', exact: true }).waitFor();
      const i = await idea2();
      const guess = i.effort_guess ?? i.effortGuess;
      if (guess !== 'M (AI estimate)') throw new Error('effort guess ' + guess);
    });
    await s.step('Check what already exists: the similar idea is listed and opens', async () => {
      await closePanel();
      await openPanel();
      const call = await shapeCall(() => starter('Check what already exists').click());
      if (call.body.kind !== 'exists') throw new Error('kind ' + call.body.kind);
      await panel.getByText('What already exists').waitFor();
      await panel.getByText('One similar idea exists.').waitFor();
      await panel.getByText('Also a switch in the settings.').waitFor();
      await panel.getByText(/idea IDEA-3 · 42% similar/).waitFor();
      await panel.getByRole('button', { name: 'Dark theme' }).click();
      await p.waitForFunction(() => document.querySelector('[aria-label="Idea title"]')?.value === 'Dark theme');
    });
    await s.step('ask a question: the answer is posted to the comments and saved to the log', async () => {
      await openIdea('Night theme');
      await openPanel();
      const input = panel.getByRole('textbox', { name: 'Ask about this idea' });
      await input.fill('What should I do first?');
      const call = await shapeCall(() => input.press('Enter'));
      if (call.body.kind !== 'ask' || call.body.question !== 'What should I do first?') throw new Error('call ' + JSON.stringify(call));
      await panel.locator('.is-turn-you').filter({ hasText: 'What should I do first?' }).waitFor();
      await panel.getByText(SHAPE.answer).waitFor();
      if ((await input.inputValue()) !== '') throw new Error('the question box was not cleared');
      await panel.getByRole('button', { name: 'Post to comments' }).click();
      await p.getByText('Posted to comments').first().waitFor();
      await panel.getByRole('button', { name: 'Save to log' }).click();
      await panel.getByRole('button', { name: 'Saved to the log' }).waitFor();
      const comments = await api('/api/idea-tickets/IDEA-2/comments');
      if (!comments.some((c) => c.body === SHAPE.answer)) throw new Error('answer comment missing');
      const log = await api('/api/idea-tickets/IDEA-2/log');
      const entry = log.find((l) => l.body === SHAPE.answer);
      if (!entry || entry.kind !== 'research') throw new Error('log entry ' + JSON.stringify(log));
    });
    await s.step('Stop ends a running request: the turn says it was stopped and Try again works', async () => {
      answers({ 'idea-shape': SHAPE }, { FAKE_CLAUDE_ASSISTANT_WAIT: '60' });
      const input = panel.getByRole('textbox', { name: 'Ask about this idea' });
      await input.fill('A slow question');
      const sent = p.waitForRequest((r) => /\/api\/idea-ai\/shape$/.test(r.url()));
      await input.press('Enter');
      const req = (await sent).postDataJSON();
      await panel.getByText(/Reading the idea/).waitFor();
      const stop = panel.getByTestId('shape-stop');
      // the request is running a stand-in AI process (it waits 60 s): this also proves the process check below can see it
      for (let i = 0; i < 40 && aiProcesses() === 0; i++) await p.waitForTimeout(100);
      if (aiProcesses() < 1) throw new Error('the running request has no AI process');
      const stopped = p.waitForResponse((r) => r.url().endsWith(`/api/idea-ai/shape/${req.request_id}/stop`));
      await stop.click();
      const res = await stopped;
      const body = await res.json();
      if (res.status() !== 200 || body.stopped !== true) throw new Error('stop answered ' + res.status() + JSON.stringify(body));
      const gone = panel.getByTestId('shape-stopped');
      await gone.waitFor();
      for (let i = 0; i < 50 && aiProcesses() > 0; i++) await p.waitForTimeout(100);
      // the process of the stopped request must not go on (and be paid for) after Stop
      if (aiProcesses() !== 0) throw new Error('Stop left the AI process running (' + aiProcesses() + ')');
      await gone.getByText('Stopped.').waitFor();
      // stopping again: nothing is running any more
      const again = await p.request.post(`${base}/api/idea-ai/shape/${req.request_id}/stop`);
      if ((await again.json()).stopped !== false) throw new Error('second stop should say false');
      answers({ 'idea-shape': SHAPE });
      const retry = await shapeCall(() => gone.getByRole('button', { name: 'Try again' }).click());
      if (retry.status !== 200 || retry.body.question !== 'A slow question') throw new Error('retry ' + JSON.stringify(retry));
      await panel.getByText(SHAPE.answer).last().waitFor();
      await gone.waitFor({ state: 'detached' });
    });
    await s.step('an answer that cannot be used shows the error with Try again', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'assistant', FAKE_CLAUDE_ASSISTANT_BY_SKILL: JSON.stringify({ 'idea-shape': null }), FAKE_CLAUDE_ASSISTANT_TEXT: '' });
      const input = panel.getByRole('textbox', { name: 'Ask about this idea' });
      await input.fill('Will this fail?');
      await input.press('Enter');
      const banner = panel.getByRole('alert');
      await banner.getByText('Idea AI did not answer.').waitFor();
      await banner.getByText(/Nothing was changed/).waitFor();
      answers({ 'idea-shape': { answer: 'Now it works.' } });
      await banner.getByRole('button', { name: 'Try again' }).click();
      await panel.getByText('Now it works.').waitFor();
      await banner.waitFor({ state: 'detached' });
    });

    // ---- Prepare the ticket in the Promote dialog, and the digest's "Open Inbox"
    await s.step('Promote > Draft with AI fills the title, description with criteria, and a split into sub-tickets', async () => {
      answers({ 'idea-prepare-ticket': {
        title: 'Edit offline and sync later',
        description: 'Queue edits on the device while there is no signal.',
        acceptance_criteria: ['Edits survive a restart', 'Edits sync when the signal is back'],
        sub_tickets: ['Local edit queue', 'Sync on reconnect'],
      } });
      await closePanel();
      await p.getByTestId('promote').click();
      const d = p.getByTestId('promote-dialog');
      await d.waitFor();
      await d.getByRole('textbox', { name: 'Ticket title' }).waitFor();
      const posted = p.waitForResponse((r) => r.url().endsWith('/api/idea-ai/prepare-ticket') && r.request().method() === 'POST');
      await d.getByTestId('draft-with-ai').click();
      const res = await posted;
      if (res.status() !== 200 || res.request().postDataJSON().idea_id !== 'IDEA-2') throw new Error('prepare call ' + res.status() + res.request().postData());
      await d.getByText('Drafted by Idea AI. Edit what you want before Create.').waitFor();
      if ((await d.getByRole('textbox', { name: 'Ticket title' }).inputValue()) !== 'Edit offline and sync later') throw new Error('title not filled');
      await d.getByText('Queue edits on the device while there is no signal.').first().waitFor();
      await d.getByText('Edits survive a restart').first().waitFor();
      await d.getByRole('textbox', { name: 'Sub-ticket 1' }).waitFor();
      if ((await d.getByRole('textbox', { name: 'Sub-ticket 1' }).inputValue()) !== 'Local edit queue') throw new Error('sub-ticket 1');
      if ((await d.getByRole('textbox', { name: 'Sub-ticket 2' }).inputValue()) !== 'Sync on reconnect') throw new Error('sub-ticket 2');
      // nothing is created until Create
      if ((await idea2()).stage === 'building') throw new Error('promoted by Draft with AI');
    });
    await s.step('Create ticket from the draft: the ticket and its sub-tickets exist', async () => {
      const d = p.getByTestId('promote-dialog');
      // a high-impact assumption is still open: promoting anyway needs the tick
      await d.getByRole('checkbox', { name: 'I understand, promote anyway' }).check();
      await d.getByTestId('create-ticket').click();
      await p.getByText(/^Created ALP-\d+$/).first().waitFor();
      await d.waitFor({ state: 'detached' });
      const i = await idea2();
      if (i.stage !== 'building' || !i.ticket) throw new Error('idea ' + i.stage + ' ' + JSON.stringify(i.ticket));
      const tk = await api('/tickets/' + i.ticket.id);
      if (tk.title !== 'Edit offline and sync later') throw new Error('ticket title ' + tk.title);
      if (!/Edits survive a restart/.test(tk.description || '')) throw new Error('criteria missing from the ticket');
    });
    await s.step('Draft with AI that cannot be used says so and changes nothing', async () => {
      // Dark theme is still in the Inbox: open its page from Triage
      await p.getByRole('button', { name: 'Back to Idea Space' }).click().catch(() => {});
      await p.getByRole('button', { name: /^Inbox/ }).click();
      await p.getByRole('region', { name: 'Idea in focus' }).getByRole('button', { name: 'Open the page' }).click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
      answers({ 'idea-prepare-ticket': { description: 'no title' } });
      await p.getByTestId('promote').click();
      const d = p.getByTestId('promote-dialog');
      await d.waitFor();
      await d.getByTestId('draft-with-ai').click();
      await d.getByText(/Nothing was changed/).waitFor();
      if ((await d.getByRole('textbox', { name: 'Ticket title' }).inputValue()) !== 'Dark theme') throw new Error('title changed');
      await d.getByRole('button', { name: 'Cancel' }).click();
      await d.waitFor({ state: 'detached' });
    });
    await s.step('the weekly digest on the Idea Space home: Write it now, then Open Inbox goes to Triage', async () => {
      answers({ 'idea-digest': {
        text: '1 idea is waiting in the Inbox.\n\nNobody has looked at Dark theme yet.',
        items: [{ kind: 'waiting', idea_ids: ['IDEA-3'], text: '1 idea is waiting in the Inbox: Dark theme.' }],
      } });
      await p.getByRole('button', { name: 'Back to Idea Space' }).click().catch(() => {});
      const nav = p.getByRole('complementary', { name: 'Project navigation' }).getByRole('button', { name: /^Idea Space/ });
      if ((await nav.getAttribute('aria-pressed')) !== 'true') await nav.click();
      await nav.and(p.locator('[aria-pressed="true"]')).waitFor();
      const card = p.getByTestId('digest-card');
      await card.getByText('Weekly grooming is on.').waitFor();
      const posted = p.waitForResponse((r) => r.url().endsWith('/api/idea-ai/digest/run') && r.request().method() === 'POST');
      await card.getByRole('button', { name: 'Write it now' }).click();
      if ((await posted).status() !== 201 && (await posted).status() !== 200) throw new Error('digest/run ' + (await posted).status());
      await card.getByText('1 idea', { exact: false }).first().waitFor();
      await card.getByText('Nobody has looked at Dark theme yet.').waitFor();
      await card.getByText(/read \d+ ideas/).waitFor();
      await card.getByRole('button', { name: 'Open Inbox' }).first().click();
      await p.getByRole('heading', { name: 'Triage' }).waitFor();
      await p.getByRole('complementary', { name: 'Inbox' }).getByText('1 to sort').waitFor();
    });
  },
};
