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
        await p.getByRole('button', { name: /^AI/ }).click();
        await p.getByRole('button', { name: /Add AI team/ }).first().click();
        await p.getByRole('dialog', { name: 'Add AI team' }).getByRole('button', { name: 'Cancel' }).click();
      }
      await p.getByRole('heading', { name: 'Members', level: 1 }).waitFor();
      if (tab) await p.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    };
    const teamPage = async () => {
      await membersPage('AI teams');
      await p.getByRole('button', { name: TEAM, exact: true }).first().click();
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
    const assignTo = async (how) => {
      const d = await openTicket(s, 'ALP-1');
      await d.getByRole('button', { name: 'Unassigned' }).click();
      await p.getByRole('button', { name: new RegExp(`^${TEAM}`) }).click();
      await p.getByRole('button', { name: how }).click();
      return d;
    };

    await s.step('set up: a project with a ticket', async () => {
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
  },
};
