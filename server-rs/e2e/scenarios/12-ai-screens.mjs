import { home, ensureProject, createTicket, openTicket } from '../lib/ui.mjs';

// The AI team screens. The Rust server does not serve every AI route yet: this group is reported, never failing.
// Each step only opens a screen and records what the page shows and which requests it made.
export default {
  name: 'AI screens: open every AI screen and record what happens',
  group: 'ai',
  soft: true,
  async run(s) {
    const p = s.page;
    await s.step('set up a project with a ticket', async () => {
      await ensureProject(s);
      await createTicket(s, { title: 'AI target' });
    });
    await s.step('Board: the Schedules tab', async () => {
      await home(s);
      await p.getByRole('button', { name: /^Schedules/ }).click();
      await p.waitForTimeout(1500);
    });
    await s.step('Board: Ask AI panel', async () => {
      await home(s);
      await p.getByRole('button', { name: /^Ask AI/ }).first().click();
      await p.waitForTimeout(1500);
      await p.keyboard.press('Escape');
    });
    await s.step('Board: Board health', async () => {
      await home(s);
      await p.getByRole('button', { name: 'Board health' }).click();
      await p.waitForTimeout(1500);
      await p.keyboard.press('Escape');
    });
    await s.step('Members: the AI team tab', async () => {
      await home(s);
      await p.getByRole('button', { name: 'Members' }).first().click();
      await p.getByRole('heading', { name: 'Project Members' }).waitFor();
      const tab = p.getByRole('tab', { name: /AI/ }).or(p.getByRole('button', { name: /^AI/ })).first();
      await tab.click({ timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(1200);
    });
    await s.step('Members: add AI team page', async () => {
      await home(s);
      await p.getByRole('button', { name: /Add AI team/ }).first().click({ timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(1500);
    });
    await s.step('Settings: AI', async () => {
      await home(s);
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'AI', exact: true }).click();
      await p.waitForTimeout(1500);
    });
    await s.step('Settings: Board assistant', async () => {
      await home(s);
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Board assistant' }).click();
      await p.waitForTimeout(1500);
      await p.getByRole('button', { name: 'Back to board' }).click();
    });
    await s.step('Ticket: AI runs, AI activity tab and the AI menu', async () => {
      await home(s);
      const d = await openTicket(s, 'ALP-1');
      await d.getByRole('tab', { name: 'AI activity' }).click();
      await p.waitForTimeout(1200);
      await d.getByRole('tab', { name: 'Ticket' }).click();
      await d.getByRole('button', { name: 'AI runs' }).click();
      await p.waitForTimeout(1200);
      await d.getByRole('button', { name: 'AI', exact: true }).click();
      await p.waitForTimeout(1200);
      await p.keyboard.press('Escape');
    });
    await s.step('Idea Space: Ask', async () => {
      await home(s);
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await p.getByRole('button', { name: 'Ask', exact: true }).click();
      await p.waitForTimeout(1500);
    });
  },
};
