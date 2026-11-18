import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { home, ensureProject, createTicket } from '../lib/ui.mjs';

// A ticket's AI activity, end to end through the stand-in CLI (server/crates/fake-claude): the run card, then the
// hand-over of the ticket's worktree (ui/src/components/ai/code/TicketHandover.tsx) with what the server says: the
// branch and what is left uncommitted, the outputs moved to the Workspace, the code committed, the route changed for
// this ticket (a pull request, the branch left, back to the project's), Merge on this machine, a merge stopped by a
// conflict with main, and a worktree discarded. The repository has no remote, so the board guesses "merge on this
// machine"; a pull request cannot be opened here (no GitHub), so the pull request route is chosen but not taken.
export default {
  name: 'Ticket AI activity: run card, worktree hand-over (commit, outputs, route, merge, conflict, discard)',
  group: 'ai',
  soft: !!process.env.E2E_SOFT,
  async run(s) {
    const p = s.page;
    const TEAM = 'Backend team';
    const repo = s.server.dirs.repo;
    const until = async (fn, what, ms = 20000) => {
      const t0 = Date.now();
      for (;;) {
        try { const v = await fn(); if (v) return v; } catch { /* look again */ }
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
    const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.com' } });
    const ids = {};
    const KEYS = { 1: 'Fix add', 2: 'Second' };
    const worktreeOf = async (n) => (await api('GET', `/tickets/ALP-${n}/ai/worktree`)).json;
    const openCard = async (n) => {
      await p.getByRole('button', { name: new RegExp(`ALP-${n} `) }).first().getByText(KEYS[n], { exact: true }).click();
      const d = p.getByRole('dialog', { name: `Ticket ALP-${n}` });
      await d.waitFor();
      return d;
    };
    const activity = async (n) => {
      await home(s);
      const d = await openCard(n);
      await d.getByRole('tab', { name: 'AI activity' }).click();
      await d.getByTestId('ai-activity').waitFor();
      return d;
    };
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
    // the screenshots of the view, for a person to look at (E2E_SHOTS names the folder; the report folder otherwise)
    const shotDir = process.env.E2E_SHOTS || null;
    const shot = async (locator, name) => {
      if (!shotDir) return;
      fs.mkdirSync(shotDir, { recursive: true });
      await locator.screenshot({ path: path.join(shotDir, `${name}.png`) }).catch(() => {});
    };

    await s.step('set up: a project, the repository, a team, one worktree per ticket', async () => {
      s.server.signIn();
      await ensureProject(s);
      await createTicket(s, { title: KEYS[1] });
      await createTicket(s, { title: KEYS[2] });
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('heading', { name: 'Repositories', level: 1 }).waitFor();
      await p.getByRole('textbox', { name: 'Repository path' }).fill(repo);
      await p.getByRole('button', { name: 'Apply' }).click();
      await p.getByText('Repository linked').first().waitFor();
      await p.getByRole('button', { name: 'Back to board' }).click();
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
      const pr = await api('GET', '/projects');
      ids.project = (Array.isArray(pr.json) ? pr.json : pr.json.projects)[0].id;
      await p.getByRole('button', { name: /^Members/ }).first().click();
      await p.getByRole('button', { name: /^AI( \d+)?$/ }).click();
      await p.getByRole('button', { name: /Add AI team/ }).first().click();
      const d = p.getByRole('dialog', { name: 'Add AI team' });
      await d.getByRole('textbox', { name: 'Name' }).fill(TEAM);
      await d.getByRole('textbox', { name: /Working folder/ }).fill(repo);
      await d.getByRole('button', { name: 'Add team' }).click();
      await p.getByRole('heading', { name: TEAM, level: 1 }).waitFor();
      // Settings > AI > Repositories: one worktree per ticket, from main
      await home(s);
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'AI', exact: true }).click();
      await p.getByRole('heading', { name: 'AI', level: 1 }).waitFor();
      const reg = p.getByRole('region', { name: 'Repositories' });
      await reg.getByRole('textbox', { name: 'Repository path' }).fill(repo);
      await reg.getByRole('textbox', { name: 'Repository path' }).blur();
      await reg.getByRole('textbox', { name: 'Base branch' }).fill('main');
      await reg.getByRole('textbox', { name: 'Base branch' }).blur();
      await reg.getByRole('switch', { name: 'One worktree per ticket' }).click();
      await reg.getByTestId('worktree-list').waitFor();
    });

    await s.step('a ticket the AI never touched shows no run and no hand-over (nothing made up)', async () => {
      const d = await activity(1);
      await d.getByTestId('ticket-timeline').waitFor();
      await s.settle();
      for (const id of ['active-run-card', 'ticket-handover', 'restart-notice', 'memory-stop', 'resources', 'pull-status']) {
        if (await d.getByTestId(id).count()) throw new Error(`${id} is shown on a ticket with no AI work`);
      }
      // none of the design's sample words
      const text = await d.getByTestId('ai-activity').innerText();
      for (const sample of ['KAN-209', 'Run #3', '2.05 GB', 'An Nguyen']) if (text.includes(sample)) throw new Error(`the design's sample "${sample}" is on a real ticket`);
      await d.getByRole('button', { name: 'Close', exact: true }).click();
    });

    await s.step('a run leaves code and an output uncommitted: the run card and the worktree say so', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2', FAKE_CLAUDE_LEAVE: JSON.stringify(['helper.py', 'screenshots/run.png']) });
      await home(s);
      await assignAndStart(1);
      await finished(1).waitFor({ timeout: 40000 });
      // the board moves a run's own outputs to the Workspace when it ends; an output written after that stays in the
      // worktree until a person moves it (a screenshot a tester saved there by hand)
      const before = await worktreeOf(1);
      s.note('left after the run (the board moved the outputs)', before.live.uncommitted);
      fs.mkdirSync(path.join(before.path, 'screenshots'), { recursive: true });
      fs.writeFileSync(path.join(before.path, 'screenshots', 'shot.png'), 'a screenshot');
      const d = await activity(1);
      await d.getByTestId('active-run-card').getByText('Run #1 finished').waitFor();
      const card = d.getByTestId('ticket-handover');
      await card.waitFor();
      await card.getByText(/^ai\/ALP-1/).waitFor();
      await card.getByTestId('worktree-state').filter({ hasText: 'Waiting for you' }).waitFor();
      await card.getByText(/2 files changed, not committed/).waitFor();
      const left = card.getByTestId('worktree-not-committed');
      await left.getByText('2 files not committed: the worktree stays until you decide').waitFor();
      await left.getByText('screenshots/shot.png').waitFor();
      // the repository has no remote: the board guessed a merge on this machine, and Merge waits for a clean worktree
      await card.getByTestId('handover-route').getByText('merging on this machine').waitFor();
      await card.getByTestId('handover-route').getByText(/The board guessed it from the repository/).waitFor();
      const merge = card.getByTestId('merge-btn');
      if (!(await merge.isDisabled())) throw new Error('Merge is offered while files are not committed');
      const wt = await worktreeOf(1);
      if (wt.route !== 'local') throw new Error(`the server names the route ${wt.route}`);
      s.note('worktree before the tidy-up', { state: wt.state, uncommitted: wt.live.uncommitted, outputs: wt.live.outputs });
      await shot(d, '38-ai-activity-worktree');
      await shot(card, '38-handover-waiting');
    });

    await s.step('the output goes to the Workspace, then the code is committed on the branch', async () => {
      const d = p.getByRole('dialog', { name: 'Ticket ALP-1' });
      const card = d.getByTestId('ticket-handover');
      const moved = p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/worktree\/outputs$/.test(r.url()));
      await card.getByTestId('move-outputs').click();
      const body = await (await moved).json();
      if (!body.moved.includes('screenshots/shot.png')) throw new Error(`moved ${JSON.stringify(body)}`);
      await card.getByTestId('tidy-note').getByText(/^Moved 1 file to the Workspace: /).waitFor();
      await card.getByTestId('worktree-not-committed').getByText('1 file not committed: the worktree stays until you decide').waitFor();
      if (await card.getByTestId('move-outputs').count()) throw new Error('Move outputs is still offered with no output left');
      await card.getByTestId('commit-leftovers').click();
      await card.getByTestId('tidy-note').getByText('Committed on the branch.').waitFor();
      await card.getByTestId('worktree-not-committed').waitFor({ state: 'detached' });
      await card.getByText('nothing uncommitted', { exact: false }).waitFor();
      await until(async () => !(await card.getByTestId('merge-btn').isDisabled()), 'Merge enabled once all is committed');
      const wt = await worktreeOf(1);
      if (wt.live.uncommitted.length) throw new Error(`still uncommitted: ${wt.live.uncommitted}`);
      const log = execFileSync('git', ['log', '--format=%s', '-1', wt.branch], { cwd: repo, encoding: 'utf8' });
      s.note('the branch after the commit', log.trim());
    });

    await s.step('the route is changed for this ticket: the branch, a pull request, then back to the project one', async () => {
      const d = p.getByRole('dialog', { name: 'Ticket ALP-1' });
      const card = d.getByTestId('ticket-handover');
      await card.getByTestId('route-branch').click();
      await card.getByTestId('handover-route').getByText('leaving the branch').waitFor();
      await card.getByTestId('handover-route').getByText(/That is its own choice/).waitFor();
      await card.getByTestId('handover-hint').getByText(/The branch is pushed/).waitFor();
      if (await card.getByTestId('merge-btn').count()) throw new Error('Merge is offered on the branch route');
      await until(async () => (await worktreeOf(1)).handover === 'branch', 'the branch route on the server');
      await card.getByTestId('route-pr').click();
      await card.getByTestId('handover-route').getByText('opening a pull request').waitFor();
      await card.getByTestId('handover-hint').getByText(/Opened as a draft when the ticket reaches Review/).waitFor();
      await until(async () => (await worktreeOf(1)).route === 'pr', 'the pull request route on the server');
      await card.getByTestId('route-auto').click();
      await card.getByTestId('handover-route').getByText('merging on this machine').waitFor();
      await card.getByTestId('route-auto').waitFor({ state: 'detached' });
      const wt = await worktreeOf(1);
      if (wt.handover !== null || wt.route !== 'local') throw new Error(`after Use the project's: ${wt.handover} / ${wt.route}`);
    });

    await s.step('Merge on this machine merges the branch into main and removes the worktree', async () => {
      const d = p.getByRole('dialog', { name: 'Ticket ALP-1' });
      const card = d.getByTestId('ticket-handover');
      const branch = (await worktreeOf(1)).branch;
      const merged = p.waitForResponse((r) => r.request().method() === 'POST' && /\/tickets\/[^/]+\/ai\/merge$/.test(r.url()));
      await card.getByTestId('merge-btn').click();
      const body = await (await merged).json();
      if (!body.merged) throw new Error(`the merge answered ${JSON.stringify(body)}`);
      await d.getByTestId('merge-done').getByText('Merged.').waitFor();
      await d.getByTestId('merge-done').getByText('The worktree is removed and its port is given back.').waitFor();
      await until(async () => (await worktreeOf(1)) === null, 'the worktree gone on the server');
      const log = git('log', '--format=%s', '-3', 'main');
      if (!log.includes(`Merge ALP-1: ${branch}`)) throw new Error(`main does not have the merge: ${log}`);
      if (!fs.existsSync(path.join(repo, 'helper.py'))) throw new Error('the committed file is not in main');
      if (fs.existsSync(path.join(repo + '.worktrees', 'ALP-1'))) throw new Error('the worktree folder is still on disk');
      await d.getByRole('button', { name: 'Close', exact: true }).click();
    });

    await s.step('a merge that meets a conflict with main is rolled back and the card names the file', async () => {
      // the AI changes calc.py on its branch while main changes the same line
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2', FAKE_CLAUDE_COMMIT: 'def add(a, b):\n    return a + b  # by the AI\n' });
      await home(s);
      await assignAndStart(2);
      await finished(2).waitFor({ timeout: 40000 });
      fs.writeFileSync(path.join(repo, 'calc.py'), 'def add(a, b):\n    return b + a  # on main\n');
      git('commit', '-q', '-am', 'main moves on');
      const d = await activity(2);
      const card = d.getByTestId('ticket-handover');
      await card.getByTestId('handover-route').getByText('merging on this machine').waitFor();
      await card.getByText('nothing uncommitted', { exact: false }).waitFor();
      const merged = p.waitForResponse((r) => r.request().method() === 'POST' && /\/tickets\/[^/]+\/ai\/merge$/.test(r.url()));
      await card.getByTestId('merge-btn').click();
      const body = await (await merged).json();
      s.note('the merge with a conflict answered', body);
      if (body.merged || !(body.conflict ?? []).includes('calc.py')) throw new Error(`the merge answered ${JSON.stringify(body)}`);
      const conflict = card.getByTestId('handover-conflict');
      await conflict.getByText('Cannot be merged: main has moved').waitFor();
      await conflict.getByText(/One file differs from main: calc\.py\./).waitFor();
      await card.getByTestId('worktree-state').filter({ hasText: 'Conflict with main' }).waitFor();
      // rolled back: main is not left mid-merge
      if (git('status', '--porcelain').trim()) throw new Error(`main is left dirty: ${git('status', '--porcelain')}`);
      await shot(card, '38-handover-conflict');
      await d.getByRole('button', { name: 'Close', exact: true }).click();
    });

    await s.step('Discard asks first, then deletes the worktree and what was not committed in it', async () => {
      // something left in the worktree after the conflict
      const wt = await worktreeOf(2);
      fs.writeFileSync(path.join(wt.path, 'notes.txt'), 'left behind');
      const d = await activity(2);
      const card = d.getByTestId('ticket-handover');
      const left = card.getByTestId('worktree-not-committed');
      await left.getByText('1 file not committed: the worktree stays until you decide').waitFor();
      await left.getByTestId('discard-worktree').click();
      await left.getByText('This deletes the worktree and everything not committed in it. It cannot be undone.').waitFor();
      // Cancel keeps it
      await left.getByRole('button', { name: 'Cancel', exact: true }).click();
      await left.getByTestId('discard-worktree').filter({ hasText: 'Discard…' }).waitFor();
      if ((await worktreeOf(2)) === null) throw new Error('Cancel removed the worktree');
      await left.getByTestId('discard-worktree').click();
      const removed = p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/worktree\/remove$/.test(r.url()));
      await left.getByTestId('discard-worktree').filter({ hasText: 'Discard 1 file and remove' }).click();
      const res = await removed;
      if (JSON.parse(res.request().postData() || '{}').force !== true) throw new Error('Discard did not force the removal');
      await card.waitFor({ state: 'detached' });
      await until(async () => (await worktreeOf(2)) === null, 'the worktree gone on the server');
      if (fs.existsSync(wt.path)) throw new Error('the worktree folder is still on disk');
    });
  },
};
