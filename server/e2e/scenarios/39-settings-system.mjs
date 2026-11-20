import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { home, ensureProject, createTicket, addMember } from '../lib/ui.mjs';

// Settings > Storage & backup and the system screens around it.
//
// - the "Move to another database" wizard, all four steps, with a second SQLite file as the target (the wizard offers
//   only PostgreSQL and MySQL/MariaDB as cards, but a pasted `sqlite:///path` connection string reaches the same
//   server calls, and no database server is needed): a target that holds tables, Start empty, a copy that stops
//   (a trigger on the target stands in for a column that is too small), apply and resume, cancel, verify and switch;
// - the reconnect screen (a 503 database_unreachable answered once to the page), Edit connection and Open the SQLite
//   file again from it;
// - the data folder, moved inside the server's HOME;
// - the desktop-only pages through a stand-in `window.electronAPI`: Settings > Updates and the update notice;
// - Open file of the MCP integrations (the config file is missing, then there).
//
// Not covered: Ask the AI of a stopped copy (it needs an AI member with a signed-in account; the failed answer is
// looked at), PostgreSQL and MariaDB (no server here), Edit connection of a server database.
export default {
  name: 'Settings (system): database move wizard, reconnect screen, data folder, Updates, Open file',
  async run(s) {
    const p = s.page;
    const dataDir = path.join(s.server.dirs.root, 'data');
    const tmp = path.join(s.server.dirs.root, 'targets');
    fs.mkdirSync(tmp, { recursive: true });
    const nav = () => p.getByRole('navigation', { name: 'Settings pages' });
    const until = async (fn, what, ms = 20000) => {
      const t0 = Date.now();
      for (;;) {
        try { if (await fn()) return; } catch { /* look again */ }
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await p.waitForTimeout(150);
      }
    };
    // One call to the REST API as the page makes it (the server state behind a screen).
    const api = async (method, url, data) => {
      const r = await p.request.fetch(s.server.base + url, { method, data, headers: { 'content-type': 'application/json' } });
      return { status: r.status(), body: await r.json().catch(() => null) };
    };
    const sqlite = (file, sql) => execFileSync('python3', ['-I', '-c', 'import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.executescript(sys.argv[2])\nc.commit()', file, sql]);
    const scalar = (file, sql) => Number(execFileSync('python3', ['-I', '-c', 'import sqlite3,sys\nprint(sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchone()[0])', file, sql]).toString().trim());
    const openStorage = async () => {
      await home(s);
      await p.getByRole('button', { name: 'Settings' }).click();
      await nav().getByRole('button', { name: 'Storage & backup', exact: true }).click();
      await p.getByRole('heading', { name: 'Storage & backup', level: 1 }).waitFor();
      await p.getByTestId('db-facts').waitFor();
    };
    const wizard = () => p.getByRole('dialog', { name: 'Move to another database' });
    const openWizard = async () => {
      await p.getByTestId('db-move').click();
      await wizard().waitFor();
    };
    // step 1 with a pasted connection string
    const whereTo = async (file) => {
      const d = wizard();
      if (await d.getByRole('radio', { name: /PostgreSQL/ }).count()) {
        await d.getByRole('radio', { name: /PostgreSQL/ }).click();
        await d.getByTestId('move-next').click();
        await d.getByRole('button', { name: 'paste a connection string' }).click();
      }
      await d.getByLabel('Connection string').fill(`sqlite:///${file}`);
      await d.getByTestId('move-test').click();
      await d.getByText(/A file on this computer/).waitFor();
    };
    const closeWizard = async () => {
      await p.keyboard.press('Escape');
      await wizard().waitFor({ state: 'detached' });
    };
    const moveState = async () => (await api('GET', '/database/move')).body?.state ?? null;
    const target = (name) => path.join(tmp, name);

    // A copy that an interruption left, with a trigger on the target that stands in for a column that is too
    // small: the server offers to resume it, and the copy stops in `project`.
    const prepareStop = async (file) => {
      const check = await api('POST', '/database/move/check', { url: `sqlite:///${file}` });
      if (check.status !== 200) throw new Error(`check: ${JSON.stringify(check.body)}`);
      const start = await api('POST', '/database/move/start', { mode: 'empty' });
      if (start.status !== 200) throw new Error(`start: ${JSON.stringify(start.body)}`);
      await until(async () => (await moveState()) === 'verified', 'the empty database to be made');
      await api('DELETE', '/database/move');
      sqlite(file, "CREATE TRIGGER too_small BEFORE INSERT ON project WHEN 1 BEGIN SELECT RAISE(ABORT, 'Data too long for column ''name'' at row 1'); END");
      fs.writeFileSync(path.join(dataDir, 'db-move.json'), JSON.stringify({ id: 'abcdef012345', state: 'copying', target: { engine: 'sqlite', path: file }, done: [], stopped_in: null, saved_at: 0.0 }));
      if ((await moveState()) !== 'interrupted') throw new Error(`the move is ${await moveState()}, not interrupted`);
    };
    const stoppedPanel = () => wizard().getByTestId('move-stopped');

    await s.step('set up: a project with a member and two tickets', async () => {
      await ensureProject(s);
      await addMember(s, 'Me');
      await createTicket(s, { title: 'Move me one' });
      await createTicket(s, { title: 'Move me two' });
    });

    // ---------------------------------------------------------------- the card
    await s.step('the Database card reads the file: engine, size, tables, tickets and schema state', async () => {
      await openStorage();
      await p.getByTestId('db-title').getByText('SQLite · local file').waitFor();
      const facts = p.getByTestId('db-facts');
      await facts.getByText(/2 tickets in 1 project/).waitFor();
      await facts.getByText(/82 tables/).waitFor();
      await facts.getByText(/up to date/).waitFor();
      await p.getByTestId('db-chip').getByText('Local file').waitFor();
      const db = (await api('GET', '/database')).body;
      if (db.engine !== 'sqlite' || db.tickets !== 2 || db.projects !== 1 || db.reachable !== true) throw new Error(`database: ${JSON.stringify(db)}`);
      await p.getByRole('button', { name: 'Why only these?' }).click();
      await p.getByText(/Redis and MongoDB|relational/).first().waitFor();
    });

    // ---------------------------------------------------------------- Check: a target that holds tables
    const foreign = target('foreign.db');
    await s.step('Check: a file that already holds tables is not written into; "Use another database" goes back', async () => {
      sqlite(foreign, 'CREATE TABLE notes (x)');
      await openWizard();
      await whereTo(foreign);
      // the test says what it found: not empty
      await wizard().getByText(/Not empty/).first().waitFor();
      await wizard().getByTestId('move-next').click();
      const d = wizard();
      await d.getByTestId('move-step-check').waitFor();
      await d.getByTestId('move-not-empty').getByText(/foreign\.db on foreign\.db already has 1 tables/).waitFor();
      await d.getByText('Step 2 of 4 · nothing has been written yet.').waitFor();
      await d.getByTestId('move-start').and(p.locator(':disabled')).waitFor();
      if ((await moveState()) !== 'ready') throw new Error(`the move is ${await moveState()}`);
      // the plan: attachments stay, the tables are made first
      await d.getByText(/Attachments do not move/).waitFor();
      await d.getByText(/The tables are created first/).waitFor();
      await d.getByRole('button', { name: 'Use another database' }).click();
      await d.getByTestId('move-step-where').waitFor();
      await d.getByLabel('Connection string').waitFor();
    });

    await s.step('Check: the script for the same copy is shown and names the target', async () => {
      const d = wizard();
      const good = target('copy-one.db');
      await whereTo(good);
      await d.getByTestId('move-next').click();
      await d.getByTestId('move-step-check').waitFor();
      await d.getByText(/Empty · the board will create 82 tables/).waitFor();
      await d.getByText(/Connection tested a moment ago/).waitFor();
      await d.getByRole('button', { name: 'Show it' }).click();
      const script = d.getByTestId('move-script');
      await script.getByText(/db migrate --from sqlite:\/\/\/.*kanban\.db --to sqlite:\/\/\/.*copy-one\.db --dry-run/).waitFor();
      await script.getByText(/--verify/).first().waitFor();
      await d.getByRole('button', { name: 'Hide it' }).click();
      await script.waitFor({ state: 'detached' });
      const cmd = (await api('GET', `/database/command?target=${encodeURIComponent('sqlite:///' + good)}`)).body;
      if (!cmd.run.includes(`--to sqlite:///${good} --verify`) || !cmd.dry_run.includes('--dry-run')) throw new Error(`command: ${JSON.stringify(cmd)}`);
      // "Start empty" can be chosen and unchosen
      await d.getByTestId('move-mode-empty').click();
      await d.getByRole('button', { name: 'Create empty database' }).waitFor();
      await d.getByTestId('move-mode-copy').click();
      await d.getByRole('button', { name: 'Copy my data' }).waitFor();
      // closing the wizard before a copy closes the move on the server
      await d.getByRole('button', { name: 'Close' }).first().click();
      await d.waitFor({ state: 'detached' });
      await until(async () => (await moveState()) === null, 'the move to be closed');
      await p.getByTestId('db-move-strip').waitFor({ state: 'detached' });
    });

    // ---------------------------------------------------------------- Empty it first, copy, verify, keep
    await s.step('Empty it first: the name must be typed, then the file is emptied and the data is copied and checked', async () => {
      await openWizard();
      await whereTo(foreign);
      await wizard().getByTestId('move-next').click();
      const d = wizard();
      await d.getByTestId('move-not-empty').waitFor();
      await d.getByRole('button', { name: /^Empty it first/ }).click();
      const del = d.getByTestId('move-empty-first');
      await del.and(p.locator(':disabled')).waitFor();
      await d.getByTestId('move-confirm-input').fill('wrong.db');
      await del.and(p.locator(':disabled')).waitFor();
      // the server refuses a wrong name too
      const refused = await api('POST', '/database/move/start', { mode: 'copy', empty_first: true, confirm: 'wrong.db' });
      if (refused.status !== 422 || refused.body.detail.code !== 'confirm' || refused.body.detail.message !== 'Type foreign.db to confirm.') throw new Error(`confirm: ${JSON.stringify(refused)}`);
      await d.getByTestId('move-confirm-input').fill('foreign.db');
      await del.and(p.locator(':enabled')).waitFor();
      await del.click();
      await d.getByTestId('move-verified').waitFor({ timeout: 60000 });
      await d.getByText(/The new database holds the same data as the file/).waitFor();
      await d.getByText('Step 4 of 4').waitFor();
      const table = d.getByTestId('move-verify-table');
      await table.getByText('project', { exact: true }).waitFor();
      await d.getByText(/Row counts · equal in all 82 tables/).waitFor();
      await d.getByText(/Counters · the next ticket number carries on from ALP-3/).waitFor();
      // the file really holds the board now, and the old `notes` table is gone
      if (scalar(foreign, 'SELECT count(*) FROM ticket') !== 2) throw new Error('the tickets are not in the new file');
      if (scalar(foreign, "SELECT count(*) FROM sqlite_master WHERE name='notes'") !== 0) throw new Error('notes was not dropped');
    });

    await s.step('Verify: "Keep SQLite, switch later" closes the move and leaves the board where it is', async () => {
      const d = wizard();
      await d.getByRole('button', { name: 'Keep SQLite, switch later' }).click();
      await d.waitFor({ state: 'detached' });
      await until(async () => (await moveState()) === null, 'the move to be forgotten');
      const db = (await api('GET', '/database')).body;
      if (db.display !== path.join(dataDir, 'kanban.db')) throw new Error(`the board moved: ${db.display}`);
      await p.getByTestId('db-move-strip').waitFor({ state: 'detached' });
    });

    // ---------------------------------------------------------------- Start empty
    await s.step('Start empty: the new database has the tables and no rows, and Verify says it is ready and empty', async () => {
      const t = target('empty.db');
      await openWizard();
      await whereTo(t);
      await wizard().getByTestId('move-next').click();
      const d = wizard();
      await d.getByTestId('move-mode-empty').click();
      await d.getByTestId('move-mode-empty').and(p.locator('[aria-checked="true"]')).waitFor();
      await d.getByTestId('move-start').click();
      await d.getByText('The new database is ready, and empty').waitFor({ timeout: 60000 });
      await d.getByText(/The board’s tables were made; nothing was copied/).waitFor();
      if (scalar(t, 'SELECT count(*) FROM ticket') !== 0) throw new Error('an empty move copied tickets');
      if (scalar(t, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='ticket'") !== 1) throw new Error('no ticket table');
      await d.getByRole('button', { name: 'Keep SQLite, switch later' }).click();
      await d.waitFor({ state: 'detached' });
    });

    // ---------------------------------------------------------------- a copy that stops
    const stopFile = target('stops.db');
    await s.step('a copy that an interruption left shows on the card; Open continues at the copy step with Resume', async () => {
      await prepareStop(stopFile);
      await openStorage();
      const strip = p.getByTestId('db-move-strip');
      await strip.getByText(/A copy to/).waitFor();
      await strip.getByText(/was interrupted/).waitFor();
      await strip.getByRole('button', { name: 'Open' }).click();
      const d = wizard();
      await d.getByTestId('move-paused').waitFor();
      await d.getByText(/The copy stopped at \d+%/).waitFor();
      await d.getByText(/The app was closed or lost the connection while it copied/).waitFor();
      await d.getByRole('button', { name: /^Resume from/ }).waitFor();
      await d.getByRole('button', { name: 'Start over' }).waitFor();
      await d.getByTestId('move-tables').waitFor();
      // Hide closes the window; the move stays and the card still offers it
      await d.getByRole('button', { name: 'Hide' }).click();
      await d.waitFor({ state: 'detached' });
      if ((await moveState()) !== 'interrupted') throw new Error('Hide closed the move');
      await strip.getByRole('button', { name: 'Open' }).click();
      await d.getByTestId('move-paused').waitFor();
    });

    await s.step('Resume: the copy stops in "project" and says what the board knows; Ask the AI has no one to ask', async () => {
      const d = wizard();
      await d.getByTestId('move-resume').click();
      await stoppedPanel().waitFor({ timeout: 60000 });
      await stoppedPanel().getByText(/The copy stopped at table project/).waitFor();
      const facts = d.getByTestId('move-stop-facts');
      await facts.getByText("Data too long for column 'name' at row 1").waitFor();
      await facts.getByText('project.name').waitFor();
      await facts.getByText('5 characters').waitFor();
      await d.getByText('Step 3 of 4 · stopped').waitFor();
      await d.getByTestId('move-ai-chip').getByText('Not run yet').waitFor();
      const job = (await api('GET', '/database/move')).body;
      if (job.state !== 'stopped' || job.stop.table !== 'project' || job.stop.column !== 'name' || job.stop.value_length !== 5) throw new Error(`stop: ${JSON.stringify(job.stop)}`);
      // the AI is asked: with no AI member answering, the move says so (either way the call is made and the chip changes)
      await d.getByTestId('move-ask').click();
      // the answer comes from a background task: wait until the chip is neither "Asking…" nor "Not run yet"
      await until(async () => !/^(Asking…|Not run yet)$/.test((await d.getByTestId('move-ai-chip').innerText()).trim()), 'the AI to answer or fail');
      const chip = (await d.getByTestId('move-ai-chip').innerText()).trim();
      s.note('Ask the AI chip with the stand-in AI', chip);
      s.note('Ask the AI panel', (await d.getByTestId('move-ai').innerText()).replace(/\s+/g, ' ').slice(0, 400));
      if (chip === 'Could not answer') {
        await d.getByTestId('move-ai-failed').waitFor();
        await d.getByRole('button', { name: 'Ask again' }).waitFor();
      }
    });

    await s.step('Ask something else sends the question; What it was given shows what the AI saw and never a row', async () => {
      const d = wizard();
      await d.getByRole('button', { name: 'Ask something else' }).click();
      await d.getByTestId('move-question').fill('Would TEXT be enough?');
      await d.getByTestId('move-question').press('Enter');
      await d.getByText('You asked: “Would TEXT be enough?”').waitFor({ timeout: 30000 });
      await d.getByRole('button', { name: 'What it was given' }).click();
      const shown = d.getByText('exactly what the AI was given');
      await shown.waitFor();
      const text = await d.getByTestId('move-ai').innerText();
      if (/Move me one|password/i.test(text.replace(/never the password/gi, ''))) throw new Error('the AI was shown a row or a password');
    });

    await s.step('Edit it myself: a statement the board will not run is refused, an ALTER TABLE is applied and the copy stops again', async () => {
      const d = wizard();
      await d.getByRole('button', { name: 'Edit it myself' }).click();
      await d.getByTestId('move-edit-statements').fill('DROP TRIGGER too_small;');
      await d.getByTestId('move-apply-edited').click();
      await d.getByRole('alert').getByText(/Only ALTER TABLE statements can be applied here: DROP TRIGGER too_small/).waitFor();
      await d.getByTestId('move-edit-statements').fill('ALTER TABLE project ADD COLUMN extra TEXT;');
      await d.getByTestId('move-apply-edited').click();
      await d.getByText(/Applied before: 1 statement\./).waitFor({ timeout: 60000 });
      await until(async () => (await moveState()) === 'stopped', 'the copy to stop again');
      const job = (await api('GET', '/database/move')).body;
      if (JSON.stringify(job.applied) !== '["ALTER TABLE project ADD COLUMN extra TEXT"]') throw new Error(`applied: ${JSON.stringify(job.applied)}`);
      if (scalar(stopFile, "SELECT count(*) FROM pragma_table_info('project') WHERE name='extra'") !== 1) throw new Error('the column was not added to the target');
    }, { expectConsole: true });

    await s.step('Cancel the copy: "Keep it" leaves it stopped, "Cancel and clear" clears the new file, Start again goes back to step 1', async () => {
      const d = wizard();
      await stoppedPanel().waitFor({ timeout: 30000 });
      await d.getByRole('button', { name: 'Cancel the copy' }).click();
      const confirm = d.getByRole('alertdialog', { name: 'Cancel the copy' });
      await confirm.getByRole('button', { name: 'Keep it' }).click();
      await confirm.waitFor({ state: 'detached' });
      if ((await moveState()) !== 'stopped') throw new Error('Keep it cancelled the copy');
      await d.getByRole('button', { name: 'Cancel the copy' }).click();
      await confirm.getByRole('button', { name: 'Cancel and clear the new database' }).click();
      await d.getByText(/The copy was cancelled and the new database was cleared/).waitFor();
      if (scalar(stopFile, "SELECT count(*) FROM sqlite_master WHERE type='table'") !== 0) throw new Error('the new file still has tables');
      await d.getByRole('button', { name: 'Start again' }).click();
      await d.getByTestId('move-step-where').waitFor();
      await closeWizard();
      await until(async () => (await moveState()) === null, 'the cancelled move to be closed');
    });

    const resumeFile = target('resumes.db');
    await s.step('Resume without a change: after the cause is gone the copy goes on, is checked and can be switched later', async () => {
      await prepareStop(resumeFile);
      await openStorage();
      await p.getByTestId('db-move-strip').getByRole('button', { name: 'Open' }).click();
      const d = wizard();
      await d.getByTestId('move-resume').click();
      await stoppedPanel().waitFor({ timeout: 60000 });
      // the person fixes the target by hand
      sqlite(resumeFile, 'DROP TRIGGER too_small');
      await d.getByTestId('move-resume-plain').click();
      await d.getByTestId('move-verified').waitFor({ timeout: 60000 });
      if (scalar(resumeFile, 'SELECT count(*) FROM project') !== 1) throw new Error('the project was not copied');
      await d.getByRole('button', { name: 'Keep SQLite, switch later' }).click();
      await d.waitFor({ state: 'detached' });
    });

    // ---------------------------------------------------------------- copy and switch
    await s.step('Copy my data to a new file, then "Switch now": the board carries on and the wizard says so', async () => {
      const t = target('switched.db');
      await openStorage();
      await openWizard();
      await whereTo(t);
      await wizard().getByTestId('move-next').click();
      const d = wizard();
      await d.getByTestId('move-start').click();
      await d.getByTestId('move-verified').waitFor({ timeout: 60000 });
      await d.getByRole('button', { name: 'Switch to SQLite now' }).click();
      await d.getByTestId('move-switched').getByText('The board now uses SQLite').waitFor();
      await d.getByText(/The SQLite file stays in the data folder as it was, a way back/).waitFor();
      const job = (await api('GET', '/database/move')).body;
      if (job.state !== 'switched') throw new Error(`move is ${job.state}`);
      // a file target keeps the data-folder file in use (the setting says only "SQLite"): the board still reads
      const db = (await api('GET', '/database')).body;
      if (db.tickets !== 2 || db.engine !== 'sqlite') throw new Error(`database after the switch: ${JSON.stringify(db)}`);
      await d.getByRole('button', { name: 'Done' }).click();
      await d.waitFor({ state: 'detached' });
      // closing a switched move closes it on the server too
      await until(async () => (await moveState()) === null, 'the switched move to be closed');
      // the board still works
      await home(s);
      await p.getByText('Move me one').first().waitFor();
    });

    // ---------------------------------------------------------------- the reconnect screen
    await s.step('the reconnect screen: a 503 database_unreachable shows it, "Try now" asks /database/health and the board comes back', async () => {
      await home(s);
      let answered = 0;
      await p.route(/\/projects$/, async (route) => {
        if (route.request().method() === 'GET' && answered < 1) {
          answered++;
          return route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ detail: { code: 'database_unreachable', since: Date.now() / 1000 - 40, error: 'connection refused (stand-in)', target: { engine: 'postgresql', host: 'db.example.test', port: 5432, name: 'kanban', label: 'PostgreSQL', display: 'db.example.test:5432/kanban' } } }),
          });
        }
        return route.continue();
      });
      await p.reload();
      const down = p.getByTestId('database-down');
      await down.waitFor({ timeout: 20000 });
      await down.getByText('The board cannot reach its database').waitFor();
      await down.getByText(/PostgreSQL\s+at\s+db\.example\.test:5432/).waitFor();
      await down.getByText('connection refused (stand-in)').waitFor();
      await down.getByText(/did not answer for \d+ seconds/).waitFor();
      // the old SQLite file is offered
      await down.getByText('Use the old SQLite file instead').waitFor();
      const health = (await api('GET', '/database/health')).body;
      if (health.ok !== true || health.unreachable !== null) throw new Error(`health: ${JSON.stringify(health)}`);
      await Promise.all([
        p.waitForResponse((r) => /\/database\/health$/.test(r.url()) && r.status() === 200),
        down.getByRole('button', { name: 'Try now' }).click(),
      ]);
      await down.waitFor({ state: 'detached' });
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
      await p.unroute(/\/projects$/);
    }, { expectConsole: true });

    await s.step('the reconnect screen: Edit connection tests and saves the same database again', async () => {
      await home(s);
      let times = 0;
      const down = (route) => route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ detail: { code: 'database_unreachable', since: Date.now() / 1000 - 5, error: 'stand-in outage', target: { engine: 'sqlite', label: 'SQLite', display: 'kanban.db' } } }),
      });
      await p.route(/\/projects$/, async (route) => {
        if (route.request().method() === 'GET' && times < 1) { times++; return down(route); }
        return route.continue();
      });
      await p.reload();
      const screen = p.getByTestId('database-down');
      await screen.waitFor({ timeout: 20000 });
      // Edit connection: SQLite has no fields; Test and Save call the server, which finds this board in the file
      await screen.getByRole('button', { name: 'Edit connection…' }).click();
      const edit = p.getByRole('dialog').last();
      await edit.getByTestId('sqlite-target-path').waitFor();
      await edit.getByRole('button', { name: 'Test connection' }).click();
      await edit.getByText(/A file on this computer/).waitFor();
      const [saved] = await Promise.all([
        p.waitForResponse((r) => /\/database\/connection$/.test(r.url())),
        edit.getByRole('button', { name: /^Save/ }).click(),
      ]);
      if (saved.status() !== 200) throw new Error(`connection: ${saved.status()} ${await saved.text()}`);
      await screen.waitFor({ state: 'detached' });
      await p.unroute(/\/projects$/);
    }, { expectConsole: true });

    await s.step('the reconnect screen: "Open the SQLite file" calls use-sqlite and reloads', async () => {
      await home(s);
      let times = 0;
      await p.route(/\/projects$/, async (route) => {
        if (route.request().method() === 'GET' && times < 1) {
          times++;
          return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: { code: 'database_unreachable', since: Date.now() / 1000 - 90, error: 'server gone', target: { engine: 'postgresql', host: 'db.example.test', port: 5432, label: 'PostgreSQL' } } }) });
        }
        return route.continue();
      });
      await p.reload();
      const screen = p.getByTestId('database-down');
      await screen.waitFor({ timeout: 20000 });
      await screen.getByText(/did not answer for \d+ (seconds|minutes)/).waitFor();
      await p.unroute(/\/projects$/);
      const [r] = await Promise.all([
        p.waitForResponse((x) => /\/database\/use-sqlite$/.test(x.url())),
        screen.getByRole('button', { name: 'Open the SQLite file' }).click(),
      ]);
      if (r.status() !== 200) throw new Error(`use-sqlite: ${r.status()} ${await r.text()}`);
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor({ timeout: 20000 });
      if ((await api('GET', '/database')).body.engine !== 'sqlite') throw new Error('not on SQLite');
    }, { expectConsole: true });

    // ---------------------------------------------------------------- the data folder
    await s.step('Data folder: a folder outside HOME is refused with the server\'s words', async () => {
      await openStorage();
      const field = p.getByRole('textbox', { name: 'Data folder path' });
      await field.fill('/tmp/outside-of-home');
      await p.getByRole('button', { name: 'Apply', exact: true }).click();
      await p.getByText('Data folder must be within your home directory').waitFor();
      await p.getByRole('button', { name: 'Cancel', exact: true }).click();
      await until(async () => (await field.inputValue()) === path.join(dataDir), 'the field to show the current folder');
    }, { expectConsole: true });

    await s.step('Data folder: a folder inside HOME takes the database and the uploads, and the board goes on there', async () => {
      const dest = path.join(s.server.dirs.home, 'moved-data');
      const field = p.getByRole('textbox', { name: 'Data folder path' });
      await field.fill(dest);
      await p.getByText('Apply moves the database and attachments to the new folder.').waitFor();
      await p.getByRole('button', { name: 'Apply', exact: true }).click();
      await p.getByText('Saved', { exact: true }).waitFor();
      await p.getByText('Data folder updated.').waitFor();
      await p.getByText(/restart the MCP server to pick up the new data path/).waitFor();
      if (!fs.existsSync(path.join(dest, 'kanban.db'))) throw new Error('no kanban.db in the new folder');
      const db = (await api('GET', '/database')).body;
      if (db.sqlite_file.path !== path.join(dest, 'kanban.db') || db.tickets !== 2) throw new Error(`database after the move: ${JSON.stringify(db)}`);
      const settings = (await api('GET', '/settings')).body;
      if (!JSON.stringify(settings).includes(dest)) throw new Error(`settings: ${JSON.stringify(settings)}`);
      await home(s);
      await p.getByText('Move me two').first().waitFor();
    });

    // ---------------------------------------------------------------- the MCP config file
    await s.step('MCP integrations: Open file says the config is missing before the install', async () => {
      await home(s);
      await p.getByRole('button', { name: 'Settings' }).click();
      await nav().getByRole('button', { name: 'Integrations', exact: true }).click();
      await p.getByRole('heading', { name: 'Integrations', level: 1 }).waitFor();
      const sec = p.getByRole('heading', { name: 'MCP integrations', level: 2 }).locator('xpath=ancestor::section[1]');
      await sec.getByRole('button', { name: 'Expand Antigravity' }).click();
      const [res] = await Promise.all([
        p.waitForResponse((r) => /\/open-file$/.test(r.url())),
        sec.getByRole('button', { name: /^Open file/ }).click(),
      ]);
      if (res.status() !== 400) throw new Error(`open-file before the install answered ${res.status()}`);
      await sec.getByText(/doesn't exist yet\. Install first, or create it yourself\./).waitFor();
    }, { expectConsole: true });

    await s.step('MCP integrations: after the install the file is there, so Open file hands it to the OS opener', async () => {
      // a fresh page: the failed Open file above left the card in its error state
      await home(s);
      await p.getByRole('button', { name: 'Settings' }).click();
      await nav().getByRole('button', { name: 'Integrations', exact: true }).click();
      await p.getByRole('heading', { name: 'Integrations', level: 1 }).waitFor();
      const sec = p.getByRole('heading', { name: 'MCP integrations', level: 2 }).locator('xpath=ancestor::section[1]');
      await sec.getByRole('button', { name: 'Install' }).last().click();
      await sec.getByText('Installed', { exact: true }).first().waitFor();
      const cfg = path.join(s.server.dirs.home, '.gemini', 'config', 'mcp_config.json');
      await until(async () => fs.existsSync(cfg), 'the MCP config');
      const [res] = await Promise.all([
        p.waitForResponse((r) => /\/open-file$/.test(r.url())),
        sec.getByRole('button', { name: /^Open file/ }).click(),
      ]);
      // a computer without xdg-open (this one) answers 400 with the OS error; one with it answers 200
      if (res.status() === 400) await sec.getByText(/^Couldn't open /).waitFor();
      else if (res.status() !== 200) throw new Error(`open-file answered ${res.status()}`);
      const body = await res.json().catch(() => null);
      if (res.status() === 200 && body?.path !== cfg) throw new Error(`opened ${body?.path}`);
      s.note('open-file after the install', res.status() === 400 ? 'the opener is missing: 400' : 'opened');
    }, { expectConsole: true });

    // ---------------------------------------------------------------- the desktop-only pages
    await s.step('Updates (desktop): the installed version, a failed check, an up-to-date check, and a newer version', async () => {
      const q = await s.newPage();
      await q.addInitScript(() => {
        window.__mode = 'error';
        window.__opened = [];
        window.electronAPI = {
          platform: 'linux',
          getUpdateStatus: async () => ({ currentVersion: '4.0.3', lastCheck: { at: '2026-11-18T10:00:00Z', error: null }, info: null }),
          checkForUpdate: async () => {
            const at = '2026-11-18T11:00:00Z';
            if (window.__mode === 'error') return { error: 'The update server did not answer', info: null, lastCheck: { at, error: 'The update server did not answer' } };
            if (window.__mode === 'newer') return { error: null, info: { version: '9.9.9', notes: 'Fixes', releaseUrl: 'https://example.test/r/9.9.9' }, lastCheck: { at, error: null } };
            return { error: null, info: null, lastCheck: { at, error: null } };
          },
          openReleasesPage: async () => { window.__released = true; },
          getUpdateInfo: async () => null,
          onUpdateAvailable(cb) { window.__avail = cb; return () => {}; },
          onUpdateProgress(cb) { window.__progress = cb; return () => {}; },
          downloadUpdate: async () => (window.__download === 'fail' ? { error: 'Not enough disk space' } : { filePath: '/tmp/kanban-9.9.9.AppImage' }),
          installUpdate: async (f) => { window.__installed = f; return { success: true }; },
          openExternal: async (u) => { window.__opened.push(u); },
        };
      });
      await q.goto(s.server.base);
      await q.getByRole('button', { name: 'Settings' }).click();
      const qnav = q.getByRole('navigation', { name: 'Settings pages' });
      await qnav.getByRole('button', { name: 'Updates', exact: true }).click();
      await q.getByRole('heading', { name: 'Updates', level: 1 }).waitFor();
      const card = q.getByTestId('update-settings');
      await card.getByText('4.0.3').waitFor();
      await card.getByText(/last checked/).waitFor();
      // 1: the check fails
      await card.getByRole('button', { name: 'Check for updates' }).click();
      await card.getByText("Couldn't check for updates: The update server did not answer").waitFor();
      await card.getByText("Couldn't check", { exact: true }).waitFor();
      // 2: up to date
      await q.evaluate(() => { window.__mode = 'latest'; });
      await card.getByRole('button', { name: 'Check for updates' }).click();
      await card.getByText('You are on the latest version.').waitFor();
      await card.getByText('Up to date', { exact: true }).waitFor();
      // 3: a newer version
      await q.evaluate(() => { window.__mode = 'newer'; });
      await card.getByRole('button', { name: 'Check for updates' }).click();
      await card.getByText('Version 9.9.9 is available.').waitFor();
      // Release notes opens the releases page of the desktop app
      await card.getByRole('button', { name: 'Release notes' }).click();
      await until(async () => (await q.evaluate(() => window.__released)) === true, 'the releases page to open');
      s.note('Updates page lists the version', '4.0.3');
      await q.close();
    });

    await s.step('the update notice: a failed download can be tried again, the installer starts, Later and Skip hide it', async () => {
      const q = await s.newPage();
      await q.addInitScript(() => {
        window.__opened = [];
        window.__download = 'fail';
        window.electronAPI = {
          platform: 'linux',
          getUpdateInfo: async () => null,
          onUpdateAvailable(cb) { window.__avail = cb; return () => {}; },
          onUpdateProgress(cb) { window.__progress = cb; return () => {}; },
          downloadUpdate: async () => (window.__download === 'fail' ? { error: 'Not enough disk space' } : { filePath: '/tmp/kanban-9.9.9.AppImage' }),
          installUpdate: async (f) => { window.__installed = f; return { success: true }; },
          openExternal: async (u) => { window.__opened.push(u); },
        };
      });
      await q.goto(s.server.base);
      await q.getByRole('complementary', { name: 'Project navigation' }).waitFor({ timeout: 20000 });
      const offer = (extra = {}) => q.evaluate((e) => window.__avail({ version: '9.9.9', notes: '**Fixes** and more', releaseUrl: 'https://example.test/r/9.9.9', ...e }), extra);
      await until(async () => q.evaluate(() => typeof window.__avail === 'function'), 'the notice to listen');
      await offer();
      const notice = q.getByRole('status').filter({ hasText: 'Version 9.9.9 is available' });
      await notice.waitFor();
      await notice.getByText('Fixes', { exact: false }).waitFor();
      // the download fails: the reason is shown and the button offers another try
      await notice.getByRole('button', { name: 'Download' }).click();
      await notice.getByText('Not enough disk space').waitFor();
      await q.evaluate(() => { window.__download = 'ok'; window.__progress(0.5); });
      await notice.getByRole('button', { name: 'Try again' }).click();
      await notice.getByText(/Downloaded\. Kanban Board will close and the installer will start\./).waitFor();
      await notice.getByRole('button', { name: 'Install and restart' }).click();
      await until(async () => (await q.evaluate(() => window.__installed)) === '/tmp/kanban-9.9.9.AppImage', 'the installer to start');
      // What's new opens the release page outside the app
      await notice.getByRole('button', { name: "What's new" }).click();
      await until(async () => (await q.evaluate(() => window.__opened)).includes('https://example.test/r/9.9.9'), 'the release page to open');
      // Later hides it, a new offer brings it back, Skip this version hides it for good
      await q.evaluate(() => { window.__download = 'fail'; });
      await offer();
      await notice.getByRole('button', { name: 'Later' }).waitFor();
      await notice.getByRole('button', { name: 'Later' }).click();
      await notice.waitFor({ state: 'detached' });
      await offer();
      await notice.waitFor();
      await notice.getByRole('button', { name: 'Skip this version' }).click();
      await notice.waitFor({ state: 'detached' });
      if ((await q.evaluate(() => localStorage.getItem('skippedUpdateVersion'))) !== '9.9.9') throw new Error('the skipped version was not kept');
      await offer();
      await q.waitForTimeout(400);
      if (await notice.count()) throw new Error('a skipped version came back');
      // a manual check clears the skip: the notice shows again
      await offer({ manual: true });
      await notice.waitFor();
      await q.close();
    });

    await s.step('back to the board', async () => {
      await home(s);
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
    });
  },
};
