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
      // the reason names the block it read, with Show (RichDocsAi2 H 46): the board's amber 20 px chip
      const chip = banner.getByTestId('freshness-block');
      await chip.getByText('Paragraph · Show').waitFor();
      const look = await chip.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { h: el.getBoundingClientRect().height, color: cs.color, border: cs.borderTopColor, size: cs.fontSize };
      });
      s.note('reason block chip', JSON.stringify(look));
      if (look.h !== 20 || look.color !== 'rgb(138, 90, 0)' || look.border !== 'rgb(235, 211, 164)' || look.size !== '11px') throw new Error('reason chip: ' + JSON.stringify(look));
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
    await s.step('Create tickets from this page: draft, edit the title, create; the toast and the key in the draft', async () => {
      // the draft's text is the checklist line it came from, so that "Replace the text" can find it in the draft
      fake({ 'docs-tickets': { drafts: [{ title: 'Add paging', text: 'Add paging', type: 'task' }], skipped: [] } });
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
      // what the dialog reads (CreatedTickets): numbers and lists, the draft with the key at the end of its line
      const key = out.tickets[0].id;
      ids.ticket = key;
      if (out.replaced !== 1 || out.linked !== 1 || !Array.isArray(out.not_replaced) || out.not_replaced.length) throw new Error('replaced/linked/not_replaced: ' + JSON.stringify(out));
      if (out.draft_markdown !== `# API\n\nThe API uses REST.\n\n- [ ] Add paging ${key}\n`) throw new Error('draft_markdown: ' + JSON.stringify(out.draft_markdown));
      // the dialog closes and the toast says what was made (it threw on `notReplaced.length` before)
      await d.waitFor({ state: 'detached', timeout: 10000 });
      await p.getByText('1 ticket created in Backlog').waitFor();
      const page = await api(`/docs/pages/${ids.API}`);
      if (page.draft?.markdown !== out.draft_markdown) throw new Error('the draft was not saved: ' + JSON.stringify(page.draft));
      s.note('draft after create', page.draft.markdown);
    });
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
      // creating the ticket saved the key into the draft of the page, so the page offers to continue it
      await p.getByRole('button', { name: 'Continue editing', exact: true }).click();
      const content = p.getByRole('textbox', { name: 'Page content' });
      // the page's text is in the editor before the caret moves: else the new line lands before it
      await content.getByText('The API uses REST.').waitFor();
      await content.getByText(new RegExp(`Add paging\\s*${ids.ticket}`)).waitFor();
      await content.click();
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
    await s.step('New page, Write with AI: "What will be sent" shows the chips and the tokens', async () => {
      await p.getByRole('button', { name: 'New page' }).first().click();
      const d = p.getByRole('dialog', { name: 'New page' });
      // Write with AI is a violet chip of the gallery (design "Starting and shaping a page", frame 47)
      await d.getByTestId('chip-ai').click();
      await d.getByRole('group', { name: 'Write with AI' }).waitFor();
      for (const t of ['From a ticket', 'From an idea', 'From pasted notes', 'From a prompt']) await d.getByRole('button', { name: t }).waitFor();
      await d.getByTestId('write-ai-prompt').click();
      await d.getByRole('textbox', { name: 'What the page is about' }).fill('How paging works in the API');
      const sent = d.getByTestId('what-will-be-sent');
      await sent.getByText('Your request', { exact: true }).waitFor();
      await sent.getByText(/~\d[\d,]* tokens/).waitFor();
      await sent.getByText(/Not metered/).waitFor();
      s.note('what will be sent', await sent.innerText());
      // the same answer for a ticket: the ticket, its linked page (the one the tickets step linked) and the tokens
      const pv = await (await p.request.post(`${s.server.base}/projects/${ids.project}/docs/ai/write/preview`, {
        data: { source: { kind: 'ticket', ticket_id: ids.ticket }, include: { comments: true, linked_pages: true, code_changes: false } },
      })).json();
      s.note('ticket preview', { send: pv.send, items: pv.items.map((i) => i.kind), skipped: pv.skipped, tokens: pv.tokens > 0, cost: pv.cost, metered: pv.metered, member: pv.member, from: pv.from, title: pv.suggested_title });
      if (pv.send.ticket?.id !== ids.ticket || !pv.send.description || pv.send.pages.length !== 1 || pv.send.pages[0].id !== ids.API) throw new Error('ticket preview: ' + JSON.stringify(pv.send));
      if (!(pv.tokens > 0) || pv.cost !== 0 || pv.metered !== false || pv.member !== 'Docs helper' || pv.from !== ids.ticket) throw new Error('ticket preview: ' + JSON.stringify(pv));
    });
    await s.step('Write with AI from a prompt: the draft the stand-in names opens', async () => {
      // The stand-in cannot call the board's tools, so it writes no page: its answer names an existing one.
      fake({ 'docs-write': { page_id: ids['Release notes'], title: 'Paging', gaps: ['Who owns it?'] } });
      await home(s);
      await openDocs(s);
      await p.getByRole('button', { name: 'New page' }).first().click();
      const d = p.getByRole('dialog', { name: 'New page' });
      await d.getByTestId('chip-ai').click();
      await d.getByTestId('write-ai-prompt').click();
      await d.getByRole('textbox', { name: 'What the page is about' }).fill('How paging works in the API');
      await d.getByTestId('what-will-be-sent').getByText(/~\d[\d,]* tokens/).waitFor();
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
      // grouped by the link's target (board Links G 40): the missing page heads the group, each row is a page that
      // links to it, with Go to link and Dismiss
      const group = h.getByTestId('health-broken-group');
      await group.getByText('Nowhere page').first().waitFor();
      await group.getByRole('button', { name: 'Create “Nowhere page”' }).waitFor();
      const row = group.getByTestId('health-broken');
      await row.getByText('Release notes').waitFor();
      await row.getByRole('button', { name: 'Go to link' }).waitFor();
      await row.getByRole('button', { name: 'Dismiss' }).click();
      await p.getByRole('menuitem').first().click();
      await row.waitFor({ state: 'detached' });
      await h.getByText('Every link and section resolves.').waitFor();
    });
    await s.step('Docs health: a picture whose file was deleted is a row of its own, with the IN column', async () => {
      const notes = ids['Release notes'];
      const v = (await api(`/docs/pages/${notes}`)).version;
      const published = await p.request.post(`${s.server.base}/docs/pages/${notes}/publish`, {
        data: { base_version: v, markdown: '# Release notes\n\nThe release ships the API described in [[API]].\n\n![Valley road](/uploads/e2e-gone/valley.png)\n', note: 'A picture' },
      });
      if (!published.ok()) throw new Error('publish answered ' + published.status());
      const h = p.getByTestId('docs-health');
      await h.getByTestId('health-run').click();
      await h.getByRole('button', { name: 'Run now' }).waitFor({ timeout: 30000 });
      await h.getByRole('tab', { name: /^Broken links 1/ }).click();
      const row = h.getByTestId('health-broken-media');
      await row.getByText('The image file was deleted: “Valley road”').waitFor({ timeout: 15000 });
      await row.getByText('Image', { exact: true }).waitFor();
      await h.getByText('IN', { exact: true }).waitFor();
      const look = await row.evaluate((el) => {
        const td = el.querySelector('td'); const cs = getComputedStyle(td);
        return { padding: cs.padding, size: cs.fontSize, status: el.dataset.status };
      });
      s.note('broken picture row', JSON.stringify(look));
      if (look.padding !== '11px 14px' || look.size !== '12.5px' || look.status !== 'image_missing') throw new Error('broken picture row: ' + JSON.stringify(look));
      await row.getByRole('button', { name: 'Dismiss' }).click();
      await p.getByRole('menuitem').first().click();
      await row.waitFor({ state: 'detached' });
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
    await s.step('Changes since you last viewed: "Summarise with AI" lists the changed pages with their lines', async () => {
      // This person saw the current version of Release notes and the space was left (the card reads the time of the
      // last visit); then the next version is published. The server finds the page by the version this person saw
      // (`PUT /docs/pages/{id}/seen`).
      const notes = ids['Release notes'];
      const v = (await api(`/docs/pages/${notes}`)).version;
      const seen = await p.request.put(`${s.server.base}/docs/pages/${notes}/seen`, { data: { version: v } });
      if (!seen.ok()) throw new Error('seen answered ' + seen.status());
      await home(s);
      const published = await p.request.post(`${s.server.base}/docs/pages/${notes}/publish`, {
        data: { base_version: v, markdown: '# Release notes\n\nThe release ships the API described in [[API]]. Paging comes next.\n', note: 'Paging' },
      });
      if (!published.ok()) throw new Error('publish answered ' + published.status());
      fake({ 'docs-history': { lines: ['Release notes: Added the paging line.'] } });
      await openDocs(s);
      const card = p.getByTestId('since-viewed-digest');
      await card.getByText('Changes since you last viewed').waitFor();
      const [res] = await Promise.all([
        p.waitForResponse((r) => r.request().method() === 'POST' && /\/docs\/ai\/since-viewed$/.test(r.url())),
        card.getByRole('button', { name: /Summarise with AI/ }).click(),
      ]);
      if (res.status() !== 200) throw new Error('since-viewed answered ' + res.status());
      const job = await res.json();
      // the card lists the page with its line, and a button that opens it
      await card.getByText('Added the paging line.').waitFor({ timeout: 30000 });
      await card.getByRole('button', { name: 'Release notes' }).waitFor();
      const done = await api(`/docs/ai/jobs/${job.id}`);
      const row = (done.result.pages ?? []).find((x) => x.page_id === notes);
      s.note('digest job result', done.result);
      if (!row || row.kind !== 'changed' || row.from_version !== v || row.to_version !== v + 1 || row.line !== 'Added the paging line.') throw new Error('since_viewed result: ' + JSON.stringify(done.result));
      // who published it and the blocks that changed (RichDocsAi2 H 44): the paragraph, as a 19 px grey chip
      if (!row.by || !row.at || !row.blocks || row.blocks.edited < 1) throw new Error('since_viewed blocks: ' + JSON.stringify(row));
      const line = card.getByTestId('since-viewed-row').filter({ hasText: 'Release notes' });
      await line.getByTestId('since-viewed-by').getByText(/: 1 block edited/).waitFor();
      const chip = line.getByTestId('since-viewed-chips').locator('span').first();
      await chip.getByText(/^Paragraph/).waitFor();
      const look = await chip.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { h: el.getBoundingClientRect().height, bg: cs.backgroundColor, size: cs.fontSize };
      });
      s.note('digest chip', JSON.stringify(look));
      if (look.h !== 19 || look.bg !== 'rgb(241, 243, 241)' || look.size !== '10.5px') throw new Error('digest chip: ' + JSON.stringify(look));
      s.note('digest after the summary', (await card.innerText()).slice(0, 300));
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
    await s.step('AI teams on a page: the page menu sets how a team\'s changes arrive, and Not for AI teams', async () => {
      await item('API').click();
      await p.getByTestId('page-title').getByText('API', { exact: true }).waitFor();
      const settingsOf = async () => (await api(`/docs/pages/${ids.API}`)).settings ?? {};
      const saved = () => p.waitForResponse((r) => r.request().method() === 'PATCH' && /\/docs\/pages\/[^/]+\/settings$/.test(r.url()), { timeout: 8000 });
      await p.getByTestId('page-menu').click();
      await p.getByTestId('menu-ai-changes').click();
      await p.getByText('WHEN A TEAM CHANGES THIS PAGE').waitFor();
      await p.getByRole('menuitemradio', { name: /Team default: Suggest first/, checked: true }).waitFor();
      // the board's radio rows (RichDocsAi1 frame 9): 8px 10px, a 16 px radio, the chosen one on #F1F8F3
      const opt = await p.getByTestId('ai-apply-suggest').evaluate((el) => {
        const cs = getComputedStyle(el); const r = el.querySelector('.sg-radio').getBoundingClientRect();
        return { padding: cs.padding, radio: r.width };
      });
      s.note('AI changes option', JSON.stringify(opt));
      if (opt.padding !== '8px 10px' || opt.radio !== 16) throw new Error('AI changes rows: ' + JSON.stringify(opt));
      await Promise.all([saved(), p.getByTestId('ai-apply-direct').click()]);
      if ((await settingsOf()).aiApply !== 'direct') throw new Error('aiApply was not saved: ' + JSON.stringify(await settingsOf()));
      await p.getByTestId('page-menu').click();
      await p.getByTestId('menu-ai-changes').getByText('Apply directly').waitFor();
      await p.getByTestId('menu-ai-changes').click();
      await Promise.all([saved(), p.getByTestId('ai-apply-default').click()]);
      if ('aiApply' in (await settingsOf())) throw new Error('the page should follow the team again');
      await p.getByTestId('page-menu').click();
      await Promise.all([saved(), p.getByTestId('menu-not-for-ai').click()]);
      if ((await settingsOf()).notForAi !== true) throw new Error('notForAi was not saved');
      await p.getByTestId('page-menu').click();
      await p.getByRole('menuitemcheckbox', { name: 'Not for AI teams', checked: true }).waitFor();
      await Promise.all([saved(), p.getByTestId('menu-not-for-ai').click()]);
      if ('notForAi' in (await settingsOf())) throw new Error('notForAi should be off again');
    });
    await s.step('Give the page to a team: each team has its roles and what it does now under its name', async () => {
      await p.getByTestId('page-menu').click();
      await p.getByTestId('menu-give-ai').click();
      const d = p.getByTestId('docs-give-page');
      const opt = d.locator('.gp-opt').filter({ hasText: 'Docs helper' });
      const sub = opt.locator('.gp-opt-hint');
      await sub.getByText(/ · (idle|working( on [A-Z]+-\d+)?|paused)$/).waitFor({ timeout: 15000 });
      const look = await sub.evaluate((el) => ({ size: getComputedStyle(el).fontSize, color: getComputedStyle(el).color }));
      s.note('team line', `${await sub.innerText()} ${JSON.stringify(look)}`);
      if (look.size !== '12.5px' || look.color !== 'rgb(91, 107, 96)') throw new Error('team line: ' + JSON.stringify(look));
      await d.getByRole('button', { name: 'Cancel' }).click();
      await d.waitFor({ state: 'detached' });
    });
    await s.step('Ask the team on a selection: one purple button; the verbs, Change tone, Translate, Format this as…, the Ask line', async () => {
      const para = p.getByTestId('page-body').locator('.dk-rich p').first();
      await para.scrollIntoViewIfNeeded();
      const box = await para.boundingBox();
      await p.mouse.move(box.x + 2, box.y + box.height / 2);
      await p.mouse.down();
      await p.mouse.move(box.x + 80, box.y + box.height / 2, { steps: 6 });
      await p.mouse.up();
      const btn = await p.getByTestId('ask-team').evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, h: el.getBoundingClientRect().height }));
      await p.getByTestId('ask-team').click();
      const m = p.getByTestId('ask-team-menu');
      await m.getByText('Docs helper', { exact: true }).waitFor();
      await m.getByText('Changes arrive as suggestions here').waitFor();
      for (const t of ['Rewrite', 'Shorten', 'Change tone', 'Fix grammar', 'Translate', 'Make a table', 'Format this as…']) {
        await m.getByRole('menuitem', { name: t, exact: true }).waitFor();
      }
      await m.getByRole('textbox', { name: 'Ask the team to…' }).waitFor();
      await m.getByText('This page is set to suggest first').waitFor();
      s.note('ask the team menu', await m.innerText());
      // the board's numbers (RichDocsAi2 frames 28-29): a light purple button, a 260 px menu of 34 px rows
      const look = await m.evaluate((el) => {
        const row = el.querySelector('.sg-ask-item').getBoundingClientRect();
        return { width: el.getBoundingClientRect().width, row: row.height, radius: getComputedStyle(el).borderRadius };
      });
      look.btn = btn.bg;
      look.btnHeight = btn.h;
      s.note('ask the team look', JSON.stringify(look));
      if (look.width !== 260 || look.row !== 34 || look.btn !== 'rgb(239, 232, 251)' || look.radius !== '12px') throw new Error('Ask the team look: ' + JSON.stringify(look));
      await m.getByTestId('ask-team-format').click();
      for (const t of ['Heading 2', 'Pull quote', 'Callout', 'Bulleted list', 'Numbered list', 'Task list', 'Two columns']) await m.getByRole('menuitem', { name: t, exact: true }).waitFor();
      await m.getByRole('menuitem', { name: '‹ Back' }).click();
      await m.getByTestId('ask-team-tone').click();
      for (const t of ['Friendly', 'Formal', 'Plain', 'Confident', 'Shorter sentences']) await m.getByRole('menuitem', { name: t, exact: true }).waitFor();
      await m.getByRole('menuitem', { name: '‹ Back' }).click();
      await m.getByTestId('ask-team-translate').click();
      await m.getByRole('menuitem', { name: 'Vietnamese', exact: true }).waitFor();
      await p.keyboard.press('Escape');
      await m.waitFor({ state: 'detached' });
    });
    await s.step('Settings, Docs: how each team changes pages, Suggest first or Apply directly', async () => {
      await p.getByRole('button', { name: 'Settings', exact: true }).click();
      await p.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Docs', exact: true }).click();
      const g = p.getByRole('radiogroup', { name: 'How Docs helper changes pages' });
      await g.getByRole('radio', { name: 'Suggest first', checked: true }).waitFor();
      // the board's segmented switch (RichDocsAi1 frame 10): a #EEF3EF track 250 px wide, 26 px buttons
      const sw = await g.evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, width: el.getBoundingClientRect().width, h: el.querySelector('button').getBoundingClientRect().height }));
      s.note('team switch', JSON.stringify(sw));
      if (sw.bg !== 'rgb(238, 243, 239)' || sw.width !== 250 || sw.h !== 26) throw new Error('team switch: ' + JSON.stringify(sw));
      const saved = () => p.waitForResponse((r) => r.request().method() === 'PATCH' && /\/docs\/settings$/.test(r.url()), { timeout: 8000 });
      const [res] = await Promise.all([saved(), g.getByRole('radio', { name: 'Apply directly' }).click()]);
      s.note('team setting saved', `${res.status()} ${(await res.text()).slice(0, 300)}`);
      await g.getByRole('radio', { name: 'Apply directly', checked: true }).waitFor();
      const st = await api(`/projects/${ids.project}/docs/settings`);
      if (!Object.values(st.aiApply ?? st.ai_apply ?? {}).includes('direct')) throw new Error('aiApply not saved: ' + JSON.stringify(st));
      await Promise.all([saved(), g.getByRole('radio', { name: 'Suggest first' }).click()]);
      await g.getByRole('radio', { name: 'Suggest first', checked: true }).waitFor();
      await p.getByRole('button', { name: 'Back to board' }).click();
      // back to the Docs space as the steps before left it
      await p.reload();
      await p.getByRole('complementary', { name: 'Project navigation' }).waitFor({ timeout: 20000 });
      await p.getByRole('button', { name: 'Docs', exact: true }).click();
      await p.getByTestId('tree-ask-docs').waitFor();
    });
    await s.step('turn Docs AI off: the AI entries disappear', async () => {
      await p.getByRole('button', { name: 'Settings', exact: true }).click(); // not the page's Reading settings
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
