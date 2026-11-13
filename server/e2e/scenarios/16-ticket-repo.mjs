import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureProject, createTicket, openTicket, closeTicket, card } from '../lib/ui.mjs';

export default {
  name: 'Ticket repo: link a repository, branches, branch graph, workspace',
  async run(s) {
    const p = s.page;
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    const repo = s.server.dirs.repo;
    // Local helper (the harness has none): a git command in the small repository the server was started with.
    const git = (...a) => execFileSync('git', a, {
      cwd: repo, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' },
    }).toString();
    const tab = (name) => dlg().getByRole('button', { name: new RegExp(`^${name}`) });
    const backToTicket = async () => {
      await dlg().getByRole('button', { name: 'ALP-1', exact: true }).click();
      await dlg().getByRole('heading', { level: 2 }).waitFor();
    };

    await s.step('set up: project and two tickets', async () => {
      await ensureProject(s);
      await createTicket(s, { title: 'Fix the adder' });
      await createTicket(s, { title: 'Second ticket' });
      await card(p, 'ALP-1').waitFor();
    });

    // ---- link the repository in the project settings
    await s.step('without a repository the Branches tab has no graph to draw', async () => {
      await openTicket(s, 'ALP-1');
      await tab('Branches').click();
      await dlg().getByRole('button', { name: 'Create branch' }).waitFor();
      await backToTicket();
      await closeTicket(s);
    });
    await s.step('link the project to the git repository in Settings', async () => {
      await p.getByRole('button', { name: 'Settings', exact: true }).click();
      await p.getByRole('heading', { name: 'Repositories', level: 1 }).waitFor();
      await p.getByRole('textbox', { name: 'Repository path' }).fill('/no/such/folder');
      await p.getByRole('button', { name: 'Apply' }).click();
      // a path that is not a git repository is refused with a message
      await p.locator('[data-testid="repo-settings"]').getByText(/repo|git|path|exist|folder/i).first().waitFor();
      await p.getByRole('textbox', { name: 'Repository path' }).fill(repo);
      await p.getByRole('button', { name: 'Apply' }).click();
      await p.getByText('Repository linked').first().waitFor();
    }, { expectConsole: true });
    await s.step('set the worktree template and the worktree switch, then go back', async () => {
      await p.getByRole('textbox', { name: 'Worktree path template' }).fill('../wt/{project}/{ticket_id}-{branch}');
      await p.getByRole('button', { name: 'Apply' }).click();
      // saved: the Apply button goes away once the stored value equals the field
      await p.getByRole('button', { name: 'Apply' }).waitFor({ state: 'detached' });
      await p.getByRole('switch', { name: 'Create a worktree by default' }).click();
      await p.getByRole('switch', { name: 'Create a worktree by default', checked: true }).waitFor();
      // off again: the branches below are made without worktrees
      await p.getByRole('switch', { name: 'Create a worktree by default' }).click();
      await p.getByRole('switch', { name: 'Create a worktree by default', checked: false }).waitFor();
      await p.getByRole('button', { name: 'Back to board' }).click();
      await card(p, 'ALP-1').waitFor();
    });

    // ---- branches
    await s.step('the Branches tab shows the repository history', async () => {
      await openTicket(s, 'ALP-1');
      await tab('Branches').click();
      await dlg().getByText('1 commits').waitFor();
      await dlg().getByRole('button', { name: /^HEAD main first/ }).waitFor();
      await dlg().getByRole('group', { name: 'Graph detail' }).getByRole('button', { name: 'Overview' }).waitFor();
    });
    await s.step('create a branch: the name is required', async () => {
      await dlg().getByRole('button', { name: 'Create branch' }).click();
      const m = p.getByRole('dialog', { name: 'New branch' });
      await m.getByRole('button', { name: 'Create branch' }).isDisabled().then((d) => { if (!d) throw new Error('Create branch must wait for a name'); });
      await m.getByRole('button', { name: 'Cancel' }).click();
      await m.waitFor({ state: 'detached' });
    });
    await s.step('create the branch feature/fix-add from main', async () => {
      await dlg().getByRole('button', { name: 'Create branch' }).click();
      const m = p.getByRole('dialog', { name: 'New branch' });
      await m.getByRole('textbox', { name: 'Name' }).fill('feature/fix-add');
      await m.getByRole('button', { name: 'Create branch' }).click();
      await m.waitFor({ state: 'detached' });
      await p.getByText('Branch created · feature/fix-add').waitFor();
      await dlg().getByText(/0 ahead, 0 behind/).waitFor();
      if (!git('branch', '--list', 'feature/fix-add').includes('feature/fix-add')) throw new Error('the branch is not in the git repository');
    });
    await s.step('a commit on the branch shows as 1 ahead in the graph', async () => {
      git('checkout', '-q', 'feature/fix-add');
      fs.writeFileSync(path.join(repo, 'calc.py'), 'def add(a, b):\n    return a + b\n');
      git('commit', '-qam', 'Fix add');
      git('checkout', '-q', 'main');
      // leave the tab and come back so the branch status is read again
      await backToTicket();
      await tab('Branches').click();
      await dlg().getByText('2 commits').waitFor();
      await dlg().getByText(/1 ahead, 0 behind/).waitFor();
      await dlg().getByRole('button', { name: /^feature\/fix-add Fix add/ }).waitFor();
    });
    await s.step('All commits, then the commit details with its diff', async () => {
      await dlg().getByRole('button', { name: 'All commits' }).click();
      await dlg().getByRole('button', { name: /^feature\/fix-add Fix add/ }).click();
      await dlg().getByRole('button', { name: 'Close commit details' }).waitFor();
      await dlg().getByText('1 file changed').waitFor();
      await dlg().getByText('calc.py').first().waitFor();
      await dlg().getByRole('button', { name: 'Close commit details' }).click();
      await dlg().getByRole('button', { name: 'Close commit details' }).waitFor({ state: 'detached' });
      await dlg().getByRole('button', { name: 'Overview' }).click();
    });
    await s.step('the branch list: origin, ahead/behind and status', async () => {
      await dlg().getByRole('button', { name: 'List', exact: true }).click();
      await dlg().getByText('Origin / Ahead-Behind / Worktree').waitFor();
      await dlg().getByText(/1 ahead, 0 behind/).waitFor();
      await dlg().getByText('Baseline', { exact: true }).waitFor();
    });
    await s.step('rename the branch', async () => {
      await dlg().getByRole('button', { name: 'Rename', exact: true }).click();
      const r = dlg().getByRole('dialog');
      await r.getByRole('heading', { name: 'Rename branch' }).waitFor();
      await r.getByRole('textbox', { name: 'New branch name' }).fill('feature/fix-adder');
      await r.getByRole('button', { name: 'Rename', exact: true }).click();
      await dlg().getByText('feature/fix-adder').first().waitFor();
      if (!git('branch', '--list', 'feature/fix-adder').includes('feature/fix-adder')) throw new Error('the git branch was not renamed');
    });
    await s.step('check the branch out in the repository', async () => {
      await dlg().getByRole('button', { name: 'Checkout' }).click();
      await p.waitForFunction(() => true);
      await s.settle();
      const cur = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
      if (cur !== 'feature/fix-adder') throw new Error(`HEAD is ${cur}, expected feature/fix-adder`);
      git('checkout', '-q', 'main');
    });
    await s.step('Merge is refused while git still has commits that are not in main', async () => {
      await dlg().getByRole('button', { name: 'Merge', exact: true }).click();
      await p.getByText(/still has commits that are not in 'main'/).first().waitFor();
      await dlg().getByRole('button', { name: 'Merge', exact: true }).waitFor();
    }, { expectConsole: true });
    await s.step('merge it in git, then mark the branch as merged', async () => {
      git('merge', '-q', '--no-ff', '-m', 'Merge feature/fix-adder', 'feature/fix-adder');
      await dlg().getByRole('button', { name: 'Merge', exact: true }).click();
      await dlg().getByText('Merged', { exact: true }).waitFor();
      await dlg().getByRole('button', { name: 'Merge', exact: true }).waitFor({ state: 'detached' });
    });
    await s.step('the graph shows the merge', async () => {
      await dlg().getByRole('button', { name: 'Graph', exact: true }).click();
      await dlg().getByRole('button', { name: 'All commits' }).click();
      await dlg().getByRole('button', { name: /Merge feature\/fix-adder/ }).waitFor();
      await dlg().getByRole('img', { name: 'Commit graph' }).waitFor();
    });
    await s.step('delete the branch (the dialog offers to delete the git branch too)', async () => {
      await dlg().getByRole('button', { name: 'List', exact: true }).click();
      await dlg().getByRole('button', { name: 'Delete branch' }).click();
      await p.getByText('Are you sure you want to delete branch feature/fix-adder?').waitFor();
      await p.getByText('Also delete the git branch').click();
      await p.getByRole('button', { name: 'Delete branch' }).last().click();
      await p.getByText('Are you sure you want to delete branch').waitFor({ state: 'detached' });
      await dlg().getByText('feature/fix-adder').waitFor({ state: 'detached' });
      if (git('branch', '--list', 'feature/fix-adder').trim()) throw new Error('the git branch should be gone');
      await dlg().getByText('main', { exact: true }).first().waitFor();
    });

    // ---- workspace
    await s.step('the Workspace tab: the folder does not exist yet, create it', async () => {
      await backToTicket();
      await tab('Workspace').click();
      await dlg().getByText('This ticket has no workspace folder yet.').waitFor({ timeout: 15000 });
      await dlg().getByRole('button', { name: 'Create folder' }).click();
      await dlg().getByText('0 files · 0 B', { exact: true }).waitFor();
      await dlg().getByText(/No files yet\. The folder exists/).waitFor();
      if (!fs.existsSync(path.join(s.server.dirs.workspace, 'ALP-1'))) throw new Error('the workspace folder was not created on disk');
    });
    await s.step('files written outside the UI show up after Refresh', async () => {
      const root = path.join(s.server.dirs.workspace, 'ALP-1');
      fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\nhello');
      fs.mkdirSync(path.join(root, 'docs'));
      fs.writeFileSync(path.join(root, 'docs', 'a.txt'), 'aaa');
      await dlg().getByRole('button', { name: 'Refresh' }).click();
      await dlg().getByText('2 files · 16 B', { exact: true }).waitFor();
      await dlg().getByRole('button', { name: 'Preview notes.md' }).first().waitFor();
      await dlg().getByRole('button', { name: 'Preview docs/a.txt' }).first().waitFor();
    });
    await s.step('upload a file', async () => {
      const chooser = p.waitForEvent('filechooser');
      await dlg().getByRole('button', { name: 'Upload' }).click();
      await (await chooser).setFiles({ name: 'upload.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded text') });
      await dlg().getByRole('button', { name: 'Preview upload.txt' }).first().waitFor();
      await dlg().getByText(/^3 files/).waitFor();
      if (fs.readFileSync(path.join(s.server.dirs.workspace, 'ALP-1', 'upload.txt'), 'utf8') !== 'uploaded text') throw new Error('upload content differs on disk');
    });
    await s.step('preview a file', async () => {
      await dlg().getByRole('button', { name: 'Preview notes.md' }).first().click();
      await p.getByText('hello').first().waitFor();
      s.note('preview shown', await p.getByRole('dialog').last().innerText());
    });
    await s.step('delete a file after confirming', async () => {
      await dlg().getByRole('button', { name: 'Delete upload.txt' }).click();
      const c = p.getByRole('dialog', { name: 'Confirm delete' });
      await c.waitFor();
      await c.getByRole('button', { name: /^Delete/ }).click();
      await c.waitFor({ state: 'detached' });
      await dlg().getByRole('button', { name: 'Preview upload.txt' }).first().waitFor({ state: 'detached' });
      if (fs.existsSync(path.join(s.server.dirs.workspace, 'ALP-1', 'upload.txt'))) throw new Error('file still on disk');
    });
    await s.step('change how long the folder is kept', async () => {
      await dlg().getByTestId('retention-chip').click();
      const menu = p.getByTestId('retention-menu');
      await menu.waitFor();
      s.note('retention options', await menu.innerText());
      await menu.getByRole('menuitemradio').nth(1).click();
      await menu.waitFor({ state: 'detached' });
    });
  },
};
