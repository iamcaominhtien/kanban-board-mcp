import { home, ensureProject, openMembers } from '../lib/ui.mjs';

// Idea Space beyond 08: the Matrix view, the Evidence tab, the Ask AI chat (assistant stand-in) and the Idea Space
// settings. The chat needs a signed-in AI account and a team, so the scenario is in the 'ai' group.
export default {
  name: 'Idea Space: Matrix, Evidence, Ask AI chat, settings',
  group: 'ai',
  async run(s) {
    const p = s.page;
    const api = async (path) => (await p.request.get(`${s.server.base}${path}`)).json();
    const view = (name) => p.getByRole('tablist', { name: 'View' }).getByRole('tab', { name });
    const sections = () => p.getByRole('tablist', { name: 'Idea sections' });
    const openIdea = async (title) => {
      await p.getByRole('button', { name: 'Back to Idea Space' }).click().catch(() => {});
      await view('List').click();
      await p.getByRole('button', { name: 'Exploring' }).click();
      await p.getByText(title, { exact: true }).first().click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
    };
    // Back from Settings the app may show the idea page again or the board: end on the page of "Offline mode"
    const backToIdea = async () => {
      await p.waitForTimeout(600);
      if (await p.getByTestId('idea-page').count()) return;
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await view('List').click();
      await p.getByRole('button', { name: 'Exploring' }).click();
      await p.getByText('Offline mode', { exact: true }).first().click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
    };
    const addAssumption = async (text, impact) => {
      await sections().getByRole('tab', { name: /^Assumptions/ }).click();
      const box = p.getByRole('textbox', { name: 'New assumption' });
      await box.fill(text);
      // the table rows have an "Impact if wrong" select too: take the one in the add form
      await p.locator('select[aria-label="Impact if wrong"]:not(table select)').selectOption({ label: impact });
      await p.getByRole('button', { name: 'Add an assumption' }).click();
      await p.getByText(text).first().waitFor();
    };

    await s.step('set up: a project with an AI team and three ideas in the Inbox', async () => {
      s.server.signIn();
      s.server.fake({ FAKE_CLAUDE_MODE: 'assistant', FAKE_CLAUDE_ASSISTANT_TEXT: 'Start with the offline assumption.' });
      await ensureProject(s);
      await openMembers(s);
      await p.getByTestId('members-tab-ai').click();
      await p.getByRole('button', { name: /Add AI team/ }).first().click();
      const d = p.getByRole('dialog', { name: 'Add AI team' });
      await d.getByTestId('team-name').fill('Idea helper');
      await d.getByTestId('team-working-dir').fill(s.server.dirs.repo);
      await d.getByTestId('add-team-submit').click();
      await p.getByRole('button', { name: 'Pause', exact: true }).waitFor();
      await home(s);
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await p.getByRole('heading', { name: 'No ideas here yet' }).waitFor();
      for (const [n, title] of [[1, 'Offline mode'], [2, 'Shortcut cheat sheet'], [3, 'Dark theme']]) {
        await p.getByRole('button', { name: 'New idea' }).first().click();
        await p.getByRole('textbox', { name: 'Idea title' }).fill(title);
        await p.getByRole('button', { name: 'Add to Inbox' }).click();
        await p.getByText(`Added IDEA-${n} to the Inbox`).waitFor();
      }
    });
    await s.step('Triage: keep all three, they move to Exploring', async () => {
      await p.getByRole('button', { name: /^Inbox/ }).click();
      await p.getByRole('heading', { name: 'Triage' }).waitFor();
      for (let i = 0; i < 3; i++) {
        await p.getByRole('region', { name: 'Idea in focus' }).waitFor();
        await p.getByRole('button', { name: /^Keep/ }).click();
        await p.getByRole('dialog', { name: 'Keep this idea' }).getByRole('button', { name: 'Keep', exact: true }).click();
        await p.getByText(/^Kept “/).first().waitFor();
        await p.getByRole('dialog', { name: 'Keep this idea' }).waitFor({ state: 'detached' });
        await s.settle();
      }
      await p.getByRole('button', { name: 'Back to the list' }).click().catch(() => {});
      await view('List').click();
      await p.getByRole('button', { name: 'Exploring' }).click();
      for (const t of ['Offline mode', 'Shortcut cheat sheet', 'Dark theme']) await p.getByText(t, { exact: true }).first().waitFor();
    });
    await s.step('Matrix with no assumptions says so', async () => {
      await view('Matrix').click();
      await p.getByRole('heading', { name: 'No assumptions to plot' }).waitFor();
      await p.getByText(/Each assumption becomes a dot here/).waitFor();
    });
    await s.step('assumptions of the first idea: one high impact, one low', async () => {
      await view('List').click();
      await p.getByRole('button', { name: 'Exploring' }).click();
      await p.getByText('Offline mode', { exact: true }).first().click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
      await addAssumption('People work on trains without signal', 'High impact');
      await addAssumption('Sync conflicts are rare', 'Low impact');
      await sections().getByRole('tab', { name: /^Assumptions 2/ }).waitFor();
    });
    await s.step('Evidence tab starts empty and explains itself', async () => {
      await sections().getByRole('tab', { name: /^Evidence/ }).click();
      const tab = p.getByTestId('evidence-tab');
      await tab.getByRole('heading', { name: 'No evidence yet' }).waitFor();
      await tab.getByText('Add evidence').waitFor();
      await tab.getByRole('combobox', { name: 'Kind of evidence' }).waitFor();
      s.note('evidence kinds', await tab.getByRole('combobox', { name: 'Kind of evidence' }).locator('option').allInnerTexts());
    });
    await s.step('add a link as evidence for the first assumption', async () => {
      const tab = p.getByTestId('evidence-tab');
      const form = tab.getByTestId('evidence-form');
      await form.getByRole('checkbox', { name: 'People work on trains without signal' }).check();
      await form.getByRole('textbox', { name: 'Evidence' }).fill('https://example.com/train-study');
      await form.getByRole('textbox', { name: 'Title' }).fill('Train study');
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      const item = tab.getByRole('list', { name: 'Evidence' }).getByRole('listitem').first();
      await item.getByRole('link', { name: 'Train study' }).waitFor();
      await item.getByText(/Link · used by 1 assumption/).waitFor();
      await item.getByText('Supports: People work on trains without signal').waitFor();
      const href = await item.getByRole('link', { name: 'Train study' }).getAttribute('href');
      if (href !== 'https://example.com/train-study') throw new Error('link href ' + href);
      await sections().getByRole('tab', { name: /^Evidence 1/ }).waitFor();
    });
    await s.step('one note supporting both assumptions', async () => {
      const tab = p.getByTestId('evidence-tab');
      const form = tab.getByTestId('evidence-form');
      await form.getByRole('combobox', { name: 'Kind of evidence' }).selectOption({ label: 'Note' });
      await form.getByRole('checkbox', { name: 'People work on trains without signal' }).check();
      await form.getByRole('checkbox', { name: 'Sync conflicts are rare' }).check();
      await form.getByRole('textbox', { name: 'Evidence' }).fill('Two interviewees lost drafts on the metro');
      await form.getByRole('button', { name: 'Add', exact: true }).click();
      const note = tab.getByRole('listitem').filter({ hasText: 'Two interviewees lost drafts on the metro' });
      await note.getByText(/Note · used by 2 assumptions/).waitFor();
      await note.getByText('Supports: Sync conflicts are rare').waitFor();
      // the tab counts the links between evidence and assumptions: the link once, the note for each of the two
      await sections().getByRole('tab', { name: /^Evidence 3/ }).waitFor();
    });
    await s.step('the Assumptions tab counts the evidence', async () => {
      await sections().getByRole('tab', { name: /^Assumptions/ }).click();
      const t = p.getByTestId('assumptions-tab');
      await t.getByText('Sync conflicts are rare').waitFor();
      s.note('assumptions table', (await t.innerText()).slice(0, 500));
    });
    await s.step('remove the note: it is gone from both assumptions', async () => {
      await sections().getByRole('tab', { name: /^Evidence/ }).click();
      const tab = p.getByTestId('evidence-tab');
      const note = tab.getByRole('listitem').filter({ hasText: 'Two interviewees lost drafts on the metro' });
      await note.getByRole('button', { name: 'Remove' }).click();
      await note.waitFor({ state: 'detached' });
      await sections().getByRole('tab', { name: /^Evidence 1/ }).waitFor();
    });
    await s.step('a second idea with a medium assumption', async () => {
      await openIdea('Dark theme');
      await addAssumption('Most users prefer dark at night', 'Medium impact');
    });
    await s.step('Matrix: three dots, the quadrants and the axes', async () => {
      await p.getByRole('button', { name: 'Back to Idea Space' }).click();
      await view('Matrix').click();
      const m = p.getByRole('group', { name: 'Assumptions by impact and evidence' });
      await m.waitFor();
      for (const t of ['Test these first', 'Well supported', 'Low stakes, low proof', 'Fine', 'IMPACT IF WRONG → higher', 'EVIDENCE → stronger']) {
        await m.getByText(t, { exact: true }).waitFor();
      }
      const dots = m.getByTestId('matrix-dot');
      await dots.first().waitFor();
      if ((await dots.count()) !== 3) throw new Error('expected 3 dots, got ' + (await dots.count()));
      const labels = await dots.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
      s.note('dots', labels);
      await p.getByRole('complementary', { name: 'Selected assumption' }).getByText(/Pick a dot to see/).waitFor();
    });
    await s.step('Matrix: the dot with evidence sits to the right of the one without, and above the low impact one', async () => {
      const m = p.getByRole('group', { name: 'Assumptions by impact and evidence' });
      const pos = async (text) => m.getByRole('button', { name: new RegExp('^' + text) }).boundingBox();
      const supported = await pos('People work on trains');
      const bare = await pos('Most users prefer dark');
      const low = await pos('Sync conflicts are rare');
      if (!(supported.x > bare.x)) throw new Error(`evidence should move a dot right: ${supported.x} vs ${bare.x}`);
      if (!(supported.y < bare.y)) throw new Error(`high impact should sit above medium: ${supported.y} vs ${bare.y}`);
      if (!(bare.y < low.y)) throw new Error(`medium should sit above low: ${bare.y} vs ${low.y}`);
    });
    await s.step('Matrix: pick a dot to read it, mark it validated', async () => {
      const m = p.getByRole('group', { name: 'Assumptions by impact and evidence' });
      await m.getByRole('button', { name: /^People work on trains/ }).click();
      const side = p.getByRole('complementary', { name: 'Selected assumption' });
      await side.getByText('People work on trains without signal').first().waitFor();
      await side.getByText('Offline mode', { exact: true }).waitFor();
      await side.getByText('High', { exact: true }).waitFor();
      await side.getByText('1 piece', { exact: true }).waitFor();
      await side.getByText('Untested', { exact: true }).waitFor();
      await side.getByText('No test yet').waitFor();
      await side.getByRole('button', { name: 'Mark validated' }).click();
      await p.getByText('Marked validated').waitFor();
      await side.getByText('Validated', { exact: true }).waitFor();
      await side.getByRole('button', { name: 'Mark validated' }).waitFor({ state: 'detached' });
      await m.getByRole('button', { name: /People work on trains.*validated/ }).waitFor();
    });
    await s.step('Matrix: Open the idea goes to its page', async () => {
      await p.getByRole('complementary', { name: 'Selected assumption' }).getByRole('button', { name: 'Open the idea' }).click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
      if ((await p.getByRole('textbox', { name: 'Idea title' }).inputValue()) !== 'Offline mode') throw new Error('wrong idea opened');
    });
    await s.step('Ask AI on the idea page opens the chat with what it reads', async () => {
      const btn = p.getByTestId('ask-ai-button');
      await btn.waitFor();
      await btn.click();
      const chat = p.getByTestId('idea-chat');
      await chat.waitFor();
      await chat.getByRole('region', { name: 'Ask AI about this idea' }).or(chat.getByTestId('scoped-chat')).first().waitFor();
      await chat.getByTestId('chat-welcome').waitFor({ timeout: 15000 });
      s.note('chat welcome', (await chat.getByTestId('chat-welcome').innerText()).slice(0, 400));
      await chat.getByTestId('chat-member').waitFor();
      s.note('chat member', await chat.getByTestId('chat-member').innerText());
    });
    await s.step('the chat answers with the stand-in text', async () => {
      const chat = p.getByTestId('idea-chat');
      await chat.getByTestId('chat-input').fill('Which assumption should I test first?');
      await chat.getByTestId('chat-send').click();
      await chat.getByText('Which assumption should I test first?').first().waitFor();
      await chat.getByText('Start with the offline assumption.').first().waitFor({ timeout: 40000 });
    });
    await s.step('a second question in the same chat, rate the answer', async () => {
      s.server.fake({ FAKE_CLAUDE_MODE: 'assistant', FAKE_CLAUDE_ASSISTANT_TEXT: 'Ask five commuters.' });
      const chat = p.getByTestId('idea-chat');
      await chat.getByTestId('chat-input').fill('How do I test it cheaply?');
      await chat.getByTestId('chat-send').click();
      await chat.getByText('Ask five commuters.').first().waitFor({ timeout: 40000 });
      await chat.getByText('Start with the offline assumption.').first().waitFor();
      const [fb] = await Promise.all([
        p.waitForResponse((r) => r.request().method() === 'POST' && /feedback/.test(r.url()), { timeout: 8000 }),
        chat.getByRole('button', { name: /Helpful/ }).last().click(),
      ]);
      s.note('feedback status', fb.status());
    });
    await s.step('the chat is kept: close it, reopen it with Ctrl+J, the answers are still there; New chat starts empty', async () => {
      await p.getByTestId('ask-ai-button').click();
      await p.getByTestId('idea-chat').waitFor({ state: 'detached' });
      await p.getByRole('textbox', { name: 'Idea title' }).click();
      await p.keyboard.press('Control+j');
      const chat = p.getByTestId('idea-chat');
      await chat.waitFor();
      await chat.getByText('Ask five commuters.').first().waitFor({ timeout: 15000 });
      await chat.getByText('Start with the offline assumption.').first().waitFor();
      await chat.getByRole('button', { name: 'New chat' }).click();
      await chat.getByTestId('chat-welcome').waitFor({ timeout: 15000 });
      await chat.getByText('Ask five commuters.').waitFor({ state: 'detached' });
      await p.keyboard.press('Control+j');
      await chat.waitFor({ state: 'detached' });
    });
    await s.step('Settings, Idea Space: the switches, the team and the daily cap', async () => {
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Idea Space', exact: true }).click();
      const set = p.getByTestId('idea-settings');
      await set.waitFor();
      for (const l of ['Enable AI help', 'Triage advice', 'Weekly grooming', 'Ask about ideas', 'Read Docs and tickets', 'Read the linked repository']) {
        await set.getByRole('switch', { name: l, exact: true }).waitFor();
        if ((await set.getByRole('switch', { name: l, exact: true }).isChecked()) !== true) throw new Error(l + ' should start on');
      }
      await set.getByRole('switch', { name: 'Read ideas, assumptions and evidence' }).isDisabled();
      if (!(await set.getByRole('switch', { name: 'Use the web' }).isDisabled())) throw new Error('web switch must be disabled');
      await set.getByText('Idea AI', { exact: false }).first().waitFor();
      const cap = set.getByRole('spinbutton', { name: 'Daily cap' });
      await cap.fill('2.5');
      await cap.blur();
      await set.getByText(/Today: \$0\.00 of \$2\.50\./).waitFor();
      s.note('cap saved', await cap.inputValue());
    });
    await s.step('settings are stored: reload and read them back', async () => {
      await p.reload();
      await p.getByRole('complementary', { name: 'Project navigation' }).waitFor({ timeout: 20000 });
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Idea Space', exact: true }).click();
      const set = p.getByTestId('idea-settings');
      await set.getByRole('spinbutton', { name: 'Daily cap' }).waitFor();
      if ((await set.getByRole('spinbutton', { name: 'Daily cap' }).inputValue()) !== '2.50') throw new Error('cap not kept');
    });
    await s.step('turn "Ask about ideas" off, then "Enable AI help" off: the sub-switches lock', async () => {
      const set = p.getByTestId('idea-settings');
      await set.getByRole('switch', { name: 'Ask about ideas' }).click();
      await set.getByRole('switch', { name: 'Ask about ideas', checked: false }).waitFor();
      await set.getByRole('switch', { name: 'Enable AI help' }).click();
      await set.getByRole('switch', { name: 'Enable AI help', checked: false }).waitFor();
      for (const l of ['Triage advice', 'Weekly grooming', 'Ask about ideas', 'Read Docs and tickets']) {
        if (!(await set.getByRole('switch', { name: l, exact: true }).isDisabled())) throw new Error(l + ' should lock');
      }
      if (!(await set.getByRole('spinbutton', { name: 'Daily cap' }).isDisabled())) throw new Error('cap should lock');
    });
    await s.step('with AI help off, the Idea Space shows no AI buttons', async () => {
      await p.getByRole('button', { name: 'Back to board' }).click();
      await backToIdea();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
      await p.waitForTimeout(800);
      if (await p.getByTestId('ask-ai-button').count()) throw new Error('Ask AI is still offered');
      s.note('ask button count', await p.getByTestId('ask-ai-button').count());
    });
    await s.step('turn AI help on again: Ask AI is back', async () => {
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Idea Space', exact: true }).click();
      const set = p.getByTestId('idea-settings');
      await set.getByRole('switch', { name: 'Enable AI help' }).click();
      await set.getByRole('switch', { name: 'Enable AI help', checked: true }).waitFor();
      await p.getByRole('button', { name: 'Back to board' }).click();
      await backToIdea();
      await p.getByTestId('ask-ai-button').waitFor();
    });
  },
};
