import { ensureProject, addMember, openDocs, newDocPage, setMarkdown, publishDoc } from '../lib/ui.mjs';

// One person uses the board, so a notification for that person needs a mention of a member named like the person
// ("Me" is the board's own user) in a Docs comment.
export default {
  name: 'Notifications: a mention shows in the centre, mark read',
  async run(s) {
    const p = s.page;
    const centre = () => p.getByRole('dialog', { name: 'Notifications' });
    await s.step('set up: member "Me" and a published page', async () => {
      await ensureProject(s);
      await addMember(s, 'Me');
      await openDocs(s);
      await newDocPage(s, 'Handbook');
      await setMarkdown(s, '# Hi\n\nBody text.\n');
      await publishDoc(s, 'first');
    });
    await s.step('the centre is empty before anything happened', async () => {
      await p.getByRole('button', { name: 'Notifications' }).first().click();
      await centre().getByText('No notifications yet').waitFor();
      await centre().getByRole('button', { name: 'Close' }).click();
    });
    await s.step('comment on the page mentioning @Me', async () => {
      await p.getByRole('textbox', { name: 'Write a comment on this page…' }).click();
      await p.keyboard.type('Please check this @Me');
      await p.getByRole('listbox', { name: 'Mention a member' }).waitFor();
      await p.keyboard.press('Enter');
      await Promise.all([
        p.waitForResponse((r) => r.request().method() === 'POST' && /comments/.test(r.url()), { timeout: 8000 }),
        p.getByRole('button', { name: 'Comment', exact: true }).click(),
      ]);
      await s.settle(2500);
    });
    await s.step('the mention is in "Needs you"', async () => {
      await p.getByRole('button', { name: 'Notifications' }).first().click();
      await centre().getByText(/mentioned you/).waitFor({ timeout: 15000 });
      await centre().getByRole('tab', { name: /Needs you 1/ }).waitFor();
    });
    await s.step('the Updates tab is empty', async () => {
      await centre().getByRole('tab', { name: /^Updates/ }).click();
      await centre().getByRole('tab', { name: /Updates 0/ }).waitFor();
      await centre().getByRole('tab', { name: /^Needs you/ }).click();
    });
    await s.step('mark all read', async () => {
      await centre().getByRole('button', { name: 'Mark all read' }).click();
      await s.settle(1500);
    });
    await s.step('open All notifications', async () => {
      await centre().getByRole('button', { name: 'All notifications' }).click();
      await p.getByText(/mentioned you/).first().waitFor();
    });
    await s.step('open the notification settings', async () => {
      await p.getByRole('button', { name: 'Notification settings' }).first().click().catch(async () => {
        await p.getByRole('button', { name: /settings/i }).first().click();
      });
      await s.settle(1500);
    });
  },
};
