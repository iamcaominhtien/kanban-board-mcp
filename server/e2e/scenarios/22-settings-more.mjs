import fs from 'node:fs';
import path from 'node:path';
import { home, ensureProject, createTicket, addMember, openDocs, newDocPage, setMarkdown, publishDoc, openTicket, closeTicket } from '../lib/ui.mjs';

// Settings beyond 10-settings: Appearance, Workspace, the database wizard, MCP integrations (they write a client
// config under the server's HOME), the logs, the activity log of a ticket, the keyboard, and the notification extras
// (the follow bell, the notification settings, a toast).
//
// Not covered: moving the data to another database (the wizard only offers PostgreSQL and MySQL/MariaDB, never another
// SQLite file, and no database server is used here: the wizard is driven up to a failed connection test); the Claude
// Code install of the MCP entry (it runs `claude mcp add`, which the stand-in CLI does not know); the data folder (it
// moves the database); the desktop-only pages (Updates) and the OS notifications.
export default {
  name: 'Settings (more): Appearance, Workspace, database wizard, MCP, logs, keyboard, notification extras',
  async run(s) {
    const p = s.page;
    const nav = () => p.getByRole('navigation', { name: 'Settings pages' });
    const until = async (fn, what, ms = 15000) => {
      const t0 = Date.now();
      for (;;) {
        try { if (await fn()) return; } catch { /* look again */ }
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await p.waitForTimeout(150);
      }
    };
    const openSettings = async (label, heading = label) => {
      await home(s);
      await p.getByRole('button', { name: 'Settings' }).click();
      await nav().getByRole('button', { name: label, exact: true }).click();
      await p.getByRole('heading', { name: heading, level: 1 }).waitFor();
    };
    const radio = (name) => p.getByRole('radio', { name });
    const checked = (loc) => loc.and(p.locator('[aria-checked="true"]'));
    const unchecked = (loc) => loc.and(p.locator('[aria-checked="false"]'));
    const mcpSection = () => p.getByRole('heading', { name: 'MCP integrations', level: 2 }).locator('xpath=ancestor::section[1]');

    await s.step('set up: a project with a ticket and a member', async () => {
      await ensureProject(s);
      await addMember(s, 'Me');
      await createTicket(s, { title: 'Watch me' });
    });

    // ---------------------------------------------------------------- Appearance
    await s.step('Appearance: black & white mode shows at once, is kept after a reload, and goes back to colour', async () => {
      await openSettings('Appearance');
      await checked(radio(/^Color/)).waitFor();
      await radio(/^Black & white/).click();
      await checked(radio(/^Black & white/)).waitFor();
      await p.getByText('Saved', { exact: true }).waitFor();
      await until(async () => (await p.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'bw', 'the page in black & white');
      await until(async () => /grayscale/.test(await p.evaluate(() => getComputedStyle(document.documentElement).filter)), 'the grayscale filter');
      await p.reload();
      await p.getByRole('button', { name: 'Settings' }).click().catch(() => {});
      await until(async () => (await p.evaluate(() => document.documentElement.getAttribute('data-theme'))) === 'bw', 'black & white after a reload');
      await openSettings('Appearance');
      await checked(radio(/^Black & white/)).waitFor();
      await radio(/^Color/).click();
      await checked(radio(/^Color/)).waitFor();
      await until(async () => (await p.evaluate(() => document.documentElement.getAttribute('data-theme'))) !== 'bw', 'colour again');
    });

    // ---------------------------------------------------------------- Workspace
    await s.step('Workspace: the default retention changes what a ticket offers, and a folder is created on disk', async () => {
      await openSettings('Storage & backup');
      await p.getByRole('heading', { name: 'Workspace', level: 2 }).waitFor();
      await p.getByRole('switch', { name: 'Enable workspace' }).and(p.locator('[aria-checked="true"]')).waitFor();
      const root = await p.getByRole('textbox', { name: 'Workspace root path' }).inputValue();
      if (path.resolve(root) !== path.resolve(s.server.dirs.workspace)) throw new Error(`workspace root is ${root}`);
      await checked(radio('14 days')).waitFor();
      await radio('30 days').click();
      await checked(radio('30 days')).waitFor();
      await s.settle();
      await openSettings('Storage & backup');
      await checked(radio('30 days')).waitFor();
      await home(s);
      const d = await openTicket(s, 'ALP-1');
      await d.getByRole('button', { name: 'Workspace' }).click();
      await d.getByText(path.join(s.server.dirs.workspace, 'ALP-1')).waitFor();
      await d.getByRole('button', { name: /^Auto-delete 30d after Done/ }).waitFor();
      await d.getByRole('button', { name: 'Create folder' }).click();
      await d.getByRole('button', { name: 'Create folder' }).waitFor({ state: 'detached' });
      await until(async () => fs.existsSync(path.join(s.server.dirs.workspace, 'ALP-1')), 'the ticket folder on disk');
      await closeTicket(s);
    });

    await s.step('Workspace: turning it off makes a ticket say it is not set up, turning it on brings the folder back', async () => {
      await openSettings('Storage & backup');
      await p.getByRole('switch', { name: 'Enable workspace' }).and(p.locator('[aria-checked="true"]')).waitFor();
      await p.getByRole('switch', { name: 'Enable workspace' }).click();
      await p.getByText(/Turned off: the Workspace tab is hidden on every ticket/).waitFor();
      await s.settle();
      await home(s);
      let d = await openTicket(s, 'ALP-1');
      await d.getByRole('button', { name: 'Workspace' }).click();
      await d.getByText("Workspace isn't set up yet").waitFor();
      if (await d.getByRole('button', { name: 'Create folder' }).count()) throw new Error('a folder can be created while the workspace is off');
      await closeTicket(s);
      await openSettings('Storage & backup');
      await p.getByText(/Turned off: the Workspace tab is hidden on every ticket/).waitFor();
      await p.getByRole('textbox', { name: 'Workspace root path' }).and(p.locator(':disabled')).waitFor();
      await p.getByRole('switch', { name: 'Enable workspace' }).click();
      await p.getByRole('switch', { name: 'Enable workspace' }).and(p.locator('[aria-checked="true"]')).waitFor();
      await p.getByRole('textbox', { name: 'Workspace root path' }).and(p.locator(':enabled')).waitFor();
      await s.settle();
      await home(s);
      d = await openTicket(s, 'ALP-1');
      await d.getByRole('button', { name: 'Workspace' }).click();
      await d.getByRole('button', { name: /^Auto-delete 30d after Done/ }).waitFor();
      await d.getByText("Workspace isn't set up yet").waitFor({ state: 'detached' });
      await closeTicket(s);
    });

    // ---------------------------------------------------------------- the database wizard
    await s.step('database wizard: SQLite is the current engine, PostgreSQL asks for a connection', async () => {
      await openSettings('Storage & backup');
      await p.getByText(/SQLite · local file/).waitFor();
      await p.getByRole('button', { name: /Move to another database/ }).click();
      const d = p.getByRole('dialog', { name: 'Move to another database' });
      await d.getByText('Your data stays where it is until the last step.').waitFor();
      for (const step of ['Where to', 'Check', 'Copy', 'Verify']) await d.getByRole('listitem').filter({ hasText: step }).waitFor();
      await d.getByRole('radio', { name: /^SQ SQLite/ }).and(p.locator(':disabled')).waitFor();
      await d.getByRole('button', { name: 'Next' }).and(p.locator(':disabled')).waitFor();
      await d.getByRole('radio', { name: /MySQL \/ MariaDB/ }).waitFor();
      await d.getByRole('radio', { name: /PostgreSQL/ }).click();
      await d.getByRole('button', { name: 'Next' }).click();
      await d.getByRole('textbox', { name: 'Host' }).waitFor();
      await until(async () => (await d.getByRole('textbox', { name: 'Port' }).inputValue()) === '5432', 'the PostgreSQL port');
      await until(async () => (await d.getByRole('textbox', { name: 'Database' }).inputValue()) === 'kanban', 'the database name');
      // the next step is not offered before a connection was tested
      await d.getByText('Test the connection first.').waitFor();
      await d.getByRole('button', { name: 'Next' }).and(p.locator(':disabled')).waitFor();
    });

    await s.step('database wizard: a connection test that fails says so, and Cancel leaves everything as it was', async () => {
      const d = p.getByRole('dialog', { name: 'Move to another database' });
      // nothing listens on this port of this computer: the test must fail, with a reason in plain words
      await d.getByRole('textbox', { name: 'Port' }).fill('1');
      await d.getByRole('textbox', { name: 'User' }).fill('nobody');
      await d.getByRole('button', { name: 'Test connection' }).click();
      await d.getByText('What the test found').waitFor({ timeout: 40000 });
      const found = d.getByRole('list').filter({ hasText: /Cannot reach the server/ });
      await found.waitFor();
      await d.getByText(/Next is off until every line is green or amber\./).waitFor();
      await d.getByRole('button', { name: 'Next' }).and(p.locator(':disabled')).waitFor();
      s.note('wizard: what the failed test says', (await found.innerText()).replace(/\s+/g, ' ').trim());
      s.note('wizard: a failed test leaves Next disabled', true);
      await d.getByRole('button', { name: 'Back' }).click();
      await d.getByRole('button', { name: /^Cancel/ }).click().catch(async () => { await p.keyboard.press('Escape'); });
      await d.waitFor({ state: 'detached' });
      await p.getByText(/SQLite · local file/).waitFor();
    });

    // ---------------------------------------------------------------- MCP integrations
    await s.step('MCP integrations: both tools are listed with their scope', async () => {
      await openSettings('Integrations');
      const sec = mcpSection();
      await sec.getByText(/^Claude Code/).first().waitFor();
      await sec.getByText(/Antigravity/).first().waitFor();
      await sec.getByText('Not installed').first().waitFor();
      await sec.getByRole('button', { name: 'Expand Antigravity' }).click();
      await sec.getByRole('radiogroup', { name: 'Antigravity scope' }).waitFor();
      await checked(sec.getByRole('radio', { name: /^Global/ })).waitFor();
      await sec.getByText('Entry to add').waitFor();
      await sec.getByText(/"mcpServers"/).first().waitFor();
      await sec.getByText(/KANBAN_DB_PATH/).first().waitFor();
      await sec.getByRole('button', { name: 'Expand Claude Code' }).click();
      await sec.getByRole('radiogroup', { name: 'Claude Code scope' }).waitFor();
      await sec.getByText(/claude mcp add kanban --transport stdio --scope user/).waitFor();
      await sec.getByRole('button', { name: 'Collapse Claude Code' }).click();
    });

    const cfg = () => path.join(s.server.dirs.home, '.gemini', 'config', 'mcp_config.json');
    await s.step('MCP integrations: Install writes the kanban entry under the server home', async () => {
      if (fs.existsSync(cfg())) throw new Error('the config exists before the install');
      const sec = mcpSection();
      await sec.getByRole('button', { name: 'Install' }).last().click();
      await sec.getByText('Installed', { exact: true }).first().waitFor();
      await p.getByText('kanban installed in Antigravity').waitFor();
      await until(async () => fs.existsSync(cfg()), 'mcp_config.json under the server HOME');
      const json = JSON.parse(fs.readFileSync(cfg(), 'utf8'));
      if (!json.mcpServers?.kanban?.command) throw new Error(`no kanban entry: ${JSON.stringify(json)}`);
      if (json.mcpServers.kanban.env?.KANBAN_DB_PATH !== path.join(s.server.dirs.root, 'data/kanban.db')) throw new Error(`the entry points at another database: ${JSON.stringify(json.mcpServers.kanban.env)}`);
      s.note('config top-level keys', Object.keys(json).join(','));
      s.note('entry keys', Object.keys(json.mcpServers.kanban).sort().join(','));
      await sec.getByText(/Installed in/).waitFor();
      await sec.getByRole('button', { name: 'Test connection' }).waitFor();
      await sec.getByRole('button', { name: 'Reinstall' }).waitFor();
    });

    await s.step('MCP integrations: Test connection starts the entry and counts the tools', async () => {
      const sec = mcpSection();
      await sec.getByRole('button', { name: 'Test connection' }).click();
      await sec.getByRole('status').filter({ hasText: /Connected - \d+ tools available/ }).waitFor({ timeout: 40000 });
      s.note('test connection says', (await sec.getByRole('status').filter({ hasText: /Connected/ }).first().innerText()).trim());
    });

    await s.step('MCP integrations: Remove asks first and only deletes the kanban entry', async () => {
      const sec = mcpSection();
      // another server of the person stays when kanban is removed
      const json = JSON.parse(fs.readFileSync(cfg(), 'utf8'));
      json.mcpServers.other = { command: 'echo' };
      fs.writeFileSync(cfg(), JSON.stringify(json, null, 2));
      await sec.getByRole('button', { name: 'Remove' }).click();
      const ask = p.getByRole('alertdialog', { name: 'Remove kanban from Antigravity' });
      await ask.getByText(/This only deletes the kanban entry/).waitFor();
      await ask.getByRole('button', { name: 'Cancel' }).click();
      await ask.waitFor({ state: 'detached' });
      if (!JSON.parse(fs.readFileSync(cfg(), 'utf8')).mcpServers.kanban) throw new Error('Cancel removed the entry');
      await sec.getByRole('button', { name: 'Remove' }).click();
      await ask.getByRole('button', { name: 'Remove' }).click();
      await ask.waitFor({ state: 'detached' });
      await until(async () => { const j = JSON.parse(fs.readFileSync(cfg(), 'utf8')); return !j.mcpServers.kanban && j.mcpServers.other; }, 'the kanban entry removed, the other kept');
      await sec.getByText('Not installed').first().waitFor();
    });

    await s.step('MCP integrations: Full control over MCP is off by default, asks first and is kept when turned on', async () => {
      await p.getByRole('heading', { name: 'Full control over MCP', level: 2 }).waitFor();
      await p.getByText(/Off by default\./).waitFor();
      await p.getByRole('button', { name: 'Turn on…' }).click();
      const ask = p.getByRole('alertdialog', { name: 'Turn on full control over MCP' });
      await ask.getByText('Turn on full control over MCP?').waitFor();
      await ask.getByRole('button', { name: 'Turn on', exact: true }).and(p.locator(':disabled')).waitFor();
      await ask.getByRole('button', { name: 'Cancel' }).click();
      await ask.waitFor({ state: 'detached' });
      await p.getByRole('button', { name: 'Turn on…' }).click();
      await ask.getByRole('checkbox', { name: /I understand and accept all the risks/ }).check();
      await ask.getByRole('button', { name: 'Turn on', exact: true }).click();
      await p.getByRole('button', { name: 'Turn off', exact: true }).waitFor();
      await s.settle();
      await openSettings('Integrations');
      await p.getByRole('button', { name: 'Turn off', exact: true }).waitFor();
      await p.getByRole('button', { name: 'Turn off', exact: true }).click();
      await p.getByRole('button', { name: 'Turn on…' }).waitFor();
    });

    // ---------------------------------------------------------------- logs
    await s.step('Diagnostics: export the application logs for a range and a level', async () => {
      await openSettings('Diagnostics');
      await p.getByRole('heading', { name: 'Application logs', level: 2 }).waitFor();
      await radio('Last hour').click();
      await checked(radio('Last hour')).waitFor();
      await p.getByRole('combobox', { name: 'Minimum log level' }).selectOption({ label: 'Everything' });
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 30000 }), p.getByRole('button', { name: 'Export logs' }).click()]);
      const name = dl.suggestedFilename();
      s.note('log export extension', name.replace(/^.*\./, ''));
      s.note('log export name pattern', name.replace(/\d+/g, 'N'));
      const file = await dl.path();
      if (!file || fs.statSync(file).size === 0) throw new Error('the exported log is empty');
    });

    // ---------------------------------------------------------------- the activity log of a ticket
    await s.step('ticket Activity log: every change is listed and the filters narrow it', async () => {
      await home(s);
      const d = await openTicket(s, 'ALP-1');
      await d.getByRole('combobox').nth(1).selectOption('high');
      await d.getByText('Activity — 2 changes').waitFor({ state: 'attached' });
      await d.getByRole('button', { name: 'Activity', exact: true }).click();
      await d.getByText(/\d+ changes? · ALP-1/).waitFor();
      await d.getByText('Created · Watch me').waitFor();
      await d.getByText('Ticket created').waitFor();
      await d.getByRole('button', { name: /^All \(\d+\)/ }).waitFor();
      await d.getByRole('button', { name: 'Priority (1)' }).click();
      await d.getByText('Medium', { exact: true }).waitFor();
      await d.getByText('High', { exact: true }).waitFor();
      if (await d.getByText('Ticket created').count()) throw new Error('the Priority filter still shows the creation');
      await d.getByRole('button', { name: /^All \(\d+\)/ }).click();
      await d.getByText('Ticket created').waitFor();
      await d.getByRole('button', { name: 'Comments (0)' }).waitFor();
    });

    // ---------------------------------------------------------------- the keyboard
    await s.step('keyboard: Ctrl+J opens and closes the Board AI', async () => {
      await home(s);
      await p.keyboard.press('Control+j');
      await p.getByRole('complementary', { name: 'Board AI' }).waitFor();
      await p.keyboard.press('Control+j');
      await p.getByRole('complementary', { name: 'Board AI' }).waitFor({ state: 'detached' });
    });

    await s.step('keyboard: P on a ticket sets it pending and P resumes it', async () => {
      const d = await openTicket(s, 'ALP-1');
      const ask = p.getByRole('dialog', { name: 'Mark ALP-1 as pending' });
      await p.keyboard.press('p');
      await ask.waitFor();
      await ask.getByRole('button', { name: 'Waiting on a ticket' }).waitFor();
      await ask.getByRole('button', { name: 'Mark pending' }).and(p.locator(':disabled')).waitFor();
      await ask.getByRole('button', { name: 'Waiting on a person or party' }).click();
      // a name that is not a member of the project
      await ask.getByRole('textbox', { name: 'Customer, Design team, vendor name...' }).fill('Design team');
      await ask.getByRole('textbox', { name: 'What is it waiting for?' }).fill('The design review');
      await ask.getByText('Free-text names cannot be notified').waitFor();
      await ask.getByRole('button', { name: 'Mark pending' }).click();
      const failed = await ask.getByText(/Could not mark ALP-1 pending/).waitFor({ timeout: 6000 }).then(() => true, () => false);
      // The UI sends a free-text party as reason_type "person" without a member; the server of 4.0.3 answers 400
      // ("member_id is required when reason_type is 'person'"). Recorded, not asserted: the two servers are compared on it.
      s.note('a free-text party is refused', failed);
      if (failed) {
        await ask.getByRole('button', { name: 'Cancel' }).click();
        await ask.waitFor({ state: 'detached' });
        await p.keyboard.press('p');
        await ask.waitFor();
        await ask.getByRole('button', { name: 'Waiting on a person or party' }).click();
        // a member of the project is picked from the list of names
        await ask.getByTitle('Me', { exact: true }).click();
        await ask.getByRole('textbox', { name: 'What is it waiting for?' }).fill('The design review');
        await ask.getByRole('button', { name: 'Mark pending' }).click();
      }
      await ask.waitFor({ state: 'detached' });
      await d.getByText(/Pending since/).first().waitFor();
      await d.getByText(/The design review/).first().waitFor();
      await p.keyboard.press('p');
      const back = p.getByRole('dialog', { name: 'Resume ALP-1?' });
      await back.getByText('Removes the Pending flag. It stays in Backlog.').waitFor();
      await back.getByRole('button', { name: 'Resume', exact: true }).click();
      await back.waitFor({ state: 'detached' });
      await d.getByText(/Pending since/).first().waitFor({ state: 'detached' });
      await closeTicket(s);
    }, { expectConsole: true });

    await s.step('keyboard: Alt+N adds an idea from anywhere, / jumps to the settings search', async () => {
      await home(s);
      await p.keyboard.press('Alt+n');
      const d = p.getByRole('dialog', { name: 'Quick idea' });
      await d.waitFor();
      await d.getByRole('textbox', { name: 'Idea title' }).fill('Keyboard idea');
      await d.getByRole('button', { name: 'Add to Inbox' }).click();
      await d.waitFor({ state: 'detached' });
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await p.getByText('Keyboard idea').first().waitFor();
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('searchbox', { name: 'Search settings' }).waitFor();
      await p.getByRole('heading', { name: /./, level: 1 }).first().click();
      await p.keyboard.press('/');
      await until(async () => (await p.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'Search settings', 'the search box focused');
    });

    await s.step('keyboard shortcuts window: searchable list (opened by the desktop menu command)', async () => {
      // The window belongs to the desktop app's Help menu; the app listens for the menu through window.electronAPI.
      // A second page gets a minimal stand-in of that bridge (only the command channel) and the menu command is sent.
      const q = await s.newPage();
      await q.addInitScript(() => {
        window.electronAPI = { platform: 'linux', onAppCommand(cb) { window.__menu = cb; return () => {}; } };
      });
      await q.goto(s.server.base);
      await q.getByRole('complementary', { name: 'Project navigation' }).waitFor({ timeout: 20000 });
      await until(async () => q.evaluate(() => typeof window.__menu === 'function'), 'the menu bridge');
      await q.evaluate(() => window.__menu({ command: 'shortcuts' }));
      const d = q.getByRole('dialog', { name: 'Keyboard Shortcuts' });
      await d.waitFor();
      for (const g of ['Go to', 'Create', 'Search', 'AI', 'Docs editor', 'On a ticket', 'Idea Inbox triage']) await d.getByRole('heading', { name: g, level: 3 }).waitFor();
      await d.getByText(/Ask AI \(open or close the Board AI\)/).waitFor();
      await d.getByText(/Quick add an idea/).waitFor();
      await d.getByRole('searchbox', { name: 'Search shortcuts and commands' }).fill('publish');
      await d.getByText(/^Publish/).first().waitFor();
      await until(async () => (await d.getByText(/Quick add an idea/).count()) === 0, 'the search narrowing the list').catch(async (e) => { throw new Error(`${e.message}: ${(await d.innerText()).replace(/\s+/g, ' ').slice(0, 300)} / ${await d.getByRole('searchbox').inputValue()}`); });
      await d.getByRole('searchbox', { name: 'Search shortcuts and commands' }).fill('zzzz');
      await d.getByText(/No shortcut matches/).waitFor();
      // a toast sent by the same menu channel
      await q.evaluate(() => window.__menu({ command: 'toast', variant: 'success', title: 'Menu says hello', message: 'From the stand-in menu' }));
      await q.getByText('Menu says hello').waitFor();
      await q.close();
    });

    // ---------------------------------------------------------------- notification extras
    await s.step('follow bell: the levels of a ticket and its mute show in the notification settings', async () => {
      await home(s);
      const d = await openTicket(s, 'ALP-1');
      await d.getByRole('button', { name: 'Follow this ticket' }).click();
      const items = ['Follow', 'Everything', 'Only mentions and questions', 'Muted', 'Mute for 1 hour'];
      for (const i of items) await p.getByRole('menuitem', { name: new RegExp(`^${i}`) }).waitFor();
      await p.getByRole('menuitem', { name: /^Everything/ }).click();
      await d.getByRole('button', { name: 'Following this ticket' }).waitFor();
      await d.getByRole('button', { name: 'Following this ticket' }).click();
      await checked(p.getByRole('menuitem', { name: /^Everything/ })).waitFor().catch(() => {});
      await p.getByRole('menuitem', { name: /^Muted/ }).click();
      await closeTicket(s);
      await openSettings('Notifications');
      await p.getByText(/Muted \(1\)/).waitFor();
      await p.getByText(/ALP-1/).first().waitFor();
    });

    await s.step('notification settings: switches, quiet hours, sound, reminder and retention are kept', async () => {
      const finished = p.getByRole('switch', { name: 'An AI finished work: in app' });
      await checked(finished).waitFor();
      await checked(p.getByRole('switch', { name: 'A question from an AI: in app (always on)' })).waitFor();
      await p.getByRole('switch', { name: 'A question from an AI: in app (always on)' }).and(p.locator(':disabled')).waitFor();
      await finished.click();
      await unchecked(finished).waitFor();
      await p.getByRole('switch', { name: 'Sound' }).click();
      await p.getByRole('switch', { name: 'Sound' }).and(p.locator('[aria-checked="false"]')).waitFor();
      await p.getByRole('combobox', { name: 'Remind me if unanswered' }).selectOption({ label: 'After 30 min' });
      await p.getByRole('combobox', { name: 'Keep notifications for' }).selectOption({ label: '180 days' });
      await p.getByRole('combobox', { name: 'Which sound' }).selectOption({ label: 'Bell' });
      await p.getByRole('textbox', { name: 'Quiet hours start' }).fill('23:30');
      await p.getByRole('textbox', { name: 'Quiet hours start' }).blur();
      await p.getByRole('button', { name: 'Sat' }).click();
      await s.settle();
      await openSettings('Notifications');
      await unchecked(p.getByRole('switch', { name: 'An AI finished work: in app' })).waitFor();
      await unchecked(p.getByRole('switch', { name: 'Sound' })).waitFor();
      await until(async () => (await p.getByRole('combobox', { name: 'Remind me if unanswered' }).inputValue()) === '30', 'the reminder of 30 min');
      await until(async () => (await p.getByRole('combobox', { name: 'Keep notifications for' }).inputValue()) === '180', 'the retention of 180 days');
      await until(async () => (await p.getByRole('textbox', { name: 'Quiet hours start' }).inputValue()) === '23:30', 'quiet hours from 23:30');
      await p.getByRole('button', { name: 'Sat' }).and(p.locator('[aria-pressed="true"]')).waitFor();
      await p.getByText('What a switch off actually does').waitFor();
      // put the defaults back
      await p.getByRole('switch', { name: 'An AI finished work: in app' }).click();
      await p.getByRole('switch', { name: 'Sound' }).click();
      await checked(p.getByRole('switch', { name: 'Sound' })).waitFor();
    });

    await s.step('toast: a mention of the person pops up as a toast and can be closed', async () => {
      await home(s);
      await openDocs(s);
      await newDocPage(s, 'Handbook');
      await setMarkdown(s, '# Hi\n\nBody text.\n');
      await publishDoc(s, 'first');
      await p.getByRole('textbox', { name: 'Write a comment on this page…' }).click();
      await p.keyboard.type('Please check this @Me');
      await p.getByRole('listbox', { name: 'Mention a member' }).waitFor();
      await p.keyboard.press('Enter');
      await Promise.all([
        p.waitForResponse((r) => r.request().method() === 'POST' && /comments/.test(r.url()), { timeout: 8000 }),
        p.getByRole('button', { name: 'Comment', exact: true }).click(),
      ]);
      // the board polls for new notifications: the toast comes with the next look
      const toast = p.getByRole('alert').filter({ hasText: /mentioned you/ });
      await toast.first().waitFor({ timeout: 45000 });
      await toast.first().getByRole('button', { name: 'Close notification' }).click();
      await toast.first().waitFor({ state: 'detached' });
    });
  },
};
