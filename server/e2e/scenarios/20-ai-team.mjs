import fs from 'node:fs';
import path from 'node:path';
import { home, ensureProject, createTicket, openTicket, closeTicket } from '../lib/ui.mjs';

// The AI team end to end, through the stand-in CLI (server/crates/fake-claude): accounts and the sign-in terminal, a
// team, a ticket run (steps, report, run detail), a question that needs the person, the team pages, the settings of
// the AI, the schedules and the assistants. The stand-in answers like the real CLI in "v2" mode (FAKE_CLAUDE_MODE).
//
// What the stand-in cannot drive (so it is not covered here): a real browser sign-in (the terminal gets the code
// "good"), the machine's RAM/CPU of a running CLI (the Resources numbers are near zero), the keep-awake chip and the
// runner of the desktop app, installing a plugin from the internet (no network), real cost and quota.
export default {
  name: 'AI team: accounts, a team, a run through the stand-in CLI, its pages and settings',
  group: 'ai',
  async run(s) {
    const p = s.page;
    const TEAM = 'Backend team';
    // poll until fn() is truthy (a check the page needs time for)
    const until = async (fn, what, ms = 15000) => {
      const t0 = Date.now();
      for (;;) {
        try { if (await fn()) return; } catch { /* look again */ }
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await p.waitForTimeout(150);
      }
    };
    const nav = () => p.getByRole('navigation', { name: 'Settings pages' });

    // The Members page of the project (people, AI teams, AI accounts): through the Members dialog's "Add AI team".
    const membersPage = async (tab) => {
      await home(s);
      if (!(await p.getByRole('heading', { name: 'Members', level: 1 }).count())) {
        await p.getByRole('button', { name: /^Members/ }).first().click();
        await p.getByRole('button', { name: /^AI( \d+)?$/ }).click();
        await p.getByRole('button', { name: /Add AI team/ }).first().click();
        await p.getByRole('dialog', { name: 'Add AI team' }).getByRole('button', { name: 'Cancel' }).click();
      }
      await p.getByRole('heading', { name: 'Members', level: 1 }).waitFor();
      if (tab) await p.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    };
    const teamPage = async () => {
      await membersPage('AI teams');
      await p.getByText(TEAM, { exact: true }).first().click();
      await p.getByRole('heading', { name: TEAM, level: 1 }).waitFor();
    };
    const aiTeamView = async (tab) => {
      await home(s);
      await p.getByRole('button', { name: /^AI Team/ }).click();
      await p.getByRole('heading', { name: 'AI Team', level: 1 }).waitFor();
      if (tab) await p.getByRole('tab', { name: tab }).click();
    };
    const settingsAi = async () => {
      await home(s);
      await p.getByRole('button', { name: 'Settings' }).click();
      await nav().getByRole('button', { name: 'AI', exact: true }).click();
      await p.getByRole('heading', { name: 'AI', level: 1 }).waitFor();
    };
    // open the ticket by its title: the middle of a card with a run can be its "Run again" button
    const openCard = async () => {
      await p.getByRole('button', { name: /ALP-1 / }).first().getByText('Fix add', { exact: true }).click();
      const d = p.getByRole('dialog', { name: 'Ticket ALP-1' });
      await d.waitFor();
      return d;
    };
    const assignTo = async (how) => {
      const d = await openCard();
      await d.getByRole('button', { name: 'Unassigned' }).click();
      await p.getByRole('button', { name: new RegExp(`^${TEAM}`) }).click();
      await p.getByRole('button', { name: how }).click();
      return d;
    };

    await s.step('set up: a project with a ticket', async () => {
      // the login of this computer (the Board AI and the other assistants use it; the team uses its own account)
      s.server.signIn();
      await ensureProject(s);
      await createTicket(s, { title: 'Fix add' });
    });

    await s.step('link the project to the repository', async () => {
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('heading', { name: 'Repositories', level: 1 }).waitFor();
      await p.getByRole('textbox', { name: 'Repository path' }).fill(s.server.dirs.repo);
      await p.getByRole('button', { name: 'Apply' }).click();
      await p.getByText('Repository linked').first().waitFor();
      await p.getByRole('button', { name: 'Back to board' }).click();
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
    });

    await s.step('AI accounts: none yet', async () => {
      await membersPage('AI accounts');
      await p.getByText('No AI accounts yet').waitFor();
    });

    await s.step('add an account and sign in through the terminal', async () => {
      await p.getByRole('button', { name: 'Add account' }).first().click();
      await p.getByRole('button', { name: 'Next' }).click();
      await p.getByRole('textbox', { name: 'Name' }).fill('Work Claude');
      await p.getByRole('button', { name: 'Sign in' }).click();
      const w = p.getByRole('dialog', { name: 'Sign in: Work Claude' });
      await w.getByText('Your turn: paste the code').waitFor();
      await w.getByLabel(/Terminal running/).click();
      await p.keyboard.type('good\n');
      await w.getByRole('status').filter({ hasText: /Work Claude is signed in as an@work\.example/ }).waitFor();
      await w.getByRole('button', { name: 'Done' }).click();
      await w.waitFor({ state: 'detached' });
    });

    await s.step('the account is listed as signed in', async () => {
      const row = p.getByRole('row', { name: /Work Claude/ });
      await row.getByText('an@work.example').waitFor();
      await row.getByText('Signed in', { exact: true }).waitFor();
      await row.getByText('No teams').waitFor();
      await p.getByRole('tab', { name: /^AI accounts 1/ }).waitFor();
      await row.getByRole('button', { name: 'Check now' }).click();
      await row.getByText(/Checked/).waitFor();
    });

    await s.step('rename the account', async () => {
      await p.getByRole('button', { name: 'More actions for Work Claude' }).click();
      await p.getByRole('menuitem', { name: /Rename/ }).click();
      const d = p.getByRole('dialog', { name: 'Rename Work Claude' });
      await d.getByRole('textbox', { name: 'Name' }).fill('Main Claude');
      await d.getByRole('button', { name: 'Save' }).click();
      await d.waitFor({ state: 'detached' });
      await p.getByRole('row', { name: /Main Claude/ }).waitFor();
    });

    await s.step('add a team: the form asks for a name and a folder', async () => {
      await p.getByRole('tab', { name: /^AI teams/ }).click();
      await p.getByRole('button', { name: 'Set up a team' }).click();
      const d = p.getByRole('dialog', { name: 'Add AI team' });
      await d.getByRole('button', { name: 'Add team' }).click();
      await d.getByText('Give the team a name').waitFor();
      await d.getByText('Choose the folder runs start in').waitFor();
      // the packs list what each brings
      await d.getByRole('radio', { name: /^Quick fix/ }).click();
      await d.getByText('Roles: Dev, Reviewer.').waitFor();
      await d.getByRole('radio', { name: /^Standard feature/ }).click();
      await d.getByText('Roles: Dev, Reviewer, QA.').waitFor();
    });

    await s.step('add the team with the account, the repository folder and a persona', async () => {
      const d = p.getByRole('dialog', { name: 'Add AI team' });
      await d.getByRole('textbox', { name: 'Name' }).fill(TEAM);
      await d.getByRole('textbox', { name: /Working folder/ }).fill(s.server.dirs.repo);
      await d.getByRole('radio', { name: /Main Claude/ }).click();
      await d.getByRole('combobox', { name: 'Effort' }).selectOption('low');
      await d.getByRole('textbox', { name: /Persona/ }).fill('Small changes only.');
      await d.getByRole('button', { name: 'Add team' }).click();
      await p.getByRole('heading', { name: TEAM, level: 1 }).waitFor();
      await p.getByText(`${TEAM} added`).waitFor();
      await p.getByText(/Standard feature · sonnet/).waitFor();
      await p.getByRole('radio', { name: /Main Claude/ }).and(p.locator('[aria-checked="true"]')).waitFor();
      await until(async () => (await p.getByRole('textbox', { name: 'Persona' }).inputValue()) === 'Small changes only.', 'the persona of the team');
    });

    await s.step('team page: Test asks the CLI', async () => {
      await p.getByRole('button', { name: 'Test', exact: true }).click();
      await p.getByText(`${TEAM}: Claude Code works`).waitFor();
    });

    await s.step('team page: a role changes its model and keeps it', async () => {
      await p.getByRole('combobox', { name: 'Reviewer model' }).selectOption({ label: 'Haiku' });
      await p.getByRole('button', { name: 'Save role' }).first().waitFor();
      // the Save button of the Reviewer row is the one that came alive
      await p.getByRole('button', { name: 'Save role' }).and(p.locator(':enabled')).click();
      await until(async () => (await p.getByRole('combobox', { name: 'Reviewer model' }).inputValue()) === 'haiku', 'the Reviewer on Haiku');
      await p.getByRole('button', { name: 'Save role' }).and(p.locator(':enabled')).waitFor({ state: 'detached' });
      await teamPage();
      await until(async () => (await p.getByRole('combobox', { name: 'Reviewer model' }).inputValue()) === 'haiku', 'Haiku after reopening the page');
      await until(async () => (await p.getByRole('combobox', { name: 'Dev (TDD) model' }).inputValue()) === 'sonnet', 'Dev unchanged');
    });

    await s.step('team page: turn a role off and on, add a role', async () => {
      await p.getByRole('button', { name: 'Turn off' }).nth(2).click();
      await p.getByText('Turned off:').waitFor();
      await p.getByRole('button', { name: 'QA (turn on)' }).waitFor();
      await p.getByRole('combobox', { name: 'QA model' }).waitFor({ state: 'detached' });
      await p.getByRole('button', { name: 'QA (turn on)' }).click();
      await p.getByRole('combobox', { name: 'QA model' }).waitFor();
      await p.getByRole('combobox', { name: 'Add a role' }).selectOption({ label: 'Security reviewer' });
      await p.getByRole('button', { name: 'Add', exact: true }).click();
      await p.getByRole('combobox', { name: 'Security reviewer model' }).waitFor();
    });

    await s.step('team page: persona, limits and permission mode are kept', async () => {
      await p.getByRole('textbox', { name: 'Persona' }).fill('Small changes only. Never touch config files.');
      await p.getByRole('button', { name: 'Save persona' }).click();
      await p.getByText('Persona saved').waitFor();
      await p.getByRole('spinbutton', { name: 'Runs a day' }).fill('7');
      await p.getByRole('spinbutton', { name: 'Runs at once' }).fill('3');
      await p.getByRole('spinbutton', { name: 'Daily budget ($)' }).fill('2.5');
      await p.getByRole('spinbutton', { name: 'Daily budget ($)' }).blur();
      await p.getByRole('radio', { name: /^Auto/ }).click();
      await p.getByRole('radio', { name: /^Auto/ }).and(p.locator('[aria-checked="true"]')).waitFor();
      await s.settle();
      await teamPage();
      await until(async () => (await p.getByRole('textbox', { name: 'Persona' }).inputValue()) === 'Small changes only. Never touch config files.', 'the new persona');
      await until(async () => (await p.getByRole('spinbutton', { name: 'Runs a day' }).inputValue()) === '7', 'Runs a day 7');
      await until(async () => (await p.getByRole('spinbutton', { name: 'Runs at once' }).inputValue()) === '3', 'Runs at once 3');
      await until(async () => (await p.getByRole('spinbutton', { name: 'Daily budget ($)' }).inputValue()) === '2.5', 'budget 2.5');
      await p.getByRole('radio', { name: /^Auto/ }).and(p.locator('[aria-checked="true"]')).waitFor();
      await p.getByRole('radio', { name: /^Bypass/ }).click();
      await p.getByRole('radio', { name: /^Bypass/ }).and(p.locator('[aria-checked="true"]')).waitFor();
    });

    await s.step('assign the ticket and start: the lead works and the card says finished', async () => {
      await home(s);
      const d = await assignTo('Assign & start');
      await d.getByRole('button', { name: new RegExp(`^${TEAM}`) }).waitFor();
      await closeTicket(s);
      await p.getByRole('button', { name: /ALP-1 Fix add Finished/ }).waitFor({ timeout: 40000 });
      await p.getByRole('button', { name: 'Run again', exact: true }).last().waitFor();
    });

    await s.step('ticket: AI activity shows the finished run', async () => {
      const d = await openCard();
      await d.getByRole('tab', { name: 'AI activity' }).click();
      await d.getByText(/Run #1 finished/).waitFor();
      await d.getByText('Right now').waitFor();
      await d.getByText('Nobody is working.').waitFor();
      await d.getByText('Resources').first().waitFor();
      await d.getByRole('button', { name: 'Open in Flow' }).waitFor();
    });

    await s.step('run detail: the report, the steps, the files and the commands', async () => {
      const d = p.getByRole('dialog', { name: 'Ticket ALP-1' });
      await d.getByRole('button', { name: 'Open run ›' }).click();
      await d.getByText('Run #1').first().waitFor();
      await d.getByText('Finished', { exact: true }).first().waitFor();
      await d.getByText('Fixed add(); tests pass.').first().waitFor();
      await d.getByText('ai/test').first().waitFor();
      await d.getByText('Edited calc.py').waitFor();
      await d.getByText(/Ran pytest -q API_TOKEN=•+ · exit 0/).waitFor();
      await d.getByText(/Asked reviewer: Review the diff/).waitFor();
      await d.getByRole('button', { name: /^(reviewer|role) 2 steps/ }).waitFor();
      await d.getByText('Wrote the final report').waitFor();
      await d.getByText(/Files touched/).waitFor();
      await d.getByText('calc.py').first().waitFor();
      await d.getByText('Test results').waitFor();
      await d.getByText('4 passed').first().waitFor();
      await d.getByText(/Secrets, tokens and key-like strings are masked/).waitFor();
      // the secret the stand-in CLI printed never reaches the page
      const body = await p.locator('body').innerText();
      if (body.includes('secret123456')) throw new Error('a secret is shown in the run detail');
      await d.getByRole('button', { name: 'Collapse all' }).click();
      await d.getByRole('button', { name: 'Expand all' }).click();
      await d.getByRole('button', { name: /^(reviewer|role) 2 steps/ }).click();
      await d.getByText('git diff --stat').first().waitFor();
      await d.getByText('Show run #1').count();
      await d.getByRole('button', { name: 'Show run #1' }).waitFor();
    });

    await s.step('run it again: the lead asks a question and waits for the person', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2_ask' });
      await closeTicket(s);
      await home(s);
      const d = await openCard();
      await d.getByRole('button', { name: `Run ${TEAM}` }).click();
      await d.getByText(`${TEAM} asks a question`).waitFor({ timeout: 40000 });
      await d.getByText('Which database: SQLite or PostgreSQL?').first().waitFor();
      await d.getByRole('button', { name: 'Answer and resume' }).waitFor();
      await d.getByText('Needs input', { exact: true }).first().waitFor();
      await closeTicket(s);
      await p.getByText(/Asks user: Which database/).waitFor();
      await p.getByRole('button', { name: /^Notifications, 1 needs you/ }).waitFor();
      await p.getByRole('button', { name: /^AI Team 1/ }).waitFor();
    });

    await s.step('answer the question: the same run resumes and finishes with the answer', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2' });
      const d = await openCard();
      await d.getByRole('textbox', { name: 'Type an answer…' }).fill('SQLite');
      await d.getByRole('button', { name: 'Answer and resume' }).click();
      await d.getByRole('button', { name: 'Answer and resume' }).waitFor({ state: 'detached', timeout: 40000 });
      await d.getByText('Answer sent to the lead').first().waitFor().catch(() => {});
      // the ticket opens on its own tab or on its runs, as it was left: look at the run in both cases
      await p.waitForTimeout(500);
      if (await d.getByRole('tablist', { name: 'Ticket or AI activity' }).count()) {
        await d.getByRole('tab', { name: 'AI activity' }).click();
        await d.getByText(/Run #\d+ finished/).waitFor({ timeout: 40000 });
        await d.getByRole('button', { name: 'Open run ›' }).click();
      }
      await d.getByText(/Done with your answer: .*SQLite/).first().waitFor({ timeout: 40000 });
      await d.getByText('Finished', { exact: true }).first().waitFor();
      await closeTicket(s);
      await p.getByRole('button', { name: /ALP-1 Fix add Finished/ }).waitFor();
      await p.getByRole('button', { name: /^Notifications, 1 needs you/ }).waitFor({ state: 'detached' });
    });

    await s.step('AI Team: Now lists the team, the recent runs and the spend', async () => {
      await aiTeamView();
      await p.getByRole('tab', { name: 'Now', exact: true }).and(p.locator('[aria-selected="true"]')).waitFor();
      await p.getByText(/0 running/).first().waitFor();
      await p.getByText(/0 waiting for you/).first().waitFor();
      await p.getByRole('heading', { name: 'Needs you', level: 2 }).waitFor();
      await p.getByText('Nothing waits for you.').waitFor();
      await p.getByRole('heading', { name: 'Teams', level: 2 }).waitFor();
      await p.getByRole('button', { name: TEAM, exact: true }).waitFor();
      await p.getByText(/Standard feature/).first().waitFor();
      await p.getByRole('heading', { name: 'Active runs', level: 2 }).waitFor();
      await p.getByText('No run is active.').waitFor();
      await p.getByRole('heading', { name: 'Recent', level: 2 }).waitFor();
      await p.getByRole('button', { name: 'ALP-1', exact: true }).first().waitFor();
      await p.getByRole('heading', { name: 'Spend today', level: 2 }).waitFor();
      await p.getByText(/2 runs today/).first().waitFor();
      await p.getByRole('button', { name: 'Open run' }).first().click();
      await p.getByText(/Done with your answer|Fixed add\(\); tests pass\./).first().waitFor();
    });

    await s.step('AI Team: Flow shows the map and the timeline of the team', async () => {
      await aiTeamView('Flow');
      await p.getByRole('navigation', { name: 'What Flow looks at' }).getByText('All teams').waitFor();
      await p.getByText(/1 team · 1 ticket with AI work/).waitFor();
      const map = p.getByRole('group', { name: 'Map of the teams, you and the tickets' });
      await map.getByRole('button', { name: TEAM }).waitFor();
      await map.getByRole('button', { name: /^ALP-1 Backlog Fix add/ }).waitFor();
      await map.getByRole('button', { name: 'Look at the flow of ALP-1' }).click();
      await p.getByRole('navigation', { name: 'What Flow looks at' }).getByText('ALP-1').waitFor();
      await p.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Timeline' }).click();
      await p.getByRole('button', { name: /^ALP-1 · run 1, finished/ }).waitFor();
      await p.getByRole('button', { name: /^ALP-1 · run 2, finished/ }).waitFor();
      await p.getByRole('button', { name: 'Range' }).waitFor();
      await p.getByRole('button', { name: 'Table' }).click();
      await p.getByRole('table').first().waitFor();
    });

    await s.step('AI Team: Run history filters the runs', async () => {
      await aiTeamView('Run history');
      const rows = () => p.getByRole('button', { name: 'ALP-1', exact: true });
      await until(async () => (await rows().count()) === 2, 'two runs in the history');
      await p.getByText('Finished', { exact: true }).first().waitFor();
      await p.getByRole('radio', { name: 'Failed' }).click();
      await until(async () => (await rows().count()) === 0, 'no failed run');
      await p.getByRole('radio', { name: 'Waiting for you' }).click();
      await until(async () => (await rows().count()) === 0, 'no run waiting for you');
      await p.getByRole('radio', { name: 'Finished' }).click();
      await until(async () => (await rows().count()) === 2, 'the finished runs');
      await rows().first().click();
      await p.getByText(/Done with your answer|Fixed add\(\); tests pass\./).first().waitFor();
    });

    await s.step('AI Team: You stepped in counts the answer the person gave', async () => {
      await aiTeamView('You stepped in');
      await p.getByText(/Touches/).first().waitFor();
      await p.getByText(/1 ticket with AI work/).first().waitFor();
      await p.getByRole('button', { name: /^Not marked/ }).waitFor();
      await p.getByRole('button', { name: 'Range' }).waitFor();
    });

    await s.step('AI Team: Health says it is too early to judge', async () => {
      await aiTeamView('Health');
      await p.getByText('Not enough to judge yet').waitFor();
      await p.getByText(/Reliability/).first().waitFor();
      await p.getByText(/Autonomy/).first().waitFor();
      await p.getByRole('button', { name: TEAM, exact: true }).waitFor();
      await p.getByText(/What to fix/).first().waitFor();
    });

    await s.step('AI Team: Resources shows the machine and the limits', async () => {
      await aiTeamView('Resources');
      await p.getByText('No AI is running right now.').waitFor();
      await p.getByText(/Machine RAM/).waitFor();
      await p.getByText(/Machine load/).waitFor();
      await p.getByRole('button', { name: 'ALP-1', exact: true }).first().waitFor();
      await p.getByRole('spinbutton', { name: 'Memory of one run (MB)' }).fill('2048');
      await p.getByRole('spinbutton', { name: 'Memory of one run (MB)' }).blur();
      await s.settle();
      await aiTeamView('Resources');
      await until(async () => (await p.getByRole('spinbutton', { name: 'Memory of one run (MB)' }).inputValue()) === '2048', 'the saved memory limit');
      await p.getByRole('spinbutton', { name: 'Memory of one run (MB)' }).fill('4096');
      await p.getByRole('spinbutton', { name: 'Memory of one run (MB)' }).blur();
      await s.settle();
    });

    await s.step('AI Team: Memory keeps the lesson the run proposed and takes a new one', async () => {
      await aiTeamView('Memory');
      await p.getByRole('tab', { name: /^Memory \d/ }).and(p.locator('[aria-selected="true"]')).waitFor();
      await p.getByText('Run pytest -q from the server folder.').waitFor();
      await p.getByRole('button', { name: 'Add a lesson' }).click();
      await p.getByRole('textbox').last().fill('Never push to main.');
      await p.getByRole('button', { name: /^(Save|Add)/ }).last().click();
      await p.getByText('Never push to main.').waitFor();
      await p.getByRole('tab', { name: 'Instructions' }).click();
      await p.getByRole('tab', { name: 'Knowledge base' }).click();
      await p.getByRole('tab', { name: /^Memory \d/ }).click();
    });

    await s.step('Settings > AI: Pause all AI stops the project and Resume starts it again', async () => {
      await settingsAi();
      const reg = p.getByRole('region', { name: 'Running the teams' });
      await reg.getByText('AI is working').waitFor();
      await reg.getByRole('button', { name: 'Pause all AI' }).click();
      const d = p.getByRole('dialog', { name: 'Pause all AI' });
      await d.getByRole('button', { name: /^Let them finish/ }).click();
      await d.getByRole('textbox', { name: 'Reason (optional)' }).fill('Maintenance window');
      await d.getByRole('button', { name: 'Pause all AI' }).click();
      await p.getByText('Nothing new starts until you resume.').waitFor();
      await reg.getByLabel(/^AI paused since/).waitFor();
      await reg.getByRole('button', { name: 'Resume…' }).waitFor();
      // the board says so too, and the team page shows the pause
      await p.getByRole('button', { name: 'Back to board' }).click();
      await home(s);
      await p.getByLabel(/^AI paused since/).first().waitFor();
      await teamPage();
      await p.getByText(/AI paused/).first().waitFor();
    });

    await s.step('Resume all AI from the banner', async () => {
      await p.getByRole('button', { name: 'Resume…' }).first().click();
      const d = p.getByRole('dialog', { name: 'Resume AI' });
      await d.getByRole('button', { name: 'Resume AI' }).click();
      await p.getByLabel(/^AI paused since/).first().waitFor({ state: 'detached' });
      await p.getByRole('button', { name: 'Pause all AI' }).first().waitFor();
    });

    await s.step('team page: pause one team and resume it', async () => {
      await p.getByRole('button', { name: 'Pause', exact: true }).click();
      await p.getByRole('button', { name: 'Resume', exact: true }).waitFor();
      await teamPage();
      await p.getByRole('button', { name: 'Resume', exact: true }).click();
      await p.getByRole('button', { name: 'Pause', exact: true }).waitFor();
    });

    await s.step('Settings > AI: the deny list and the limits of the project are kept', async () => {
      await settingsAi();
      const reg = p.getByRole('region', { name: 'Running the teams' });
      await reg.getByRole('textbox', { name: 'Deny list' }).fill('Bash(git push --force:*)');
      await reg.getByRole('textbox', { name: 'Deny list' }).blur();
      await reg.getByText('Saved. Takes effect on the next run.').waitFor();
      await reg.getByRole('spinbutton', { name: 'Runs a day' }).fill('20');
      await reg.getByRole('spinbutton', { name: 'Runs a day' }).blur();
      await reg.getByRole('spinbutton', { name: 'Runs at once on this project' }).fill('3');
      await reg.getByRole('spinbutton', { name: 'Runs at once on this project' }).blur();
      await s.settle();
      await settingsAi();
      await until(async () => (await p.getByRole('textbox', { name: 'Deny list' }).inputValue()) === 'Bash(git push --force:*)', 'the saved deny list');
      await until(async () => (await p.getByRole('spinbutton', { name: 'Runs a day' }).inputValue()) === '20', 'Runs a day 20');
      await until(async () => (await p.getByRole('spinbutton', { name: 'Runs at once on this project' }).inputValue()) === '3', 'Runs at once 3');
    });

    await s.step('Settings > AI: skills and plugins (a board skill off, a plugin from a folder, the other tabs)', async () => {
      const folder = path.join(s.server.dirs.root, 'team-skills');
      for (const [name, text] of [['one', 'Use one.'], ['two', 'Use two.']]) {
        fs.mkdirSync(path.join(folder, 'skills', name), { recursive: true });
        fs.writeFileSync(path.join(folder, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${text}\n---\n\nBody ${name}.\n`);
      }
      await settingsAi();
      const reg = p.getByRole('region', { name: 'Skills & plugins' });
      const sw = reg.getByRole('switch', { name: 'drawio-diagrams' });
      await sw.and(p.locator('[aria-checked="true"]')).waitFor();
      await sw.click();
      await sw.and(p.locator('[aria-checked="false"]')).waitFor();
      await s.settle();
      await settingsAi();
      await reg.getByRole('switch', { name: 'drawio-diagrams' }).and(p.locator('[aria-checked="false"]')).waitFor();
      await reg.getByRole('switch', { name: 'drawio-diagrams' }).click();
      await reg.getByRole('switch', { name: 'drawio-diagrams' }).and(p.locator('[aria-checked="true"]')).waitFor();
      await reg.getByRole('tab', { name: 'Suggested for a role' }).click();
      await reg.getByText('Anthropic\'s design plugin', { exact: false }).first().waitFor();
      await reg.getByRole('tab', { name: 'By team' }).click();
      await reg.getByText(TEAM).first().waitFor();
      await reg.getByRole('tab', { name: 'Add from a source' }).click();
      await reg.getByRole('tab', { name: 'A folder on this computer' }).click();
      await reg.getByRole('textbox', { name: 'Folder' }).fill(folder);
      await reg.getByRole('button', { name: 'Preview' }).click();
      await reg.getByText(/2 skills · 0 hooks · 0 MCP servers/).waitFor();
      await reg.getByRole('checkbox', { name: 'Dev', exact: true }).check();
      await reg.getByRole('button', { name: 'Install', exact: true }).click();
      await reg.getByRole('tab', { name: /^Installed 1/ }).waitFor();
      await reg.getByText('team-skills').first().waitFor();
    });

    await s.step('Settings > AI: instructions for every AI and the memory of the project', async () => {
      await settingsAi();
      const mem = p.getByRole('region', { name: 'Memory' });
      await mem.getByRole('button', { name: 'Edit' }).click();
      await mem.getByRole('textbox', { name: 'Instructions' }).fill('Use pytest. Never touch the CI files.');
      await mem.getByText('37 / 40,000 characters').waitFor();
      await mem.getByRole('button', { name: 'Save' }).click();
      await mem.getByText('Use pytest. Never touch the CI files.').first().waitFor();
      await mem.getByRole('button', { name: 'History' }).click();
      await mem.getByRole('button', { name: 'Edit' }).waitFor();
      await settingsAi();
      await p.getByRole('region', { name: 'Memory' }).getByText('Use pytest. Never touch the CI files.').first().waitFor();
      await p.getByRole('region', { name: 'Memory' }).getByRole('tab', { name: /^Memory \d/ }).click();
      await p.getByRole('region', { name: 'Memory' }).getByText('Run pytest -q from the server folder.').waitFor();
    });

    await s.step('Settings > AI: role packs (open a ready-made role, edit it for this project)', async () => {
      await settingsAi();
      const reg = p.getByRole('region', { name: 'Role packs' });
      await reg.getByRole('button', { name: 'Dev (TDD)', exact: true }).click();
      await reg.getByRole('heading', { name: 'Dev (TDD)', level: 3 }).waitFor();
      await reg.getByText('Ready-made', { exact: true }).first().waitFor();
      await reg.getByRole('textbox', { name: 'Tagline' }).fill('A failing test first, always');
      await reg.getByRole('button', { name: /^Save as version/ }).click();
      await reg.getByRole('button', { name: 'Reset to ready-made' }).and(p.locator(':enabled')).waitFor();
      await reg.getByRole('button', { name: 'Role packs ›' }).click();
      await reg.getByText('A failing test first, always').waitFor();
    });

    await s.step('Settings > AI: repositories hold the repository path and the hand-over', async () => {
      await settingsAi();
      const reg = p.getByRole('region', { name: 'Repositories' });
      await reg.getByRole('textbox', { name: 'Repository path' }).fill(s.server.dirs.repo);
      await reg.getByRole('textbox', { name: 'Repository path' }).blur();
      await reg.getByRole('textbox', { name: 'Base branch' }).fill('main');
      await reg.getByRole('textbox', { name: 'Base branch' }).blur();
      await reg.getByRole('combobox', { name: 'Hand over finished code by' }).selectOption({ label: 'Leave the branch' });
      await s.settle();
      await settingsAi();
      const again = p.getByRole('region', { name: 'Repositories' });
      await until(async () => (await again.getByRole('textbox', { name: 'Base branch' }).inputValue()) === 'main', 'the saved base branch');
      await until(async () => (await again.getByRole('combobox', { name: 'Hand over finished code by' }).inputValue()) === 'leave', 'the saved hand-over').catch(async () => {
        await again.getByRole('combobox', { name: 'Hand over finished code by' }).locator('option:checked').filter({ hasText: 'Leave the branch' }).waitFor();
      });
    });

    await s.step('Schedules: a dry run shows the plan, then the schedule is created', async () => {
      await home(s);
      await p.getByRole('button', { name: /^Schedules/ }).click();
      await p.getByRole('heading', { name: 'No schedules yet', level: 3 }).waitFor();
      await p.getByRole('button', { name: 'New schedule' }).first().click();
      const d = p.getByRole('dialog', { name: 'New schedule' });
      await d.getByRole('button', { name: /^Nightly test run/ }).waitFor();
      await d.getByRole('button', { name: 'Dry run' }).and(p.locator(':disabled')).waitFor();
      await d.getByRole('button', { name: 'Create schedule' }).and(p.locator(':disabled')).waitFor();
      await d.getByRole('button', { name: 'Pick a ticket' }).click();
      await p.getByRole('option', { name: /ALP-1 Fix add/ }).click();
      await d.getByRole('textbox', { name: 'Time of day' }).fill('03:15');
      await d.getByText(/Every weekday at 03:15 \(UTC\), Backend team works on ALP-1/).waitFor();
      await d.getByRole('button', { name: 'Dry run' }).click();
      await d.getByText(/Plan by Backend team/).waitFor({ timeout: 40000 });
      await d.getByText(/Nothing was changed\./).waitFor();
      await d.getByRole('button', { name: 'Create schedule' }).click();
      await d.waitFor({ state: 'detached' });
      await p.getByText('Schedule created', { exact: true }).waitFor();
      await p.getByRole('button', { name: /^Schedules 1/ }).waitFor();
      await p.getByText('Fix add').first().waitFor();
    });

    await s.step('Schedules: Run now starts a run, Pause and Resume change the state, Delete removes it', async () => {
      await p.getByText('Fix add').first().click();
      const d = p.getByRole('dialog', { name: 'Schedule' });
      await d.getByText(/Every weekday at 03:15/).first().waitFor();
      await d.getByRole('button', { name: 'Run now' }).click();
      await p.getByText('Run started', { exact: true }).waitFor();
      await d.getByRole('button', { name: 'Pause', exact: true }).click();
      await p.getByText('Schedule paused', { exact: true }).waitFor();
      await d.getByRole('button', { name: 'Resume', exact: true }).click();
      await p.getByText('Schedule resumed', { exact: true }).waitFor();
      await d.getByRole('button', { name: 'Edit' }).click();
      await p.getByRole('dialog', { name: /schedule/i }).last().getByRole('button', { name: 'Cancel' }).click();
      p.once('dialog', (dlg) => void dlg.accept());
      await d.getByRole('button', { name: 'More' }).click();
      await p.getByRole('menuitem', { name: /Delete schedule/ }).click();
      await d.waitFor({ state: 'detached' });
      await p.getByRole('heading', { name: 'No schedules yet', level: 3 }).waitFor();
    });

    await s.step('Board AI: ask a question and get the answer with its actions', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'assistant', FAKE_CLAUDE_ASSISTANT_TEXT: 'Nothing is overdue.' });
      await home(s);
      await p.getByRole('button', { name: /^Ask AI/ }).first().click();
      const a = p.getByRole('complementary', { name: 'Board AI' });
      await a.getByText(/online/).waitFor();
      await a.getByRole('tab', { name: 'This project' }).and(p.locator('[aria-selected="true"]')).waitFor();
      await a.getByRole('button', { name: 'What should I pick up next?' }).waitFor();
      await a.getByRole('textbox', { name: 'Ask the Board AI' }).fill('What is overdue?');
      await a.getByRole('button', { name: 'Send' }).click();
      await a.getByText('Nothing is overdue.').waitFor({ timeout: 40000 });
      await a.getByRole('button', { name: 'Copy answer' }).waitFor();
      await a.getByRole('button', { name: 'Regenerate' }).waitFor();
      await a.getByRole('button', { name: 'Helpful' }).click();
      await a.getByRole('button', { name: 'Close Board AI' }).click();
      await a.waitFor({ state: 'detached' });
    });

    await s.step('Board health: Check now lists what the AI found', async () => {
      const board = await (await fetch(`${s.server.base}/projects`)).json();
      const pid = (Array.isArray(board) ? board : board.projects)[0].id;
      const tickets = await (await fetch(`${s.server.base}/projects/${pid}/tickets`)).json();
      const tid = (Array.isArray(tickets) ? tickets : tickets.tickets)[0].id;
      s.server.fake({
        FAKE_CLAUDE_MODE: 'assistant',
        FAKE_CLAUDE_ASSISTANT_JSON: JSON.stringify({
          insights: [{ kind: 'stuck', ticket_id: tid, title: 'ALP-1 has not moved for 6 days', detail: 'In backlog since Monday.', score: 80 }],
          summary: 'One ticket is stuck.',
        }),
      });
      await home(s);
      await p.getByRole('button', { name: 'Board health' }).click();
      const d = p.getByRole('dialog', { name: 'Board health' });
      await d.getByText(/Not checked yet/).waitFor();
      await d.getByRole('button', { name: 'Check now' }).click();
      await d.getByText('ALP-1 has not moved for 6 days').waitFor({ timeout: 40000 });
      await d.getByText('One ticket is stuck.').waitFor();
      await d.getByRole('button', { name: 'Needs action 1' }).waitFor();
      await d.getByRole('button', { name: 'Close' }).click();
      await d.waitFor({ state: 'detached' });
    });

    await s.step('Idea Space: Ask about ideas and write the weekly digest', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'assistant', FAKE_CLAUDE_ASSISTANT_TEXT: 'Ideas look fine.' });
      await home(s);
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await p.getByRole('button', { name: 'Ask', exact: true }).click();
      const a = p.getByRole('complementary', { name: 'Ask about ideas' });
      await a.getByRole('button', { name: 'Which ideas are stale?' }).waitFor();
      await a.getByRole('textbox', { name: 'Ask about your ideas' }).fill('Which ideas are stale?');
      await a.getByRole('button', { name: 'Send' }).click();
      await a.getByText('Ideas look fine.').waitFor({ timeout: 40000 });
      await a.getByText(/Read 0 ideas/).waitFor();
      await p.getByRole('button', { name: 'Write it now' }).click();
      await p.getByText(/Weekly digest/).first().waitFor();
      await p.getByText(/Nothing needs attention this week\./).waitFor({ timeout: 40000 });
    });

    await s.step('remove the team and the account', async () => {
      s.server.fake({});
      await teamPage();
      await p.getByRole('button', { name: 'Remove…' }).click();
      await p.getByRole('heading', { name: `Remove team ${TEAM}` }).waitFor();
      const d = p.getByRole('dialog').filter({ has: p.getByRole('heading', { name: `Remove team ${TEAM}` }) });
      await d.getByRole('button', { name: /^(Reassign & remove|Remove)$/ }).click();
      await p.getByRole('heading', { name: 'Members', level: 1 }).waitFor();
      await p.getByText('No AI teams yet').waitFor();
      await p.getByRole('tab', { name: 'AI accounts 1' }).click();
      await p.getByRole('button', { name: 'More actions for Main Claude' }).click();
      await p.getByRole('menuitem', { name: /Remove/ }).click();
      await p.getByRole('heading', { name: 'Remove Main Claude?' }).waitFor();
      await p.getByRole('button', { name: 'Remove account' }).click();
      await p.getByText('No AI accounts yet').waitFor();
    });
  },
};
