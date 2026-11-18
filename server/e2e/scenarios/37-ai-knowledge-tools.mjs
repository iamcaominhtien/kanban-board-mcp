import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { home, ensureProject, createTicket, dragCard } from '../lib/ui.mjs';

export default {
  name: 'AI knowledge and tools: knowledge base, memory, role packs, plugins',
  group: 'ai',
  soft: !!process.env.E2E_SOFT,
  async run(s) {
    const p = s.page;
    const TEAM = 'Backend team';
    const root = s.server.dirs.root;
    const until = async (fn, what, ms = 15000) => {
      const t0 = Date.now();
      for (;;) {
        try { if (await fn()) return; } catch { /* look again */ }
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await p.waitForTimeout(150);
      }
    };
    const api = async (method, url, body) => {
      const res = await fetch(`${s.server.base}${url}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, json, text };
    };
    const ids = {};
    const loadIds = async () => {
      const pr = await api('GET', '/projects');
      ids.project = (Array.isArray(pr.json) ? pr.json : pr.json.projects)[0].id;
    };
    const nav = () => p.getByRole('navigation', { name: 'Settings pages' });
    const settingsAi = async () => {
      await home(s);
      await p.getByRole('button', { name: 'Settings' }).click();
      await nav().getByRole('button', { name: 'AI', exact: true }).click();
      await p.getByRole('heading', { name: 'AI', level: 1 }).waitFor();
    };
    const memoryTab = async (tab) => {
      await settingsAi();
      const mem = p.getByRole('region', { name: 'Memory' });
      await mem.getByRole('tab', { name: tab }).click();
      return mem;
    };

    await s.step('set up: a project, a repository, a team', async () => {
      s.server.signIn();
      await ensureProject(s);
      await createTicket(s, { title: 'Fix add' });
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('heading', { name: 'Repositories', level: 1 }).waitFor();
      await p.getByRole('textbox', { name: 'Repository path' }).fill(s.server.dirs.repo);
      await p.getByRole('button', { name: 'Apply' }).click();
      await p.getByText('Repository linked').first().waitFor();
      await p.getByRole('button', { name: 'Back to board' }).click();
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
      await loadIds();
      // the team: Members page > AI teams > Set up a team
      await p.getByRole('button', { name: /^Members/ }).first().click();
      await p.getByRole('button', { name: /^AI( \d+)?$/ }).click();
      await p.getByRole('button', { name: /Add AI team/ }).first().click();
      const d = p.getByRole('dialog', { name: 'Add AI team' });
      await d.getByRole('textbox', { name: 'Name' }).fill(TEAM);
      await d.getByRole('textbox', { name: /Working folder/ }).fill(s.server.dirs.repo);
      await d.getByRole('button', { name: 'Add team' }).click();
      await p.getByRole('heading', { name: TEAM, level: 1 }).waitFor();
    });

    // ------------------------------------------------------------------ knowledge base
    const kbDocs = async () => (await api('GET', `/projects/${ids.project}/ai/kb`)).json;
    // every document the project can see, from the server: [{id, title, store, ...}]
    const kbDocsList = async (shared = false) => {
      const l = await kbDocs();
      return [...(l.documents ?? []), ...(shared ? l.shared_documents ?? l.sharedDocuments ?? [] : [])];
    };
    const kbRow = (kb, title) => kb.getByTestId('kb-row').filter({ hasText: title });

    await s.step('Knowledge base: empty, then a pasted text and a file are added', async () => {
      const mem = await memoryTab('Knowledge base');
      await mem.getByTestId('kb-empty').waitFor();
      await mem.getByRole('button', { name: 'Add files' }).click();
      const form = mem.getByTestId('kb-add');
      await form.getByRole('button', { name: 'Add', exact: true }).and(p.locator(':disabled')).waitFor();
      await form.getByRole('textbox', { name: 'Text to add' }).fill('Releases are cut on Thursday. To roll back a release run the rollback script first, then tell the team.');
      await form.getByRole('textbox', { name: 'Title' }).fill('Release checklist');
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      await form.waitFor({ state: 'detached' });
      await kbRow(mem, 'Release checklist').waitFor();
      const file = path.join(root, 'deploy-notes.md');
      fs.writeFileSync(file, '# Deploy notes\n\nThe staging database is reset every night. Use the canary flag for risky migrations.\n');
      await mem.getByRole('button', { name: 'Add files' }).click();
      await mem.getByTestId('kb-file').setInputFiles(file);
      await form.getByText('deploy-notes.md').first().waitFor();
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      await form.waitFor({ state: 'detached' });
      await kbRow(mem, 'deploy-notes.md').waitFor();
      await mem.getByRole('tab', { name: /^This project 2/ }).waitFor();
      const l = await kbDocs();
      if ((l.documents ?? []).length !== 2) throw new Error(`the server lists ${(l.documents ?? []).length} documents, not 2`);
    });

    await s.step('Knowledge base: search as the AIs do marks the match, and says when nothing is found', async () => {
      const mem = await memoryTab('Knowledge base');
      await mem.getByRole('button', { name: 'Search', exact: true }).and(p.locator(':disabled')).waitFor();
      await mem.getByRole('textbox', { name: 'Search the knowledge base' }).fill('rollback');
      await mem.getByRole('button', { name: 'Search', exact: true }).click();
      const hit = mem.getByTestId('kb-hit');
      await hit.first().waitFor();
      await hit.first().getByText('Release checklist').waitFor();
      await hit.first().getByText(/from the project store · score/).waitFor();
      await hit.first().locator('mark').first().waitFor();
      if ((await hit.count()) !== 1) throw new Error('the search for rollback must find the one document that says it');
      await mem.getByRole('textbox', { name: 'Search the knowledge base' }).fill('zebra');
      await mem.getByRole('textbox', { name: 'Search the knowledge base' }).press('Enter');
      await mem.getByText('Nothing found for “zebra”.').waitFor();
      await mem.getByRole('textbox', { name: 'Search the knowledge base' }).fill('');
      await mem.getByTestId('kb-results').waitFor({ state: 'detached' });
    });

    await s.step('Knowledge base: a document opens, goes private, shared and back, and is deleted', async () => {
      const mem = await memoryTab('Knowledge base');
      const row = kbRow(mem, 'deploy-notes.md');
      await row.getByRole('button', { name: 'Open deploy-notes.md' }).click();
      const pane = row.getByTestId('kb-detail');
      await pane.getByText(/Deploy notes/).first().waitFor();
      await pane.getByText(/Source: deploy-notes\.md/).waitFor();
      await row.getByText(/added \d+ \w+ · not read yet/).waitFor();
      // private: it cannot go to the shared store any more
      await pane.getByRole('button', { name: 'Make it private' }).click();
      await row.getByText(/· private/).waitFor();
      await pane.getByRole('button', { name: 'Move to the shared store' }).and(p.locator(':disabled')).waitFor();
      await until(async () => (await api('GET', `/ai/kb/${(await kbDocsList()).find((d) => d.title === 'deploy-notes.md').id}`)).json.private === true, 'the document private on the server');
      await pane.getByRole('button', { name: 'Make it visible' }).click();
      await row.getByText(/· private/).waitFor({ state: 'detached' });
      // the shared store is off for this project: the add form has no such store until it is turned on
      await mem.getByRole('tab', { name: /^Shared 0/ }).click();
      await mem.getByTestId('kb-shared-off').waitFor();
      await mem.getByRole('button', { name: 'Search the shared store too' }).click();
      await mem.getByText('+ shared store').waitFor();
      await mem.getByRole('tab', { name: /^This project/ }).click();
      await row.getByRole('button', { name: 'Open deploy-notes.md' }).or(row.getByRole('button', { name: 'Close deploy-notes.md' })).first().waitFor();
      if (await row.getByTestId('kb-detail').count() === 0) await row.getByRole('button', { name: 'Open deploy-notes.md' }).click();
      await row.getByRole('button', { name: 'Move to the shared store' }).click();
      const ask = row.getByRole('alertdialog');
      await ask.getByText('Move “deploy-notes.md” to the shared store?').waitFor();
      await ask.getByRole('button', { name: 'Keep it here' }).click();
      await ask.waitFor({ state: 'detached' });
      await row.getByRole('button', { name: 'Move to the shared store' }).click();
      await ask.getByRole('button', { name: 'Move to the shared store' }).click();
      await row.waitFor({ state: 'detached' });
      await mem.getByRole('tab', { name: /^Shared 1/ }).click();
      const shared = kbRow(mem, 'deploy-notes.md');
      await shared.getByText('in the shared store').waitFor();
      await until(async () => (await kbDocsList(true)).some((d) => d.title === 'deploy-notes.md' && d.store === 'shared'), 'the document in the shared store');
      await shared.getByRole('button', { name: 'Open deploy-notes.md' }).click();
      await shared.getByRole('button', { name: 'Move back to this project' }).click();
      await shared.waitFor({ state: 'detached' });
      await mem.getByRole('tab', { name: /^This project 2/ }).click();
      // delete asks first; the open document must not be asked for again once it is gone (that was a 404)
      const refused = [];
      const watch = (r) => { if (r.status() >= 400 && /\/ai\/kb\//.test(r.url())) refused.push(`${r.status()} ${r.url()}`); };
      p.on('response', watch);
      const rel = kbRow(mem, 'Release checklist');
      await rel.getByRole('button', { name: 'Open Release checklist' }).click();
      await rel.getByRole('button', { name: 'Delete', exact: true }).click();
      const del = rel.getByRole('alertdialog');
      await del.getByText('Delete “Release checklist”?').waitFor();
      await del.getByRole('button', { name: 'Keep it' }).click();
      await del.waitFor({ state: 'detached' });
      await rel.getByRole('button', { name: 'Delete', exact: true }).click();
      await del.getByRole('button', { name: 'Delete', exact: true }).click();
      await rel.waitFor({ state: 'detached' });
      await until(async () => !(await kbDocsList()).some((d) => d.title === 'Release checklist'), 'the document deleted on the server');
      await p.waitForTimeout(600);
      p.off('response', watch);
      if (refused.length) throw new Error(`the deleted document was asked for again: ${refused.join(', ')}`);
      await mem.getByRole('tab', { name: /^This project 1/ }).waitFor();
    });

    await s.step('Knowledge base: the table of contents lists what is left', async () => {
      const mem = await memoryTab('Knowledge base');
      await mem.getByRole('tab', { name: 'Table of contents' }).click();
      const toc = mem.getByTestId('kb-toc');
      await toc.getByRole('columnheader', { name: 'Who sees it' }).waitFor();
      const row = toc.getByTestId('kb-row').filter({ hasText: 'deploy-notes.md' });
      await row.getByText("This project's people and AIs").waitFor();
      await row.getByRole('button', { name: 'Open deploy-notes.md' }).click();
      await toc.getByTestId('kb-detail').waitFor();
      await row.getByRole('button', { name: 'Close deploy-notes.md' }).click();
      await toc.getByTestId('kb-detail').waitFor({ state: 'detached' });
    });

    // ------------------------------------------------------------------ memory: lessons and notes
    const knowledge = async () => (await api('GET', `/projects/${ids.project}/ai/knowledge`)).json;

    await s.step('Memory: a lesson is written, edited and deleted', async () => {
      const mem = await memoryTab(/^Memory/);
      await mem.getByTestId('lessons-empty').waitFor();
      await mem.getByTestId('lesson-add').click();
      await mem.getByTestId('lesson-editor').fill('Never push to main.');
      await mem.getByTestId('lesson-editor-save').click();
      const lesson = mem.getByTestId('lesson').filter({ hasText: 'Never push to main.' });
      await lesson.waitFor();
      await mem.getByTestId('memory-count').filter({ hasText: /^1$/ }).waitFor();
      await lesson.getByRole('button', { name: 'Edit' }).click();
      // the text is in the editor now, so the row is found by it
      const editing = mem.getByTestId('lesson').filter({ has: p.getByTestId('lesson-editor') });
      await editing.getByTestId('lesson-editor-save').and(p.locator(':disabled')).waitFor();
      await editing.getByTestId('lesson-editor').fill('Never push to main; open a pull request.');
      await editing.getByTestId('lesson-editor-save').click();
      await mem.getByText('Never push to main; open a pull request.').waitFor();
      await until(async () => (await knowledge()).lessons.some((l) => l.text === 'Never push to main; open a pull request.'), 'the edited lesson on the server');
      // Cancel leaves it as it was
      await mem.getByTestId('lesson').getByRole('button', { name: 'Edit' }).click();
      await mem.getByTestId('lesson-editor').fill('x');
      await editing.getByRole('button', { name: 'Cancel' }).click();
      await mem.getByText('Never push to main; open a pull request.').waitFor();
      await mem.getByTestId('lesson-delete').click();
      await mem.getByTestId('lessons-empty').waitFor();
      await until(async () => (await knowledge()).lessons.length === 0, 'the lesson gone from the server');
    });

    await s.step('Memory: notes the AIs keep are edited and deleted (no screen writes a new one)', async () => {
      // POST /projects/:id/ai/notes has no screen (useAddNote has no caller): the notes are written through the API the
      // way an AI writes them, then the screen is what edits and deletes them.
      const teams = (await api('GET', `/projects/${ids.project}/ai/teams`)).json;
      const team = (Array.isArray(teams) ? teams : teams.teams)[0];
      const tickets = (await api('GET', `/projects/${ids.project}/tickets`)).json;
      const ticket = (Array.isArray(tickets) ? tickets : tickets.tickets)[0];
      ids.team = team.id;
      ids.ticket = ticket.id;
      for (const n of [
        { text: 'Dev: keep functions small.', scope: 'role', scope_key: 'dev', kind: 'learned' },
        { text: 'Always run the tests before saying done.', scope: 'role', scope_key: 'dev', kind: 'feedback' },
        { text: 'The layout is described in src/no_such_module/README.md', scope: 'ticket', scope_key: ticket.id, kind: 'learned' },
      ]) {
        const r = await api('POST', `/projects/${ids.project}/ai/notes`, n);
        if (r.status !== 201) throw new Error(`POST notes answered ${r.status}: ${r.text}`);
      }
      const mem = await memoryTab(/^Memory/);
      await mem.getByTestId('notes-count').filter({ hasText: /^3$/ }).waitFor();
      const groups = mem.getByTestId('notes-group');
      await groups.filter({ hasText: 'Role notes' }).getByText('2 of').waitFor();
      await groups.filter({ hasText: 'Ticket notes' }).waitFor();
      const fb = mem.getByTestId('memory-note').filter({ hasText: 'Always run the tests' });
      await fb.getByTestId('note-feedback').waitFor();
      await mem.getByTestId('memory-flag').first().waitFor();
      // edit the note: Save is off until the text changes
      const note = mem.getByTestId('memory-note').filter({ hasText: 'Dev: keep functions small.' });
      await note.getByRole('button', { name: 'Edit' }).click();
      const open = mem.getByTestId('memory-note').filter({ has: p.getByTestId('note-editor') });
      await open.getByRole('button', { name: 'Save' }).and(p.locator(':disabled')).waitFor();
      await open.getByTestId('note-editor').fill('Dev: keep functions under 30 lines.');
      await open.getByRole('button', { name: 'Save' }).click();
      await mem.getByText('Dev: keep functions under 30 lines.').waitFor();
      await until(async () => (await knowledge()).notes.some((n) => n.text === 'Dev: keep functions under 30 lines.'), 'the edited note on the server');
      await mem.getByTestId('memory-note').filter({ hasText: 'under 30 lines' }).getByRole('button', { name: 'Edit' }).click();
      await mem.getByRole('button', { name: 'Cancel' }).click();
      // delete
      await mem.getByTestId('memory-note').filter({ hasText: 'under 30 lines' }).getByTestId('note-delete').click();
      await mem.getByText('Dev: keep functions under 30 lines.').waitFor({ state: 'detached' });
      await mem.getByTestId('notes-count').filter({ hasText: /^2$/ }).waitFor();
      await until(async () => (await knowledge()).notes.length === 2, 'two notes on the server');
    });

    await s.step('Memory: lessons the AIs propose wait for a person (the automatic keeping is turned off)', async () => {
      const mem = await memoryTab(/^Memory/);
      const sw = mem.getByRole('switch', { name: 'Keep the lessons the AIs propose without asking me' });
      await sw.and(p.locator('[aria-checked="true"]')).waitFor();
      await sw.click();
      await sw.and(p.locator('[aria-checked="false"]')).waitFor();
      await until(async () => (await api('GET', `/projects/${ids.project}/ai/settings`)).json.lessons_mode === 'review', 'lessons_mode review on the server');
      await mem.getByRole('spinbutton', { name: "Most kept lessons in a run's prompt" }).fill('5');
      await mem.getByRole('spinbutton', { name: "Most kept lessons in a run's prompt" }).blur();
      await until(async () => (await api('GET', `/projects/${ids.project}/ai/settings`)).json.lessons_max === 5, 'lessons_max 5 on the server');
    });

    // ------------------------------------------------------------------ role packs
    const packRegion = () => p.getByRole('region', { name: 'Role packs' });
    const packsPage = async () => {
      await settingsAi();
      return packRegion();
    };
    const packsOnServer = async () => (await api('GET', `/projects/${ids.project}/ai/packs`)).json;

    await s.step('Role packs: add a role; the dialog checks the name and the key first', async () => {
      const reg = await packsPage();
      await reg.getByTestId('pack-add').click();
      const d = p.getByRole('dialog', { name: 'Add a role' });
      await d.getByTestId('pack-add-go').click();
      await d.getByText('A pack needs a name.').waitFor();
      await d.getByText('A pack needs a key.').waitFor();
      await d.getByRole('textbox', { name: 'Name' }).fill('Release manager');
      await d.getByRole('textbox', { name: 'Key' }).and(p.locator('[value="release_manager"]')).waitFor();
      await d.getByRole('textbox', { name: 'Key' }).fill('dev');
      await d.getByTestId('pack-add-go').click();
      await d.getByText('A role with this key exists already.').waitFor();
      await d.getByRole('textbox', { name: 'Key' }).fill('Bad Key!');
      await d.getByText('Letters, digits and underscores only.').waitFor();
      await d.getByRole('textbox', { name: 'Key' }).fill('release_manager');
      // a copy of the Dev role
      await d.getByRole('radio', { name: 'A copy of' }).click();
      await d.getByRole('combobox', { name: 'Copy of' }).selectOption({ label: 'Dev (TDD)' });
      await d.getByTestId('pack-add-go').click();
      await d.waitFor({ state: 'detached' });
      await p.getByText('Release manager added').waitFor();
      await reg.getByRole('button', { name: 'Role packs ›' }).waitFor();
      await reg.getByRole('textbox', { name: 'Name' }).and(p.locator('[value="Release manager"]')).waitFor();
      const made = (await packsOnServer()).find((x) => x.key === 'release_manager');
      if (!made || made.builtin) throw new Error('the new role is not the project’s own pack on the server');
    });

    await s.step('Role packs: export a role as a file, remove it, import the file back', async () => {
      const reg = await packsPage();
      const row = reg.getByTestId('pack-row-release_manager');
      await row.getByTestId('pack-state-release_manager').filter({ hasText: /^This project’s own · v1$/ }).waitFor();
      await reg.getByTestId('pack-more-release_manager').click();
      await p.getByRole('menuitem', { name: 'Export' }).click();
      const d = p.getByRole('dialog', { name: 'Export Release manager, or import a pack' });
      const card = d.getByTestId('pack-export-card');
      await card.getByText('release-manager.role-pack.json').waitFor();
      await card.getByText(/^kanban-role-pack\/1 · version 1 · /).waitFor();
      const [download] = await Promise.all([p.waitForEvent('download'), d.getByTestId('pack-download').click()]);
      if (download.suggestedFilename() !== 'release-manager.role-pack.json') throw new Error(`the file is named ${download.suggestedFilename()}`);
      const file = path.join(root, 'release-manager.role-pack.json');
      await download.saveAs(file);
      const packFile = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (packFile.format !== 'kanban-role-pack/1') throw new Error('the exported file has no format line');
      // a file that is not a pack, and one that is not JSON
      fs.writeFileSync(path.join(root, 'not-a-pack.json'), '{"format":"something-else"}');
      fs.writeFileSync(path.join(root, 'broken.json'), 'this is not json');
      await d.getByTestId('pack-import-file').setInputFiles(path.join(root, 'not-a-pack.json'));
      await d.getByTestId('pack-import-error').getByText('This is not a role pack file.').waitFor();
      await d.getByTestId('pack-import-file').setInputFiles(path.join(root, 'broken.json'));
      await d.getByTestId('pack-import-error').getByText('This is not a role pack file.').waitFor();
      await d.getByRole('button', { name: 'Close' }).click();
      await d.waitFor({ state: 'detached' });
      // remove the role: asks first, then DELETE
      await reg.getByTestId('pack-more-release_manager').click();
      await p.getByRole('menuitem', { name: 'Remove' }).click();
      const rm = p.getByRole('dialog', { name: 'Remove Release manager?' });
      await rm.getByText('It is this project’s own role; there is no ready-made version to go back to.').waitFor();
      await rm.getByRole('button', { name: 'Keep it' }).click();
      await rm.waitFor({ state: 'detached' });
      await reg.getByTestId('pack-more-release_manager').click();
      await p.getByRole('menuitem', { name: 'Remove' }).click();
      await rm.getByTestId('pack-confirm').click();
      await p.getByText('Release manager removed').waitFor();
      await row.waitFor({ state: 'detached' });
      await until(async () => !(await packsOnServer()).some((x) => x.key === 'release_manager'), 'the role gone from the server');
      // import the file: the role is back, the plugin it names is not on the project
      const withPlugin = JSON.parse(fs.readFileSync(file, 'utf8'));
      const body = withPlugin.pack ?? withPlugin;
      body.plugins = ['not-installed-plugin'];
      fs.writeFileSync(path.join(root, 'release-manager-plugin.role-pack.json'), JSON.stringify(withPlugin));
      await reg.getByTestId('pack-import').click();
      const imp = p.getByRole('dialog', { name: 'Import a pack' });
      await imp.getByTestId('pack-import-file').setInputFiles(path.join(root, 'release-manager-plugin.role-pack.json'));
      await imp.getByTestId('pack-import-result').getByText(/Imported Release manager as version \d+\./).waitFor();
      await imp.getByTestId('pack-import-missing').getByText('not-installed-plugin').waitFor();
      await imp.getByRole('button', { name: 'Close' }).click();
      await reg.getByTestId('pack-row-release_manager').waitFor();
      if (!(await packsOnServer()).some((x) => x.key === 'release_manager')) throw new Error('the imported role is not on the server');
    });

    await s.step('Role packs: an edited ready-made role is put back (Reset to ready-made)', async () => {
      const reg = await packsPage();
      await reg.getByRole('button', { name: 'Dev (TDD)', exact: true }).click();
      await reg.getByRole('textbox', { name: 'Tagline' }).fill('Edited for the reset check');
      await reg.getByRole('button', { name: /^Save as version/ }).click();
      await reg.getByRole('button', { name: 'Role packs ›' }).click();
      await reg.getByTestId('pack-state-dev').filter({ hasText: /^Edited · v\d+$/ }).waitFor();
      await reg.getByText('Edited for the reset check').waitFor();
      await reg.getByTestId('pack-more-dev').click();
      await p.getByRole('menuitem', { name: 'Reset to ready-made' }).click();
      const d = p.getByRole('dialog', { name: 'Put back the ready-made Dev (TDD)?' });
      await d.getByRole('button', { name: 'Keep my edits' }).click();
      await d.waitFor({ state: 'detached' });
      await reg.getByTestId('pack-more-dev').click();
      await p.getByRole('menuitem', { name: 'Reset to ready-made' }).click();
      await d.getByTestId('pack-confirm').click();
      await p.getByText('Ready-made Dev (TDD) is back').waitFor();
      await reg.getByTestId('pack-state-dev').filter({ hasText: /^Ready-made$/ }).waitFor();
      await reg.getByText('Edited for the reset check').waitFor({ state: 'detached' });
    });

    // ------------------------------------------------------------------ plugins
    const PLUGIN = 'release-notes';
    const pluginRepo = path.join(root, 'plugin-src');
    const pgit = (...a) => execFileSync('git', a, { cwd: pluginRepo, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' } }).toString().trim();
    const writeSkill = (name, text) => {
      fs.mkdirSync(path.join(pluginRepo, 'skills', name), { recursive: true });
      fs.writeFileSync(path.join(pluginRepo, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${text}\n---\n\nBody ${name}.\n`);
    };
    const writeManifest = (version) => {
      fs.mkdirSync(path.join(pluginRepo, '.claude-plugin'), { recursive: true });
      fs.writeFileSync(path.join(pluginRepo, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: PLUGIN, version, description: 'Writes release notes' }));
    };
    const pluginsOnServer = async () => (await api('GET', `/projects/${ids.project}/ai/plugins`)).json;
    const pluginRow = async () => (await pluginsOnServer()).find((x) => x.name === PLUGIN);
    const skillsRegion = () => p.getByRole('region', { name: 'Skills & plugins' });
    const skillsPage = async () => {
      await settingsAi();
      return skillsRegion();
    };
    const pluginCard = (reg) => reg.getByTestId(`plugin-${PLUGIN}`);
    const pluginMenu = async (reg, item) => {
      await pluginCard(reg).getByTestId('plugin-more').click();
      await p.getByRole('menuitem', { name: item }).click();
    };

    await s.step('Plugins: install one from a git repository, for the Dev role', async () => {
      fs.mkdirSync(pluginRepo);
      pgit('init', '-q', '-b', 'main');
      writeManifest('1.0.0');
      writeSkill('notes-alpha', 'Write the notes.');
      writeSkill('notes-beta', 'Check the notes.');
      pgit('add', '.');
      pgit('commit', '-q', '-m', 'v1');
      const reg = await skillsPage();
      await reg.getByRole('tab', { name: 'Add from a source' }).click();
      await reg.getByRole('textbox', { name: 'Repository' }).fill(pluginRepo);
      await reg.getByRole('checkbox', { name: 'Dev', exact: true }).check();
      await reg.getByTestId('preview-source').click();
      await reg.getByTestId('install-counts').getByText(/2 skills · 0 hooks · 0 MCP servers/).waitFor();
      await reg.getByTestId('install-preview').getByText(PLUGIN).first().waitFor();
      await reg.getByTestId('no-review').waitFor();
      await reg.getByTestId('install-confirm').click();
      await reg.getByRole('tab', { name: /^Installed 1/ }).waitFor();
      const card = pluginCard(reg);
      await card.getByText('Git URL · 2 skills').waitFor();
      await card.getByTestId('version').getByText(/^v1\.0\.0 · [0-9a-f]{8}$/).waitFor();
      await card.getByTestId('used').getByText('never used').waitFor();
      await card.getByText('On by default: Dev').waitFor();
    });

    await s.step('Plugins: Open shows the skills; "On for every team" and the roles are kept', async () => {
      const reg = await skillsPage();
      const card = pluginCard(reg);
      await card.getByRole('button', { name: 'Open', exact: true }).click();
      const detail = card.getByTestId('plugin-detail');
      await detail.getByText(/2 skills: notes-alpha, notes-beta · 0 hooks · 0 MCP servers/).waitFor();
      await detail.getByRole('switch', { name: 'On for every team' }).click();
      await card.getByText('On by default: every team').waitFor();
      await until(async () => (await pluginRow()).default_on === true, 'On for every team on the server');
      await detail.getByRole('switch', { name: 'On for every team' }).click();
      await card.getByText('On by default: Dev').waitFor();
      await detail.getByRole('button', { name: 'QA' }).click();
      await card.getByText(/On by default: .*QA/).waitFor();
      await detail.getByRole('button', { name: 'Dev (TDD)' }).or(detail.getByRole('button', { name: 'Dev' })).first().click();
      await until(async () => !(await pluginRow()).roles.includes('dev') && (await pluginRow()).roles.includes('qa'), 'the roles on the server');
      await detail.getByRole('button', { name: 'QA' }).click();
      await card.getByText('On by default: nobody').waitFor();
      await detail.getByRole('button', { name: /^Dev/ }).first().click();
      await card.getByText('On by default: Dev').waitFor();
      // the installed list filters
      await reg.getByRole('textbox', { name: 'Search installed' }).fill('zzz');
      await reg.getByTestId('installed-empty').getByText('Nothing matches this search.').waitFor();
      await reg.getByRole('textbox', { name: 'Search installed' }).fill('');
      await reg.getByRole('group', { name: 'Filter' }).getByRole('button', { name: /^Never used 1/ }).click();
      await card.waitFor();
      await reg.getByRole('group', { name: 'Filter' }).getByRole('button', { name: /^All/ }).click();
    });

    await s.step('Plugins: Check for update finds a new commit, shows what changed, updates, rolls back', async () => {
      const reg = await skillsPage();
      const card = pluginCard(reg);
      await pluginMenu(reg, 'Check for update');
      await card.getByText('Up to date.').waitFor();
      // the source moves on: a new skill and a changed one
      writeManifest('1.1.0');
      writeSkill('notes-gamma', 'Publish the notes.');
      writeSkill('notes-alpha', 'Write the notes, shorter.');
      pgit('add', '.');
      pgit('commit', '-q', '-m', 'v1.1');
      await pluginMenu(reg, 'Check for update');
      await card.getByRole('button', { name: 'Update', exact: true }).waitFor();
      await card.getByTestId('version').getByText(/→ [0-9a-f]{40}/).waitFor();
      await card.getByRole('button', { name: 'See what changed' }).click();
      const changes = card.getByTestId('plugin-changes');
      await changes.getByText(/^Changes in [0-9a-f]{8}$/).waitFor();
      await changes.getByText(/^\+ .*notes-gamma/).waitFor();
      await changes.getByText(/^~ .*notes-alpha/).waitFor();
      await card.getByRole('button', { name: 'Update', exact: true }).click();
      await card.getByText('Git URL · 3 skills').waitFor();
      await card.getByTestId('version').getByText(/^v1\.1\.0 · /).waitFor();
      await card.getByRole('button', { name: 'Update', exact: true }).waitFor({ state: 'detached' });
      await until(async () => (await pluginRow()).skills.length === 3, 'three skills on the server');
      await pluginMenu(reg, 'Roll back');
      await card.getByText('Git URL · 2 skills').waitFor();
      await card.getByTestId('version').getByText(/^v1\.0\.0 · /).waitFor();
      await until(async () => (await pluginRow()).skills.length === 2, 'two skills on the server again');
    });

    await s.step('Plugins: Pin stops updates, Unpin brings them back, Reload and Reset re-read the source', async () => {
      const reg = await skillsPage();
      const card = pluginCard(reg);
      await pluginMenu(reg, /^Pin v1\.0\.0/);
      await card.getByText('Pinned', { exact: true }).waitFor();
      await card.getByTestId('version').getByText(/· pinned$/).waitFor();
      await pluginMenu(reg, 'Check for update');
      await card.getByText('Up to date.').waitFor();
      await until(async () => (await pluginRow()).pinned === true, 'the plugin pinned on the server');
      await card.getByRole('button', { name: 'Unpin', exact: true }).click();
      await card.getByText('Pinned', { exact: true }).waitFor({ state: 'detached' });
      // the same commit again: Reload and Reset keep the version
      await pluginMenu(reg, 'Reload');
      await card.getByTestId('version').getByText(/^v1\.0\.0 · /).waitFor();
      await pluginMenu(reg, 'Reset');
      await card.getByTestId('version').getByText(/^v1\.0\.0 · /).waitFor();
      await reg.getByRole('button', { name: 'Reload all' }).click();
      await reg.getByRole('status').filter({ hasText: /^Reloaded 1 from the source\. Every change takes effect from the next run\.$/ }).waitFor();
      await reg.getByRole('button', { name: 'Reset all to the catalogue' }).click();
      await reg.getByText('Put every plugin back to its source and drop local edits?').waitFor();
      await reg.getByRole('button', { name: 'Keep', exact: true }).click();
      await reg.getByRole('button', { name: 'Reset all to the catalogue' }).click();
      await reg.getByRole('button', { name: 'Reset all', exact: true }).click();
      await reg.getByRole('status').filter({ hasText: /^Reset 1 from the source\./ }).waitFor();
    });

    await s.step('Plugins: a plugin from a folder reloads from it; Remove asks first and deletes', async () => {
      const folder = path.join(root, 'folder-plugin');
      fs.mkdirSync(path.join(folder, 'skills', 'solo'), { recursive: true });
      fs.writeFileSync(path.join(folder, 'skills', 'solo', 'SKILL.md'), '---\nname: solo\ndescription: One skill.\n---\n\nBody.\n');
      const reg = await skillsPage();
      await reg.getByRole('tab', { name: 'Add from a source' }).click();
      await reg.getByRole('tab', { name: 'A folder on this computer' }).click();
      await reg.getByRole('textbox', { name: 'Folder' }).fill(folder);
      await reg.getByTestId('preview-source').click();
      await reg.getByTestId('install-counts').getByText(/1 skills/).waitFor();
      await reg.getByTestId('install-confirm').click();
      await reg.getByRole('tab', { name: /^Installed 2/ }).waitFor();
      const card = reg.getByTestId('plugin-folder-plugin');
      await card.getByText('Imported from a folder · 1 skills').waitFor();
      fs.mkdirSync(path.join(folder, 'skills', 'duo'));
      fs.writeFileSync(path.join(folder, 'skills', 'duo', 'SKILL.md'), '---\nname: duo\ndescription: Another.\n---\n\nBody.\n');
      await card.getByRole('button', { name: 'Check for update' }).click();
      await card.getByText('Up to date.').waitFor();
      await card.getByRole('button', { name: 'Reload', exact: true }).click();
      await card.getByText('Imported from a folder · 2 skills').waitFor();
      // Remove: Keep leaves it, Remove deletes it
      await card.getByTestId('plugin-more').click();
      await p.getByRole('menuitem', { name: 'Remove' }).click();
      await card.getByText('Remove folder-plugin?').waitFor();
      await card.getByRole('button', { name: 'Keep', exact: true }).click();
      await card.getByText('Remove folder-plugin?').waitFor({ state: 'detached' });
      await card.getByTestId('plugin-more').click();
      await p.getByRole('menuitem', { name: 'Remove' }).click();
      await card.getByTestId('confirm-remove').click();
      await card.waitFor({ state: 'detached' });
      await reg.getByRole('tab', { name: /^Installed 1/ }).waitFor();
      await until(async () => (await pluginsOnServer()).length === 1, 'one plugin left on the server');
    });

    // ------------------------------------------------------------------ code worktrees
    // The per-ticket hand-over card (GET /tickets/:id/ai/worktree, POST …/worktree/commit, /outputs, /merge, PATCH
    // …/handover) has no screen to drive: TicketHandover is rendered by TicketModal only while MOCK_AI_ACTIVITY (ui/src/
    // components/ai/activity/mock.ts) is false, and it is `true`, so the ticket's AI tab shows the design instead.
    // These calls are therefore not made here. The worktree list of Settings > AI > Repositories (Keep, Remove, Open
    // folder, Stop, Clean up finished) is what drives the rest of aiCode.ts.
    const reposRegion = () => p.getByRole('region', { name: 'Repositories' });
    const KEYS = { 1: 'Fix add', 2: 'Second', 3: 'Third', 4: 'Fourth' };
    const openCard = async (n) => {
      await p.getByRole('button', { name: new RegExp(`ALP-${n} `) }).first().getByText(KEYS[n], { exact: true }).click();
      const d = p.getByRole('dialog', { name: `Ticket ALP-${n}` });
      await d.waitFor();
      return d;
    };
    // assign to the team and start (the card then says Finished when the stand-in CLI ends)
    const assignAndStart = async (n) => {
      const d = await openCard(n);
      await d.getByRole('button', { name: 'Unassigned' }).click();
      await p.getByRole('button', { name: new RegExp(`^${TEAM}`) }).click();
      await p.getByRole('button', { name: 'Assign & start' }).click();
      await d.getByRole('button', { name: new RegExp(`^${TEAM}`) }).waitFor();
      await d.getByRole('button', { name: 'Close', exact: true }).click();
      await d.waitFor({ state: 'detached' });
    };
    const finished = (n) => p.getByRole('button', { name: new RegExp(`ALP-${n} ${KEYS[n]} Finished`) });
    const worktreesOnServer = async () => (await api('GET', `/projects/${ids.project}/ai/worktrees`)).json;
    const wtRow = (n) => reposRegion().getByTestId(`worktree-ALP-${n}`);
    const ticketId = async (n) => {
      const tickets = (await api('GET', `/projects/${ids.project}/tickets`)).json;
      return (Array.isArray(tickets) ? tickets : tickets.tickets).find((t) => t.key === `ALP-${n}` || t.ticket_key === `ALP-${n}` || t.id === `ALP-${n}`)?.id;
    };

    await s.step('Repositories: one worktree per ticket is turned on with the repository path and base branch', async () => {
      await home(s);
      await createTicket(s, { title: KEYS[2] });
      await createTicket(s, { title: KEYS[3] });
      await createTicket(s, { title: KEYS[4] });
      await settingsAi();
      const reg = reposRegion();
      await reg.getByTestId('wt-off-note').waitFor();
      await reg.getByRole('textbox', { name: 'Repository path' }).fill(s.server.dirs.repo);
      await reg.getByRole('textbox', { name: 'Repository path' }).blur();
      await reg.getByRole('textbox', { name: 'Base branch' }).fill('main');
      await reg.getByRole('textbox', { name: 'Base branch' }).blur();
      await reg.getByRole('textbox', { name: 'First port' }).fill('80');
      await reg.getByRole('textbox', { name: 'First port' }).blur();
      await reg.getByRole('alert').getByText('The first port must be between 1024 and 65515.').waitFor();
      await reg.getByRole('textbox', { name: 'First port' }).fill('5200');
      await reg.getByRole('textbox', { name: 'First port' }).blur();
      await reg.getByRole('switch', { name: 'One worktree per ticket' }).click();
      await reg.getByTestId('worktree-list').waitFor();
      await reg.getByTestId('wt-empty').waitFor();
      await reg.getByRole('button', { name: 'Clean up finished' }).and(p.locator(':disabled')).waitFor();
    });

    await s.step('Worktrees: a run leaves files uncommitted; the row waits for you; Keep is offered, Remove is not', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2', FAKE_CLAUDE_LEAVE: JSON.stringify(['helper.py']) });
      await home(s);
      await assignAndStart(1);
      await finished(1).waitFor({ timeout: 40000 });
      await settingsAi();
      const row = wtRow(1);
      await row.waitFor();
      await row.getByTestId('worktree-state').filter({ hasText: 'Waiting for you' }).waitFor();
      await row.getByText(/1 file changed, not committed/).waitFor();
      await row.getByRole('button', { name: 'Remove', exact: true }).waitFor({ state: 'detached' });
      await row.getByText(/^ai\/ALP-1/).waitFor();
      await reposRegion().getByText(/1 worktree · /).waitFor();
      const list = await worktreesOnServer();
      if (list.worktrees.length !== 1 || list.worktrees[0].state !== 'active') throw new Error(`the server lists ${JSON.stringify(list.worktrees.map((w) => w.state))}`);
      await row.getByRole('button', { name: 'Keep', exact: true }).waitFor();
    });

    await s.step('Worktrees: Open folder asks the file manager, Copy path copies the path', async () => {
      // a stand-in file manager first on the server's PATH (the server's PATH starts with <root>/bin), so no real one starts
      const log = path.join(root, 'xdg-open.log');
      fs.writeFileSync(path.join(root, 'bin', 'xdg-open'), `#!/bin/sh\necho "$1" >> "${log}"\n`, { mode: 0o755 });
      await settingsAi();
      const row = wtRow(1);
      const opened = p.waitForResponse((r) => r.request().method() === 'POST' && /\/tickets\/[^/]+\/ai\/worktree\/open$/.test(r.url()));
      await row.getByRole('button', { name: 'Open folder' }).click();
      const body = await (await opened).json();
      await until(async () => fs.existsSync(log) && fs.readFileSync(log, 'utf8').trim() === body.opened, 'the file manager asked for the worktree folder');
      if (!body.opened.includes('ALP-1')) throw new Error(`the opened folder is ${body.opened}`);
      await row.getByRole('button', { name: 'Copy path' }).click();
      await until(async () => (await p.evaluate(() => navigator.clipboard.readText())) === body.opened, 'the path on the clipboard');
    });

    await s.step('Worktrees: a clean worktree is removed from its row', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2' });
      await home(s);
      await assignAndStart(2);
      await finished(2).waitFor({ timeout: 40000 });
      await settingsAi();
      const row = wtRow(2);
      await row.getByTestId('worktree-state').filter({ hasText: 'In use' }).waitFor();
      await row.getByText('nothing uncommitted').waitFor();
      await row.getByRole('button', { name: 'Remove', exact: true }).click();
      await row.waitFor({ state: 'detached' });
      if (fs.existsSync(path.join(s.server.dirs.repo + '.worktrees', 'ALP-2'))) throw new Error('the worktree folder is still on disk');
      if ((await worktreesOnServer()).worktrees.some((w) => w.ticket_id === 'ALP-2')) throw new Error('the server still lists the removed worktree');
    });

    await s.step('Worktrees: Keep pins one; Clean up finished removes the worktree of a ticket that is Done', async () => {
      await home(s);
      await assignAndStart(3);
      await finished(3).waitFor({ timeout: 40000 });
      await settingsAi();
      const reg = reposRegion();
      await wtRow(1).getByRole('button', { name: 'Keep', exact: true }).click();
      await wtRow(1).getByTestId('worktree-state').filter({ hasText: 'Kept' }).waitFor();
      await until(async () => (await worktreesOnServer()).worktrees.find((w) => w.ticket_id === 'ALP-1').state === 'kept', 'the worktree kept on the server');
      await wtRow(1).getByRole('button', { name: 'Keep', exact: true }).waitFor({ state: 'detached' });
      // "Leave the branch": moving to Done does not merge on this machine (the branch cannot be pushed here either),
      // so the worktree is still there when the ticket is Done
      await reg.getByRole('combobox', { name: 'Hand over finished code by' }).selectOption({ label: 'Leave the branch' });
      await s.settle();
      await home(s);
      await dragCard(p, 'ALP-3', 'Done');
      await until(async () => {
        const all = (await api('GET', `/projects/${ids.project}/tickets`)).json;
        return (Array.isArray(all) ? all : all.tickets).some((t) => t.status === 'done');
      }, 'ALP-3 in Done');
      await settingsAi();
      await wtRow(3).getByTestId('worktree-state').filter({ hasText: 'In use' }).waitFor();
      // moving to Done starts the hand-over in the background (it commits what is left and tries to push, which fails
      // here); while it holds the worktree the clean-up keeps it and says so, so it is asked again until it is free
      let answer = { removed: [], kept: [] };
      for (let attempt = 0; attempt < 6 && !answer.removed.includes('ALP-3'); attempt++) {
        const done = p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/worktrees\/cleanup$/.test(r.url()));
        await reposRegion().getByRole('button', { name: 'Clean up finished' }).click();
        answer = await (await done).json();
      }
      if (answer.removed.join() !== 'ALP-3') throw new Error(`Clean up finished answered ${JSON.stringify(answer)}`);
      await reposRegion().getByText(/^Removed 1\.$/).waitFor();
      await wtRow(3).waitFor({ state: 'detached' });
      await wtRow(1).getByTestId('worktree-state').filter({ hasText: 'Kept' }).waitFor();
      const left = (await worktreesOnServer()).worktrees;
      if (left.length !== 1 || left[0].ticket_id !== 'ALP-1') throw new Error(`the worktrees left: ${JSON.stringify(left.map((w) => w.ticket_id))}`);
    });

    // ------------------------------------------------------------------ a run that is going: team page, Resources, drag
    const WAITING_RUN = { FAKE_CLAUDE_MODE: 'v2', FAKE_CLAUDE_V2_WAIT_MESSAGE: '1', FAKE_CLAUDE_WAIT: '120' };
    const aiTeamView = async (tab) => {
      await home(s);
      await p.getByRole('button', { name: /^AI Team/ }).click();
      await p.getByRole('heading', { name: 'AI Team', level: 1 }).waitFor();
      if (tab) await p.getByRole('tab', { name: tab }).click();
    };
    const teamPage = async () => {
      await aiTeamView();
      await p.getByRole('button', { name: TEAM, exact: true }).click();
      await p.getByTestId('team-page').waitFor();
    };

    await s.step('a run that waits for a message starts on ALP-4', async () => {
      s.server.fake(WAITING_RUN);
      await home(s);
      await assignAndStart(4);
      await until(async () => {
        const board = (await api('GET', `/projects/${ids.project}/ai/board`)).json;
        return Object.values(board?.tickets ?? {}).some((r) => r.state === 'running');
      }, 'a run going on the server');
    });

    await s.step('Team page: the header, the RAM chip of the going run and the role cards', async () => {
      await teamPage();
      const head = p.getByTestId('team-header');
      await head.getByText(TEAM, { exact: true }).waitFor();
      await head.getByText('Slots').waitFor();
      await head.getByText(/1 of \d+ running/).waitFor();
      await p.getByTestId('role-cards').waitFor();
      await p.getByTestId('team-memory').getByTestId('ram-chip').waitFor({ timeout: 20000 });
      await p.getByTestId('ram-chip').first().getByText(/^RAM \d/).waitFor();
      if (!['ok', 'warn', 'bad'].includes(await p.getByTestId('ram-chip').first().getAttribute('data-level'))) throw new Error('the RAM chip has no level');
    });

    await s.step('Team page: Pause the team and Resume it; the Members link and the way back work', async () => {
      await teamPage();
      await p.getByTestId('team-pause').click();
      await p.getByTestId('team-pause').filter({ hasText: 'Resume the team' }).waitFor();
      await p.getByTestId('team-header').getByText(/Paused/i).first().waitFor();
      await until(async () => ((await api('GET', `/projects/${ids.project}/ai/teams`)).json.teams ?? (await api('GET', `/projects/${ids.project}/ai/teams`)).json)[0].paused === true, 'the team paused on the server');
      await p.getByTestId('team-pause').click();
      await p.getByTestId('team-pause').filter({ hasText: 'Pause the team' }).waitFor();
      await p.getByTestId('team-configure').click();
      await p.getByRole('heading', { name: TEAM, level: 1 }).waitFor();
      await teamPage();
      await p.getByTestId('team-back').click();
      await p.getByRole('heading', { name: 'Teams', level: 2 }).waitFor();
    });

    await s.step('Resources: the RAM chip opens the tab; Restart and Stop ask first', async () => {
      await teamPage();
      await p.getByTestId('team-memory').getByTestId('ram-chip').click();
      await p.getByTestId('resources-tab').waitFor();
      const row = p.getByTestId('rs-run-ALP-4');
      await row.getByTestId('rs-lead').waitFor();
      await row.getByRole('button', { name: 'Restart', exact: true }).click();
      const ask = row.getByRole('dialog', { name: 'Confirm restart' });
      await ask.getByText(/^Restart Backend team’s run on ALP-4\?$/).waitFor();
      await ask.getByRole('button', { name: 'Cancel' }).click();
      await ask.waitFor({ state: 'detached' });
      await row.getByRole('button', { name: 'Restart', exact: true }).click();
      await ask.getByTestId('rs-confirm').click();
      await ask.waitFor({ state: 'detached' });
      await row.getByText(/restarted by /).waitFor({ timeout: 30000 });
      await row.getByRole('button', { name: 'Stop', exact: true }).click();
      const stop = row.getByRole('dialog', { name: 'Confirm stop' });
      await stop.getByText('Ends the run now. Partial work in the folder is kept; Retry on the run starts it again.').waitFor();
      await stop.getByRole('button', { name: 'Cancel' }).click();
      await stop.waitFor({ state: 'detached' });
      await row.getByRole('button', { name: 'Stop', exact: true }).click();
      await stop.getByTestId('rs-confirm').click();
      await row.getByText('Ended', { exact: true }).waitFor({ timeout: 30000 });
      await row.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached' });
    });

    // the card of a going run re-renders every second, so a drag can miss. A drag that did drop has put its question
    // up (or the live region says it dropped) within a few seconds: only a drag that did neither is made again
    const dragAsk = async (n, column) => {
      const ask = p.getByRole('alertdialog', { name: `Move ALP-${n} anyway` });
      for (let attempt = 0; attempt < 3; attempt++) {
        await dragCard(p, `ALP-${n}`, column);
        if (await ask.waitFor({ timeout: 10000 }).then(() => true, () => false)) return ask;
      }
      throw new Error(`dragging ALP-${n} to ${column} did not ask`);
    };
    const runningRuns = async () => Object.values((await api('GET', `/projects/${ids.project}/ai/board`)).json?.tickets ?? {}).filter((r) => r.state === 'running');
    // start a run on a ticket that was run before: its dialog's Run button
    const runAgain = async (n, { stays = true } = {}) => {
      const d = await openCard(n);
      await d.getByRole('button', { name: `Run ${TEAM}` }).click();
      await d.getByRole('button', { name: 'Close', exact: true }).click();
      await d.waitFor({ state: 'detached' });
      if (stays) await until(async () => (await runningRuns()).length === 1, 'a run going on the server');
    };

    await s.step('Drag: moving a card a team is working on asks first; Keep it leaves the run', async () => {
      s.server.fake(WAITING_RUN);
      await home(s);
      await runAgain(2);
      const ask = await dragAsk(2, 'To Do');
      await ask.getByRole('heading', { name: 'Move ALP-2 anyway?' }).waitFor();
      await ask.getByText(/Backend team is working on it \(run #\d+\)\./).waitFor();
      await ask.getByText('To Do', { exact: true }).waitFor();
      await ask.getByTestId('drag-confirm-keep').click();
      await ask.waitFor({ state: 'detached' });
      if ((await runningRuns()).length !== 1) throw new Error('Keep it with the AI must leave the run going');
    });

    await s.step('Drag: Move and cancel run cancels the run and moves the card', async () => {
      const ask = await dragAsk(2, 'To Do');
      await ask.getByTestId('drag-confirm-move').click();
      await ask.waitFor({ state: 'detached' });
      await until(async () => (await runningRuns()).length === 0, 'the run cancelled');
      await until(async () => {
        const all = (await api('GET', `/projects/${ids.project}/tickets`)).json;
        return (Array.isArray(all) ? all : all.tickets).some((t) => t.status === 'todo');
      }, 'the card moved to To Do');
    });

    await s.step('Worktrees: Stop on a going run cancels it', async () => {
      await home(s);
      await runAgain(4);
      await settingsAi();
      const row = wtRow(4);
      await row.waitFor();
      await row.getByRole('button', { name: 'Stop', exact: true }).click();
      await until(async () => (await runningRuns()).length === 0, 'the run stopped on the server');
      await row.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'detached' });
    });

    // ------------------------------------------------------------------ memory: a lesson the runs proposed
    const proposalCount = async () => (await knowledge()).lessons.filter((l) => l.state === 'proposed').length;

    await s.step('Memory: the lesson the runs proposed is edited and kept', async () => {
      const mem = await memoryTab(/^Memory/);
      await mem.getByTestId('proposals-waiting').getByText(/^1 lesson waiting for you$/).waitFor();
      // the tab counts the proposal and the note flagged as out of date
      await mem.getByTestId('memory-waiting').filter({ hasText: /^2 waiting for you$/ }).waitFor();
      await mem.getByTestId('memory-waiting').and(p.locator('[title="1 proposed lesson and 1 flagged"]')).waitFor();
      const card = mem.getByTestId('lesson-proposal');
      await card.getByText('“Run pytest -q from the server folder.”').waitFor();
      await card.getByText(/It is not in any prompt until you keep it\./).waitFor();
      await card.getByTestId('proposal-edit').click();
      const editor = card.getByTestId('lesson-editor');
      await editor.fill('Run pytest -q from the server folder, never from the repository root.');
      await card.getByTestId('lesson-editor-save').click();
      await card.waitFor({ state: 'detached' });
      await mem.getByTestId('lesson').getByText('Run pytest -q from the server folder, never from the repository root.').waitFor();
      await until(async () => (await knowledge()).lessons.some((l) => l.state === 'kept' && l.text.endsWith('repository root.')), 'the edited lesson kept on the server');
    });

    await s.step('Memory: a proposal that is turned down ("No") is dropped', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2' });
      await home(s);
      await runAgain(2, { stays: false });
      await until(async () => (await proposalCount()) === 1, 'the lesson proposed again', 60000);
      const mem = await memoryTab(/^Memory/);
      const card = mem.getByTestId('lesson-proposal');
      await card.getByTestId('proposal-no').click();
      await card.waitFor({ state: 'detached' });
      await until(async () => (await proposalCount()) === 0 && (await knowledge()).lessons.every((l) => l.text !== 'Run pytest -q from the server folder.'), 'the lesson dropped on the server');
      await mem.getByTestId('memory-waiting').and(p.locator('[title="0 proposed lessons and 1 flagged"]')).waitFor();
    });

    // ------------------------------------------------------------------ schedules: Edit, a slot that waits, History
    const schedulesOnServer = async () => (await api('GET', `/projects/${ids.project}/ai/schedules`)).json;
    const detail = () => p.getByRole('dialog', { name: 'Schedule' });
    const openSchedules = async () => {
      await home(s);
      await p.getByRole('button', { name: /^Schedules/ }).click();
      await p.getByRole('button', { name: 'New schedule' }).first().waitFor();
    };
    const openDetail = async () => {
      await openSchedules();
      await p.getByTestId('schedule-table').getByText(KEYS[4], { exact: true }).click();
      await detail().waitFor();
    };

    await s.step('Schedules: a schedule is created, then Edit changes its time (PATCH)', async () => {
      await openSchedules();
      await p.getByRole('button', { name: 'New schedule' }).first().click();
      const d = p.getByRole('dialog', { name: 'New schedule' });
      await d.getByRole('button', { name: 'Pick a ticket' }).click();
      await p.getByRole('option', { name: /ALP-4 Fourth/ }).click();
      await d.getByRole('textbox', { name: 'Time of day' }).fill('03:15');
      await d.getByRole('textbox', { name: 'Time of day' }).blur();
      await d.getByText(/Backend team works on ALP-4/).waitFor();
      await d.getByRole('button', { name: 'Create schedule' }).click();
      await d.waitFor({ state: 'detached' });
      await p.getByTestId('schedule-table').getByText(KEYS[4], { exact: true }).click();
      await detail().getByText(/Weekdays at 03:15 \(UTC\) · Backend team/).waitFor();
      await detail().getByTestId('edit').click();
      const ed = p.getByRole('dialog', { name: 'Edit schedule' });
      await ed.getByRole('textbox', { name: 'Time of day' }).fill('04:30');
      await ed.getByRole('textbox', { name: 'Time of day' }).blur();
      await ed.getByText(/Every weekday at 04:30/).waitFor();
      await ed.getByRole('button', { name: 'Save', exact: true }).click();
      await ed.waitFor({ state: 'detached' });
      await detail().getByText(/Weekdays at 04:30 \(UTC\) · Backend team/).waitFor();
      await until(async () => JSON.stringify(await schedulesOnServer()).includes('04:30'), 'the new time on the server');
    });

    await s.step('Schedules: with the team paused, Run now is refused and the slot waits; Skip this time ends it', async () => {
      await teamPage();
      await p.getByTestId('team-pause').click();
      await p.getByTestId('team-pause').filter({ hasText: 'Resume the team' }).waitFor();
      await openDetail();
      await detail().getByTestId('run-now').click();
      const slot = detail().getByTestId('slot').first();
      await slot.and(p.locator('[data-state="waiting"]')).waitFor();
      await slot.getByTestId('slot-actions').waitFor();
      await slot.getByTestId('slot-skip').click();
      await slot.and(p.locator('[data-state="skipped"]')).waitFor();
      await slot.getByTestId('slot-actions').waitFor({ state: 'detached' });
    }, { expectConsole: true });

    await s.step('Schedules: a waiting slot runs on another team choice, or now once the team is back', async () => {
      await detail().getByTestId('run-now').click();
      const slot = detail().getByTestId('slot').first();
      await slot.and(p.locator('[data-state="waiting"]')).waitFor();
      await slot.getByTestId('slot-other').click();
      await slot.getByRole('combobox', { name: 'Another team' }).waitFor();
      await slot.getByTestId('slot-use-member').and(p.locator(':disabled')).waitFor();
      // Run now while the team is still paused is refused, and the slot keeps waiting
      await slot.getByTestId('slot-start').click();
      await p.getByText("Couldn't update this run").waitFor();
      await slot.and(p.locator('[data-state="waiting"]')).waitFor();
      // the team comes back: the slot runs now
      await teamPage();
      await p.getByTestId('team-pause').click();
      await p.getByTestId('team-pause').filter({ hasText: 'Pause the team' }).waitFor();
      await openDetail();
      const again = detail().getByTestId('slot').first();
      // the schedule's clock may have started the waiting slot already, as it says it does
      if (await again.getByTestId('slot-start').count()) await again.getByTestId('slot-start').click();
      await again.and(p.locator('[data-state="running"],[data-state="passed"],[data-state="partly"]')).waitFor({ timeout: 40000 });
    }, { expectConsole: true });

    await s.step('Schedules: the History tab lists every planned start', async () => {
      await openSchedules();
      await p.getByTestId('tab-history').click();
      await p.getByText(KEYS[4]).first().waitFor();
      const table = p.locator('table, [role="table"], .sc-table').last();
      await table.getByText(/Skipped|skipped/).first().waitFor();
      await p.getByTestId('tab-upcoming').click();
      await p.getByTestId('schedule-table').waitFor();
    });

    // ------------------------------------------------------------------ repository scan: the commands of the project
    const cmds = () => reposRegion().getByTestId('repo-commands');
    const scanPage = async () => {
      await settingsAi();
      await cmds().waitFor();
    };

    // GET /ai/scans/:id has no screen: the card reads the newest scan (GET …/scans/latest) and never one by its id.
    // The stand-in CLI cannot play the AI of this card: the card starts `claude -p <prompt> --output-format stream-json`
    // with no --session-id and no --resume, and fake-claude (crates/fake-claude/src/main.rs, where it picks the
    // session) stops with "ValueError: '--resume' is not in list" for such a call. What would be needed: a one-shot
    // stream-json call that answers with a result whose text is the JSON proposal ({"commands": {"test": {"command":
    // ..., "source": ...}}, "notes": ...}), say from FAKE_CLAUDE_SCAN_JSON. So the step asserts what the card does with
    // an AI that ends without a proposal, not the proposal itself.
    await s.step('Scan: the AI is asked to find the commands; whatever its end, the card says so and offers it again', async () => {
      await scanPage();
      const find = cmds().getByTestId('rc-find');
      await find.and(p.locator(':enabled')).waitFor();
      await cmds().getByTestId('rc-how').waitFor();
      const asked = p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/scans\/[^/]+\/ai$/.test(r.url()));
      await find.click();
      if ((await asked).status() !== 200) throw new Error('POST /ai/scans/:id/ai was refused');
      const strip = cmds().getByTestId('rc-strip');
      await strip.waitFor();
      await strip.and(p.locator('[data-state="done"],[data-state="failed"],[data-state="timeout"]')).waitFor({ timeout: 60000 });
      await cmds().getByText('The AI is setting up the commands').waitFor();
      await find.filter({ hasText: /^(Set up again|Run it again)$/ }).waitFor();
      await cmds().getByTestId('rc-stop').waitFor({ state: 'detached' });
    });

    await s.step('Scan: typed commands are run by the board, each one is proven, and Save keeps them', async () => {
      await scanPage();
      await cmds().getByTestId('cmd-test').fill('echo tests ok');
      await cmds().getByTestId('cmd-lint').fill('echo lint problem; exit 1');
      await cmds().getByTestId('cmd-build').fill('no-such-program-xyz');
      await cmds().getByTestId('rc-row-test').getByTestId('rc-chip-test').filter({ hasText: 'Not tried yet' }).waitFor();
      await cmds().getByTestId('rc-save').and(p.locator(':enabled')).waitFor();
      const tried = p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/scans\/[^/]+\/try$/.test(r.url()));
      await cmds().getByTestId('rc-run-all').click();
      if ((await tried).status() !== 200) throw new Error('POST /ai/scans/:id/try was refused');
      await cmds().getByTestId('rc-chip-test').filter({ hasText: /^Works · / }).waitFor({ timeout: 60000 });
      await cmds().getByTestId('rc-chip-lint').filter({ hasText: 'Runs · the repo’s own tests fail' }).waitFor({ timeout: 60000 });
      await cmds().getByTestId('rc-chip-build').filter({ hasText: /^Command is wrong · exit 127/ }).waitFor({ timeout: 60000 });
      await cmds().getByTestId('rc-strip').and(p.locator('[data-state="done"]')).waitFor();
      await cmds().getByTestId('rc-out-lint').getByText('lint problem').waitFor();
      // an edit after the proof is said so
      await cmds().getByTestId('cmd-test').fill('echo tests ok again');
      await cmds().getByTestId('rc-chip-test').filter({ hasText: 'Changed since the last run' }).waitFor();
      await cmds().getByRole('button', { name: 'Discard' }).click();
      await cmds().getByTestId('cmd-test').and(p.locator('[value=""]')).waitFor();
      // type again and keep them
      await cmds().getByTestId('cmd-test').fill('echo tests ok');
      await cmds().getByTestId('rc-save').click();
      await cmds().getByText('Saved for this project. Nothing else changes.').waitFor();
      await scanPage();
      await until(async () => (await cmds().getByTestId('cmd-test').inputValue()) === 'echo tests ok', 'the saved test command');
    });

    await s.step('Scan: Stop cancels the board while it runs a long command', async () => {
      await scanPage();
      await cmds().getByTestId('cmd-test').fill('sleep 120');
      const tried = p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/scans\/[^/]+\/try$/.test(r.url()));
      await cmds().getByTestId('rc-run-test').click();
      await tried;
      await cmds().getByTestId('rc-chip-test').filter({ hasText: 'Running' }).waitFor();
      const stopped = p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/scans\/[^/]+\/cancel$/.test(r.url()));
      await cmds().getByTestId('rc-stop').click();
      if ((await stopped).status() !== 200) throw new Error('POST /ai/scans/:id/cancel was refused');
      await cmds().getByTestId('rc-strip').and(p.locator('[data-state="cancelled"]')).waitFor();
      await cmds().getByText('Stopped', { exact: true }).waitFor();
      await cmds().getByTestId('rc-stop').waitFor({ state: 'detached' });
    });
  },
};
