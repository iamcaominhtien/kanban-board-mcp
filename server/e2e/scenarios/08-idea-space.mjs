import { ensureProject } from '../lib/ui.mjs';

export default {
  name: 'Idea Space: capture, triage, stages, assumption, promote',
  async run(s) {
    const p = s.page;
    await s.step('set up and open the Idea Space (empty)', async () => {
      await ensureProject(s);
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await p.getByRole('heading', { name: 'No ideas here yet' }).waitFor();
    });
    await s.step('capture an idea from the Quick idea dialog', async () => {
      await p.getByRole('button', { name: 'New idea' }).first().click();
      await p.getByRole('textbox', { name: 'Idea title' }).fill('Offline mode for the board');
      await p.getByRole('button', { name: 'Add to Inbox' }).click();
      await p.getByText('Added IDEA-1 to the Inbox').waitFor();
    });
    await s.step('capture a second idea', async () => {
      await p.getByRole('button', { name: 'New idea' }).first().click();
      await p.getByRole('textbox', { name: 'Idea title' }).fill('Keyboard shortcuts cheat sheet');
      await p.keyboard.press('Enter');
      await p.getByText('Added IDEA-2 to the Inbox').waitFor();
    });
    await s.step('open the Inbox (triage)', async () => {
      await p.getByRole('button', { name: /^Inbox/ }).click();
      await p.getByRole('heading', { name: 'Triage' }).waitFor();
      await p.getByRole('region', { name: 'Idea in focus' }).waitFor();
    });
    await s.step('keep the first idea: it moves to Exploring', async () => {
      await p.getByRole('complementary', { name: 'Inbox' }).getByRole('button', { name: /Offline mode for the board/ }).click();
      await p.getByRole('region', { name: 'Idea in focus' }).getByRole('heading', { name: 'Offline mode for the board' }).waitFor();
      await p.getByRole('button', { name: /^Keep/ }).click();
      await p.getByRole('dialog', { name: 'Keep this idea' }).getByRole('button', { name: 'Keep', exact: true }).click();
      await p.getByText(/^Kept “/).first().waitFor();
    });
    await s.step('archive the second idea with a reason', async () => {
      await p.getByRole('button', { name: /^Archive/ }).click();
      const d = p.getByRole('dialog', { name: 'Archive this idea' });
      await d.getByRole('radio', { name: 'Not now' }).click();
      await d.getByRole('textbox').first().fill('Maybe next quarter');
      await d.getByRole('button', { name: 'Archive', exact: true }).click();
      await p.getByText(/Archived|sorted/).first().waitFor();
    });
    await s.step('back to the list: the kept idea is under Exploring', async () => {
      await p.getByRole('button', { name: 'Back to the list' }).click().catch(() => {});
      await p.getByRole('button', { name: 'Exploring' }).click();
      await p.getByText('Offline mode for the board').first().waitFor();
    });
    await s.step('Stages view shows the idea in a column', async () => {
      await p.getByRole('tab', { name: 'Stages' }).click();
      await p.getByText('Offline mode for the board').first().waitFor();
      await p.getByRole('tab', { name: 'List' }).click();
    });
    await s.step('open the idea page', async () => {
      await p.getByText('Offline mode for the board').first().click();
      await p.getByRole('textbox', { name: 'Idea title' }).waitFor();
    });
    await s.step('write in the idea page', async () => {
      await p.getByRole('textbox', { name: 'Page content' }).click();
      await p.keyboard.type('Users lose work when the network drops.');
      await p.getByText('Saved').first().waitFor();
      await p.waitForTimeout(2000);
    });
    await s.step('add an assumption', async () => {
      await p.getByRole('tab', { name: 'Assumptions' }).click();
      await p.getByRole('textbox', { name: 'New assumption' }).fill('We believe people work on trains without signal');
      await p.getByRole('combobox', { name: 'Impact if wrong' }).selectOption({ label: 'High impact' });
      await p.getByRole('button', { name: 'Add an assumption' }).click();
      await p.getByText('We believe people work on trains without signal').first().waitFor();
    });
    await s.step('say "I want this" (demand)', async () => {
      await p.getByRole('button', { name: 'I want this' }).click();
      await s.settle();
    });
    await s.step('move the idea to Ready from More actions', async () => {
      await p.getByRole('button', { name: 'More actions' }).click();
      await p.getByRole('menuitem', { name: 'Move to Ready' }).click();
      await p.getByRole('dialog', { name: 'Move without the checks' }).getByRole('button', { name: 'Move anyway' }).click();
      await p.getByRole('complementary', { name: 'Decide' }).getByText('Ready', { exact: true }).waitFor();
      // the "Moved to Ready / Undo" toast covers the promote dialog's footer, and a pointer over it stops its timer:
      // a fast server reaches the next click while it is still there
      const toast = p.getByRole('alert').filter({ hasText: 'to Ready' });
      await toast.first().getByRole('button', { name: 'Close notification' }).click();
      await toast.first().waitFor({ state: 'detached' });
    }, { expectConsole: true }); // the first move is refused (409) because of the open assumption
    await s.step('promote the idea to a ticket', async () => {
      await p.getByRole('button', { name: 'Promote' }).click();
      const d = p.getByRole('dialog').last();
      await d.waitFor();
      await d.getByRole('checkbox', { name: 'I understand, promote anyway' }).check();
      await d.getByTestId('create-ticket').scrollIntoViewIfNeeded();
      await p.waitForTimeout(400);
      await d.getByTestId('create-ticket').click();
      await s.settle(2500);
    });
    await s.step('the ticket exists on the board of the project', async () => {
      await p.getByRole('button', { name: 'Alpha ALP' }).click();
      await p.getByText('Offline mode for the board').first().waitFor();
    });
  },
};
