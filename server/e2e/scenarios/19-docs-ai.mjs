import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { home, ensureProject, openDocs, newDocPage, setMarkdown, publishDoc, openMembers } from '../lib/ui.mjs';

// Docs AI with the stand-in CLI (FAKE_CLAUDE_MODE=assistant): what the model would answer is given per skill in
// FAKE_CLAUDE_ASSISTANT_BY_SKILL. The stand-in never calls the board's tools, so a page it "writes" is a page that
// already exists: the answer of docs-write names it.
export default {
  name: 'Docs AI: write, ask, summary, translate, check, tickets, tidy, health, comments, follow',
  group: 'ai',
  async run(s) {
    const p = s.page;
    const ids = {};
    let tmp = null;
    const answers = {};
    // answers for the next turns; ids of pages are put in where an answer names a page
    const fake = (more = {}) => {
      Object.assign(answers, more);
      s.server.fake({ FAKE_CLAUDE_MODE: 'assistant', FAKE_CLAUDE_ASSISTANT_BY_SKILL: JSON.stringify(answers) });
    };
    const api = async (path) => (await p.request.get(`${s.server.base}${path}`)).json();
    const item = (name) => p.getByRole('tree').getByRole('treeitem', { name: new RegExp(`(^|Expand |Collapse )${name}( \\d+)? ?(Add child|Page actions|$)`) }).first();
    const aiMenu = async (row) => {
      await p.getByTestId('page-ai-menu').click();
      await p.getByTestId(`ai-row-${row}`).click();
    };

    await s.step('set up: signed-in AI account, a project with an AI team', async () => {
      s.server.signIn();
      fake();
      await ensureProject(s);
      await openMembers(s);
      await p.getByTestId('members-tab-ai').click();
      await p.getByRole('button', { name: /Add AI team/ }).first().click();
      const d = p.getByRole('dialog', { name: 'Add AI team' });
      await d.getByTestId('team-name').fill('Docs helper');
      await d.getByTestId('team-working-dir').fill(s.server.dirs.repo);
      await d.getByTestId('add-team-submit').click();
      await p.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      await p.getByText('Roles', { exact: true }).waitFor();
    });
    await s.step('Settings, Docs: turn on "Use AI in Docs"', async () => {
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Docs', exact: true }).click();
      const sw = p.getByRole('switch', { name: 'Use AI in Docs' });
      await sw.waitFor();
      if ((await sw.getAttribute('aria-checked')) === 'true') throw new Error('Docs AI should start off');
      await sw.click();
      await p.getByRole('switch', { name: 'Use AI in Docs', checked: true }).waitFor();
      await p.getByRole('combobox', { name: 'AI that answers' }).selectOption({ label: 'Docs helper' });
      await s.settle();
      await p.getByRole('button', { name: 'Back to board' }).click();
    });
    await s.step('Docs (empty): import a Markdown file with "Tidy while importing"', async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-e2e-tidy-'));
      const file = path.join(tmp, 'handbook.md');
      fs.writeFileSync(file, '# Overview\n\nSee Auth for the sign-in rules. The work is tracked in ALP-1.\n\n### Details\n\nA heading that skips a level.\n\n# Auth\n\nSign in with a token.\n');
      await home(s);
      await openDocs(s);
      await p.getByTestId('docs-import').click();
      const d = p.getByRole('dialog', { name: 'Import Markdown' });
      await d.locator('input[type="file"]').first().setInputFiles(file);
      const tidy = d.getByTestId('tidy-options');
      await tidy.waitFor({ timeout: 30000 });
      await tidy.getByText('TIDY WHILE IMPORTING (OPTIONAL)').waitFor();
      await tidy.getByText(/handbook\.md · .* 2 top-level sections/).waitFor({ timeout: 30000 });
      for (const o of ['Split into one page per top-level section', 'Turn ticket keys into chips', 'Turn “see Auth” into [[links]]', 'Fix heading levels']) {
        await tidy.getByText(o).waitFor();
      }
      s.note('tidy hints', await tidy.innerText());
      await tidy.getByLabel(/Turn “see Auth” into/).check();
      await tidy.getByTestId('see-links-review').waitFor();
      await tidy.getByRole('button', { name: 'Add all' }).click();
      await tidy.getByRole('button', { name: 'Add none' }).waitFor();
      s.note('review links', await tidy.getByTestId('see-links-review').innerText());
    });
    await s.step('confirm the tidy import: one page per section, with the link', async () => {
      const d = p.getByRole('dialog', { name: 'Import Markdown' });
      await d.getByRole('button', { name: /^Import/ }).last().click();
      await s.settle(3000);
      const close = d.getByRole('button', { name: /Close|Done/ });
      if (await close.count()) await close.first().click();
      await p.getByRole('tree').getByText('Overview').first().waitFor();
      await p.getByRole('tree').getByText('Auth', { exact: true }).first().waitFor();
      await p.getByRole('tree').getByText('Overview').first().click();
      await p.getByTestId('page-title').getByText('Overview', { exact: true }).waitFor();
      await p.getByText(/sign-in rules/).waitFor();
      s.note('overview page text', await p.locator('.dk-md').first().innerText());
    });
    await s.step('Docs: two pages, API (with a checklist) and Release notes', async () => {
      await home(s);
      await openDocs(s);
      await newDocPage(s, 'API');
      await setMarkdown(s, '# API\n\nThe API uses REST.\n\n- [ ] Add paging\n');
      await publishDoc(s, 'First version');
      await newDocPage(s, 'Release notes');
      await setMarkdown(s, '# Release notes\n\nThe release ships the API described in [[API]].\n');
      await publishDoc(s);
      const pid = (await api('/projects'))[0].id;
      ids.project = pid;
      const tree = await api(`/projects/${pid}/docs/tree`);
      for (const n of tree.nodes ?? tree) ids[n.title] = n.id;
      if (!ids.API || !ids['Release notes']) throw new Error('page ids not found: ' + JSON.stringify(tree).slice(0, 300));
    });
    await s.step('the tree offers Ask the docs and Docs health once Docs AI is on', async () => {
      await p.getByTestId('tree-ask-docs').waitFor();
      await p.getByRole('button', { name: /Docs health/ }).waitFor();
    });
    await s.step('Ask the docs: an answer with a citation, then rate it', async () => {
      fake({ 'docs-ask': { answer: 'The API uses REST [1].', verdict: 'answered', citations: [{ page_id: ids.API, title: 'API' }], pages_read: 2 } });
      await p.getByTestId('tree-ask-docs').click();
      const d = p.getByRole('dialog', { name: 'Ask the docs' });
      await d.getByRole('textbox').fill('Which API style do we use?');
      await p.keyboard.press('Enter');
      await d.getByTestId('ask-answer').waitFor({ timeout: 30000 });
      await d.getByText(/The API uses REST/).waitFor();
      await d.getByText(/Read 2 pages, cited 1/).waitFor();
      await d.getByRole('button', { name: 'Yes', exact: true }).click();
      await s.settle();
    });
    await s.step('Ask the docs: a question the docs do not cover', async () => {
      fake({ 'docs-ask': { answer: 'The docs do not say.', verdict: 'not_covered', citations: [], pages_read: 2 } });
      const d = p.getByRole('dialog', { name: 'Ask the docs' });
      await d.getByRole('textbox').fill('Who pays for hosting?');
      await p.keyboard.press('Enter');
      await d.getByTestId('ask-not_covered').waitFor({ timeout: 30000 });
      await d.getByText(/The docs do not say/).first().waitFor();
      await p.keyboard.press('Escape');
      await d.waitFor({ state: 'detached' });
    });
    await s.step('AI menu on the page API: Summarise shows a block above the page', async () => {
      fake({ 'docs-summarise': { text: 'A REST API with paging still to do.', title: 'API' } });
      await item('API').click();
      await p.getByTestId('page-title').getByText('API', { exact: true }).waitFor();
      await p.getByTestId('page-ai-menu').click();
      const menu = p.getByRole('menu', { name: 'AI' });
      for (const t of ['Ask this page', 'Summarise', 'Check if up to date', 'Create tickets from this page', 'Suggest links', 'Translate view…', 'Edit with AI…']) {
        await menu.getByText(t, { exact: true }).waitFor();
      }
      await p.getByTestId('ai-row-summarise').click();
      const box = p.getByRole('region', { name: 'Summary by AI' });
      await box.getByTestId('summary-text').waitFor({ timeout: 30000 });
      await box.getByText('A REST API with paging still to do.').waitFor();
      await box.getByRole('button', { name: 'Copy' }).click();
      await box.getByRole('button', { name: 'Copied' }).waitFor();
      await box.getByTestId('summary-hide').click();
      await box.waitFor({ state: 'detached' });
    });
    await s.step('Translate view: a Vietnamese translation, then the original', async () => {
      fake({ 'docs-translate': { markdown: '# API\n\nAPI d\u00f9ng REST.\n\n- [ ] Th\u00eam ph\u00e2n trang\n', language: 'Vietnamese' } });
      await aiMenu('translate');
      await p.getByRole('menuitem', { name: 'Vietnamese', exact: true }).click();
      const banner = p.getByTestId('translate-banner');
      await banner.getByText(/Showing a Vietnamese translation by AI/).waitFor({ timeout: 30000 });
      await p.getByText('API d\u00f9ng REST.').waitFor();
      await banner.getByTestId('translate-toggle').click();
      await banner.getByText('Showing the original page.').waitFor();
      await p.getByText('The API uses REST.').waitFor();
      await banner.getByTestId('translate-toggle').click();
      await p.getByText('API d\u00f9ng REST.').waitFor();
    });
    await s.step('Translate view: another language typed in', async () => {
      fake({ 'docs-translate': { markdown: '# API\n\nL\u2019API utilise REST.\n', language: 'French' } });
      await p.getByTestId('page-ai-menu').click();
      await p.getByTestId('ai-row-translate').click();
      await p.getByRole('textbox', { name: 'Another language' }).fill('French');
      await p.getByRole('button', { name: 'Translate', exact: true }).click();
      await p.getByText(/Showing a French translation by AI/).waitFor({ timeout: 30000 });
      await p.getByText('L\u2019API utilise REST.').waitFor();
    });
    await s.step('Translate view: close the translation', async () => {
      // the banner has no Close once the translation is shown: reload the page from the tree instead
      await item('Release notes').click();
      await p.getByTestId('page-title').getByText('Release notes', { exact: true }).waitFor();
      await item('API').click();
      await p.getByTestId('page-title').getByText('API', { exact: true }).waitFor();
      await p.getByText('The API uses REST.').waitFor();
    });
    await s.step('Check if up to date: a stale banner with its reason, then "Still correct"', async () => {
      fake({ 'docs-freshness': { state: 'stale', reasons: [{ quote: 'REST', source: 'ALP-1', why: 'The API moved to gRPC.' }] } });
      await aiMenu('check');
      const banner = p.getByTestId('freshness-banner');
      await banner.getByText('This page may be out of date').waitFor({ timeout: 30000 });
      await banner.getByTestId('freshness-reason').getByText('The API moved to gRPC.').waitFor();
      await banner.getByTestId('freshness-still-correct').click();
      await banner.waitFor({ state: 'detached' });
    });
    await s.step('Check if up to date: dismiss one reason', async () => {
      fake({ 'docs-freshness': { state: 'stale', reasons: [{ quote: 'paging', source: 'ALP-2', why: 'Paging was dropped.' }] } });
      await aiMenu('check');
      const banner = p.getByTestId('freshness-banner');
      await banner.getByText('Paging was dropped.').waitFor({ timeout: 30000 });
      await banner.getByRole('button', { name: 'Dismiss this reason' }).click();
      await p.getByRole('menuitem').first().click();
      await banner.waitFor({ state: 'detached' });
    });
    await s.step('Create tickets from this page: draft, edit the title, create (see the note on the 4.0.3 answer)', async () => {
      fake({ 'docs-tickets': { drafts: [{ title: 'Add paging', text: 'From the API page.', type: 'task' }], skipped: [] } });
      await aiMenu('tickets');
      const d = p.getByRole('dialog', { name: 'Create tickets' });
      await d.getByTestId('ticket-draft').waitFor({ timeout: 30000 });
      await d.getByRole('textbox', { name: /^Title of ticket/ }).fill('Add paging to the API');
      await d.getByTestId('create-tickets-submit').getByText('Create 1 ticket').waitFor();
      const [res] = await Promise.all([
        p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/tickets\/create$/.test(r.url())),
        d.getByTestId('create-tickets-submit').click(),
      ]);
      if (res.status() !== 200) throw new Error('create answered ' + res.status());
      const out = await res.json();
      if (out.tickets.length !== 1 || out.tickets[0].title !== 'Add paging to the API') throw new Error('unexpected answer ' + JSON.stringify(out));
      s.note('create answer keys', Object.keys(out).sort().join());
      // KNOWN BUG of 4.0.3 (the UI is newer than that server): the answer has no `not_replaced`, so the dialog's
      // onSuccess throws on `notReplaced.length` before it shows the "1 ticket created" toast and closes. The ticket
      // exists; the dialog stays open and is closed by hand. A server that sends the field makes the toast appear.
      await Promise.race([
        d.waitFor({ state: 'detached' }),
        p.waitForTimeout(2500),
      ]);
      if (await d.count()) {
        s.note('dialog stayed open after create', true);
        await d.getByRole('button', { name: 'Cancel' }).click();
        await d.waitFor({ state: 'detached' });
      }
    }, { expectConsole: true });
    await s.step('the new ticket is on the board and lists the page', async () => {
      await p.getByRole('button', { name: 'Board', exact: true }).click();
      await p.getByText('Add paging to the API').first().waitFor();
      await openDocs(s);
      await item('API').click();
      await p.getByTestId('page-title').getByText('API', { exact: true }).waitFor();
    });
    await s.step('Check this page in the editor (/ai): findings, Fix as draft, Accept', async () => {
      fake({
        'docs-check': { findings: [
          { kind: 'unclear', quote: 'The API uses REST.', message: 'Say which version.', suggestion: 'The API uses REST v2.' },
          { kind: 'style', quote: 'Add paging', message: 'Write a full sentence.' },
        ] },
        'docs-fix': { old: 'The API uses REST.', new: 'The API uses REST v2.' },
      });
      await p.getByRole('button', { name: 'Edit', exact: true }).click();
      await p.getByRole('textbox', { name: 'Page content' }).click();
      await p.keyboard.press('Control+End');
      await p.keyboard.press('Enter');
      await p.keyboard.type('/ai');
      const menu = p.getByRole('listbox', { name: 'Insert block' });
      await menu.waitFor();
      await menu.getByRole('option', { name: /Check this page/ }).click();
      const panel = p.getByTestId('check-this-page');
      await panel.waitFor();
      await panel.getByTestId('check-finding').first().waitFor({ timeout: 30000 });
      if ((await panel.getByTestId('check-finding').count()) !== 2) throw new Error('expected two findings');
      await panel.getByText('Say which version.').waitFor();
      await panel.getByText('Write a full sentence.').waitFor();
      s.note('finding kinds', await panel.getByTestId('check-finding').evaluateAll((els) => els.map((e) => e.dataset.kind)));
    });
    await s.step('Check this page: ignore the style finding', async () => {
      const panel = p.getByTestId('check-this-page');
      const style = panel.locator('[data-testid="check-finding"][data-kind="style"]');
      await style.getByTestId('ignore-finding').click();
      await style.waitFor({ state: 'detached' });
    });
    await s.step('Check this page: Fix as draft shows a diff, Accept puts it in the editor', async () => {
      const panel = p.getByTestId('check-this-page');
      await panel.getByTestId('fix-as-draft').click();
      await panel.getByTestId('fix-diff').waitFor({ timeout: 30000 });
      await panel.getByTestId('fix-accept').click();
      await p.getByRole('textbox', { name: 'Page content' }).getByText('The API uses REST v2.').waitFor();
      await s.settle();
    });
    await s.step('publish the fixed page as v2', async () => {
      await publishDoc(s, 'Fixed after the AI check');
      await p.getByText('Published · v2').waitFor();
      await p.getByText('The API uses REST v2.').waitFor();
    });
    await s.step('New page, Write with AI: picking a source crashes the screen (KNOWN BUG of 4.0.3, kept as it is)', async () => {
      // KNOWN BUG of 4.0.3: the "What will be sent" answer of POST /projects/{id}/docs/ai/write/preview is
      // {cost, items, left_out, tokens}; the UI reads its `send` object (`send.ticket`) and the whole app goes
      // blank with "Cannot read properties of undefined (reading 'ticket')". This step asserts that behaviour so a
      // server that behaves differently shows up as a difference. The next step works around it.
      await p.getByRole('button', { name: 'New page' }).first().click();
      const d = p.getByRole('dialog', { name: 'New page' });
      await d.getByRole('group', { name: 'Write with AI' }).waitFor();
      for (const t of ['From a ticket', 'From an idea', 'From pasted notes', 'From a prompt']) await d.getByRole('button', { name: t }).waitFor();
      await d.getByTestId('write-ai-prompt').click();
      const crash = p.waitForEvent('pageerror', { timeout: 15000 }).catch(() => null);
      await d.getByRole('textbox', { name: 'What the page is about' }).fill('How paging works in the API');
      const err = await crash;
      s.note('page error on the Write preview', err ? String(err.message).split('\n')[0] : 'none');
      const blank = await p.evaluate(() => !document.querySelector('[role="dialog"]') && document.body.innerText.trim() === '');
      s.note('screen blank after the preview', blank);
    }, { expectConsole: true });
    await s.step('Write with AI from a prompt: the draft the stand-in names opens', async () => {
      // The stand-in cannot call the board's tools, so it writes no page: its answer names an existing one. The
      // preview answer is completed with the `send` object the UI needs (see the step before) so that the rest runs.
      await p.route('**/docs/ai/write/preview', async (route) => {
        const res = await route.fetch();
        const j = await res.json();
        j.send = { ticket: null, description: false, comments: 0, pages: [], code: false, idea: false, notes: false, prompt: true, style_guide: null };
        j.skipped = j.skipped ?? [];
        j.notes = j.notes ?? [];
        // 4.0.3 also sends null for tokens and cost; the UI formats them
        Object.assign(j, { tokens: 1200, cost: 0, metered: false, member: 'Docs helper', suggested_title: 'Paging', from: 'a prompt', injections: [] });
        j.items = j.items.map((it, i) => ({ n: i + 1, ...it }));
        await route.fulfill({ response: res, json: j });
      });
      fake({ 'docs-write': { page_id: ids['Release notes'], title: 'Paging', gaps: ['Who owns it?'] } });
      await home(s);
      await openDocs(s);
      await p.getByRole('button', { name: 'New page' }).first().click();
      const d = p.getByRole('dialog', { name: 'New page' });
      await d.getByTestId('write-ai-prompt').click();
      await d.getByRole('textbox', { name: 'What the page is about' }).fill('How paging works in the API');
      await d.getByTestId('what-will-be-sent').waitFor();
      s.note('what will be sent', await d.getByTestId('what-will-be-sent').innerText());
      await d.getByRole('textbox', { name: 'Title' }).fill('Paging');
      await d.getByTestId('write-draft').click();
      await d.waitFor({ state: 'detached', timeout: 30000 });
      await p.getByRole('textbox', { name: 'Page title' }).waitFor();
    });
    await s.step('the page the AI wrote is in the editor, then leave it', async () => {
      s.note('title field', await p.getByRole('textbox', { name: 'Page title' }).inputValue());
      await p.getByRole('button', { name: 'Discard' }).click();
      const confirm = p.getByRole('dialog').getByRole('button', { name: /Discard/ });
      if (await confirm.count()) await confirm.last().click();
      await s.settle();
      await p.getByRole('button', { name: 'Edit', exact: true }).waitFor();
    });
    await s.step('a page with a link to a page that does not exist', async () => {
      await item('Release notes').click();
      await p.getByTestId('page-title').getByText('Release notes', { exact: true }).waitFor();
      await p.getByRole('button', { name: 'Edit', exact: true }).click();
      await setMarkdown(s, '# Release notes\n\nThe release ships the API described in [[API]], see also [[Nowhere page]].\n');
      await publishDoc(s, 'A link to nowhere');
    });
    await s.step('Docs health: run it now, the Broken links tab lists the link, dismiss it', async () => {
      fake({ 'docs-freshness': { state: 'ok', reasons: [] } });
      await p.getByRole('button', { name: /Docs health/ }).click();
      const h = p.getByTestId('docs-health');
      await h.getByRole('heading', { name: 'Docs health' }).waitFor();
      await h.getByText('Nothing here changes a page.').waitFor();
      await h.getByTestId('health-run').click();
      await h.getByRole('button', { name: 'Run now' }).waitFor({ timeout: 30000 });
      await h.getByRole('tab', { name: /^Broken links 1/ }).waitFor({ timeout: 15000 });
      await h.getByRole('tab', { name: /^Out of date 0/ }).waitFor();
      await h.getByRole('tab', { name: /^Broken links/ }).click();
      const row = h.getByTestId('health-broken');
      await row.getByText('Nowhere page').waitFor();
      await row.getByText('Release notes').waitFor();
      await row.getByRole('button', { name: 'Review' }).waitFor();
      await row.getByRole('button').last().click();
      await p.getByRole('menuitem').first().click();
      await row.waitFor({ state: 'detached' });
      await h.getByText('Every link and section resolves.').waitFor();
    });
    await s.step('Docs health: Missing docs lists a Done ticket no page mentions', async () => {
      const h = p.getByTestId('docs-health');
      await h.getByRole('tab', { name: /^Missing docs/ }).click();
      s.note('missing docs tab', (await h.innerText()).slice(-200));
    });
    await s.step('a page comment on API', async () => {
      await item('API').click();
      await p.getByTestId('page-title').getByText('API', { exact: true }).waitFor();
      await p.getByPlaceholder('Write a comment on this page…').click();
      await p.waitForTimeout(600);
      await p.keyboard.type('Please add an example request.');
      await p.getByText('Please add an example request.').waitFor();
      await Promise.all([
        p.waitForResponse((r) => r.request().method() === 'POST' && /comments/.test(r.url()), { timeout: 8000 }),
        p.keyboard.press('Control+Enter'),
      ]);
      await p.getByText('Please add an example request.').first().waitFor();
    });
    await s.step('Comments panel: Send to AI, to the page\'s assistant', async () => {
      // The stand-in answers the job but has no board tool to post the reply, so only the "Sent to" line shows.
      fake({ 'docs-thread': { reply: 'An example request would be GET /items?page=2.', posted: true } });
      await p.getByTestId('comments-button').or(p.getByRole('button', { name: /^Comments/ })).first().click();
      await p.getByTestId('send-to-ai-open').click();
      const box = p.getByRole('region', { name: 'Send comments to an AI' });
      await box.getByText('1 of 1 chosen').waitFor();
      for (const t of ['The team of a ticket', 'Board AI decides', "The page's assistant"]) await box.getByText(t, { exact: true }).waitFor();
      await box.getByTestId('send-to-ai-to-page_assistant').check();
      await box.getByTestId('send-to-ai-go').getByText("Send to the page's assistant").waitFor();
      await box.getByTestId('send-to-ai-go').click();
      await p.getByText(/Sent to the page.s assistant/).first().waitFor();
      await box.waitFor({ state: 'detached' });
    });
    await s.step('a comment that mentions the AI team gets its answer in the thread', async () => {
      fake({ 'docs-thread': { reply: 'Nobody owns paging yet: assign it.', posted: false } });
      await p.getByPlaceholder('Write a comment on this page…').click();
      await p.waitForTimeout(600);
      await p.keyboard.type('@Docs');
      const pick = p.getByRole('option', { name: /Docs helper/ }).or(p.getByText('Docs helper', { exact: true }).last());
      await pick.first().waitFor();
      await p.keyboard.press('Enter');
      await p.keyboard.type(' who owns paging?');
      await p.getByText(/who owns paging\?/).waitFor();
      await p.keyboard.press('Control+Enter');
      const ask = p.getByRole('dialog', { name: /You mentioned Docs helper/ }).or(p.getByText('You mentioned Docs helper'));
      await ask.first().waitFor();
      await p.getByText('Ask (answer in the thread)').waitFor();
      await p.getByText('Just notify').waitFor();
      await Promise.all([
        p.waitForResponse((r) => r.request().method() === 'POST' && /comments/.test(r.url()), { timeout: 8000 }),
        p.getByRole('button', { name: 'Post comment' }).click(),
      ]);
      await p.getByText('Nobody owns paging yet: assign it.').first().waitFor({ timeout: 30000 });
    });
    await s.step('the answer is written as the Docs AI', async () => {
      const cm = await api(`/docs/pages/${ids.API}/comments`);
      const last = cm.threads.at(-1).comments.at(-1);
      s.note('reply', { by: last.author, ai: last.ai, body: last.body });
      if (last.body !== 'Nobody owns paging yet: assign it.') throw new Error('unexpected last comment ' + last.body);
    });
    await s.step('Changes since you last viewed: "Summarise with AI" (the 4.0.3 answer is recorded)', async () => {
      // 4.0.3 answers the job with `lines`, the card reads `pages`; what the card does is recorded for the diff.
      fake({ 'docs-history': { lines: [{ page_id: ids.API, line: 'Added the REST v2 line.' }] } });
      const card = p.getByTestId('since-viewed-digest');
      if (!(await card.count())) { s.note('digest card', 'not shown'); return; }
      await card.getByText('Changes since you last viewed').waitFor();
      await card.getByRole('button', { name: /Summarise with AI/ }).click();
      await p.waitForTimeout(3000);
      await s.settle();
      s.note('digest after the summary', (await card.count()) ? (await card.innerText()).slice(0, 300) : 'card gone');
    });
    await s.step('Follow a page: the bell menu, Everything, Only mentions, Muted, unfollow', async () => {
      await p.getByTestId('comments-button').or(p.getByRole('button', { name: /^Comments/ })).first().click().catch(() => {});
      const bell = p.getByRole('button', { name: /^(Follow this page|Following this page|Muted: notifications of this page)$/ });
      await bell.first().waitFor();
      s.note('bell at the start', await bell.first().getAttribute('aria-label'));
      const menuOf = () => p.getByRole('menu').filter({ hasText: 'This page' });
      const pick = async (name) => {
        await bell.first().click();
        await menuOf().getByRole('menuitem', { name: new RegExp(name) }).first().click();
        await s.settle();
      };
      await pick('^Follow');
      await p.getByRole('button', { name: 'Following this page' }).waitFor();
      await pick('Everything');
      await p.getByRole('button', { name: 'Following this page' }).waitFor();
      await bell.first().click();
      await menuOf().getByRole('menuitem', { name: /Everything/ }).waitFor();
      s.note('follow menu', await menuOf().innerText());
      await menuOf().getByRole('menuitem', { name: /Only mentions and questions/ }).click();
      await s.settle();
      await bell.first().click();
      await menuOf().getByRole('menuitem', { name: /Muted/ }).first().click();
      await p.getByRole('button', { name: 'Muted: notifications of this page' }).waitFor();
      await bell.first().click();
      await menuOf().getByRole('menuitem', { name: /Muted/ }).first().click(); // choosing the level again forgets it
      await p.getByRole('button', { name: 'Follow this page' }).waitFor();
    });
    await s.step('Follow the space: the bell above the page tree', async () => {
      const sw = p.getByRole('switch', { name: /^(Follow this space|Following this space)$/ });
      await sw.waitFor();
      if ((await sw.getAttribute('aria-checked')) === 'true') await sw.click();
      await p.getByRole('switch', { name: 'Follow this space' }).waitFor();
      await p.getByRole('switch', { name: 'Follow this space' }).click();
      await p.getByRole('switch', { name: 'Following this space', checked: true }).waitFor();
      await p.reload();
      await p.getByRole('complementary', { name: 'Project navigation' }).waitFor({ timeout: 20000 });
      await p.getByRole('button', { name: 'Docs', exact: true }).click();
      await p.getByRole('switch', { name: 'Following this space', checked: true }).waitFor();
    });
    await s.step('turn Docs AI off: the AI entries disappear', async () => {
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Docs', exact: true }).click();
      await p.getByRole('switch', { name: 'Use AI in Docs' }).click();
      await p.getByRole('switch', { name: 'Use AI in Docs', checked: false }).waitFor();
      await p.getByRole('button', { name: 'Back to board' }).click();
      await openDocs(s);
      await p.getByTestId('tree-ask-docs').waitFor({ state: 'detached' });
      await item('API').click();
      await p.getByTestId('page-title').getByText('API', { exact: true }).waitFor();
      await p.getByTestId('page-ai-menu').waitFor({ state: 'detached' });
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });
  },
};
