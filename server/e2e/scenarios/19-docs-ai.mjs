import { ensureProject, openDocs, newDocPage, setMarkdown, publishDoc, openMembers } from '../lib/ui.mjs';

export default {
  name: 'Docs AI: write, ask, summary, translate, tidy, health, comments, follow',
  group: 'ai',
  async run(s) {
    const p = s.page;
    await s.step('set up: signed-in AI account, a project with an AI team', async () => {
      s.server.signIn();
      s.server.fake({ FAKE_CLAUDE_MODE: 'assistant' });
      await ensureProject(s);
      await openMembers(s);
      await p.getByTestId('members-tab-ai').click();
      await p.getByRole('button', { name: /Add AI team/ }).first().click();
      const d = p.getByRole('dialog', { name: 'Add AI team' });
      await d.getByTestId('team-name').fill('Docs helper');
      await d.getByTestId('team-working-dir').fill(s.server.dirs.repo);
      await p.waitForTimeout(1500);
      s.note('dialog', await d.innerText());
      await d.getByTestId('add-team-submit').click();
      await p.waitForTimeout(2500);
    });
  },
};
