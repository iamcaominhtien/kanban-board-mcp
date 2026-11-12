import { ensureProject } from '../lib/ui.mjs';

export default {
  name: 'Settings: every section that works without the desktop app',
  async run(s) {
    const p = s.page;
    const nav = () => p.getByRole('navigation', { name: 'Settings pages' });
    const section = async (label, heading) => {
      await nav().getByRole('button', { name: label, exact: true }).click();
      await p.getByRole('heading', { name: heading, level: 1 }).waitFor();
    };
    await s.step('open Settings (Repositories is first)', async () => {
      await ensureProject(s);
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('heading', { name: 'Repositories', level: 1 }).waitFor();
    });
    await s.step('Docs settings', async () => { await section('Docs', 'Docs'); });
    await s.step('Idea Space settings', async () => { await section('Idea Space', 'Idea Space'); });
    await s.step('Appearance', async () => { await section('Appearance', 'Appearance'); });
    await s.step('Notifications settings', async () => { await section('Notifications', 'Notifications'); });
    await s.step('Storage & backup shows the database', async () => {
      await section('Storage & backup', 'Storage & backup');
      await p.getByText(/SQLite/).first().waitFor();
    });
    await s.step('open the database wizard and close it again', async () => {
      await p.getByRole('button', { name: /Move to another database/ }).click();
      const d = p.getByRole('dialog').last();
      await d.waitFor();
      await p.waitForTimeout(800);
      await p.keyboard.press('Escape');
      if (await d.count()) await d.getByRole('button', { name: /Cancel|Close/ }).first().click();
      await d.waitFor({ state: 'detached' });
    });
    await s.step('export all data as a ZIP', async () => {
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 20000 }), p.getByRole('button', { name: 'Export data' }).click()]);
      const name = dl.suggestedFilename();
      s.note('export file extension', name.replace(/^.*\./, ''));
      s.note('export file name pattern', name.replace(/\d+/g, 'N'));
    });
    await s.step('Integrations', async () => { await section('Integrations', 'Integrations'); });
    await s.step('Diagnostics', async () => { await section('Diagnostics', 'Diagnostics'); });
    await s.step('search the settings', async () => {
      await p.getByRole('searchbox', { name: 'Search settings' }).fill('backup');
      await p.getByText('Storage & backup').first().waitFor();
      await p.getByRole('searchbox', { name: 'Search settings' }).fill('');
    });
    await s.step('change the Docs edit policy of the project', async () => {
      await section('Docs', 'Docs');
    });
    await s.step('back to the board', async () => {
      await p.getByRole('button', { name: 'Back to board' }).click();
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
    });
  },
};
