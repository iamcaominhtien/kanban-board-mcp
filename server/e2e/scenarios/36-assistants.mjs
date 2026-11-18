import { home, ensureProject, openMembers, createTicket, openTicket, openDocs, newDocPage, setMarkdown, publishDoc } from '../lib/ui.mjs';

// The assistants beyond their first screens (Board AI chats, answers, health insights, ticket chat; the editor AI in
// the editors; Docs AI drafts, jobs and notes), with the stand-in CLI (FAKE_CLAUDE_MODE=assistant). What the model
// would answer is given per skill (FAKE_CLAUDE_ASSISTANT_BY_SKILL) or as plain text (FAKE_CLAUDE_ASSISTANT_TEXT).
// Not covered (the stand-in cannot give it): DoneReceipt and its Undo all (a receipt is read from ticket Activity written
// by the board's tools while a turn runs; the stand-in never calls them), ContextMeter (the stand-in sends no
// `modelUsage.contextWindow`, and the Rust server never writes `contextWindow` into a Board AI answer), "Continue"
// of a cut-short answer or draft (`cut_short` is never set), the sketch panel's Accept / Discard of shapes (the Rust
// server draws no shapes), and the DocsAi draft blocks (the server makes no doc drafts any more).
export default {
  name: 'Assistants: Board AI chats and answers, health insights, ticket chat, editor AI, Docs AI drafts',
  group: 'ai',
  async run(s) {
    const p = s.page;
    const base = s.server.base;
    const ids = {};
    const get = async (path) => {
      const r = await p.request.get(`${base}${path}`);
      if (!r.ok()) throw new Error(`GET ${path} answered ${r.status()}`);
      return r.json();
    };
    const send = async (method, path, data) => {
      const r = await p.request.fetch(`${base}${path}`, { method, data });
      let body = null;
      try { body = await r.json(); } catch { /* no body */ }
      return { status: r.status(), body };
    };
    const until = async (fn, what, ms = 20000) => {
      const t0 = Date.now();
      let last;
      while (Date.now() - t0 < ms) {
        try { last = await fn(); if (last) return last; } catch (e) { last = e; }
        await new Promise((r) => setTimeout(r, 150));
      }
      throw new Error(`timed out waiting for ${what}${last instanceof Error ? ': ' + last.message : ''}`);
    };
    // what the stand-in answers: plain text, and/or by skill
    const answers = { by: {} };
    const fake = (more = {}) => {
      const { by, ...rest } = more;
      Object.assign(answers.by, by || {});
      Object.assign(answers, rest);
      const vars = { FAKE_CLAUDE_MODE: 'assistant', FAKE_CLAUDE_ASSISTANT_BY_SKILL: JSON.stringify(answers.by) };
      if (answers.text != null) vars.FAKE_CLAUDE_ASSISTANT_TEXT = answers.text;
      if (answers.wait != null) vars.FAKE_CLAUDE_ASSISTANT_WAIT = String(answers.wait);
      s.server.fake(vars);
    };
    const dock = () => p.getByRole('complementary', { name: 'Board AI' });
    const openDock = async () => {
      await p.getByRole('button', { name: /^Ask AI/ }).first().click();
      await dock().getByText(/online/).waitFor();
    };
    const ask = async (text) => {
      const box = dock().getByRole('textbox', { name: 'Ask the Board AI' });
      await box.fill(text);
      await dock().getByRole('button', { name: 'Send' }).click();
    };

    await s.step('set up: a signed-in AI account, a project with an AI team, a ticket and a page', async () => {
      s.server.signIn();
      fake({ text: 'Nothing is overdue.' });
      await ensureProject(s);
      await openMembers(s);
      await p.getByTestId('members-tab-ai').click();
      await p.getByRole('button', { name: /Add AI team/ }).first().click();
      const d = p.getByRole('dialog', { name: 'Add AI team' });
      await d.getByTestId('team-name').fill('Helper');
      await d.getByTestId('team-working-dir').fill(s.server.dirs.repo);
      await d.getByTestId('add-team-submit').click();
      await p.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Docs', exact: true }).click();
      await p.getByRole('switch', { name: 'Use AI in Docs' }).click();
      await p.getByRole('switch', { name: 'Use AI in Docs', checked: true }).waitFor();
      await p.getByRole('combobox', { name: 'AI that answers' }).selectOption({ label: 'Helper' });
      await s.settle();
      await p.getByRole('button', { name: 'Back to board' }).click();
      await home(s);
      await createTicket(s, { title: 'Fix the login page' });
      await createTicket(s, { title: 'Add paging to the API' });
      ids.project = (await get('/projects'))[0].id;
      const tickets = await get(`/projects/${ids.project}/tickets`);
      for (const t of tickets.tickets ?? tickets) ids[t.title] = t.id;
      s.note('tickets', ids);
    });

    await s.step('Board AI: ask a question, the answer shows what it was based on', async () => {
      await home(s);
      await openDock();
      await ask('What is overdue?');
      await dock().getByText('Nothing is overdue.').waitFor({ timeout: 40000 });
      await dock().getByRole('button', { name: 'Regenerate' }).waitFor();
      const chats = await get(`/projects/${ids.project}/ai/assist/chats`);
      s.note('chats', { count: chats.count, titles: chats.chats.map((c) => c.title), keepDays: chats.keepDays });
      if (chats.count !== 1) throw new Error('expected one chat: ' + JSON.stringify(chats));
      ids.chat = chats.chats[0].id;
    });

    await s.step('Board AI: Regenerate asks the same question again (POST retry), a thumb is kept', async () => {
      fake({ text: 'One ticket is late.' });
      const retried = p.waitForResponse((r) => /\/ai\/assist\/messages\/[^/]+\/retry$/.test(r.url()) && r.request().method() === 'POST');
      await dock().getByRole('button', { name: 'Regenerate' }).click();
      if ((await retried).status() !== 200) throw new Error('retry answered ' + (await retried).status());
      await dock().getByText('One ticket is late.').waitFor({ timeout: 40000 });
      await dock().getByText('Nothing is overdue.').waitFor({ state: 'detached' });
      await dock().getByRole('button', { name: 'Not helpful' }).click();
      const chat = await get(`/ai/assist/chats/${ids.chat}`);
      const ai = chat.messages.find((m) => m.role === 'ai');
      await until(async () => (await get(`/ai/assist/chats/${ids.chat}`)).messages.find((m) => m.role === 'ai').feedback?.thumb === 'down', 'the thumb on the server');
      s.note('answer', { state: ai.state, text: ai.text, tokens: [ai.tokens_in, ai.tokens_out] });
    });
    await s.step('Board AI: Stop a slow answer (POST stop), the partial answer is kept', async () => {
      fake({ text: 'Too late.', wait: 25 });
      await dock().locator('button[title="New chat"]').click();
      await dock().getByTestId('assist-welcome').waitFor();
      await ask('A slow question');
      const waiting = dock().getByTestId('answer-thinking');
      await waiting.waitFor();
      const stopped = p.waitForResponse((r) => /\/ai\/assist\/messages\/[^/]+\/stop$/.test(r.url()) && r.request().method() === 'POST');
      await waiting.getByRole('button', { name: 'Stop' }).click();
      const res = await stopped;
      if (res.status() !== 200) throw new Error('stop answered ' + res.status());
      await dock().getByText(/Stopped · the partial answer is kept/).waitFor();
      const chats = await get(`/projects/${ids.project}/ai/assist/chats`);
      s.note('chats', chats.chats.map((c) => c.title));
      ids.chat2 = chats.chats.find((c) => c.title === 'A slow question').id;
      const m = (await get(`/ai/assist/chats/${ids.chat2}`)).messages.find((x) => x.role === 'ai');
      if (m.state !== 'stopped') throw new Error('state ' + m.state);
    });
    await s.step('Chat history: both chats, search, open an older one', async () => {
      fake({ text: 'Fine.', wait: 0 });
      await dock().getByRole('button', { name: 'Chat history' }).click();
      const h = p.getByTestId('assist-history');
      await h.getByText('What is overdue?').waitFor();
      await h.getByText('A slow question').waitFor();
      await h.getByRole('textbox', { name: 'Search chats' }).fill('overdue');
      await h.getByText('A slow question').waitFor({ state: 'detached' });
      await h.getByText('What is overdue?').click();
      await dock().getByText('One ticket is late.').waitFor();
    });
    await s.step('Board AI: switching the scope of a chat saves it (PATCH chat)', async () => {
      const patched = p.waitForResponse((r) => /\/ai\/assist\/chats\/[^/]+$/.test(r.url()) && r.request().method() === 'PATCH');
      await dock().getByRole('tab', { name: 'All projects' }).click();
      if ((await patched).status() !== 200) throw new Error('patch answered ' + (await patched).status());
      await dock().getByRole('tab', { name: 'All projects' }).and(p.locator('[aria-selected="true"]')).waitFor();
      const chat = await get(`/ai/assist/chats/${ids.chat}`);
      if (chat.scope !== 'all') throw new Error('scope ' + chat.scope);
      await dock().getByRole('tab', { name: 'This project' }).click();
      await until(async () => (await get(`/ai/assist/chats/${ids.chat}`)).scope === 'project', 'the scope back to project');
    });
    await s.step('a chat: the seen heartbeat and delete (DELETE) through the API', async () => {
      const seen = await send('POST', `/ai/assist/chats/${ids.chat2}/seen`);
      if (seen.status >= 300) throw new Error('seen ' + seen.status);
      const gone = await send('DELETE', `/ai/assist/chats/${ids.chat2}`);
      s.note('delete answer', gone);
      if (gone.status >= 300) throw new Error('delete answered ' + gone.status);
      const after = await get(`/projects/${ids.project}/ai/assist/chats`);
      if (after.chats.some((c) => c.id === ids.chat2)) throw new Error('the chat is still listed');
      const again = await send('GET', `/ai/assist/chats/${ids.chat2}`);
      s.note('deleted chat read', again.status);
      await dock().getByRole('button', { name: 'Chat history' }).click();
      await p.getByTestId('assist-history').getByText('A slow question').waitFor({ state: 'detached' });
    });

    const HEALTH = {
      insights: [
        { kind: 'stuck', ticket_id: 'ALP-1', title: 'ALP-1 has not moved for 6 days', detail: 'In backlog since Monday.', score: 90 },
        { kind: 'unassigned', ticket_id: 'ALP-2', title: 'ALP-2 has nobody on it', detail: 'No assignee yet.', score: 70 },
        { kind: 'priority', ticket_id: 'ALP-2', title: 'ALP-2 may need a higher priority', detail: 'Other work waits on it.', score: 50 },
      ],
      summary: 'Three things need a look.',
    };
    const panelOf = async () => get(`/projects/${ids.project}/ai/assist/health`);
    const health = () => p.getByRole('dialog', { name: 'Board health' });
    await s.step('Board health: Check now lists three insights', async () => {
      fake({ by: { 'board-health': HEALTH } });
      await dock().getByRole('button', { name: 'Close Board AI' }).click();
      await p.getByRole('button', { name: 'Board health' }).click();
      const d = health();
      await d.getByRole('button', { name: 'Check now' }).click();
      await d.getByText('ALP-1 has not moved for 6 days').waitFor({ timeout: 40000 });
      await d.getByRole('button', { name: 'Needs action 3' }).waitFor();
      const panel = await panelOf();
      s.note('needs action', panel.needs_action.map((i) => [i.kind, i.state]));
      ids.insights = Object.fromEntries(panel.needs_action.map((i) => [i.kind, i.id]));
    });
    await s.step('an insight is snoozed for a week (POST insights/:id/snooze) and restored', async () => {
      const d = health();
      const row = d.getByTestId('insight-stuck');
      const posted = p.waitForResponse((r) => /\/ai\/assist\/insights\/[^/]+\/snooze$/.test(r.url()) && r.request().method() === 'POST');
      await row.getByRole('button', { name: 'Snooze' }).click();
      await row.getByRole('button', { name: 'Snooze for a week' }).click();
      if ((await posted).status() !== 200) throw new Error('snooze answered ' + (await posted).status());
      await row.waitFor({ state: 'detached' });
      await d.getByRole('button', { name: 'Snoozed 1' }).click();
      const snoozed = d.getByTestId('insight-stuck');
      await snoozed.getByText('ALP-1 has not moved for 6 days').waitFor();
      const posted2 = p.waitForResponse((r) => /\/ai\/assist\/insights\/[^/]+\/restore$/.test(r.url()) && r.request().method() === 'POST');
      await snoozed.getByRole('button', { name: 'Restore' }).click();
      if ((await posted2).status() !== 200) throw new Error('restore answered ' + (await posted2).status());
      await d.getByText('No snoozed insights.').waitFor();
      await d.getByRole('button', { name: 'Needs action 3' }).waitFor();
    });
    await s.step('an insight is dismissed (POST insights/:id/dismiss) and restored', async () => {
      const d = health();
      await d.getByRole('button', { name: 'Needs action 3' }).click();
      const row = d.getByTestId('insight-priority');
      const posted = p.waitForResponse((r) => /\/ai\/assist\/insights\/[^/]+\/dismiss$/.test(r.url()) && r.request().method() === 'POST');
      await row.getByRole('button', { name: 'Dismiss' }).click();
      if ((await posted).status() !== 200) throw new Error('dismiss answered ' + (await posted).status());
      await d.getByRole('button', { name: 'Dismissed 1' }).click();
      const gone = d.getByTestId('insight-priority');
      await gone.getByText('ALP-2 may need a higher priority').waitFor();
      const panel = await panelOf();
      if (panel.dismissed.length !== 1 || panel.dismissed[0].kind !== 'priority') throw new Error('dismissed: ' + JSON.stringify(panel.dismissed));
      await gone.getByRole('button', { name: 'Restore' }).click();
      await d.getByText('No dismissed insights.').waitFor();
      await d.getByRole('button', { name: 'Needs action 3' }).waitFor();
    });
    await s.step('the insight "act" has no draft any more: the server answers 410', async () => {
      const r = await send('POST', `/ai/assist/insights/${ids.insights.stuck}/act`, { hours: 24 });
      s.note('act answer', r);
      if (r.status !== 410) throw new Error('act answered ' + r.status);
      const bad = await send('POST', `/ai/assist/insights/${ids.insights.stuck}/explode`, { hours: 24 });
      s.note('unknown action answer', bad);
      if (bad.status < 400) throw new Error('an unknown action was accepted');
      await health().getByRole('button', { name: 'Close' }).click();
      await health().waitFor({ state: 'detached' });
    });
    await s.step('the toast "Board health is ready": Snooze all (POST health/snooze-all)', async () => {
      // a new check while the panel is closed leaves insights nobody has seen
      const run = await send('POST', `/projects/${ids.project}/ai/assist/health/run`);
      if (run.status >= 300) throw new Error('health run answered ' + run.status);
      await home(s);
      const toast = p.getByTestId('health-toast');
      await toast.waitFor({ timeout: 30000 });
      await toast.getByText(/need attention\. Nothing has been changed\./).waitFor();
      const posted = p.waitForResponse((r) => /\/health\/snooze-all$/.test(r.url()) && r.request().method() === 'POST');
      await toast.getByRole('button', { name: 'Snooze all' }).click();
      const res = await posted;
      if (res.status() !== 200) throw new Error('snooze-all answered ' + res.status());
      s.note('snooze-all', await res.json());
      await toast.waitFor({ state: 'detached' });
      const panel = await panelOf();
      if (panel.needs_action.length !== 0 || panel.snoozed.length < 1) throw new Error('after snooze-all: ' + JSON.stringify([panel.needs_action.length, panel.snoozed.length]));
    });
    const chatPanel = () => p.getByRole('complementary', { name: 'AI chat' });
    await s.step('ticket chat: ask about ALP-1, the chat keeps it private (POST seen)', async () => {
      fake({ text: 'The login page needs a redirect after sign-in.' });
      await home(s);
      const d = await openTicket(s, 'ALP-1');
      const seen = p.waitForResponse((r) => /\/ai\/assist\/chats\/[^/]+\/seen$/.test(r.url()) && r.request().method() === 'POST', { timeout: 40000 });
      await d.getByTestId('ticket-ai-chat').click();
      const c = chatPanel();
      await c.getByTestId('chat-member').getByText('Board AI').waitFor();
      const box = c.getByRole('textbox', { name: 'Ask the AI' });
      await box.waitFor();
      await box.fill('What is left on this ticket?');
      await box.press('Enter');
      await c.getByText('The login page needs a redirect after sign-in.').waitFor({ timeout: 40000 });
      // the heartbeat tells the board the chat is in front of its owner (only while the window has the focus)
      const res = await seen.catch(() => null);
      s.note('seen answered', res ? res.status() : 'no heartbeat (the window has no focus)');
      const chats = await get(`/projects/${ids.project}/ai/assist/chats`);
      const mine = chats.chats.find((x) => x.ticket_id === ids['Fix the login page']);
      if (!mine || mine.scope !== 'ticket') throw new Error('no ticket chat: ' + JSON.stringify(chats.chats.map((x) => [x.title, x.scope, x.ticket_id])));
      ids.ticketChat = mine.id;
    });
    await s.step('ticket chat: Post as comment shares the answer on the ticket (POST post-comment)', async () => {
      const c = chatPanel();
      const posted = p.waitForResponse((r) => /\/ai\/assist\/messages\/[^/]+\/post-comment$/.test(r.url()) && r.request().method() === 'POST');
      await c.getByTestId('answer-post-comment').click();
      const res = await posted;
      if (res.status() !== 200) throw new Error('post-comment answered ' + res.status());
      const out = await res.json();
      s.note('post-comment keys', Object.keys(out).sort().join());
      ids.comment = out.commentId ?? out.comment_id;
      await c.getByTestId('answer-posted').waitFor();
      await p.getByRole('dialog', { name: 'Ticket ALP-1' }).getByText('The login page needs a redirect after sign-in.').last().waitFor();
      const ticket = await get(`/tickets/${ids['Fix the login page']}`);
      const comment = (ticket.comments ?? []).find((x) => x.text?.includes('redirect after sign-in') || x.body?.includes('redirect after sign-in'));
      s.note('comment', comment ? { ai: comment.ai ?? comment.author, keys: Object.keys(comment).sort().join() } : null);
      if (!comment) throw new Error('the comment is not on the ticket: ' + JSON.stringify(ticket.comments));
      // KNOWN GAP (server, kb-assist assistant/chat/messages.rs post_comment): the UI hides the button once an answer is
      // posted (context.posted), but the route does not refuse a second post: it adds a duplicate comment. Asserted as
      // it is today; once the route answers 4xx for a posted answer, flip the check.
      const msg = (await get(`/ai/assist/chats/${ids.ticketChat}`)).messages.find((m) => m.role === 'ai');
      const again = await send('POST', `/ai/assist/messages/${msg.id}/post-comment`, {});
      s.note('second post', again);
      if (again.status !== 200 || again.body.comment_id === out.comment_id) throw new Error('the second post: ' + JSON.stringify(again));
    });
    const bubble = () => p.getByTestId('ea-pill');
    const editorMenu = () => p.getByRole('menu', { name: 'AI' });
    await s.step('ticket description: /ai opens the editor AI menu', async () => {
      await home(s);
      const d = await openTicket(s, 'ALP-2');
      await d.getByText('Add a description…').click();
      const field = d.locator('[contenteditable="true"]').first();
      await field.waitFor();
      await field.click();
      await p.keyboard.type('Paging for the list endpoint. ');
      const menu = editorMenu();
      // the menu opens once the editor knows that AI is on here (its state request has answered): type again till then
      for (let i = 0; i < 6 && !(await menu.isVisible()); i++) {
        await p.keyboard.type('/ai');
        await menu.waitFor({ timeout: 2500 }).catch(async () => { await p.keyboard.press('Backspace'); await p.keyboard.press('Backspace'); await p.keyboard.press('Backspace'); });
      }
      await menu.waitFor();
      for (const a of ['ask', 'continue', 'summarise', 'criteria', 'translate']) await menu.getByTestId(`ea-menu-${a}`).waitFor();
      // the state of this editor, as the server tells it
      const st = await get(`/projects/${ids.project}/ai/editor/state?surface=ticket_description&ticket_id=${ids['Add paging to the API']}`);
      s.note('state', { availability: st.availability, menu: st.menu.map((m) => m.action), bar: st.bar.map((m) => m.action) });
      if (st.availability.code !== 'ok') throw new Error('availability ' + JSON.stringify(st.availability));
    });
    await s.step('Ask AI: "What will be sent" (POST preview), then Discard (POST discard)', async () => {
      fake({ by: { 'editor-write': { text: 'Add cursor paging to GET /items.' } } });
      await editorMenu().getByTestId('ea-menu-ask').click();
      const box = p.getByTestId('ea-prompt-box');
      await box.getByRole('textbox', { name: 'What should it write?' }).fill('Say what paging means here');
      const previewed = p.waitForResponse((r) => /\/ai\/editor\/preview$/.test(r.url()) && r.request().method() === 'POST');
      await box.getByTestId('ea-sent').click();
      if ((await previewed).status() !== 200) throw new Error('preview answered ' + (await previewed).status());
      const list = box.getByTestId('ea-sent-list');
      await list.waitFor();
      s.note('what will be sent', await list.innerText());
      const drafted = p.waitForResponse((r) => /\/ai\/editor\/drafts$/.test(r.url()) && r.request().method() === 'POST');
      await box.getByTestId('ea-generate').click();
      if (![200, 201].includes((await drafted).status())) throw new Error('draft answered ' + (await drafted).status());
      await p.getByTestId('ea-draft-replace').or(p.getByTestId('ea-draft-text')).first().waitFor({ timeout: 40000 });
      await p.getByTestId('ea-draft-text').getByText('Add cursor paging to GET /items.').waitFor();
      const discarded = p.waitForResponse((r) => /\/ai\/assist\/drafts\/[^/]+\/discard$/.test(r.url()) && r.request().method() === 'POST');
      await bubble().getByTestId('ea-discard').click();
      if ((await discarded).status() !== 200) throw new Error('discard answered ' + (await discarded).status());
      await bubble().waitFor({ state: 'detached' });
    });
    const typeAi = async () => {
      const d = p.getByRole('dialog', { name: /^Ticket / });
      const field = d.locator('[contenteditable="true"]').first();
      await field.click();
      await p.keyboard.press('Control+End');
      await p.keyboard.type(' ');
      await p.keyboard.type('/ai');
      await editorMenu().waitFor();
    };
    await s.step('Ask AI: Accept (POST accept) puts the draft in the description', async () => {
      fake({ by: { 'editor-write': { text: 'Add cursor paging to GET /items.' } } });
      await typeAi();
      await editorMenu().getByTestId('ea-menu-ask').click();
      const box = p.getByTestId('ea-prompt-box');
      await box.getByRole('textbox', { name: 'What should it write?' }).fill('Say what paging means here');
      await box.getByTestId('ea-generate').click();
      await p.getByTestId('ea-draft-text').getByText('Add cursor paging to GET /items.').waitFor({ timeout: 40000 });
      const accepted = p.waitForResponse((r) => /\/ai\/editor\/drafts\/[^/]+\/accept$/.test(r.url()) && r.request().method() === 'POST');
      await bubble().getByTestId('ea-accept').click();
      const res = await accepted;
      if (!res.ok()) throw new Error('accept answered ' + res.status());
      s.note('accept answer keys', Object.keys(await res.json()).sort().join());
      await bubble().waitFor({ state: 'detached' });
      await p.getByRole('dialog', { name: /^Ticket / }).getByText('Add cursor paging to GET /items.').waitFor();
      await s.settle(6000);
    });
    await s.step('Ask AI: Try again (POST regenerate) writes it again, then Accept still puts it in', async () => {
      fake({ by: { 'editor-write': { text: 'Draft one.' } } });
      await typeAi();
      await editorMenu().getByTestId('ea-menu-ask').click();
      const box = p.getByTestId('ea-prompt-box');
      await box.getByRole('textbox', { name: 'What should it write?' }).fill('Write it shorter');
      await box.getByTestId('ea-generate').click();
      await p.getByTestId('ea-draft-text').getByText('Draft one.').waitFor({ timeout: 40000 });
      fake({ by: { 'editor-write': { text: 'Return 20 items per page with a next-page cursor.' } } });
      const regenerated = p.waitForResponse((r) => /\/ai\/assist\/drafts\/[^/]+\/regenerate$/.test(r.url()) && r.request().method() === 'POST');
      await bubble().getByTestId('ea-retry').click();
      if (!(await regenerated).ok()) throw new Error('regenerate answered ' + (await regenerated).status());
      await p.getByTestId('ea-draft-text').getByText('Return 20 items per page with a next-page cursor.').waitFor({ timeout: 40000 });
      const accepted = p.waitForResponse((r) => /\/ai\/editor\/drafts\/[^/]+\/accept$/.test(r.url()) && r.request().method() === 'POST');
      await bubble().getByTestId('ea-accept').click();
      if (!(await accepted).ok()) throw new Error('accept answered ' + (await accepted).status());
      await bubble().waitFor({ state: 'detached' });
      await p.getByRole('dialog', { name: /^Ticket / }).getByText('Return 20 items per page with a next-page cursor.').waitFor();
      await s.settle(6000);
    });
    await s.step('Draft acceptance criteria: a list, add the ticked ones (POST accept with items)', async () => {
      fake({ by: { 'editor-write': { text: '- A page has 20 items\n- The reply names the next cursor\n- A bad cursor answers 422' } } });
      await typeAi();
      await editorMenu().getByTestId('ea-menu-criteria').click();
      const list = p.getByTestId('ea-list');
      await list.waitFor({ timeout: 40000 });
      await list.getByText('Draft · 3 acceptance criteria').waitFor();
      await list.locator('label').filter({ hasText: 'A bad cursor answers 422' }).getByRole('checkbox').uncheck();
      await list.getByTestId('ea-add-criteria').getByText('Add 2').waitFor();
      const accepted = p.waitForResponse((r) => /\/ai\/editor\/drafts\/[^/]+\/accept$/.test(r.url()) && r.request().method() === 'POST');
      await list.getByTestId('ea-add-criteria').click();
      const res = await accepted;
      if (!res.ok()) throw new Error('accept answered ' + res.status());
      const out = await res.json();
      s.note('created', out.created);
      await until(async () => {
        const t = await get(`/tickets/${ids['Add paging to the API']}`);
        const texts = (t.acceptance_criteria ?? t.criteria ?? []).map((c) => c.text);
        return texts.length === 2 && texts.includes('A page has 20 items') && !texts.includes('A bad cursor answers 422');
      }, 'the two criteria on the ticket');
      await p.getByRole('dialog', { name: /^Ticket / }).getByText('The reply names the next cursor').first().waitFor();
    });
    await s.step('a draft that is still being written is cancelled (POST cancel)', async () => {
      fake({ wait: 20 });
      await typeAi();
      await editorMenu().getByTestId('ea-menu-summarise').click();
      const stop = p.getByTestId('ea-stop');
      await stop.waitFor();
      await p.getByText('Writing a draft. Nothing is changed yet.').waitFor();
      const cancelled = p.waitForResponse((r) => /\/ai\/assist\/drafts\/[^/]+\/cancel$/.test(r.url()) && r.request().method() === 'POST');
      await stop.click();
      if (!(await cancelled).ok()) throw new Error('cancel answered ' + (await cancelled).status());
      await stop.waitFor({ state: 'detached' });
      fake({ wait: 0 });
    });
    await s.step('routes of the old assistant that only answer "nothing" or "gone": similar, assignees, PATCH draft', async () => {
      const similar = await send('GET', `/projects/${ids.project}/ai/assist/similar?text=paging`);
      const assignees = await send('GET', `/projects/${ids.project}/ai/assist/assignees?text=paging&ticket_id=${ids['Add paging to the API']}`);
      s.note('similar', similar);
      s.note('assignees', assignees);
      if (similar.status !== 200 || similar.body.length !== 0) throw new Error('similar: ' + JSON.stringify(similar));
      if (assignees.status !== 200 || assignees.body.length !== 0) throw new Error('assignees: ' + JSON.stringify(assignees));
      // a draft the editor AI wrote cannot be edited any more (AI v2): PATCH answers 410, the draft is untouched
      fake({ by: { 'editor-write': { text: 'A draft.' } } });
      const made = await send('POST', `/projects/${ids.project}/ai/editor/drafts`, { surface: 'comment', action: 'improve', selection: 'a sentense', ticket_id: ids['Fix the login page'] });
      if (made.status !== 201) throw new Error('draft: ' + JSON.stringify(made));
      const id = made.body.id;
      await until(async () => (await get(`/ai/assist/drafts/${id}`)).status === 'open', 'the draft to be written');
      const patched = await send('PATCH', `/ai/assist/drafts/${id}`, { payload: { text: 'Mine.' } });
      s.note('patch draft', patched);
      if (patched.status !== 410) throw new Error('PATCH draft answered ' + patched.status);
      const listed = await get(`/projects/${ids.project}/ai/assist/drafts?doc_id=none`);
      s.note('drafts of a page', listed);
      const discarded = await send('POST', `/ai/assist/drafts/${id}/discard`);
      if (discarded.status !== 200 || discarded.body.status !== 'discarded') throw new Error('discard: ' + JSON.stringify(discarded));
    });
    // ---- Docs ----
    const treeItem = (name) => p.getByRole('tree').getByRole('treeitem', { name: new RegExp(`(^|Expand |Collapse )${name}( \\d+)? ?(Add child|Page actions|$)`) }).first();
    const PARA = 'The API serves the list of items with a page size of twenty and a cursor for the next page.';
    const selectPara = async () => {
      const para = p.getByRole('paragraph').filter({ hasText: 'The API serves the list' }).first();
      await para.scrollIntoViewIfNeeded();
      await para.click({ clickCount: 3 });
      await p.getByTestId('selection-comment').waitFor();
    };
    await s.step('Docs: the page API, published three times', async () => {
      await home(s);
      await openDocs(s);
      await newDocPage(s, 'API');
      await setMarkdown(s, `# API\n\n${PARA}\n\n- [ ] Add paging\n`);
      await publishDoc(s, 'First version');
      const tree = await get(`/projects/${ids.project}/docs/tree`);
      ids.page = (tree.nodes ?? tree).find((n) => n.title === 'API').id;
      for (const [n, md, note] of [[1, `# API\n\n${PARA}\n\n- [ ] Add paging\n\nIt returns JSON.\n`, 'Say JSON'], [2, `# API\n\n${PARA}\n\n- [ ] Add paging\n\nIt returns JSON and a next cursor.\n`, 'Say the cursor']]) {
        const r = await send('POST', `/docs/pages/${ids.page}/publish`, { base_version: n, markdown: md, note });
        if (r.status !== 200) throw new Error('publish v' + (n + 1) + ': ' + JSON.stringify(r));
      }
      await p.reload();
      await p.getByRole('complementary', { name: 'Project navigation' }).waitFor({ timeout: 20000 });
      await p.getByRole('button', { name: 'Docs', exact: true }).click();
      await treeItem('API').click();
      await p.getByTestId('page-title').getByText('API', { exact: true }).waitFor();
      await p.getByText('Published · v3').waitFor();
    });
    await s.step('a selection in the page: Explain shows a card by the selection', async () => {
      fake({ by: { 'docs-explain': { text: 'It means the list comes in pages of twenty.' } } });
      await selectPara();
      await p.getByTestId('selection-explain').click();
      const card = p.getByTestId('explain-card');
      await card.getByTestId('explain-text').getByText('It means the list comes in pages of twenty.').waitFor({ timeout: 40000 });
      await card.getByText(/From this page · /).waitFor();
      await card.getByRole('button', { name: 'Close' }).click();
      await card.waitFor({ state: 'detached' });
    });
    await s.step('a selection in the page: Summarise puts a summary block above the page', async () => {
      fake({ by: { 'docs-summarise': { text: 'Pages of twenty, next cursor.', title: 'API' } } });
      await selectPara();
      await p.getByTestId('selection-summarise').click();
      const box = p.getByRole('region', { name: 'Summary by AI' });
      await box.getByTestId('summary-text').getByText('Pages of twenty, next cursor.').waitFor({ timeout: 40000 });
      await box.getByTestId('summary-hide').click();
      await box.waitFor({ state: 'detached' });
    });
    await s.step('a selection in the page: Ask… opens the Board AI on this page and sends the passage', async () => {
      fake({ text: 'The passage says the list has pages.' });
      await selectPara();
      await p.getByTestId('selection-ask').click();
      await dock().getByText('Ask this page').waitFor();
      await dock().getByText(/About this passage of the page/).waitFor();
      await dock().getByText('The passage says the list has pages.').waitFor({ timeout: 40000 });
      const chats = await get(`/projects/${ids.project}/ai/assist/chats`);
      const mine = chats.chats.find((c) => c.scope === 'doc');
      s.note('page chat', mine && { scope: mine.scope, doc: mine.doc_id === ids.page });
      if (!mine || mine.doc_id !== ids.page) throw new Error('no chat about the page: ' + JSON.stringify(chats.chats.map((c) => [c.scope, c.doc_id])));
      await dock().getByRole('button', { name: 'Close Board AI' }).click();
    });
    const askDocs = async (question) => {
      await p.getByTestId('tree-ask-docs').click();
      const d = p.getByRole('dialog', { name: 'Ask the docs' });
      await d.getByRole('textbox').fill(question);
      await p.keyboard.press('Enter');
      return d;
    };
    await s.step('Ask the docs: "Open as chat" opens the question and its answer in the Board AI (POST ask/:id/chat)', async () => {
      fake({ by: { 'docs-ask': { answer: 'The API pages its lists.', verdict: 'answered', citations: [{ page_id: ids.page, title: 'API' }], pages_read: 1 } } });
      const d = await askDocs('How does paging work?');
      await d.getByTestId('ask-answer').waitFor({ timeout: 40000 });
      const opened = p.waitForResponse((r) => /\/docs\/ai\/ask\/[^/]+\/chat$/.test(r.url()) && r.request().method() === 'POST');
      await d.getByRole('button', { name: 'Open as chat' }).click();
      const res = await opened;
      if (!res.ok()) throw new Error('open as chat answered ' + res.status());
      await d.waitFor({ state: 'detached' });
      await dock().getByText('How does paging work?').waitFor();
      await dock().getByText('The API pages its lists.').waitFor();
      await dock().getByRole('button', { name: 'Close Board AI' }).click();
    });
    await s.step('Ask the docs: Stop a slow answer (POST jobs/:id/cancel)', async () => {
      fake({ wait: 25 });
      const d = await askDocs('Who owns paging?');
      const thinking = d.getByTestId('ask-thinking');
      await thinking.waitFor();
      const cancelled = p.waitForResponse((r) => /\/docs\/ai\/jobs\/[^/]+\/cancel$/.test(r.url()) && r.request().method() === 'POST');
      await thinking.getByRole('button', { name: 'Stop' }).click();
      const res = await cancelled;
      if (!res.ok()) throw new Error('cancel answered ' + res.status());
      s.note('cancelled job', { state: (await res.json()).state });
      await d.getByTestId('ask-error').waitFor({ timeout: 20000 });
      s.note('error shown', await d.getByTestId('ask-error').innerText());
      fake({ wait: 0 });
      await d.getByRole('textbox').press('Escape');
      await d.waitFor({ state: 'detached' });
    });
    await s.step('Ask the docs: two pages that disagree (the skill says "conflict"): both are shown, Report adds one to Docs health (POST report-stale)', async () => {
      // the second side need not be a real page: it is only listed (the report goes to the first cited page, API)
      fake({ by: { 'docs-ask': { answer: 'API says twenty, the notes say fifty.', verdict: 'conflict', citations: [{ page_id: ids.page, title: 'API' }, { page_id: 'notes-page', title: 'Notes' }], pages_read: 2 } } });
      const d = await askDocs('What is the page size?');
      await d.getByText('API says twenty, the notes say fifty.').waitFor({ timeout: 40000 });
      // the server's "conflict" is the UI's "pages disagree" (it used to be shown as a plain answer, without sources)
      await d.getByTestId('ask-state-disagree').waitFor();
      await d.getByText('Notes', { exact: true }).first().waitFor();
      const posted = p.waitForResponse((r) => r.request().method() === 'POST' && /\/docs\/pages\/[^/]+\/ai\/report-stale$/.test(r.url()));
      await d.getByRole('button', { name: 'Report API as out of date' }).click();
      const rep = await posted;
      if (rep.status() !== 200) throw new Error('report-stale answered ' + rep.status());
      if (!rep.url().includes(`/docs/pages/${ids.page}/`)) throw new Error('reported another page: ' + rep.url());
      await d.getByRole('button', { name: 'API added to Docs health' }).waitFor();
      await d.getByRole('textbox').press('Escape');
      await d.waitFor({ state: 'detached' });
    });
    await s.step('History: "What changed since" summarises versions (POST history-summary)', async () => {
      fake({ by: { 'docs-history': { summary: 'v2 added a JSON line; v3 named the cursor.', note: '', lines: [] } } });
      await p.getByRole('button', { name: 'Page actions' }).click();
      await p.getByRole('menuitem', { name: /Page history/ }).click();
      await p.getByRole('dialog', { name: 'Page history' }).waitFor();
      const box = p.getByTestId('history-summary');
      await box.getByText(/WHAT CHANGED SINCE V/).waitFor();
      const posted = p.waitForResponse((r) => /\/docs\/pages\/[^/]+\/ai\/history-summary$/.test(r.url()) && r.request().method() === 'POST');
      await box.getByTestId('summarise-history').click();
      if (!(await posted).ok()) throw new Error('history-summary answered ' + (await posted).status());
      await box.getByText('v2 added a JSON line; v3 named the cursor.').waitFor({ timeout: 40000 });
      await p.keyboard.press('Escape');
    });
    await s.step('Publish: "Suggest a note" fills the version note (POST publish-note)', async () => {
      fake({ by: { 'docs-history': { summary: '', note: 'Explain the page size', lines: [] } } });
      await p.getByRole('button', { name: 'Edit', exact: true }).click();
      await setMarkdown(s, `# API\n\n${PARA}\n\nThe page size is configurable.\n`);
      await p.getByRole('button', { name: 'Publish', exact: true }).click();
      const d = p.getByRole('dialog', { name: 'Publish page' });
      const posted = p.waitForResponse((r) => /\/docs\/pages\/[^/]+\/ai\/publish-note$/.test(r.url()) && r.request().method() === 'POST');
      await d.getByTestId('suggest-note').click();
      if (!(await posted).ok()) throw new Error('publish-note answered ' + (await posted).status());
      await d.getByTestId('suggested-note').waitFor({ timeout: 40000 });
      const note = await d.getByRole('textbox', { name: 'Version note' }).inputValue();
      if (note !== 'Explain the page size') throw new Error('the note is ' + note);
      await d.getByRole('button', { name: /^Publish v\d+/ }).click();
      await d.waitFor({ state: 'detached' });
      await p.getByRole('button', { name: 'Edit', exact: true }).waitFor();
      const versions = await get(`/docs/pages/${ids.page}/versions`);
      s.note('versions', (versions.versions ?? versions).map((v) => v.note));
    });
    await s.step('Create tickets from the page, then Undo in the toast (POST tickets/undo)', async () => {
      fake({ by: { 'docs-tickets': { drafts: [{ title: 'Add paging', text: 'Add paging', type: 'task' }], skipped: [] } } });
      await p.getByTestId('page-ai-menu').click();
      await p.getByTestId('ai-row-tickets').click();
      const d = p.getByRole('dialog', { name: 'Create tickets' });
      await d.getByTestId('ticket-draft').waitFor({ timeout: 40000 });
      const [res] = await Promise.all([
        p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/tickets\/create$/.test(r.url())),
        d.getByTestId('create-tickets-submit').click(),
      ]);
      const out = await res.json();
      if (out.tickets.length !== 1) throw new Error('create: ' + JSON.stringify(out));
      ids.created = out.tickets[0].id;
      await p.getByText('1 ticket created in Backlog').waitFor();
      const undone = p.waitForResponse((r) => /\/docs\/ai\/tickets\/undo$/.test(r.url()) && r.request().method() === 'POST');
      await p.getByText('1 ticket created in Backlog').locator('xpath=ancestor::*[.//button[normalize-space()="Undo"]][1]').getByRole('button', { name: 'Undo', exact: true }).click();
      const back = await undone;
      if (!back.ok()) throw new Error('undo answered ' + back.status());
      s.note('undo answer', await back.json());
      await p.getByText(/1 ticket removed/).waitFor();
      const gone = await send('GET', `/tickets/${ids.created}`);
      if (gone.status !== 404 && !gone.body?.deleted_at) throw new Error('the ticket is still there: ' + JSON.stringify(gone).slice(0, 200));
    });
    await s.step('Draw a diagram from /ai in the editor: the AI names a diagram and the line goes into the draft', async () => {
      fake({ by: { 'docs-diagram': { diagram_id: 'dg-e2e', label: 'API flow', markdown: 'Diagram: API flow', changed: false } } });
      await p.getByRole('button', { name: /^(Edit|Continue editing)$/ }).first().click();
      const content = p.getByRole('textbox', { name: 'Page content' });
      await content.getByText('The page size is configurable.').waitFor();
      await content.click();
      await p.keyboard.press('Control+End');
      await p.keyboard.press('Enter');
      await p.keyboard.type('/ai');
      const menu = p.getByRole('listbox', { name: 'Insert block' });
      await menu.waitFor();
      await menu.getByRole('option', { name: /Draw a diagram/ }).click();
      const panel = p.getByTestId('draw-diagram');
      await panel.getByText('From this page.').waitFor();
      await panel.getByTestId('draw-instruction').fill('Show the paging flow');
      await panel.getByTestId('draw-go').click();
      await panel.getByTestId('draw-done').getByText(/Added “API flow” to your draft\./).waitFor({ timeout: 40000 });
      await p.getByRole('textbox', { name: 'Page content' }).getByText('Diagram: API flow').waitFor();
      await panel.getByRole('button', { name: 'Close' }).click();
      await panel.waitFor({ state: 'detached' });
    });
    await s.step('a ticket with a linked page that has an open comment: "Ask the team to apply the comments"', async () => {
      const key = ids['Fix the login page'];
      const linked = await send('POST', `/tickets/${key}/docs`, { page_id: ids.page });
      if (linked.status >= 300) throw new Error('link: ' + JSON.stringify(linked));
      const th = await send('POST', `/docs/pages/${ids.page}/comments`, { kind: 'page', body: 'Please state the maximum page size.' });
      if (th.status >= 300) throw new Error('thread: ' + JSON.stringify(th));
      s.server.fake({});
      await home(s);
      const d = await openTicket(s, key);
      const box = d.getByTestId('ticket-comments-send');
      await box.getByTestId('ticket-comments-send-btn').getByText('Ask the team to apply the comments (1)').waitFor();
      const sent = p.waitForResponse((r) => /\/tickets\/[^/]+\/docs\/comments\/send$/.test(r.url()) && r.request().method() === 'POST');
      await box.getByTestId('ticket-comments-send-btn').click();
      const first = await sent;
      s.note('first send', { status: first.status(), body: await first.json().catch(() => null) });
      // the ticket has no team yet: the board asks which one gets it
      const give = box.getByTestId('ticket-comments-give');
      await give.waitFor();
      await give.getByRole('combobox', { name: 'Team' }).selectOption({ label: 'Helper' });
      const sent2 = p.waitForResponse((r) => /\/tickets\/[^/]+\/docs\/comments\/send$/.test(r.url()) && r.request().method() === 'POST');
      await give.getByRole('button', { name: 'Give it to a team and send' }).click();
      const second = await sent2;
      if (!second.ok()) throw new Error('send answered ' + second.status());
      s.note('second send', await second.json());
      await p.getByText('Sent to the team').first().waitFor();
    }, { expectConsole: true }); // the first send answers 422 (no team): the board then asks which team
    await s.step('Docs editor: select a sentence, Improve (selection bar) and Accept replaces it', async () => {
      fake({ by: { 'editor-write': { text: 'The page size is set per request.' } } });
      await home(s);
      await openDocs(s);
      await treeItem('API').click();
      await p.getByTestId('page-title').getByText('API', { exact: true }).waitFor();
      await p.getByRole('button', { name: /^(Edit|Continue editing)$/ }).first().click();
      const content = p.getByRole('textbox', { name: 'Page content' });
      const para = content.getByRole('paragraph').filter({ hasText: 'The page size is configurable.' });
      await para.waitFor();
      await para.click({ clickCount: 3 });
      // the selection toolbar offers "AI": it opens the AI bar in its place
      await p.getByRole('button', { name: 'AI on the selection' }).click();
      const bar = p.getByRole('toolbar', { name: 'AI on the selection' });
      await bar.waitFor();
      for (const a of ['improve', 'shorten', 'fix_spelling', 'explain', 'ask']) await bar.getByTestId(`ea-bar-${a}`).waitFor();
      await bar.getByTestId('ea-bar-improve').click();
      // a rewrite of a selection is shown as a word diff, so the draft text is read as a whole
      await p.getByTestId('ea-pill').waitFor({ timeout: 40000 });
      await until(async () => (await p.getByTestId('ea-draft-text').innerText()).includes('set per request.'), 'the draft text');
      await p.getByTestId('ea-pill').getByTestId('ea-accept').click();
      await p.getByTestId('ea-pill').waitFor({ state: 'detached' });
      await content.getByText('The page size is set per request.').waitFor();
      if (await content.getByText('The page size is configurable.').count()) throw new Error('the old sentence is still there');
    });
    await s.step('Docs editor: Explain on a selection is an answer, not part of the text (Copy, Discard)', async () => {
      fake({ by: { 'editor-write': { text: 'It lets the caller choose how many items come back.' } } });
      const content = p.getByRole('textbox', { name: 'Page content' });
      const para = content.getByRole('paragraph').filter({ hasText: 'The page size is set per request.' });
      await para.click({ clickCount: 3 });
      await p.getByRole('button', { name: 'AI on the selection' }).click();
      await p.getByRole('toolbar', { name: 'AI on the selection' }).getByTestId('ea-bar-explain').click();
      const draft = p.getByTestId('ea-draft-answer');
      await draft.getByText('Answer · not part of the text').waitFor({ timeout: 40000 });
      await draft.getByText('It lets the caller choose how many items come back.').waitFor();
      await draft.getByTestId('ea-copy').click();
      await p.getByTestId('ea-pill').getByTestId('ea-discard').click();
      await p.getByTestId('ea-pill').waitFor({ state: 'detached' });
      if (await content.getByText('It lets the caller choose').count()) throw new Error('the answer went into the page');
      await p.getByRole('button', { name: 'Discard' }).click();
      const confirm = p.getByRole('dialog').getByRole('button', { name: /Discard/ });
      if (await confirm.count()) await confirm.last().click();
      await s.settle();
    });
    await s.step('New page, Write with AI: Cancel while the page is being written stops the job (POST jobs/:id/cancel)', async () => {
      fake({ by: { 'docs-write': { page_id: ids.page, title: 'Paging', gaps: [] } }, wait: 25 });
      await home(s);
      await openDocs(s);
      await p.getByRole('button', { name: 'New page' }).first().click();
      const d = p.getByRole('dialog', { name: 'New page' });
      await d.getByTestId('write-ai-prompt').click();
      await d.getByRole('textbox', { name: 'What the page is about' }).fill('How paging works in the API');
      await d.getByRole('textbox', { name: 'Title' }).fill('Paging');
      const started = p.waitForResponse((r) => /\/docs\/ai\/write$/.test(r.url()) && r.request().method() === 'POST');
      await d.getByTestId('write-draft').click();
      const job = await (await started).json();
      const cancelled = p.waitForResponse((r) => /\/docs\/ai\/jobs\/[^/]+\/cancel$/.test(r.url()) && r.request().method() === 'POST');
      await d.getByRole('button', { name: 'Cancel', exact: true }).click();
      const res = await cancelled;
      if (!res.ok()) throw new Error('cancel answered ' + res.status());
      await d.waitFor({ state: 'detached' });
      await until(async () => (await get(`/docs/ai/jobs/${job.id}`)).state === 'cancelled', 'the job to be cancelled');
      const jobs = await get(`/projects/${ids.project}/docs/ai/jobs`);
      s.note('jobs of the space', jobs.map((j) => [j.kind, j.state]).sort());
      fake({ wait: 0 });
    });
    await s.step('page AI side routes: accepted mark, markers, and the sketch accept on a draft with no shapes', async () => {
      const marked = await send('POST', `/docs/pages/${ids.page}/ai/accepted`);
      s.note('accepted', marked);
      if (marked.status !== 200 || marked.body.ok !== true) throw new Error('accepted: ' + JSON.stringify(marked));
      const markers = await get(`/docs/pages/${ids.page}/ai/markers`);
      s.note('markers', markers);
      if (markers.count !== 0) throw new Error('markers: ' + JSON.stringify(markers));
      // KNOWN GAP (nothing reaches it in the UI): the assistant no longer draws shapes, so no sketch draft exists for the
      // sketch panel to accept or discard (see 30-sketch). The route closes any open draft; asserted on an editor draft.
      fake({ by: { 'editor-write': { text: 'Another draft.' } } });
      const made = await send('POST', `/projects/${ids.project}/ai/editor/drafts`, { surface: 'comment', action: 'improve', selection: 'a sentense', ticket_id: ids['Fix the login page'] });
      await until(async () => (await get(`/ai/assist/drafts/${made.body.id}`)).status === 'open', 'the draft to be written');
      const accepted = await send('POST', `/ai/sketch/drafts/${made.body.id}/accept`);
      s.note('sketch accept', { status: accepted.status, draftStatus: accepted.body?.status });
      if (accepted.status !== 200 || accepted.body.status !== 'applied') throw new Error('sketch accept: ' + JSON.stringify(accepted));
    });
  },
};
