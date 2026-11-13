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

// The board column whose header text is `name` (the column element holds the header and its cards).
export function columnOf(p, name) {
  return p.locator('[class*="_column_"]').filter({ has: p.locator('[class*="columnLabel"]', { hasText: new RegExp(`^${name}$`) }) });
}

export async function dragCard(p, key, columnName) {
  const src = card(p, key);
  const header = columnOf(p, columnName).locator('[class*="columnLabel"]').first();
  await src.scrollIntoViewIfNeeded();
  const a = await src.boundingBox();
  const h = await header.boundingBox();
  const sx = a.x + a.width / 2, sy = a.y + a.height / 2;
  const tx = h.x + 60, ty = h.y + 140;
  await p.mouse.move(sx, sy);
  await p.mouse.down();
  await p.mouse.move(sx + 12, sy + 12, { steps: 4 });
  await p.mouse.move(tx, ty, { steps: 14 });
  await p.waitForTimeout(250);
  await p.mouse.up();
}

export async function openDocs(s) {
  await s.page.getByRole('button', { name: 'Docs', exact: true }).click();
  await s.page.getByRole('complementary', { name: /^Docs space/ }).waitFor();
}

// Creates a page through the New page dialog; the editor opens on the new draft.
export async function newDocPage(s, title, { parent } = {}) {
  const p = s.page;
  const first = p.getByRole('button', { name: 'Create the first page' });
  if (await first.count()) await first.click();
  else await p.getByRole('button', { name: 'New page' }).first().click();
  const d = p.getByRole('dialog', { name: 'New page' });
  await d.getByRole('textbox', { name: 'Title' }).fill(title);
  if (parent) {
    await d.getByRole('button', { name: 'Parent page' }).click();
    await p.getByText(parent, { exact: true }).last().click();
  }
  await d.getByRole('button', { name: 'Create page' }).click();
  await d.waitFor({ state: 'detached' });
  await p.getByRole('textbox', { name: 'Page title' }).waitFor();
}

// In the editor: put Markdown text in the source pane and wait for the autosave.
export async function setMarkdown(s, md) {
  const p = s.page;
  const src = p.getByRole('textbox', { name: 'Markdown source' });
  if (!(await src.count())) await p.getByRole('button', { name: 'Markdown', exact: true }).click();
  await src.fill(md);
  await p.getByText(/^Saved/).waitFor();
  await p.waitForTimeout(2300);
  await s.settle();
}

export async function publishDoc(s, note) {
  const p = s.page;
  await p.getByRole('button', { name: 'Publish', exact: true }).click();
  const d = p.getByRole('dialog', { name: 'Publish page' });
  if (note) await d.getByRole('textbox', { name: 'Version note' }).fill(note);
  await d.getByRole('button', { name: /^Publish v\d+/ }).click();
  await d.waitFor({ state: 'detached' });
  await p.getByRole('button', { name: 'Edit', exact: true }).waitFor();
}

// Reload the app and get back to the board of the first project, whatever view was open (for steps that must not
// depend on what the step before left open).
export async function home(s) {
  const p = s.page;
  await p.goto(s.server.base);
  await p.getByRole('complementary', { name: 'Project navigation' }).waitFor({ timeout: 20000 });
  await p.waitForTimeout(1500);
  await p.getByRole('button', { name: /^Alpha ALP/ }).click({ timeout: 5000 }).catch(() => {});
  await p.getByRole('button', { name: 'Board', exact: true }).click({ timeout: 3000 }).catch(() => {});
  await p.waitForTimeout(500);
}
