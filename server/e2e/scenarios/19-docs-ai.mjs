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
      await p.getByRole('heading', { name: 'API', level: 1 }).waitFor();
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
  },
};
