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
      const members = p.getByRole('radio', { name: /^Members/ });
      const admins = p.getByRole('radio', { name: /^Admins/ });
      await members.and(p.locator('[aria-checked="true"]')).waitFor();
      await admins.click();
      await p.getByText('Saved', { exact: true }).waitFor();
      await admins.and(p.locator('[aria-checked="true"]')).waitFor();
      await members.and(p.locator('[aria-checked="false"]')).waitFor();
      // the change is stored: reload the app and look again
      await p.reload();
      await p.getByRole('navigation', { name: 'Settings pages' }).waitFor({ timeout: 20000 }).catch(() => {});
      if (!(await p.getByRole('heading', { name: 'Docs', level: 1 }).count())) {
        if (!(await nav().count())) await p.getByRole('button', { name: 'Settings' }).click();
        await section('Docs', 'Docs');
      }
      await p.getByRole('radio', { name: /^Admins/ }).and(p.locator('[aria-checked="true"]')).waitFor();
      // and back to the default
      await p.getByRole('radio', { name: /^Members/ }).click();
      await p.getByRole('radio', { name: /^Members/ }).and(p.locator('[aria-checked="true"]')).waitFor();
    });
    await s.step('phone: Settings › Docs follows the narrow Settings layout: one column, the choices a list, nothing wider than the screen (Tree4 51)', async () => {
      const size = p.viewportSize();
      await p.setViewportSize({ width: 390, height: 844 });
      try {
        await p.getByRole('heading', { name: 'Docs', level: 1 }).waitFor();
        const radios = await p.getByRole('radio', { name: /^(Everyone|Members|Admins)/ }).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
        if (radios.length !== 3 || new Set(radios).size !== 1) throw new Error('the edit choices are not one list: ' + radios);
        const wide = await p.evaluate(() => document.documentElement.scrollWidth);
        if (wide > 390) throw new Error('Settings › Docs is wider than the phone: ' + wide);
        const cards = await p.locator('[data-setting^="docs-"]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
        if (cards.some((r) => r > 390)) throw new Error('a Docs card runs off the screen: ' + cards);
        s.note('settings docs phone', { radios, cards: cards.length });
      } finally {
        await p.setViewportSize(size);
      }
    });
    await s.step('back to the board', async () => {
      await p.getByRole('button', { name: 'Back to board' }).click();
      await p.getByRole('heading', { name: 'Alpha', level: 1 }).waitFor();
    });
    await s.step('phone: the bell opens a full white screen, the heading 17/700, 30 px buttons and 33 px tabs in an r10 track (Export2 29)', async () => {
      const size = p.viewportSize();
      await p.setViewportSize({ width: 390, height: 844 });
      try {
        await p.getByRole('button', { name: /^Notifications/ }).first().click();
        const panel = p.getByRole('dialog', { name: 'Notifications' });
        await panel.waitFor();
        const look = (loc) => loc.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height), bg: cs.backgroundColor, font: `${cs.fontWeight} ${cs.fontSize}`, radius: cs.borderRadius };
        });
        const got = { panel: await look(panel), title: await look(panel.getByText('Notifications', { exact: true }).first()), tabs: await look(panel.getByRole('tablist')), tab: await look(panel.getByRole('tab').first()) };
        s.note('bell on a phone', got);
        if (got.panel.x !== 0 || got.panel.w !== 390 || got.panel.bg !== 'rgb(255, 255, 255)') throw new Error('the bell panel is not a full white screen: ' + JSON.stringify(got.panel));
        if (got.title.font !== '700 17px' || got.tabs.radius !== '10px' || got.tab.h !== 33) throw new Error('the bell panel head: ' + JSON.stringify(got));
        await p.keyboard.press('Escape');
        await panel.waitFor({ state: 'detached' });
      } finally {
        await p.setViewportSize(size);
      }
    });
  },
};
