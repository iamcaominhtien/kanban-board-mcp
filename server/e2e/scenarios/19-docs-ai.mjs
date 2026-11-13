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
    await s.step('Create tickets from this page: draft, edit the title, create', async () => {
      fake({ 'docs-tickets': { drafts: [{ title: 'Add paging', text: 'From the API page.', type: 'task' }], skipped: [] } });
      await aiMenu('tickets');
      const d = p.getByRole('dialog', { name: 'Create tickets' });
      await d.getByTestId('ticket-draft').waitFor({ timeout: 30000 });
      await d.getByRole('textbox', { name: /^Title of ticket/ }).fill('Add paging to the API');
      await d.getByTestId('create-tickets-submit').getByText('Create 1 ticket').waitFor();
      await d.getByTestId('create-tickets-submit').click();
      await p.getByText(/1 ticket created in/).waitFor();
      await d.waitFor({ state: 'detached' });
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
  },
};
