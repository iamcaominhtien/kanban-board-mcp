// Helpers that work through the UI the way a person does.
export async function openBoard(s, page = s.page) {
  await page.goto(s.server.base);
  await page.waitForFunction(() => {
    const t = document.body.innerText;
    return /Create your first project/.test(t) || document.querySelector('h1') && !/Loading/.test(document.querySelector('h1')?.getAttribute('aria-label') || '') && /Backlog|Create your first/.test(t);
  }, null, { timeout: 20000 });
  await page.waitForTimeout(1200);
}

export async function firstProject(s, { name = 'Alpha', prefix = 'ALP' } = {}) {
  const p = s.page;
  await p.getByLabel('Project name').fill(name);
  await p.getByLabel('Prefix', { exact: true }).fill(prefix);
  await p.getByRole('button', { name: 'Create project' }).click();
  await p.getByRole('heading', { name, level: 1 }).waitFor();
}

// Fresh server -> board with one project (through the first-run screen)
export async function ensureProject(s, opts) {
  await openBoard(s);
  await firstProject(s, opts);
  await s.page.getByText('No tickets').first().waitFor();
}

export async function createTicket(s, { title, type = 'Task', description, priority, assignee, tags, start, due } = {}) {
  const p = s.page;
  await p.getByRole('button', { name: 'New Ticket' }).click();
  await p.getByPlaceholder('Ticket title…').fill(title);
  await p.getByRole('button', { name: new RegExp(`^${type} ${type}$`) }).click();
  if (description) {
    await p.locator('[contenteditable="true"], textarea').filter({ hasNot: p.locator('nothing') }).last().click().catch(() => {});
    await p.keyboard.type(description);
  }
  if (priority) await p.getByRole('radio', { name: new RegExp(`^${priority}$`, 'i') }).check({ force: true });
  if (tags) await p.getByPlaceholder('frontend, bug, phase-2…').fill(tags);
  if (start) await p.getByLabel('Start Date').fill(start);
  if (due) await p.getByLabel('Due Date').fill(due);
  await p.getByRole('button', { name: 'Create Ticket' }).click();
  await p.getByRole('button', { name: 'Create Ticket' }).waitFor({ state: 'detached' });
  await s.settle();
}

export function card(p, key) { return p.getByRole('button', { name: new RegExp(`${key} `) }).first(); }

export async function openTicket(s, key) {
  await card(s.page, key).click();
  await s.page.getByRole('dialog', { name: `Ticket ${key}` }).waitFor();
  return s.page.getByRole('dialog', { name: `Ticket ${key}` });
}

export async function closeTicket(s) {
  const d = s.page.getByRole('dialog', { name: /^Ticket / });
  await d.getByRole('button', { name: 'Close', exact: true }).click();
  await d.waitFor({ state: 'detached' });
}

export async function openMembers(s) {
  await s.page.getByRole('button', { name: 'Members' }).first().click();
  await s.page.getByRole('heading', { name: 'Project Members' }).waitFor();
}

export async function closeMembers(s) {
  await s.page.getByRole('heading', { name: 'Project Members' }).locator('xpath=..').getByRole('button', { name: 'Close' }).click();
  await s.page.getByRole('heading', { name: 'Project Members' }).waitFor({ state: 'detached' });
}

export async function addMember(s, name) {
  await openMembers(s);
  await s.page.getByPlaceholder('Member name…').fill(name);
  await s.page.getByRole('button', { name: 'Add', exact: true }).click();
  await s.page.getByText(name, { exact: true }).first().waitFor();
  await closeMembers(s);
}
