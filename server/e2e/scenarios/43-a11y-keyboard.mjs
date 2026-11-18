import { createRequire } from 'node:module';
import { home, ensureProject, createTicket, addMember, openDocs, newDocPage, setMarkdown, publishDoc, card, columnOf } from '../lib/ui.mjs';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

// Axe violations accepted for now: `screen:rule` or `*:rule`, each with the reason. Nothing else of impact
// critical or serious may appear.
const KNOWN = {
  // Every screen: the board stays in the page behind a dialog, and a card is a drag handle (role=button, from dnd-kit)
  // that holds its own "Card options" button. Fixing it means moving that button out of the draggable element.
  '*:nested-interactive': 'ticket card: draggable role=button wraps the "Card options" button (DraggableTicketCard / TicketCard)',
  // MenuSelect names the control ("Docs role of Admin", "Project to edit: Alpha") and reads the chosen value through
  // aria-describedby, so the visible value is not part of the name. Renaming them changes names the e2e steps use.
  '*:label-content-name-mismatch': 'MenuSelect trigger and toolbar buttons: aria-label does not contain the visible text',
};
// Stops of the Tab walk that show no focus indicator, and structure findings accepted for now (regexes, with reasons).
const FOCUS_RING_KNOWN = [
  // CSS, reported to the owner of the .css files: each of these sets outline:none and has no :focus(-visible) style
  /"Edit description"/, // ticket description view area (MarkdownEditor.module.css .viewArea): needs an outline on :focus-visible
  /"Resize page tree"/, // Docs panel resizer (PanelResizer.css): needs an outline or a coloured bar on :focus-visible
  /input "Page title"/, // Docs page title input: needs a border or underline change on :focus-visible
  /\[textbox\] "Page content"/, // Docs editor surface: the caret shows the place, but no outline marks the field
];
const STRUCTURE_KNOWN = [];


// What has the focus now: its name, its box and whether anything shows that it has it.
const ACTIVE = () => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const name = el.getAttribute('aria-label') || (el.labels && el.labels[0]?.innerText) || (el.innerText || '').trim().split('\n')[0] || el.getAttribute('title') || el.getAttribute('placeholder') || el.tagName;
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  const shadow = cs.boxShadow && cs.boxShadow !== 'none';
  // a focus ring may sit on a wrapper (:focus-within) or be a change of border; look one level up for those
  const parent = el.parentElement ? getComputedStyle(el.parentElement) : null;
  const wrapRing = !!parent && ((parent.outlineStyle !== 'none' && parseFloat(parent.outlineWidth) > 0) || (parent.boxShadow && parent.boxShadow !== 'none')) && el.parentElement.matches(':focus-within');
  const inDialog = !!el.closest('[role="dialog"]');
  return { name: name.slice(0, 60), text: (el.innerText || '').replace(/\s+/g, ' ').slice(0, 160), tag: el.tagName.toLowerCase(), role: el.getAttribute('role'), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), ring: outline || shadow || wrapRing, inDialog, id: el.id || null };
};

async function active(p) { return p.evaluate(ACTIVE); }

// Press Tab (or Shift+Tab) until the focus is on an element for which `match(info)` holds; returns the stops passed.
async function tabTo(p, match, { max = 80, back = false } = {}) {
  const stops = [];
  for (let i = 0; i < max; i++) {
    await p.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    const a = await active(p);
    stops.push(a);
    if (a && match(a)) return { found: a, stops };
  }
  throw new Error(`Tab never reached the element in ${max} presses; passed: ${stops.map((x) => x && x.name).join(' > ').slice(0, 1800)}`);
}

async function runAxe(p, tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']) {
  if (!(await p.evaluate(() => typeof window.axe !== 'undefined'))) await p.addScriptTag({ path: AXE_PATH });
  return p.evaluate(async (values) => {
    const r = await window.axe.run(document, {
      runOnly: { type: 'tag', values },
      rules: { 'color-contrast': { enabled: false } },
    });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(' ') + ' :: ' + n.html.slice(0, 140)) }));
  }, tags);
}

export default {
  name: 'Accessibility and keyboard-only use: axe on the main screens, keyboard walk, landmarks and names',
  async run(s) {
    const p = s.page;
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    const unexpected = [];
    const moderate = {};
    const audit = async (screen) => {
      const v = await runAxe(p);
      for (const x of v) {
        console.log(`AXE [${screen}] ${x.impact} ${x.id} x${x.nodes.length}: ${x.help}`);
        if (process.env.AXE_VERBOSE) for (const n of x.nodes.slice(0, 5)) console.log('     ' + n);
      }
      for (const x of v) {
        if (x.impact === 'critical' || x.impact === 'serious') {
          const reason = KNOWN[`${screen}:${x.id}`] || KNOWN[`*:${x.id}`];
          if (!reason) unexpected.push(`${screen}: ${x.id} (${x.impact}) x${x.nodes.length}: ${x.nodes[0]}`);
        } else (moderate[screen] ||= []).push(`${x.id} x${x.nodes.length}`);
      }
      // best-practice rules (not WCAG): reported, never asserted
      for (const x of await runAxe(p, ['best-practice'])) (moderate[screen] ||= []).push(`${x.id}(${x.impact}) x${x.nodes.length}`);
      s.note(`axe ${screen}`, v.map((x) => `${x.id}:${x.impact}:${x.nodes.length}`).join(', ') || 'clean');
    };

    await s.step('set up: project, member, tickets, a page, an idea', async () => {
      await ensureProject(s);
      await addMember(s, 'Ada Lovelace');
      await createTicket(s, { title: 'Axe ticket', description: 'Some text' });
      await openDocs(s);
      await newDocPage(s, 'Handbook');
      await setMarkdown(s, '# Intro\n\nBody text.\n');
      await publishDoc(s, 'first');
    });
    await s.step('axe: Docs editor and tree', async () => {
      await p.getByRole('button', { name: 'Edit', exact: true }).waitFor();
      await audit('docs');
    });
    await s.step('axe: Idea Space', async () => {
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await p.getByRole('button', { name: 'New idea' }).first().click();
      await p.getByRole('textbox', { name: 'Idea title' }).fill('An idea');
      await p.keyboard.press('Enter');
      await p.getByText('Added IDEA-1 to the Inbox').waitFor();
      await audit('idea-space');
    });
    await s.step('axe: board', async () => {
      await home(s);
      await card(p, 'ALP-1').waitFor();
      await audit('board');
    });
    await s.step('axe: ticket modal', async () => {
      await card(p, 'ALP-1').click();
      await dlg().waitFor();
      await audit('ticket-modal');
      await dlg().getByRole('button', { name: 'Close', exact: true }).click();
      await dlg().waitFor({ state: 'detached' });
    });
    await s.step('axe: New ticket', async () => {
      await p.getByRole('button', { name: 'New Ticket' }).click();
      await p.getByPlaceholder('Ticket title…').waitFor();
      await audit('new-ticket');
      await p.keyboard.press('Escape');
      await p.getByRole('button', { name: 'Create Ticket' }).waitFor({ state: 'detached' });
    });
    await s.step('axe: Members', async () => {
      await p.getByRole('button', { name: 'Members' }).first().click();
      await p.getByRole('heading', { name: 'Project Members' }).waitFor();
      await audit('members');
      await p.keyboard.press('Escape');
      await p.getByRole('heading', { name: 'Project Members' }).waitFor({ state: 'detached' });
    });
    await s.step('axe: notifications panel', async () => {
      await p.getByRole('button', { name: /^Notifications(, \d+ needs you)?$/ }).first().click();
      await p.getByRole('dialog', { name: 'Notifications' }).waitFor();
      await audit('notifications');
      await p.keyboard.press('Escape');
      await p.getByRole('dialog', { name: 'Notifications' }).waitFor({ state: 'detached' });
    });
    await s.step('axe: Recycle Bin', async () => {
      await p.getByRole('button', { name: /^Recycle Bin/ }).click();
      await p.getByRole('dialog', { name: 'Recycle Bin' }).waitFor();
      await audit('recycle-bin');
      await p.keyboard.press('Escape');
      await p.getByRole('dialog', { name: 'Recycle Bin' }).waitFor({ state: 'detached' });
    });
    await s.step('axe: Settings', async () => {
      await p.getByRole('button', { name: 'Settings' }).click();
      await p.getByRole('heading', { name: 'Repositories', level: 1 }).waitFor();
      await audit('settings');
    });
    await s.step('axe summary', async () => {
      console.log('MODERATE/MINOR: ' + JSON.stringify(moderate));
      s.note('axe moderate and minor', moderate);
      if (unexpected.length) throw new Error('axe violations: ' + unexpected.join(' || '));
    });

    // ---------------------------------------------------------------- keyboard only: no mouse from here on
    const ringless = new Set();
    const note = (a) => { if (a && !a.ring) ringless.add(`${a.tag}${a.role ? `[${a.role}]` : ''} "${a.name}"`); return a; };
    const tab = async (match, opts) => { const r = await tabTo(p, match, opts); r.stops.forEach(note); return r.found; };
    const named = (re) => (a) => re.test(a.name);
    const goHome = async () => {
      await home(s);
      await p.evaluate(() => { document.activeElement?.blur(); });
    };
    // focus is inside the open dialog `d` (a locator)
    const focusInside = async (d, what) => {
      const ok = await d.evaluate((el) => el.contains(document.activeElement));
      if (!ok) throw new Error(`${what}: focus is not inside the dialog (it is on ${JSON.stringify(await active(p))})`);
    };
    // Esc closes the dialog `d` and the focus is back on the control marked data-a11y-opener
    const escapeBack = async (d, what, openerName) => {
      await p.keyboard.press('Escape');
      await d.waitFor({ state: 'detached' });
      const a = await active(p);
      if (!a || !openerName.test(a.name)) throw new Error(`${what}: after Esc the focus is on ${JSON.stringify(a)}, not on "${openerName}"`);
    };

    await s.step('keyboard: the board header is tabbed left to right', async () => {
      await goHome();
      const first = await tab(named(/^Board health$/));
      const stops = [first];
      while (stops[stops.length - 1].name !== 'New Ticket') {
        await p.keyboard.press('Tab');
        const a = note(await active(p));
        if (!a) throw new Error('focus left the page inside the header');
        stops.push(a);
        if (stops.length > 20) throw new Error('"New Ticket" was not reached from "Board health"');
      }
      for (let i = 1; i < stops.length; i++) {
        if (Math.abs(stops[i].y - stops[i - 1].y) > 12 || stops[i].x <= stops[i - 1].x)
          throw new Error(`Tab order differs from the visual order: ${stops.map((x) => `${x.name}@${x.x},${x.y}`).join(' > ')}`);
      }
      s.note('header tab order', stops.map((x) => x.name));
    });

    await s.step('keyboard: create a ticket (New Ticket, type a title, Enter)', async () => {
      await goHome();
      const nt = p.getByRole('dialog', { name: 'New ticket' });
      await tab(named(/^New Ticket$/));
      await p.keyboard.press('Enter');
      await nt.waitFor();
      await focusInside(nt, 'New ticket');
      await p.keyboard.type('Keyboard ticket');
      await p.keyboard.press('Enter');
      await nt.waitFor({ state: 'detached' });
      await card(p, 'ALP-2').waitFor();
      const a = await active(p);
      if (!a || a.name !== 'New Ticket') throw new Error(`after creating, focus should be back on New Ticket, it is on ${JSON.stringify(a)}`);
    });

    await s.step('keyboard: open the ticket, edit the title, comment, move it, close it', async () => {
      await goHome();
      await tab((a) => a.role === 'button' && /Keyboard ticket/.test(a.text), { max: 60 });
      await p.keyboard.press('Enter');
      await dlg().waitFor();
      await focusInside(dlg(), 'ticket');
      // title
      await tab(named(/^Keyboard ticket$/), { max: 40 });
      await p.keyboard.press('Enter');
      await p.keyboard.press('Control+A');
      await p.keyboard.type('Keyboard ticket, renamed');
      await p.keyboard.press('Enter');
      await dlg().getByRole('heading', { name: 'Keyboard ticket, renamed', level: 2 }).waitFor();
      const a = await active(p);
      if (!a || !/renamed/.test(a.name)) throw new Error(`after the title edit the focus should be on the title, it is on ${JSON.stringify(a)}`);
      // comment
      // the "Add a comment…" button turns into the composer as soon as it gets the focus
      const c0 = await tab((x) => x.tag === 'textarea' || /^Add a comment…$/.test(x.name), { max: 80 });
      if (c0.tag !== 'textarea') await p.keyboard.press('Enter');
      await p.keyboard.type('Said from the keyboard');
      await p.keyboard.press('Control+Enter');
      await dlg().getByText('Said from the keyboard').first().waitFor();
      // move: the status button in the sidebar, then the list
      await p.getByRole('dialog', { name: /^Ticket / }).evaluate((el) => el.focus());
      await tab(named(/^(To Do|Backlog)$/), { max: 120 });
      await p.keyboard.press('Enter');
      await p.getByRole('listbox').waitFor();
      await tab(named(/^In Progress$/), { max: 10 });
      await p.keyboard.press('Enter');
      await p.getByRole('listbox').waitFor({ state: 'detached' });
      await dlg().getByRole('complementary').getByRole('button', { name: 'In Progress', exact: true }).waitFor();
      const b = await active(p);
      if (!b || b.name !== 'In Progress') throw new Error(`after choosing a status the focus should stay on its button, it is on ${JSON.stringify(b)}`);
      // close: Esc on the status button would only close a list; Esc here closes the ticket
      await p.keyboard.press('Escape');
      await dlg().waitFor({ state: 'detached' });
      await columnOf(p, 'In Progress').getByText('Keyboard ticket, renamed').waitFor();
      const c = await active(p);
      if (!c || c.role !== 'button' || !/Task|renamed/.test(c.name)) throw new Error(`after closing the ticket the focus should be on its card, it is on ${JSON.stringify(c)}`);
    });

    await s.step('keyboard: Docs, make a page, type, publish', async () => {
      await goHome();
      await tab(named(/^Docs$/), { max: 80 });
      await p.keyboard.press('Enter');
      await p.getByRole('complementary', { name: /^Docs space/ }).waitFor();
      await tab(named(/^New page$/), { max: 80 });
      await p.keyboard.press('Enter');
      const nd = p.getByRole('dialog', { name: 'New page' });
      await nd.waitFor();
      await focusInside(nd, 'New page');
      await p.keyboard.type('Keyboard page');
      await p.keyboard.press('Enter');
      await nd.waitFor({ state: 'detached' });
      await p.getByRole('textbox', { name: 'Page title' }).waitFor();
      await tab((a) => a.tag === 'div' || a.tag === 'textarea' ? /Page content|Markdown source|Write/i.test(a.name) || a.role === 'textbox' : false, { max: 120 });
      await p.keyboard.type('Typed with the keyboard only.');
      await p.getByText(/^Saved/).waitFor();
      await tab(named(/^Publish$/), { max: 60 });
      await p.keyboard.press('Enter');
      const pd = p.getByRole('dialog', { name: 'Publish page' });
      await pd.waitFor();
      await focusInside(pd, 'Publish page');
      await tab(named(/^Publish v\d+/), { max: 20 });
      await p.keyboard.press('Enter');
      await pd.waitFor({ state: 'detached' });
      await p.getByRole('button', { name: 'Edit', exact: true }).waitFor();
      await p.getByText('Typed with the keyboard only.').first().waitFor();
    });

    await s.step('keyboard: Settings, change a setting', async () => {
      await goHome();
      await tab(named(/^Settings$/), { max: 80 });
      await p.keyboard.press('Enter');
      await p.getByRole('heading', { name: 'Repositories', level: 1 }).waitFor();
      await tab(named(/^Appearance$/), { max: 80 });
      await p.keyboard.press('Enter');
      await p.getByRole('heading', { name: 'Appearance', level: 1 }).waitFor();
      // the two looks are radios (each a Tab stop); Space picks one
      await tab(named(/^Black & white/), { max: 40 });
      await p.keyboard.press('Space');
      await p.getByText('Saved', { exact: true }).first().waitFor();
      const on = await p.evaluate(() => document.activeElement?.getAttribute('aria-checked'));
      if (on !== 'true') throw new Error(`Space on "Black & white" did not select it (aria-checked=${on})`);
      await tab(named(/^Color/), { max: 4, back: true });
      await p.keyboard.press('Space');
      await p.getByRole('radio', { name: /^Color/ }).and(p.locator('[aria-checked="true"]')).waitFor();
    });

    await s.step('keyboard: each main dialog opens and closes with Esc, focus returns to its opener', async () => {
      const cases = [
        ['Members', /^Members$/, () => p.getByRole('dialog', { name: 'Project Members' })],
        ['Recycle Bin', /^Recycle Bin/, () => p.getByRole('dialog', { name: 'Recycle Bin' })],
        ['Notifications', /^Notifications/, () => p.getByRole('dialog', { name: 'Notifications' })],
        ['New Ticket', /^New Ticket$/, () => p.getByRole('dialog', { name: 'New ticket' })],
      ];
      for (const [label, opener, dialog] of cases) {
        await goHome();
        await tab(named(opener), { max: 80 });
        await p.keyboard.press('Enter');
        await dialog().waitFor();
        await focusInside(dialog(), label);
        await escapeBack(dialog(), label, opener);
      }
      // a ticket, from its card
      await goHome();
      await tab((a) => a.role === 'button' && a.tag === 'div' && a.name !== 'Card options', { max: 60 });
      const cardName = (await active(p)).name;
      await p.keyboard.press('Enter');
      await dlg().waitFor();
      await focusInside(dlg(), 'ticket');
      await escapeBack(dlg(), 'ticket', new RegExp(`^${cardName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    });

    await s.step('keyboard: the Docs and Idea dialogs close with Esc and give the focus back', async () => {
      await goHome();
      await tab(named(/^Docs$/), { max: 80 });
      await p.keyboard.press('Enter');
      await p.getByRole('complementary', { name: /^Docs space/ }).waitFor();
      for (const [label, opener, dialog] of [
        ['New page', /^New page$/, 'New page'],
        ['Publish', /^(Publish|Edit)$/, 'Publish page'],
      ]) {
        if (label === 'Publish') {
          // the page we made is published: edit it first so the Publish button is there
          await tab(named(/^Edit$/), { max: 80 });
          await p.keyboard.press('Enter');
          await p.getByRole('textbox', { name: 'Page title' }).waitFor();
        }
        await tab(named(opener), { max: 120 });
        await p.keyboard.press('Enter');
        const d = p.getByRole('dialog', { name: dialog });
        await d.waitFor();
        await focusInside(d, label);
        await escapeBack(d, label, opener);
      }
      await goHome();
      await tab(named(/^Idea Space$/), { max: 80 });
      await p.keyboard.press('Enter');
      await p.getByRole('button', { name: 'New idea' }).first().waitFor();
      await tab(named(/^New idea$/), { max: 80 });
      await p.keyboard.press('Enter');
      const qd = p.getByRole('textbox', { name: 'Idea title' });
      await qd.waitFor();
      await p.keyboard.press('Escape');
      await qd.waitFor({ state: 'detached' });
      const a = await active(p);
      if (!a || !/New idea/.test(a.name)) throw new Error(`Idea dialog: after Esc the focus is on ${JSON.stringify(a)}, not on "New idea"`);
    });

    await s.step('keyboard: no focus trap on the board, Tab and Shift+Tab both leave every region', async () => {
      await goHome();
      const seen = new Set();
      let left = 0;
      for (let i = 0; i < 90; i++) {
        await p.keyboard.press('Tab');
        const a = await active(p);
        if (!a) { left++; continue; }
        seen.add(`${a.name}@${a.x},${a.y}`);
        if (a.inDialog) throw new Error(`focus is inside a dialog with none open: ${JSON.stringify(a)}`);
      }
      if (left === 0) throw new Error('Tab never left the page: the focus is trapped');
      if (seen.size < 15) throw new Error(`only ${seen.size} stops in 90 Tab presses: ${[...seen].join(' | ')}`);
      const back = new Set();
      for (let i = 0; i < 30; i++) { await p.keyboard.press('Shift+Tab'); const a = await active(p); if (a) back.add(`${a.name}@${a.x},${a.y}`); }
      if (back.size < 10) throw new Error(`Shift+Tab visited only ${back.size} stops in 30 presses`);
      s.note('tab stops seen', seen.size);
    });

    await s.step('keyboard: every stop of the walk showed a focus indicator', async () => {
      const list = [...ringless];
      console.log('NO FOCUS INDICATOR: ' + JSON.stringify(list));
      const bad = list.filter((x) => !FOCUS_RING_KNOWN.some((re) => re.test(x)));
      if (bad.length) throw new Error('no visible focus indicator on: ' + bad.join(' || '));
    });

    // ---------------------------------------------------------------- landmarks, title, headings, names
    const structure = () => p.evaluate(() => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'; };
      const mains = [...document.querySelectorAll('main, [role="main"]')].filter(vis);
      const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')].filter(vis).map((h) => (h.getAttribute('aria-level') ? Number(h.getAttribute('aria-level')) : h.tagName.match(/^H(\d)$/) ? Number(h.tagName[1]) : 2));
      const nameOf = (el) => (el.getAttribute('aria-label') || '').trim() || (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent?.trim()) || (el.innerText || '').trim() || (el.getAttribute('title') || '').trim() || el.querySelector('img[alt]:not([alt=""])')?.getAttribute('alt') || '';
      const unnamed = [...document.querySelectorAll('button, [role="button"], a[href], [role="link"], [role="switch"], [role="checkbox"], [role="tab"], [role="menuitem"], input:not([type="hidden"]), select, textarea')]
        .filter(vis).filter((el) => !el.closest('[aria-hidden="true"]')).filter((el) => !nameOf(el) && !(el.labels && el.labels.length) && !el.getAttribute('placeholder'))
        .map((el) => el.outerHTML.slice(0, 120));
      return { title: document.title, mains: mains.length, heads, unnamed, lang: document.documentElement.lang };
    });
    const structureProblems = [];
    const checkStructure = async (screen) => {
      const x = await structure();
      if (!x.title.trim()) structureProblems.push(`${screen}: no page title`);
      if (x.mains !== 1) structureProblems.push(`${screen}: ${x.mains} main landmarks`);
      if (!x.lang) structureProblems.push(`${screen}: no lang on <html>`);
      if (!x.heads.includes(1)) structureProblems.push(`${screen}: no h1 (${x.heads.join(',')})`);
      for (let i = 1; i < x.heads.length; i++) if (x.heads[i] > x.heads[i - 1] + 1) { structureProblems.push(`${screen}: heading order jumps h${x.heads[i - 1]} to h${x.heads[i]} (${x.heads.join(',')})`); break; }
      for (const u of x.unnamed) structureProblems.push(`${screen}: control without a name: ${u}`);
      s.note(`structure ${screen}`, { title: x.title, mains: x.mains, headings: x.heads.join(','), unnamed: x.unnamed.length });
    };
    await s.step('landmarks: board', async () => { await home(s); await checkStructure('board'); });
    await s.step('landmarks: Docs', async () => { await openDocs(s); await p.getByRole('button', { name: 'Edit', exact: true }).waitFor(); await checkStructure('docs'); });
    await s.step('landmarks: Idea Space', async () => { await home(s); await p.getByRole('button', { name: 'Idea Space' }).click(); await p.getByRole('button', { name: 'New idea' }).first().waitFor(); await checkStructure('idea-space'); });
    await s.step('landmarks: Settings', async () => { await home(s); await p.getByRole('button', { name: 'Settings' }).click(); await p.getByRole('navigation', { name: 'Settings pages' }).waitFor(); await p.getByRole('heading', { level: 1 }).first().waitFor(); await checkStructure('settings'); });
    await s.step('landmarks: summary', async () => {
      const bad = structureProblems.filter((x) => !STRUCTURE_KNOWN.some((re) => re.test(x)));
      console.log('STRUCTURE: ' + JSON.stringify(structureProblems));
      if (bad.length) throw new Error(bad.join(' || '));
    });
  },
};
