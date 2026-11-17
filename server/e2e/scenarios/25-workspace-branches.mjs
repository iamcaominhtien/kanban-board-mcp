import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureProject, createTicket, openTicket, closeTicket, card, home } from '../lib/ui.mjs';

// Ticket workspace folder (new folder, download, copy path, move, open folder, the sweep from Settings) and the
// branch graph / repository field (per-ticket repo, Reset to project, Branch from, worktree path, Load older commits).
//
// "Open folder" would start `xdg-open` on the machine; the step runs only when that program is missing (the server then
// answers with an error and the UI says so), otherwise it is skipped so no file manager is launched by a test.
export default {
  name: 'Workspace and branches: folders, move, download, sweep, ticket repo, branch graph paging',
  async run(s) {
    const p = s.page;
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    const repo = s.server.dirs.repo;
    const root = s.server.dirs.root;
    const ws = s.server.dirs.workspace;
    const env = { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' };
    // Local helper: a git command in the given repository (default: the one the project is linked to).
    const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe', env }).toString();
    const gitIn = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', env }).toString();
    const tab = (name) => dlg().getByRole('button', { name: new RegExp(`^${name}`) });
    const backToTicket = async () => {
      await dlg().getByRole('button', { name: 'ALP-1', exact: true }).click();
      await dlg().getByRole('heading', { level: 2 }).waitFor();
    };
    const hasProgram = (name) => {
      try { execFileSync('which', [name], { stdio: 'ignore' }); return true; } catch { return false; }
    };
    await p.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: s.server.base }).catch(() => {});

    await s.step('set up: project, three tickets and the linked repository', async () => {
      await ensureProject(s);
      await createTicket(s, { title: 'Workspace ticket' });
      await createTicket(s, { title: 'Target ticket' });
      await createTicket(s, { title: 'Old ticket' });
      await card(p, 'ALP-3').waitFor();
      await p.getByRole('button', { name: 'Settings', exact: true }).click();
      await p.getByRole('heading', { name: 'Repositories', level: 1 }).waitFor();
      await p.getByRole('textbox', { name: 'Repository path' }).fill(repo);
      await p.getByRole('button', { name: 'Apply' }).click();
      await p.getByText('Repository linked').first().waitFor();
      await p.getByRole('button', { name: 'Back to board' }).click();
      await card(p, 'ALP-1').waitFor();
    });

    // ---- the repository field of a ticket
    const other = path.join(root, 'other-repo');
    await s.step('the ticket repository field starts on the project repository', async () => {
      fs.mkdirSync(other);
      gitIn(other, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(other, 'other.txt'), 'x');
      gitIn(other, 'add', '.');
      gitIn(other, 'commit', '-q', '-m', 'other first');
      await openTicket(s, 'ALP-1');
      await dlg().getByRole('button', { name: /^Branch: main/ }).or(dlg().getByTitle(/^Branch: /)).first().click();
      await dlg().getByText('Branches of ALP-1').waitFor();
      await dlg().getByText('Local Git repo').waitFor();
      await dlg().getByText('project', { exact: true }).waitFor();
      await dlg().getByText(repo).waitFor();
    });
    await s.step('Change: set a repository of its own for this ticket', async () => {
      await dlg().getByRole('button', { name: 'Change', exact: true }).click();
      const input = dlg().getByPlaceholder('/absolute/path/to/local/git-repo');
      if ((await input.inputValue()) !== repo) throw new Error('the field should start on the project repository');
      await input.fill(other);
      await dlg().getByRole('button', { name: 'Save', exact: true }).click();
      await p.getByText('Ticket repository set').waitFor();
      await dlg().getByText('override', { exact: true }).waitFor();
      await dlg().getByText(other).waitFor();
    });
    await s.step('the Branches tab now draws the history of that repository', async () => {
      await tab('Branches').click();
      await dlg().getByRole('button', { name: /^HEAD main other first/ }).waitFor();
      await backToTicket();
    });
    await s.step('Reset to project: back on the project repository', async () => {
      await dlg().getByTitle(/^Branch: /).first().click();
      await dlg().getByRole('button', { name: 'Change', exact: true }).click();
      await dlg().getByRole('button', { name: 'Reset to project' }).click();
      await p.getByText('Using project repository').waitFor();
      await dlg().getByText('project', { exact: true }).waitFor();
      await dlg().getByText(repo).waitFor();
      await dlg().getByRole('button', { name: 'Change', exact: true }).waitFor();
      await closeTicket(s);
    });

    // ---- branches
    await s.step('the Branches tab: the graph and its detail switch', async () => {
      await openTicket(s, 'ALP-1');
      await tab('Branches').click();
      await dlg().getByRole('button', { name: /^HEAD main first/ }).waitFor();
      await dlg().getByRole('group', { name: 'Graph detail' }).getByRole('button', { name: 'All commits' }).waitFor();
      await dlg().getByRole('img', { name: 'Commit graph' }).waitFor();
      // no branch is linked to the ticket yet: the legend ("Branches of this ticket") is drawn once there is one
      if (await dlg().getByLabel('Branches of this ticket').count()) throw new Error('the legend needs a branch of the ticket');
    });
    await s.step('many commits: the graph shows 80 and offers Load older commits', async () => {
      for (let i = 1; i <= 85; i++) git('commit', '-q', '--allow-empty', '-m', `Commit ${i}`);
      // (the graph always reaches back to the fork point of a branch, so this runs before any branch is made)
      await backToTicket();
      await tab('Branches').click();
      await dlg().getByRole('button', { name: 'All commits' }).click();
      await dlg().getByText(/^80 commits · older history not loaded/).waitFor();
      await dlg().getByRole('button', { name: 'Load older commits' }).waitFor();
    });
    await s.step('Load older commits brings the rest and the button goes away', async () => {
      await dlg().getByRole('button', { name: 'Load older commits' }).click();
      await dlg().getByRole('button', { name: 'Load older commits' }).waitFor({ state: 'detached' });
      await dlg().getByText('86 commits', { exact: true }).waitFor();
      await dlg().getByRole('button', { name: /^main first/ }).or(dlg().getByRole('button', { name: /first/ })).first().waitFor();
    });
    await s.step('create a branch from the dropdown with its own worktree path, then reset the path to the template', async () => {
      await dlg().getByRole('button', { name: 'Create branch' }).click();
      const m = p.getByRole('dialog', { name: 'New branch' });
      await m.getByRole('textbox', { name: 'Name' }).fill('feature/picked');
      await m.getByRole('button', { name: /^main/ }).click();
      const opt = m.getByRole('option', { name: 'main' });
      await opt.waitFor();
      await opt.click();
      await opt.waitFor({ state: 'detached' });
      await m.getByRole('checkbox', { name: 'Create git worktree for this branch' }).check();
      const wtPath = m.getByPlaceholder('../worktrees/{project}/{ticket_id}-{branch}');
      const template = await wtPath.inputValue();
      await wtPath.fill('../wt-custom/picked');
      await m.getByRole('button', { name: 'Reset to template' }).click();
      await m.getByRole('button', { name: 'Reset to template' }).waitFor({ state: 'detached' });
      if ((await wtPath.inputValue()) !== template) throw new Error('Reset to template did not bring the template path back');
      await wtPath.fill('../wt-custom/picked');
      await m.getByRole('button', { name: 'Create branch' }).click();
      await m.waitFor({ state: 'detached' });
      await p.getByText('Branch & worktree created · feature/picked').waitFor();
      if (!fs.existsSync(path.join(root, 'wt-custom', 'picked'))) throw new Error('the worktree was not made at the typed path');
      if (!/wt-custom\/picked/.test(git('worktree', 'list'))) throw new Error('git does not list the worktree');
      await dlg().getByLabel('Branches of this ticket').getByText('feature/picked').waitFor();
      await dlg().getByRole('button', { name: 'All commits' }).click();
    });
    await s.step('Commit details of an old commit', async () => {
      await dlg().getByRole('button', { name: /Commit 85/ }).first().click();
      const panel = dlg().getByLabel('Commit details');
      await panel.waitFor();
      await panel.getByText(/Commit 85/).first().waitFor();
      await dlg().getByRole('button', { name: 'Close commit details' }).first().click();
      await panel.waitFor({ state: 'detached' });
      await closeTicket(s);
    });

    // ---- workspace
    await s.step('Workspace tab: create the folder, then a folder inside it', async () => {
      await openTicket(s, 'ALP-1');
      await tab('Workspace').click();
      await dlg().getByRole('button', { name: 'Create folder' }).click();
      await dlg().getByText(/^0 files · 0 B/i).waitFor();
      await dlg().getByRole('button', { name: 'New folder', exact: true }).click();
      await dlg().getByRole('textbox', { name: 'New folder name' }).fill('assets');
      await dlg().getByRole('button', { name: 'Create', exact: true }).click();
      await dlg().getByRole('textbox', { name: 'New folder name' }).waitFor({ state: 'detached' });
      await dlg().getByText('assets', { exact: true }).first().waitFor();
      if (!fs.statSync(path.join(ws, 'ALP-1', 'assets')).isDirectory()) throw new Error('the folder is not on disk');
    });
    await s.step('select the folder as the target and make a nested folder', async () => {
      await dlg().getByTitle('Select as the target for Upload / New folder').first().click();
      await dlg().getByText(/in \/assets/).waitFor();
      await dlg().getByRole('button', { name: 'New folder', exact: true }).click();
      await dlg().getByRole('textbox', { name: 'New folder name' }).fill('sub');
      await dlg().getByRole('button', { name: 'Create', exact: true }).click();
      await dlg().getByRole('textbox', { name: 'New folder name' }).waitFor({ state: 'detached' });
      if (!fs.statSync(path.join(ws, 'ALP-1', 'assets', 'sub')).isDirectory()) throw new Error('the nested folder is not on disk');
      await dlg().getByRole('button', { name: /in \/assets/ }).click();
      await dlg().getByText(/in \/assets/).waitFor({ state: 'detached' });
    });
    await s.step('Download a file: the browser gets the same bytes', async () => {
      fs.writeFileSync(path.join(ws, 'ALP-1', 'report.txt'), 'quarterly numbers');
      await dlg().getByRole('button', { name: 'Refresh' }).click();
      const link = dlg().getByRole('link', { name: 'Download report.txt' });
      await link.waitFor();
      const [dl] = await Promise.all([p.waitForEvent('download'), link.click()]);
      if (dl.suggestedFilename() !== 'report.txt') throw new Error(`downloaded as ${dl.suggestedFilename()}`);
      const got = fs.readFileSync(await dl.path(), 'utf8');
      if (got !== 'quarterly numbers') throw new Error(`downloaded content: ${got}`);
    });
    await s.step('Copy path puts the folder path on the clipboard', async () => {
      await dlg().getByRole('button', { name: 'Copy path' }).click();
      await dlg().getByTitle('Copied!').waitFor();
      const text = await p.evaluate(() => navigator.clipboard.readText());
      if (text !== path.join(ws, 'ALP-1')) throw new Error(`clipboard: ${text}`);
    });
    await s.step('Confirm delete: Cancel keeps the folder, Delete removes it and what is inside', async () => {
      await dlg().getByRole('button', { name: 'Delete assets', exact: true }).click();
      const c = p.getByRole('dialog', { name: 'Confirm delete' });
      await c.getByText('and everything inside it').waitFor();
      await c.getByRole('button', { name: 'Cancel' }).click();
      await c.waitFor({ state: 'detached' });
      if (!fs.existsSync(path.join(ws, 'ALP-1', 'assets'))) throw new Error('Cancel must keep the folder');
      await dlg().getByRole('button', { name: 'Delete assets', exact: true }).click();
      await c.getByRole('button', { name: 'Delete', exact: true }).click();
      await c.waitFor({ state: 'detached' });
      await dlg().getByRole('button', { name: 'Delete assets', exact: true }).waitFor({ state: 'detached' });
      if (fs.existsSync(path.join(ws, 'ALP-1', 'assets'))) throw new Error('the folder is still on disk');
    });
    await s.step('Open folder: with no file manager the app says so and copies the path instead', async () => {
      if (hasProgram('xdg-open')) {
        s.note('open folder skipped', 'xdg-open exists here; the test would launch a file manager');
        return;
      }
      await dlg().getByRole('button', { name: 'Open folder' }).click();
      await dlg().getByRole('alert').getByText(/No file manager available on this machine.*path copied instead/).waitFor();
      await dlg().getByRole('alert').getByRole('button', { name: 'Dismiss' }).click();
      await dlg().getByRole('alert').waitFor({ state: 'detached' });
    }, { expectConsole: true });
    await s.step('Move to ticket: an unknown ticket is refused', async () => {
      await dlg().getByRole('button', { name: 'Move to ticket…' }).click();
      const to = dlg().getByRole('textbox', { name: 'Ticket to move the workspace to' });
      const mv = dlg().getByRole('button', { name: 'Move', exact: true });
      if (!(await mv.isDisabled())) throw new Error('Move must wait for a ticket ID');
      await to.fill('ALP-99');
      await mv.click();
      await dlg().getByRole('alert').waitFor();
      s.note('move to unknown ticket', await dlg().getByRole('alert').innerText());
      if (!fs.existsSync(path.join(ws, 'ALP-1', 'report.txt'))) throw new Error('a refused move must leave the files');
      await dlg().getByRole('button', { name: 'Cancel', exact: true }).click();
      await to.waitFor({ state: 'detached' });
    }, { expectConsole: true });
    await s.step('Move to ticket: every file goes to ALP-2', async () => {
      await dlg().getByRole('button', { name: 'Move to ticket…' }).click();
      await dlg().getByRole('textbox', { name: 'Ticket to move the workspace to' }).fill('alp-2');
      await dlg().getByRole('button', { name: 'Move', exact: true }).click();
      await dlg().getByRole('alert').getByText(/^Workspace moved to ALP-2/).waitFor();
      if (fs.existsSync(path.join(ws, 'ALP-1', 'report.txt'))) throw new Error('the file is still in ALP-1');
      if (fs.readFileSync(path.join(ws, 'ALP-2', 'report.txt'), 'utf8') !== 'quarterly numbers') throw new Error('the file is not in ALP-2');
      await closeTicket(s);
      await openTicket(s, 'ALP-2');
      await tab('Workspace').click();
      await dlg().getByRole('button', { name: 'Preview report.txt' }).first().waitFor();
      await closeTicket(s);
    });

    // ---- Open Settings from a ticket while the workspace is off
    await s.step('with the workspace off the ticket offers Open Settings', async () => {
      await p.getByRole('button', { name: 'Settings', exact: true }).click();
      await p.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Storage & backup', exact: true }).click();
      await p.getByRole('heading', { name: 'Workspace', level: 2 }).waitFor();
      await p.getByRole('switch', { name: 'Enable workspace' }).click();
      await p.getByText(/Turned off: the Workspace tab is hidden on every ticket/).waitFor();
      await s.settle();
      await home(s);
      await openTicket(s, 'ALP-1');
      await tab('Workspace').click();
      await dlg().getByText("Workspace isn't set up yet").waitFor();
      await dlg().getByRole('button', { name: 'Open Settings' }).click();
      await p.getByRole('heading', { level: 1 }).filter({ hasText: /Storage|Settings|Workspace/ }).first().waitFor();
      await p.getByRole('heading', { name: 'Workspace', level: 2 }).waitFor();
      await p.getByRole('switch', { name: 'Enable workspace' }).click();
      await p.getByRole('switch', { name: 'Enable workspace' }).and(p.locator('[aria-checked="true"]')).waitFor();
      await s.settle();
    });

    // ---- the sweep
    await s.step('an old, Done ticket with a stale folder: set up its workspace and retention', async () => {
      await home(s);
      await openTicket(s, 'ALP-3');
      await tab('Workspace').click();
      await dlg().getByRole('button', { name: 'Create folder' }).click();
      await dlg().getByText(/^0 files/i).waitFor();
      fs.writeFileSync(path.join(ws, 'ALP-3', 'old.txt'), 'old');
      await dlg().getByRole('button', { name: 'Refresh' }).click();
      await dlg().getByRole('button', { name: 'Preview old.txt' }).first().waitFor();
      await dlg().getByTestId('retention-chip').click();
      await p.getByTestId('retention-menu').getByRole('menuitemradio', { name: 'Auto-delete after 7 days' }).click();
      await dlg().getByTestId('retention-chip').getByText(/7d/).waitFor();
      await dlg().getByRole('button', { name: 'ALP-3', exact: true }).click();
      await dlg().getByRole('heading', { level: 2 }).waitFor();
      await dlg().getByRole('complementary').getByRole('button', { name: 'Backlog', exact: true }).click();
      await p.getByRole('listbox').getByText('Done', { exact: true }).click();
      await dlg().getByRole('complementary').getByRole('button', { name: 'Done', exact: true }).waitFor();
      await closeTicket(s);
      // ten days ago: files first, then the folder itself
      const old = new Date(Date.now() - 10 * 86400 * 1000);
      fs.utimesSync(path.join(ws, 'ALP-3', 'old.txt'), old, old);
      fs.utimesSync(path.join(ws, 'ALP-3'), old, old);
    });
    await s.step('Settings > Clean now… lists the folder that is due, ALP-1 and ALP-2 (open tickets) stay out', async () => {
      await p.getByRole('button', { name: 'Settings', exact: true }).click();
      await p.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Storage & backup', exact: true }).click();
      await p.getByRole('button', { name: /Clean now/ }).click();
      await p.getByRole('status').getByText(/^1 folder\(s\) would be deleted: ALP-3\./).waitFor();
      if (!fs.existsSync(path.join(ws, 'ALP-3', 'old.txt'))) throw new Error('the preview must not delete anything');
    });
    await s.step('Delete them: the folder is gone from disk, the others stay', async () => {
      await p.getByRole('button', { name: 'Delete them' }).click();
      await p.getByText('Deleted 1 folder(s)').waitFor();
      await p.getByRole('button', { name: 'Delete them' }).waitFor({ state: 'detached' });
      if (fs.existsSync(path.join(ws, 'ALP-3'))) throw new Error('ALP-3 folder is still on disk');
      if (!fs.existsSync(path.join(ws, 'ALP-2', 'report.txt'))) throw new Error('an open ticket lost its folder');
      await p.getByRole('button', { name: /Clean now/ }).click();
      await p.getByRole('status').getByText('Nothing is due for cleanup.').waitFor();
    });
  },
};
