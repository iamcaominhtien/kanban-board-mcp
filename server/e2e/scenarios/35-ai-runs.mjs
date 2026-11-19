import fs from 'node:fs';
import { home, ensureProject, createTicket, closeTicket } from '../lib/ui.mjs';

// AI runs that go wrong or are steered, through the stand-in CLI (server/crates/fake-claude): a run that fails (the
// card says so, Retry starts run 2), a run stopped while it works (Stop run kills the CLI), a note to a working run,
// the steps of a run, /compact and /new in the ticket chat, Restart and Stop on the Resources tab, the team's activity,
// what "You stepped in" counts (marked, turned into a lesson), and the accounts: a sign-in cancelled, an account signed
// out and the team moved to another one. The stand-in is told how to behave by server.fake(...): FAKE_CLAUDE_V2_FAIL
// (an error), FAKE_CLAUDE_V2_HANG (works for ever), FAKE_CLAUDE_V2_DELAY (slow), FAKE_CLAUDE_V2_WAIT_MESSAGE.
//
// Not covered through the screen: GET /ai/power (only the desktop app polls it; the step reads it with a request) and
// POST /projects/:id/ai/pulls/poll (its button is on the card of a pull request opened on GitHub, which the stand-in
// cannot make; the step calls it with a request).
export default {
  name: 'AI runs: failed, retried, stopped, a note to a working run, compact, restart, touches, accounts',
  group: 'ai',
  soft: !!process.env.E2E_SOFT,
  async run(s) {
    const p = s.page;
    const base = s.server.base;
    const TEAM = 'Runs team';
    const until = async (fn, what, ms = 20000) => {
      const t0 = Date.now();
      for (;;) {
        try { const v = await fn(); if (v) return v; } catch { /* look again */ }
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await p.waitForTimeout(150);
      }
    };
    const api = async (method, path, body) => {
      const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json, text };
    };
    // the stand-in CLI processes this scenario's server started (found by the control file in their environment)
    const cliProcesses = () => fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).filter((n) => {
      try {
        const env = fs.readFileSync(`/proc/${n}/environ`, 'utf8');
        const cmd = fs.readFileSync(`/proc/${n}/cmdline`, 'utf8');
        return env.includes(`FAKE_CTL=${s.server.dirs.root}/fake.env`) && /fake-claude/.test(cmd) && !/sh\0/.test(cmd.slice(0, 4));
      } catch { return false; }
    });
    const ids = {};
    const runs = async () => (await api('GET', `/tickets/${ids.ticket}/ai/runs`)).json;
    const runOf = async (n) => (await runs()).find((r) => r.number === n);
    const openCard = async () => {
      await p.getByRole('button', { name: /ALP-1 / }).first().getByText('Fix add', { exact: true }).click();
      const d = p.getByRole('dialog', { name: 'Ticket ALP-1' });
      await d.waitFor();
      return d;
    };
    const activity = async (d) => {
      const tab = d.getByRole('tab', { name: 'AI activity' });
      if (await tab.count()) await tab.click();
      return d;
    };
    const membersPage = async (tab) => {
      await home(s);
      await p.getByRole('button', { name: /^Members/ }).first().click();
      await p.getByRole('button', { name: /^AI( \d+)?$/ }).click();
      await p.getByRole('button', { name: /Add AI team/ }).first().click();
      await p.getByRole('dialog', { name: 'Add AI team' }).getByRole('button', { name: 'Cancel' }).click();
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
    // sign an account in through the terminal window (the stand-in CLI wants the code "good")
    const signInThroughTerminal = async (name, email) => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2', FAKE_CLAUDE_EMAIL: email });
      const w = p.getByRole('dialog', { name: `Sign in: ${name}` });
      await w.getByText('Your turn: paste the code').waitFor();
      await w.getByLabel(/Terminal running/).click();
      await p.keyboard.type('good\n');
      await w.getByRole('status').filter({ hasText: new RegExp(`${name} is signed in as ${email.replace('.', '\\.')}`) }).waitFor();
      await w.getByRole('button', { name: 'Done' }).click();
      await w.waitFor({ state: 'detached' });
    };
    const addAccount = async (name) => {
      await p.getByRole('button', { name: 'Add account' }).first().click();
      await p.getByRole('button', { name: 'Next' }).click();
      await p.getByRole('textbox', { name: 'Name' }).fill(name);
      await p.getByRole('button', { name: 'Sign in' }).click();
    };

    await s.step('set up: a project with a ticket, linked to the repository', async () => {
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
      const projects = (await api('GET', '/projects')).json;
      ids.project = (Array.isArray(projects) ? projects : projects.projects)[0].id;
      const tickets = (await api('GET', `/projects/${ids.project}/tickets`)).json;
      ids.ticket = (Array.isArray(tickets) ? tickets : tickets.tickets)[0].id;
    });

    await s.step('accounts: a sign-in that is cancelled leaves the account signed out', async () => {
      await membersPage('AI accounts');
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2', FAKE_CLAUDE_EMAIL: 'spare@work.example' });
      await addAccount('Spare Claude');
      const w = p.getByRole('dialog', { name: 'Sign in: Spare Claude' });
      await w.getByText('Your turn: paste the code').waitFor();
      const stopped = p.waitForResponse((r) => r.request().method() === 'DELETE' && /\/ai\/accounts\/[^/]+\/signin$/.test(r.url()));
      await w.getByRole('button', { name: 'Cancel sign-in' }).click();
      await p.getByRole('alertdialog', { name: 'Stop signing in?' }).getByRole('button', { name: /^Stop/ }).click();
      const res = await stopped;
      s.note('cancel sign-in status', res.status());
      await w.waitFor({ state: 'detached' });
      const row = p.getByRole('row', { name: /Spare Claude/ });
      await row.waitFor();
      const list = (await api('GET', `/ai/accounts?project_id=${ids.project}`)).json;
      const spare = list.accounts.find((a) => a.name === 'Spare Claude');
      if (!spare || spare.status === 'signed_in') throw new Error('a cancelled sign-in must not leave the account signed in: ' + JSON.stringify(spare));
      ids.spare = spare.id;
      s.note('spare account status after the cancel', spare.status);
    });

    await s.step('accounts: sign both accounts in through the terminal', async () => {
      // the spare account again, now to the end
      await p.getByRole('row', { name: /Spare Claude/ }).getByRole('button', { name: /^Sign in/ }).first().click();
      await signInThroughTerminal('Spare Claude', 'spare@work.example');
      await p.getByRole('row', { name: /Spare Claude/ }).getByText('Signed in', { exact: true }).waitFor();
      await addAccount('Work Claude');
      await signInThroughTerminal('Work Claude', 'an@work.example');
      await p.getByRole('row', { name: /Work Claude/ }).getByText('Signed in', { exact: true }).waitFor();
      const list = (await api('GET', `/ai/accounts?project_id=${ids.project}`)).json;
      ids.work = list.accounts.find((a) => a.name === 'Work Claude').id;
    });

    await s.step('add the team on the Work account', async () => {
      await p.getByRole('tab', { name: /^AI teams/ }).click();
      await p.getByRole('button', { name: 'Set up a team' }).click();
      const d = p.getByRole('dialog', { name: 'Add AI team' });
      await d.getByRole('textbox', { name: 'Name' }).fill(TEAM);
      await d.getByRole('textbox', { name: /Working folder/ }).fill(s.server.dirs.repo);
      await d.getByRole('radio', { name: /Work Claude/ }).click();
      await d.getByRole('button', { name: 'Add team' }).click();
      await p.getByRole('heading', { name: TEAM, level: 1 }).waitFor();
      await p.getByText(`${TEAM} added`).waitFor();
      const teams = (await api('GET', `/projects/${ids.project}/ai/teams`)).json;
      ids.team = (Array.isArray(teams) ? teams : teams.teams).find((t) => t.name === TEAM).id;
    });

    await s.step('a run that fails: the card, the ticket and the run say so and offer Retry', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2', FAKE_CLAUDE_V2_FAIL: 'Credit balance is too low' });
      await home(s);
      const d = await openCard();
      await d.getByRole('button', { name: 'Unassigned' }).click();
      await p.getByRole('button', { name: new RegExp(`^${TEAM}`) }).click();
      await p.getByRole('button', { name: 'Assign & start' }).click();
      await closeTicket(s);
      await p.getByRole('button', { name: /ALP-1 Fix add Failed/ }).waitFor({ timeout: 40000 });
      const r1 = await runOf(1);
      if (r1.state !== 'failed') throw new Error('run 1 should be failed, is ' + r1.state);
      s.note('run 1 state', r1.state);
      s.note('run 1 error', String(r1.error || r1.summary || ''));
      const d2 = await activity(await openCard());
      await d2.getByText('Run #1 did not finish').waitFor();
      await d2.getByRole('button', { name: 'Open run ›' }).click();
      await d2.getByText(/Credit balance is too low/).first().waitFor();
      await d2.getByText('Failed', { exact: true }).first().waitFor();
      await d2.getByTestId('run-retry').getByText('Retry', { exact: true }).waitFor();
    });

    await s.step('Retry starts run 2, which finishes; a long run shows its newest steps and loads the earlier ones', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2', FAKE_CLAUDE_V2_STEPS: '120' });
      const d = p.getByRole('dialog', { name: 'Ticket ALP-1' });
      const posted = p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/runs\/[^/]+\/retry$/.test(r.url()));
      await d.getByTestId('run-retry').click();
      const res = await posted;
      if (res.status() !== 200) throw new Error('retry answered ' + res.status());
      await d.getByText('Finished', { exact: true }).first().waitFor({ timeout: 40000 }).catch(() => {});
      await until(async () => (await runOf(2))?.state === 'finished', 'run 2 finished', 40000);
      const [r1, r2] = [await runOf(1), await runOf(2)];
      s.note('states after the retry', [r1.state, r2.state]);
      ids.run2 = r2.id;
      // run 2 is on screen: its report and the older steps behind a button
      await d.getByText('Run #2').first().waitFor();
      const earlier = d.getByTestId('show-earlier-steps');
      await earlier.waitFor();
      const got = p.waitForResponse((r) => r.request().method() === 'GET' && /\/ai\/runs\/[^/]+\/steps\?/.test(r.url()));
      await earlier.click();
      const steps = await got;
      if (steps.status() !== 200) throw new Error('steps answered ' + steps.status());
      await earlier.waitFor({ state: 'detached' });
      const page = await api('GET', `/ai/runs/${ids.run2}/steps?after=0&limit=500`);
      if (page.status !== 200 || !Array.isArray(page.json) || page.json.length < 120) throw new Error('steps page: ' + page.status + ' ' + page.text.slice(0, 200));
      const tail = await api('GET', `/ai/runs/${ids.run2}/steps?after=${page.json[page.json.length - 3].seq}`);
      if (tail.json.length !== 2) throw new Error('after= must return the steps after that seq, got ' + tail.json.length);
      await d.getByText('echo step 0', { exact: false }).first().waitFor();
    });

    await s.step('run 3 works and never ends: the team page and the machine see it', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2', FAKE_CLAUDE_V2_HANG: '1' });
      await closeTicket(s);
      await home(s);
      const d = await openCard();
      await d.getByRole('button', { name: `Run ${TEAM}` }).click();
      await until(async () => (await runOf(3))?.state === 'running', 'run 3 running', 40000);
      ids.run3 = (await runOf(3)).id;
      await closeTicket(s);
      await p.getByRole('button', { name: /ALP-1 Fix add Running/ }).waitFor({ timeout: 20000 });
      // the machine: one run is active
      const power = await api('GET', '/ai/power');
      if (power.status !== 200 || power.json.active !== 1) throw new Error('GET /ai/power: ' + power.status + ' ' + power.text);
      // the team's activity (GET /ai/teams/:id/activity) is the team page's cards
      const act = await api('GET', `/ai/teams/${ids.team}/activity`);
      if (act.status !== 200 || !act.json.lead.working) throw new Error('the lead should be working: ' + act.text.slice(0, 300));
      s.note('lead working on', act.json.lead.working.ticket_id || act.json.lead.working.ticketId);
      await aiTeamView();
      await p.getByRole('button', { name: TEAM, exact: true }).click();
      const cards = p.getByTestId('role-cards');
      await cards.waitFor();
      await cards.getByText(/ALP-1/).first().waitFor();
      await cards.getByText(/Working|working/).first().waitFor();
    });

    await s.step('Resources: Restart starts the CLI of the working run again inside the same run', async () => {
      await aiTeamView('Resources');
      await p.getByRole('button', { name: 'ALP-1', exact: true }).first().waitFor();
      await p.getByTestId('rs-restart').click();
      const ask = p.getByRole('dialog', { name: 'Confirm restart' });
      await ask.getByText(/Restart Runs team.s run on ALP-1\?/).waitFor();
      const posted = p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/runs\/[^/]+\/restart$/.test(r.url()));
      await ask.getByTestId('rs-confirm').click();
      const res = await posted;
      if (res.status() !== 200) throw new Error('restart answered ' + res.status());
      const body = await res.json();
      if (body.restarting !== true) throw new Error('restart body: ' + JSON.stringify(body));
      await ask.waitFor({ state: 'detached' });
      // the same run goes on (no new run), still working
      await p.waitForTimeout(100);
      await until(async () => (await runs()).length === 3 && (await runOf(3)).state === 'running', 'run 3 still the working run');
      const live = await api('GET', `/projects/${ids.project}/ai/live`);
      s.note('live after the restart', live.status);
    });

    await s.step('ticket chat: the commands, /compact while the lead works is queued, /cost', async () => {
      await home(s);
      const d = await openCard();
      await d.getByRole('button', { name: 'AI', exact: true }).click();
      const chat = p.getByTestId('scoped-chat');
      await chat.waitFor();
      const box = chat.getByRole('textbox', { name: 'Ask the AI' });
      await box.fill('/');
      const menu = chat.getByTestId('chat-slash-menu');
      await menu.waitFor();
      for (const c of ['compact', 'new', 'history', 'report', 'stop', 'cost']) await menu.getByTestId(`chat-slash-${c}`).waitFor();
      // /new is not offered while the lead works
      const off = await menu.getByTestId('chat-slash-new').getAttribute('aria-disabled');
      if (off !== 'true') throw new Error('/new must be disabled while a run works');
      await box.fill('/compact');
      const posted = p.waitForResponse((r) => r.request().method() === 'POST' && /\/tickets\/[^/]+\/ai\/compact$/.test(r.url()));
      await menu.getByTestId('chat-slash-compact').click();
      const res = await posted;
      if (res.status() !== 200) throw new Error('compact answered ' + res.status());
      const body = await res.json();
      s.note('compact answer', body);
      if (body.state !== 'queued') throw new Error('compact while working must be queued: ' + JSON.stringify(body));
      await chat.getByTestId('chat-notice').getByText(/Compacting once the lead finishes the step it is on/).waitFor();
      // /cost reads the runs of the ticket
      await box.fill('/cost');
      await menu.getByTestId('chat-slash-cost').click();
      await chat.getByTestId('chat-notice').getByText(/3 runs/).waitFor();
    });

    await s.step('Stop run ends the working run: it is cancelled, the CLI is gone and Run again is offered', async () => {
      const chat = p.getByTestId('scoped-chat');
      await chat.getByRole('button', { name: 'Close' }).click();
      const d = p.getByRole('dialog', { name: 'Ticket ALP-1' });
      await activity(d);
      await d.getByRole('button', { name: 'Open run ›' }).click();
      await d.getByText('Run #3').first().waitFor();
      if (!cliProcesses().length) throw new Error('the working run should have a CLI process');
      const posted = p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/runs\/[^/]+\/cancel$/.test(r.url()));
      await d.getByTestId('run-cancel').click();
      const res = await posted;
      if (res.status() !== 200) throw new Error('cancel answered ' + res.status());
      await d.getByText('Cancelled', { exact: true }).first().waitFor();
      await d.getByTestId('run-cancel').waitFor({ state: 'detached' });
      await d.getByTestId('run-retry').getByText('Run again', { exact: true }).waitFor();
      const r3 = await runOf(3);
      if (r3.state !== 'cancelled') throw new Error('run 3 should be cancelled, is ' + r3.state);
      await until(async () => cliProcesses().length === 0, 'the CLI of the stopped run to be gone');
      const power = await api('GET', '/ai/power');
      if (power.json.active !== 0) throw new Error('GET /ai/power after the stop: ' + power.text);
      await closeTicket(s);
      await p.getByRole('button', { name: /ALP-1 Fix add Cancelled/ }).waitFor();
    });

    await s.step('a note to a working run: the lead hears it and the run finishes with it', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2', FAKE_CLAUDE_V2_WAIT_MESSAGE: '1', FAKE_CLAUDE_WAIT: '60' });
      const d = await openCard();
      await d.getByRole('button', { name: `Run ${TEAM}` }).click();
      await until(async () => (await runOf(4))?.state === 'running', 'run 4 running', 40000);
      ids.run4 = (await runOf(4)).id;
      // the ticket opens on the working run itself
      await d.getByText('Run #4').first().waitFor();
      const box = d.getByTestId('run-message-box');
      await box.getByText(/Tell the lead now|Leave a note for the lead/).waitFor();
      await box.getByTestId('run-message-input').fill('Use tabs, not spaces.');
      const posted = p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/runs\/[^/]+\/message$/.test(r.url()));
      await box.getByTestId('run-message-send').click();
      const res = await posted;
      if (res.status() !== 200) throw new Error('message answered ' + res.status());
      s.note('message answer', await res.json());
      s.note('toast "Sent" shown', await p.getByText('Sent', { exact: true }).first().waitFor({ timeout: 4000 }).then(() => true, () => false));
      await until(async () => (await runOf(4)).state === 'finished', 'run 4 finished', 40000);
      await d.getByText(/Heard:[\s\S]*Use tabs, not spaces\./).and(p.locator(':visible')).first().waitFor();
      await d.getByTestId('run-message-box').waitFor({ state: 'detached' });
      const msgs = await api('GET', `/ai/runs/${ids.run4}/messages`);
      if (msgs.status !== 200 || !JSON.stringify(msgs.json).includes('Use tabs, not spaces.')) throw new Error('the message is not in the run: ' + msgs.text.slice(0, 300));
      await d.getByTestId('run-messages').getByText(/Use tabs, not spaces\./).first().waitFor().catch(async () => {
        await d.getByTestId('run-messages').locator('summary').click();
        await d.getByTestId('run-messages').getByText(/Use tabs, not spaces\./).waitFor();
      });
      await closeTicket(s);
    });

    await s.step('ticket chat: /new starts the team over and keeps the old conversation in History', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2', FAKE_CLAUDE_JSON_RESULT: 'Fixed add() and heard about tabs.' });
      const before = await api('GET', `/tickets/${ids.ticket}/ai/sessions`);
      if (before.status !== 200 || before.json.length !== 0) throw new Error('no closed conversation yet: ' + before.text);
      const d = await openCard();
      await d.getByRole('button', { name: 'AI', exact: true }).click();
      const chat = p.getByTestId('scoped-chat');
      const box = chat.getByRole('textbox', { name: 'Ask the AI' });
      await box.fill('/new');
      const menu = chat.getByTestId('chat-slash-menu');
      await menu.getByTestId('chat-slash-new').click();
      await chat.getByTestId('chat-start-over-confirm').getByText(/Start Runs team over\?/).waitFor();
      const posted = p.waitForResponse((r) => r.request().method() === 'POST' && /\/tickets\/[^/]+\/ai\/sessions\/new$/.test(r.url()));
      await chat.getByTestId('chat-start-over-yes').click();
      const res = await posted;
      if (res.status() !== 200) throw new Error('sessions/new answered ' + res.status());
      s.note('sessions/new keys', Object.keys(await res.json()).sort());
      await chat.getByTestId('chat-notice').getByText(/Started over\. Kept in History/).waitFor();
      const history = chat.getByTestId('chat-history');
      await history.waitFor();
      const item = history.getByTestId('chat-history-item');
      await item.waitFor();
      await item.locator('summary').click();
      await item.getByText(/4 runs/).waitFor();
      const after = await api('GET', `/tickets/${ids.ticket}/ai/sessions`);
      if (after.json.length !== 1) throw new Error('one closed conversation expected: ' + after.text);
      s.note('history item runs', after.json[0].run_ids ? after.json[0].run_ids.length : after.json[0].runIds?.length);
      await chat.getByRole('button', { name: 'Close' }).click();
      await closeTicket(s);
    });

    await s.step('You stepped in: the retry, the stop and the note are counted; one is marked avoidable and becomes a lesson', async () => {
      await aiTeamView('You stepped in');
      const rows = p.getByTestId('touch-row');
      await until(async () => (await rows.count()) >= 3, 'the touches of this session');
      const kinds = await rows.locator('.st-kind').allInnerTexts();
      s.note('touch kinds', kinds.sort());
      const note = rows.filter({ hasText: /Use tabs, not spaces/ });
      await note.first().waitFor();
      const put = p.waitForResponse((r) => r.request().method() === 'PUT' && /\/ai\/team\/touches\/mark$/.test(r.url()));
      await note.first().getByRole('button', { name: /Avoidable|avoidable/ }).click();
      const marked = await put;
      if (!marked.ok()) throw new Error('mark answered ' + marked.status());
      await note.first().getByRole('button', { name: /Avoidable|avoidable/ }).and(p.locator('[aria-pressed="true"]')).waitFor();
      await note.first().getByTestId('make-lesson').click();
      const lessonBox = note.first().getByRole('textbox');
      await lessonBox.fill('Tell the lead to use tabs in this repository.');
      const posted = p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/team\/touches\/lesson$/.test(r.url()));
      await note.first().getByTestId('lesson-propose').click();
      const res = await posted;
      if (!res.ok()) throw new Error('lesson answered ' + res.status() + ' ' + await res.text());
      await note.first().getByTestId('lesson-made').waitFor();
      // the lesson waits in Memory
      await aiTeamView('Memory');
      await p.getByText('Tell the lead to use tabs in this repository.').waitFor();
      // and the mark is kept after a reload
      await aiTeamView('You stepped in');
      await p.getByTestId('touch-row').filter({ hasText: /Use tabs, not spaces/ }).getByTestId('lesson-made').waitFor();
    });

    await s.step('accounts: Sign out makes the team wait for a sign-in; Choose another account moves it', async () => {
      await membersPage('AI accounts');
      await p.getByRole('button', { name: 'More actions for Work Claude' }).click();
      await p.getByRole('menuitem', { name: /Sign out/ }).click();
      const dlg = p.getByRole('dialog', { name: 'Sign out Work Claude?' });
      await dlg.waitFor();
      const posted = p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/accounts\/[^/]+\/sign-out$/.test(r.url()));
      await dlg.getByRole('button', { name: 'Sign out' }).click();
      const res = await posted;
      if (res.status() !== 200) throw new Error('sign-out answered ' + res.status());
      await dlg.waitFor({ state: 'detached' });
      const row = p.getByRole('row', { name: /Work Claude/ });
      await row.getByText('Signed in', { exact: true }).waitFor({ state: 'detached' });
      const list = (await api('GET', `/ai/accounts?project_id=${ids.project}`)).json;
      const work = list.accounts.find((a) => a.name === 'Work Claude');
      s.note('Work account after sign-out', work.status);
      if (work.status === 'signed_in') throw new Error('the account must be signed out: ' + JSON.stringify(work));
      // the team that runs as it says so
      await teamPage();
      await p.getByText('The account Work Claude needs to sign in.').waitFor();
      await p.getByText('Needs sign-in').first().waitFor();
    });

    await s.step('a run on the signed-out account waits; Cancel run and Run again; the team moves to the spare account and the waiting run starts', async () => {
      const record = `${s.server.dirs.root}/config-record.txt`;
      s.server.fake({ FAKE_CLAUDE_MODE: 'v2', FAKE_CLAUDE_CONFIG_RECORD: record });
      await home(s);
      const d = await openCard();
      await d.getByRole('button', { name: `Run ${TEAM}` }).click();
      await d.getByText('Work Claude is signed out').waitFor();
      await d.getByRole('button', { name: 'Sign in again' }).waitFor();
      // Cancel run on the waiting run, then Run again: run 6 waits the same way
      const cancelled = p.waitForResponse((r) => r.request().method() === 'POST' && /\/ai\/runs\/[^/]+\/cancel$/.test(r.url()));
      await d.getByTestId('run-cancel').getByText('Cancel run').click();
      if ((await cancelled).status() !== 200) throw new Error('cancel of a queued run failed');
      await d.getByText('Cancelled', { exact: true }).first().waitFor();
      await d.getByTestId('run-retry').click();
      await until(async () => (await runOf(6))?.state === 'queued', 'run 6 queued', 10000);
      await d.getByText('Work Claude is signed out').waitFor();
      await closeTicket(s);
      // the banner on the Members page moves the team to the account that is signed in (PUT /ai/teams/:id/account)
      await membersPage('AI teams');
      await p.getByText(/Work Claude/).first().waitFor();
      await p.getByRole('button', { name: 'Choose another account' }).first().click();
      const pick = p.getByRole('dialog', { name: 'Choose an account' });
      await pick.getByRole('radio', { name: /^Spare Claude/ }).click();
      const put = p.waitForResponse((r) => r.request().method() === 'PUT' && /\/ai\/teams\/[^/]+\/account$/.test(r.url()));
      await pick.getByTestId('account-save').click();
      const moved = await put;
      if (moved.status() !== 200) throw new Error('PUT account answered ' + moved.status());
      await pick.waitFor({ state: 'detached' });
      await p.getByRole('button', { name: 'Choose another account' }).waitFor({ state: 'detached' });
      const teams = (await api('GET', `/projects/${ids.project}/ai/teams`)).json;
      const t = (Array.isArray(teams) ? teams : teams.teams).find((x) => x.id === ids.team);
      if ((t.account_id || t.accountId) !== ids.spare) throw new Error('the team should run as the spare account: ' + JSON.stringify(t).slice(0, 300));
      // the waiting run follows the team to the spare account and starts (it used to keep waiting for the old
      // account's sign-in until it was cancelled)
      await until(async () => ['running', 'finished'].includes((await runOf(6))?.state), 'run 6 started on the spare account', 20000);
      await home(s);
      const d2 = await activity(await openCard());
      const open = d2.getByRole('button', { name: 'Open run ›' });
      if (await open.count()) await open.click();
    });

    await s.step('the waiting run uses the spare account', async () => {
      const record = `${s.server.dirs.root}/config-record.txt`;
      await until(async () => (await runOf(6))?.state === 'finished', 'run 6 finished on the spare account', 40000);
      const spare = (await api('GET', `/ai/accounts?project_id=${ids.project}`)).json.accounts.find((a) => a.id === ids.spare);
      const used = fs.readFileSync(record, 'utf8').trim().split('\n');
      if (!used.length || !used.every((l) => l === spare.folder)) throw new Error(`the run should use ${spare.folder}, used ${used.join(', ')}`);
      await p.getByRole('dialog', { name: 'Ticket ALP-1' }).getByText('Finished', { exact: true }).first().waitFor();
      await closeTicket(s);
    });

    await s.step('the pull request check answers without a pull request (POST /ai/pulls/poll)', async () => {
      const r = await api('POST', `/projects/${ids.project}/ai/pulls/poll`);
      s.note('pulls/poll', [r.status, r.json]);
      // the UI types `changes` as a number; the server answers a list of the changes
      if (r.status !== 200 || !Array.isArray(r.json.changes)) throw new Error('pulls/poll: ' + r.status + ' ' + r.text.slice(0, 200));
      const list = await api('GET', `/projects/${ids.project}/ai/pulls`);
      if (list.status !== 200 || !Array.isArray(list.json) || list.json.length) throw new Error('pulls: ' + list.text.slice(0, 200));
    });
  },
};
