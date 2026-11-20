import { ensureProject, createTicket, addMember, openTicket, closeTicket, openDocs, newDocPage, setMarkdown, getMarkdown, publishDoc, home } from '../lib/ui.mjs';

// Docs: version history and compare, "Changes since you last viewed", the search palette and the results page,
// hover cards and the side panel, references typed in the editor, the bubble toolbar and the table controls.
export default {
  name: 'Docs: history and compare, since viewed, search, peek, references, bubble toolbar, tables',
  async run(s) {
    const p = s.page;
    const base = () => s.server.base;
    const get = async (path, headers) => (await p.request.get(`${base()}${path}`, { headers })).json();
    const tree = () => p.getByRole('tree');
    const item = (name) => tree().getByRole('treeitem', { name: new RegExp(`(^|Expand |Collapse )${name}( \\d+)? ?(Add child|Page actions|$)`) }).first();
    const content = () => p.getByRole('textbox', { name: 'Page content' });
    const ids = {};
    const saved = async () => { await p.getByText(/^Saved/).waitFor(); await s.settle(); };
    // Back to the Docs space with the page open, as after a fresh visit
    const visit = async (title) => {
      await home(s);
      await openDocs(s);
      await item(title).click();
      await p.getByTestId('page-title').filter({ hasText: title }).waitFor();
    };
    const openHistory = async () => {
      await p.getByRole('button', { name: 'Page actions' }).click();
      await p.getByRole('menuitem', { name: /Page history/ }).click();
      await p.getByRole('dialog', { name: 'Page history' }).waitFor();
    };
    const drawer = () => p.getByTestId('history-drawer');
    const compare = () => p.getByTestId('history-compare');
    const palette = () => p.getByRole('dialog', { name: 'Search docs' });
    const openPalette = async () => {
      await p.keyboard.press('Control+k');
      await palette().waitFor();
      return palette().getByRole('combobox');
    };

    await s.step('set up: a project, a ticket, Docs, the page Architecture published as v1', async () => {
      await ensureProject(s);
      await createTicket(s, { title: 'Plan the rollout' });
      await addMember(s, 'Grace Hopper');
      await openDocs(s);
      await newDocPage(s, 'Architecture');
      await setMarkdown(s, '# Architecture\n\nOverview of the platform.\n\n## Storage\n\nData lives in SQLite.\n\n## API\n\nThe API speaks REST.\n\n```js\nconst answer = 42;\n```\n');
      await publishDoc(s, 'First draft');
      await p.getByText('Published · v1').waitFor();
    });
    await s.step('edit Architecture: storage changes and a Security section is added (v2)', async () => {
      await p.getByRole('button', { name: 'Edit', exact: true }).click();
      await setMarkdown(s, '# Architecture\n\nOverview of the platform.\n\n## Storage\n\nData lives in PostgreSQL.\n\n## API\n\nThe API speaks REST.\n\n```js\nconst answer = 42;\n```\n\n## Security\n\nTokens expire daily.\n');
      await publishDoc(s, 'Switch storage');
      await p.getByText('Published · v2').waitFor();
    });
    await s.step('a teammate publishes v3 of Architecture while this person is away', async () => {
      const pid = (await get('/projects'))[0].id;
      const nodes = await get(`/projects/${pid}/docs/tree`);
      for (const n of nodes.nodes ?? nodes) ids[n.title] = n.id;
      const page = await get(`/docs/pages/${ids.Architecture}`);
      const r = await p.request.post(`${base()}/docs/pages/${ids.Architecture}/publish`, {
        headers: { 'X-Actor': 'Grace Hopper' },
        data: { base_version: page.version, markdown: page.markdown.replace('The API speaks REST.', 'The API speaks REST and GraphQL.'), note: 'Document GraphQL' },
      });
      if (!r.ok()) throw new Error('publish answered ' + r.status());
    });
    await s.step('Runbook links the page, two sections (one gone) and the ticket; a draft page comes next', async () => {
      await visit('Architecture');
      await newDocPage(s, 'Runbook');
      await setMarkdown(s, '# Runbook\n\nRestore from the PostgreSQL backups first.\n\nSee [[Architecture#Storage]], [[Architecture]], ALP-1 and [[Architecture#Gone]].\n');
      await publishDoc(s, 'Runbook');
      await p.getByText('Published · v1').waitFor();
      await newDocPage(s, 'Scratch');
      // typed in the Markdown pane right after the page opened: it is autosaved (an edit in the first 2.5 s used to be
      // taken for the editor's own re-serialising and dropped)
      await setMarkdown(s, 'PostgreSQL scratch notes.\n\nSecond paragraph.\n\n| Env | DB |\n| --- | --- |\n| dev | sqlite |\n| prod | pg |\n');
      // the draft autosaves a few seconds after the last key: wait until the server has the text (it is never published)
      const pid2 = (await get('/projects'))[0].id;
      const tr2 = await get(`/projects/${pid2}/docs/tree`);
      const scratch = (tr2.nodes ?? tr2).find((n) => n.title === 'Scratch');
      const t0 = Date.now();
      while (!(await get(`/docs/pages/${scratch.id}`)).draft?.markdown) {
        if (Date.now() - t0 > 15000) throw new Error('the draft was not autosaved');
        await new Promise((r) => setTimeout(r, 250));
      }
    });

    // ---- Changes since you last viewed ----
    await s.step('the page the teammate changed shows "Changes since you last viewed", collapsed', async () => {
      await visit('Architecture');
      const banner = p.getByTestId('since-viewed-banner');
      await banner.getByText('Changes since you last viewed').waitFor();
      await banner.getByText(/1 edit by Grace Hopper/).waitFor();
      await p.getByText('Published · v3').waitFor();
    });
    await s.step('Show changes lists the edit and the changed section; changed paragraphs are marked in the page', async () => {
      const banner = p.getByTestId('since-viewed-banner');
      await banner.getByRole('button', { name: 'Show changes' }).click();
      await banner.getByText('Document GraphQL').waitFor();
      // the rich page names the changed blocks as chips ("Paragraph 2"), not by section heading
      await banner.getByTestId('since-chips').getByText('Paragraph 2', { exact: true }).waitFor();
      await banner.getByText(/1 section/).waitFor();
      await p.locator('[data-changed-in="Changed in v3"]').first().waitFor();
    });
    await s.step('the eye button hides and shows the change markers', async () => {
      const eye = p.getByRole('button', { name: 'Mark changed paragraphs in the page' });
      await eye.click();
      await p.locator('[data-changed-in="Changed in v3"]').first().waitFor({ state: 'detached' });
      await eye.and(p.locator('[aria-pressed="false"]')).waitFor();
      await eye.click();
      await p.locator('[data-changed-in="Changed in v3"]').first().waitFor();
    });
    await s.step('Compare v2 to v3 opens the diff of just that edit', async () => {
      await p.getByTestId('since-viewed-banner').getByRole('button', { name: 'Compare v2 to v3' }).click();
      await compare().waitFor();
      await compare().getByText(/REST and GraphQL\./) /* inline word diff: the changed words are marked on their own */.waitFor();
      await compare().getByRole('combobox', { name: 'From version' }).waitFor();
      await compare().getByRole('button', { name: 'Close' }).click();
      await compare().waitFor({ state: 'detached' });
    });
    await s.step('Mark as seen removes the banner', async () => {
      await p.getByTestId('since-viewed-banner').getByRole('button', { name: 'Mark as seen' }).click();
      await p.getByTestId('since-viewed-banner').waitFor({ state: 'detached' });
    });

    // ---- history and compare ----
    await s.step('page history lists three versions with their notes and authors', async () => {
      await openHistory();
      const d = drawer();
      await d.getByText('Document GraphQL').waitFor();
      await d.getByText('Switch storage').waitFor();
      await d.getByText('First draft').waitFor();
      await d.getByText('Grace Hopper').first().waitFor();
      await d.getByText('Current').waitFor();
    });
    await s.step('select v1 and v3: the footer counts them and Compare opens the diff with its totals', async () => {
      const d = drawer();
      await d.getByLabel('Select version 1').check({ force: true });
      await d.getByLabel('Select version 3').check({ force: true });
      await d.getByText('2 selected').waitFor();
      await d.getByText('v1 → v3').waitFor();
      await d.getByRole('button', { name: 'Compare', exact: true }).click();
      await compare().waitFor();
      // the rich compare counts blocks (the Security section's heading and paragraph are new), not lines
      await compare().getByTestId('hx-counts').filter({ hasText: /[1-9]\d* added/ }).waitFor();
      await compare().getByText(/PostgreSQL/).first().waitFor();
      await compare().getByText('Tokens expire daily.').first().waitFor();
      await compare().getByText(/Comparing the published versions/).waitFor();
    });
    await s.step('Diff layout: Side by side, then back to Inline', async () => {
      const layout = compare().getByRole('group', { name: 'Diff layout' });
      await layout.getByRole('button', { name: 'Side by side' }).click();
      await layout.getByRole('button', { name: 'Side by side' }).and(p.locator('[aria-pressed="true"]')).waitFor();
      await compare().locator('.hx-mode-side-by-side').first().waitFor();
      await layout.getByRole('button', { name: 'Inline' }).click();
      await compare().locator('.hx-mode-inline').first().waitFor();
      await layout.getByRole('button', { name: 'Inline' }).and(p.locator('[aria-pressed="true"]')).waitFor();
    });
    await s.step('Jump to a change: pick a section, then step with J and K', async () => {
      const nav = compare().getByRole('navigation', { name: 'Jump to a change' });
      const bold = async (name) => p.waitForFunction((n) => {
        const nv = document.querySelector('[aria-label="Jump to a change"]');
        const b = [...nv.querySelectorAll('button')].find((x) => x.textContent.includes(n));
        return b && b.getAttribute('aria-current') === 'true'; // the current change is the marked item
      }, name);
      await nav.getByRole('button', { name: /Security/ }).click();
      await bold('Security');
      await p.keyboard.press('k'); // the change listed before the Security heading (the old trailing paragraph)
      await bold('Paragraph 4');
      await p.keyboard.press('j');
      await bold('Security');
      await nav.getByRole('button', { name: /Storage/ }).click();
      await bold('Storage');
    });
    await s.step('the version pickers change the pair that is compared', async () => {
      await compare().getByRole('combobox', { name: 'From version' }).selectOption('2');
      await compare().getByTestId('hx-counts').filter({ hasText: /\b0 added/ }).waitFor();
      await compare().getByText(/REST and GraphQL\./).first().waitFor();
      // no block is added or removed between v2 and v3 (the Security section exists in both)
      await compare().getByTestId('hx-counts').filter({ hasText: /\b0 removed/ }).waitFor();
      await compare().getByRole('button', { name: 'Restore v2' }).waitFor();
    });
    await s.step('Back to page returns to the list; View on a row shows what that version changed', async () => {
      await compare().getByRole('button', { name: 'Back to page' }).click();
      await compare().waitFor({ state: 'detached' });
      const row = drawer().locator('.hd-row').filter({ hasText: 'Switch storage' });
      await row.hover();
      await row.getByRole('button', { name: 'View' }).click();
      await compare().getByText(/PostgreSQL/).first().waitFor();
      await compare().getByRole('combobox', { name: 'From version' }).waitFor();
      await p.keyboard.press('Escape');
      await compare().waitFor({ state: 'detached' });
    });

    // ---- search palette and results page ----
    await s.step('Ctrl+K: search finds the pages that mention a word', async () => {
      const box = await openPalette();
      await box.fill('postgresql');
      await palette().getByRole('option', { name: /Architecture/ }).waitFor();
      await palette().getByRole('option', { name: /Runbook/ }).waitFor();
    });
    await s.step('a word with a minus sign hides pages; "Show them" brings them back', async () => {
      const box = palette().getByRole('combobox');
      await box.fill('postgresql -backups');
      await palette().getByText(/Hiding 1 page that contain/).waitFor();
      await palette().getByRole('option', { name: /Runbook/ }).waitFor({ state: 'detached' });
      await palette().getByRole('button', { name: 'Show them' }).click();
      await palette().getByRole('option', { name: /Runbook/ }).waitFor();
    });
    await s.step('scope buttons switch to tickets', async () => {
      await palette().getByRole('button', { name: 'Tickets' }).click();
      await palette().getByRole('button', { name: 'Tickets' }).and(p.locator('[aria-pressed="true"]')).waitFor();
      await palette().getByRole('combobox').fill('rollout');
      await palette().getByRole('option', { name: /ALP-1/ }).waitFor();
    });
    await s.step('the syntax help opens with ?, and its link opens the reference cheat sheet', async () => {
      const box = palette().getByRole('combobox');
      await box.fill('');
      await box.press('?');
      await palette().getByText('Search syntax').waitFor();
      await palette().getByRole('button', { name: /Linking syntax/ }).click();
      await p.getByRole('dialog', { name: 'Reference syntax' }).waitFor();
      await p.keyboard.press('Escape');
      await p.getByRole('dialog', { name: 'Reference syntax' }).waitFor({ state: 'detached' });
      await palette().getByRole('combobox').click();
      await p.keyboard.press('Escape');
      await palette().getByText('Search syntax').waitFor({ state: 'detached' });
    });
    await s.step('Ctrl+Enter opens the full results page with the match count', async () => {
      await palette().getByRole('button', { name: 'This space' }).click();
      const box = palette().getByRole('combobox');
      await box.fill('postgresql');
      await palette().getByRole('option', { name: /Architecture/ }).waitFor();
      await p.keyboard.press('Control+Enter');
      await p.getByRole('textbox', { name: 'Search docs' }).waitFor();
      await p.getByText(/in\s+\d+ pages? for/).waitFor();
    });
    await s.step('results page: Search within results narrows the list', async () => {
      const before = await p.getByText(/Showing \d+ of \d+ pages/).innerText();
      await p.getByRole('textbox', { name: 'Search within results' }).fill('backups');
      await p.getByText(/Showing 1 of/).waitFor();
      await p.getByRole('textbox', { name: 'Search within results' }).fill('');
      await p.getByText(before).waitFor();
    });
    await s.step('results page: sort by Recently edited, then back to Relevance', async () => {
      await p.getByRole('button', { name: 'Recently edited' }).click();
      await p.getByRole('button', { name: 'Recently edited' }).and(p.locator('.mb-view-btn-active')).waitFor();
      await p.getByRole('button', { name: 'Relevance' }).click();
      await p.getByRole('button', { name: 'Relevance' }).and(p.locator('.mb-view-btn-active')).waitFor();
    });
    await s.step('results page: the Edited filter shows a chip that Remove edited filter clears', async () => {
      await p.getByRole('radio', { name: /Past 24 hours/ }).click();
      await p.getByText('Showing pages edited in the last 24 hours').waitFor();
      await p.getByRole('button', { name: 'Remove edited filter' }).click();
      await p.getByText('Showing pages edited in the last 24 hours').waitFor({ state: 'detached' });
      await p.getByRole('radio', { name: /Custom range/ }).click();
      await p.getByLabel('Edited since').fill('2000-01-01');
      await p.getByText('Showing pages edited since the chosen date').waitFor();
      await p.getByRole('button', { name: 'Remove edited filter' }).click();
    });
    await s.step('results page: Page tree location limits the search to a page and what is below it', async () => {
      await p.getByRole('combobox', { name: 'Page tree location' }).selectOption({ label: 'Runbook' });
      await p.getByText(/Showing 1 of 1 pages/).waitFor();
      await p.getByRole('combobox', { name: 'Page tree location' }).selectOption({ label: 'Anywhere in space' });
      await p.getByText(/Showing [2-9] of/).waitFor();
    });
    await s.step('results page: Only pages that link a ticket, then Clear all', async () => {
      await p.getByRole('switch', { name: 'Only pages that link a ticket' }).click();
      await p.getByText(/Showing 1 of 1 pages/).waitFor();
      await p.getByRole('button', { name: 'Clear all' }).click();
      await p.getByRole('switch', { name: 'Only pages that link a ticket' }).and(p.locator('[aria-checked="false"]')).waitFor();
      await p.getByText(/Showing [2-9] of/).waitFor();
    });
    await s.step('results page: the Author filter keeps only the pages a person last edited', async () => {
      const grace = p.getByRole('checkbox', { name: /Grace Hopper/ });
      await grace.click();
      await p.getByText(/Showing 1 of 1 pages/).waitFor();
      await grace.and(p.locator('[aria-checked="true"]')).waitFor();
      await grace.click();
      await p.getByText(/Showing [2-9] of/).waitFor();
    });
    await s.step('results page: the Status filter hides the published pages; Clear all brings them back', async () => {
      await p.getByRole('checkbox', { name: /^Published/ }).click();
      // the never-published Scratch page is found by its draft (saving a draft used to leave the index empty for it)
      await p.getByText(/Showing 1 of 1 pages/).waitFor();
      await p.getByRole('link', { name: 'Scratch', exact: true }).waitFor();
      await p.getByRole('button', { name: 'Clear all' }).click();
      await p.getByText(/Showing [2-9] of/).waitFor();
    });
    await s.step('results page: the scope menu searches tickets and all projects', async () => {
      await p.getByRole('combobox', { name: 'Search scope' }).selectOption('tickets');
      await p.getByRole('textbox', { name: 'Search docs' }).fill('rollout');
      await p.getByRole('textbox', { name: 'Search docs' }).press('Enter');
      await p.getByRole('link', { name: /ALP-1/ }).waitFor();
      await p.getByRole('combobox', { name: 'Search scope' }).selectOption('all');
      await p.getByRole('combobox', { name: 'Search scope' }).selectOption('space');
    });
    await s.step('results page: Clear search empties the field; a new search and a click open the page', async () => {
      await p.getByRole('button', { name: 'Clear search' }).click();
      await p.getByText('Type to search pages, headings and tickets').waitFor();
      await p.getByRole('textbox', { name: 'Search docs' }).fill('graphql');
      await p.getByRole('button', { name: 'Search', exact: true }).click();
      await p.getByRole('link').filter({ hasText: 'GraphQL' }).first().click();
      await p.getByTestId('page-title').filter({ hasText: 'Architecture' }).waitFor();
    });

    // ---- references, hover cards and the side panel ----
    await s.step('Runbook shows chips for the page, the section, the ticket and the section that is gone', async () => {
      await item('Runbook').click();
      await p.getByTestId('page-title').filter({ hasText: 'Runbook' }).waitFor();
      await p.getByTestId('ref-ticket-ALP-1').waitFor();
      await p.getByTestId('ref-section-missing').waitFor();
      await p.getByTestId('ref-page').first().waitFor();
    });
    await s.step('hovering a page chip shows a preview card; "Open in side panel" opens the Doc preview', async () => {
      await p.getByTestId('ref-page').first().hover();
      await p.getByRole('button', { name: 'Open in side panel' }).click();
      await p.getByRole('complementary', { name: 'Doc preview' }).waitFor();
      await p.getByTestId('peek-body').getByText('The API speaks REST and GraphQL.').waitFor();
    });
    await s.step('Close panel closes the side panel', async () => {
      const panel = p.getByRole('complementary', { name: 'Doc preview' });
      await panel.getByRole('button', { name: 'Close panel' }).click();
      await panel.waitFor({ state: 'detached' });
    });
    await s.step('the chip of a gone section explains it in its card', async () => {
      // the page keeps shifting under the pointer while it settles after the side panel closed, so a pointer hover is
      // unreliable here: the chip opens the same card when it gets the keyboard focus
      await p.getByTestId('ref-section-missing').focus();
      await p.locator('[aria-label^="Preview of"]').getByText(/Gone/).first().waitFor();
    });
    await s.step('Referenced by lists the pages that link here; the button collapses and expands it', async () => {
      await item('Architecture').click();
      const refs = p.getByRole('region', { name: 'Referenced by' });
      await refs.getByText('Runbook').first().waitFor();
      await refs.getByRole('button', { name: 'Collapse' }).click();
      await refs.getByText('Runbook').first().waitFor({ state: 'detached' });
      await refs.getByRole('button', { name: 'Expand' }).click();
      await refs.getByText('Runbook').first().waitFor();
    });
    await s.step('On this page jumps to a heading; Copy code copies the block; Find steps back with Previous match', async () => {
      const toc = p.getByRole('navigation', { name: 'On this page' });
      await toc.getByText('Security').first().click();
      await p.getByRole('button', { name: 'Copy code' }).first().click();
      await p.getByText('Copied').first().waitFor();
      const clip = await p.evaluate(() => navigator.clipboard.readText());
      if (!clip.includes('const answer = 42;')) throw new Error('clipboard: ' + clip);
      await p.keyboard.press('Control+f');
      const bar = p.getByRole('search', { name: 'Find in page' });
      await bar.getByRole('textbox', { name: 'Find' }).fill('API');
      await bar.getByText(/1\/\d/).waitFor();
      await bar.getByRole('button', { name: 'Previous match' }).click();
      await bar.getByText(/^[2-9]\/\d/).waitFor();
      await bar.getByRole('button', { name: 'Close' }).click();
    });

    // ---- the editor: references, bubble toolbar, tables, blocks, files ----
    const toolbar = () => p.getByRole('toolbar', { name: 'Formatting' });
    const refMenu = () => p.getByRole('listbox', { name: 'Link a page or ticket' });
    const source = () => getMarkdown(s); // the editor has no Markdown pane: read what it would write
    await s.step('typing [[ in the editor suggests pages; Tab completes one, # lists its sections, Enter inserts', async () => {
      await item('Runbook').click();
      await newDocPage(s, 'Deploy guide', { parent: 'Runbook' });
      await content().click();
      await p.keyboard.type('Deploy PostgreSQL first, see [[Arch');
      await refMenu().waitFor();
      await refMenu().getByRole('option', { name: /Architecture/ }).first().waitFor();
      await p.keyboard.press('Tab');
      await p.keyboard.type('Sto'); // Tab already added the #
      await refMenu().getByRole('option', { name: /Storage/ }).first().waitFor();
      await refMenu().getByRole('option', { name: /Storage/ }).first().click();
      await refMenu().waitFor({ state: 'detached' });
    });
    await s.step('typing a ticket key suggests tickets', async () => {
      await p.keyboard.type(' and ALP-');
      await refMenu().getByRole('option', { name: /ALP-1/ }).first().waitFor();
      await p.keyboard.press('Enter');
      await refMenu().waitFor({ state: 'detached' });
      await saved();
      const md = await source();
      if (!md.includes('[[Architecture#Storage]]') || !md.includes('ALP-1')) throw new Error('the Markdown source lacks the references: ' + md);
    });
    await s.step('Syntax help in the suggester opens the reference cheat sheet', async () => {
      await content().click();
      await p.keyboard.press('Control+End');
      await p.keyboard.type(' [[');
      await refMenu().waitFor();
      await refMenu().getByRole('button', { name: 'Syntax help' }).click();
      await p.getByRole('dialog', { name: 'Reference syntax' }).waitFor();
      await p.keyboard.press('Escape');
      await p.getByRole('dialog', { name: 'Reference syntax' }).waitFor({ state: 'detached' });
      await content().click();
      await p.keyboard.press('Escape');
      await refMenu().waitFor({ state: 'detached' });
      await p.keyboard.press('Backspace');
      await p.keyboard.press('Backspace');
    });
    await s.step('bubble toolbar: select a line, make it bold, then link it', async () => {
      await p.keyboard.press('Control+End');
      await p.keyboard.press('Enter');
      await p.keyboard.type('Read the deploy notes');
      await p.keyboard.press('Shift+Home');
      const bubble = p.getByTestId('bubble-toolbar');
      await bubble.waitFor();
      await bubble.getByRole('button', { name: 'Bold' }).click();
      await content().locator('strong', { hasText: 'Read the deploy notes' }).waitFor();
      await bubble.getByRole('button', { name: 'Link' }).click();
      await bubble.getByRole('textbox', { name: 'Link URL' }).fill('example.com/deploy');
      await bubble.getByRole('textbox', { name: 'Link URL' }).press('Enter');
      await content().locator('a[href*="example.com/deploy"]').filter({ hasText: 'Read the deploy notes' }).waitFor();
      await saved();
    });
    await s.step('bubble toolbar: the link field can be cancelled', async () => {
      await content().locator('a[href*="example.com/deploy"]').dblclick();
      await p.keyboard.press('Control+k');
      const input = p.getByRole('textbox', { name: 'Link URL' });
      await input.waitFor();
      await p.getByTestId('bubble-toolbar').getByRole('button', { name: 'Cancel' }).click();
      await input.waitFor({ state: 'detached' });
    });
    await s.step('publish Deploy guide: its references show as chips', async () => {
      await publishDoc(s, 'Deploy guide');
      await p.getByText('Published · v1').waitFor();
      await p.getByTestId('ref-page').first().waitFor();
      await p.getByTestId('ref-ticket-ALP-1').waitFor();
      await p.locator('a[href*="example.com/deploy"]').waitFor();
    });
    await s.step('the draft page: Add block inserts a slash line and opens the Insert block menu', async () => {
      await tree().getByRole('treeitem', { name: /Scratch/ }).first().click();
      await p.getByRole('button', { name: 'Continue editing' }).click();
      const visual = p.getByRole('button', { name: 'Visual', exact: true });
      if (await visual.count()) await visual.click();
      await content().getByText('Second paragraph.').hover();
      await p.getByRole('button', { name: 'Add block' }).click();
      await p.getByRole('listbox', { name: 'Insert block' }).waitFor();
      await p.keyboard.press('Escape');
      await p.getByRole('listbox', { name: 'Insert block' }).waitFor({ state: 'detached' });
    });
    await s.step('Drag to move: dragging a paragraph by its grip reorders the blocks', async () => {
      const first = content().getByText('PostgreSQL scratch notes.');
      await first.hover();
      const grip = p.getByRole('button', { name: 'Drag to move' });
      const g = await grip.boundingBox();
      const target = await content().getByText('Second paragraph.').boundingBox();
      await p.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
      await p.mouse.down();
      await p.mouse.move(g.x + g.width / 2, g.y + 20, { steps: 5 });
      await p.mouse.move(target.x + 20, target.y + target.height + 14, { steps: 12 });
      await p.mouse.up();
      await p.waitForFunction(() => {
        const t = document.querySelector('[aria-label="Page content"]')?.innerText ?? '';
        return t.indexOf('Second paragraph.') >= 0 && t.indexOf('Second paragraph.') < t.indexOf('PostgreSQL scratch notes.');
      });
      await saved();
    });
    await s.step('table controls: select a row, add a row below, delete it; Header row from Table properties', async () => {
      const table = content().locator('table');
      await table.locator('td').first().click(); // the grips belong to the cell with the caret
      await p.getByRole('button', { name: 'Select row 2' }).click();
      const cells = p.getByTestId('cell-toolbar');
      await cells.waitFor();
      await cells.getByRole('button', { name: 'Add row below' }).click();
      await p.waitForFunction(() => document.querySelector('[aria-label="Page content"] table').rows.length === 4);
      await cells.getByRole('button', { name: 'Delete row' }).click();
      await p.waitForFunction(() => document.querySelector('[aria-label="Page content"] table').rows.length === 3);
      // the Header row switch lives in Table properties (board F 31), not in the cell toolbar
      await table.locator('td').first().click();
      const heads = await table.locator('th').count();
      await p.getByRole('button', { name: 'Table properties' }).click();
      const props = p.getByTestId('table-props');
      await props.getByRole('switch', { name: 'Header row' }).click({ force: true });
      await p.waitForFunction((n) => document.querySelectorAll('[aria-label="Page content"] table th').length !== n, heads);
      await props.getByRole('button', { name: 'Done' }).click();
      await props.waitFor({ state: 'detached' });
    });
    await s.step('table controls: select a column, add one to the right, then delete the table', async () => {
      const table = content().locator('table');
      await table.locator('td').first().click(); // the grips belong to the cell with the caret
      await p.getByRole('button', { name: 'Select column 1' }).click();
      const cells = p.getByTestId('cell-toolbar');
      await cells.getByRole('button', { name: 'Add column right' }).click();
      await p.waitForFunction(() => document.querySelector('[aria-label="Page content"] table').rows[0].cells.length === 3);
      // Delete table is in Table properties, at the foot of the panel
      await table.locator('td').first().click();
      await p.getByRole('button', { name: 'Table properties' }).click();
      await p.getByTestId('table-props').getByRole('button', { name: 'Delete table' }).click();
      await table.waitFor({ state: 'detached' });
      await saved();
    });
    await s.step('toolbar: Image uploads a picture, Attach a file inserts a card of the upload', async () => {
      await content().click();
      await p.keyboard.press('Control+End');
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const [pic] = await Promise.all([p.waitForEvent('filechooser'), toolbar().getByRole('button', { name: 'Image', exact: true }).click()]);
      await pic.setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
      await content().locator('img').first().waitFor();
      const attach = toolbar().getByRole('button', { name: /^Attach a file/ });
      const [f] = await Promise.all([p.waitForEvent('filechooser'), attach.click()]);
      await f.setFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('some notes') });
      // the rich editor puts an attached file in as a file card that names it
      await content().getByTestId('file-block').filter({ hasText: 'notes.txt' }).waitFor();
      await saved();
    });

    // ---- hover cards and the side panel from a ticket ----
    await s.step('a ticket description with page references shows pills', async () => {
      await p.getByRole('button', { name: 'Board', exact: true }).click();
      const dlg = await openTicket(s, 'ALP-1');
      await dlg.getByRole('button', { name: 'Edit description' }).click();
      await dlg.locator('[contenteditable="true"]').first().click();
      await p.keyboard.type('Design in [[Architecture]] and see [[Architecture#Gone]].');
      await dlg.getByRole('heading', { name: 'Plan the rollout' }).click();
      await dlg.getByTestId('ref-page').first().waitFor({ timeout: 15000 });
      await dlg.getByTestId('ref-section-missing').waitFor();
    });
    await s.step('a pill in a ticket: the hover card opens the page in the side panel', async () => {
      const dlg = p.getByRole('dialog', { name: /^Ticket / });
      await dlg.getByTestId('ref-page').first().hover();
      await p.getByTestId('card-open-panel').click();
      const panel = p.getByRole('complementary', { name: 'Doc preview' });
      await panel.waitFor();
      await panel.getByTestId('peek-body').getByText('Tokens expire daily.').waitFor();
      await panel.getByRole('button', { name: 'Close panel' }).click();
      await panel.waitFor({ state: 'detached' });
    });
    await s.step('a pill with a gone section opens the panel with a notice; Show page top dismisses it', async () => {
      const dlg = p.getByRole('dialog', { name: /^Ticket / });
      await dlg.getByTestId('ref-section-missing').click();
      const panel = p.getByRole('complementary', { name: 'Doc preview' });
      await panel.getByTestId('peek-section-missing').getByText(/was renamed or removed/).waitFor();
      await panel.getByRole('button', { name: 'Show page top' }).click();
      await panel.getByTestId('peek-section-missing').waitFor({ state: 'detached' });
      await panel.getByTestId('peek-open-docs').click();
      await p.getByTestId('page-title').filter({ hasText: 'Architecture' }).waitFor();
    });
  },
};
