import path from 'node:path';
import { home, ensureProject, createTicket, addMember, openDocs, newDocPage, setMarkdown, publishDoc, openTicket, closeTicket, dragCard, columnOf, card } from '../lib/ui.mjs';

// The main screens at tablet widths (1024x768 and 768x1024) in each theme the app offers (Settings > Appearance:
// Color, the default, and Black & white, a grayscale filter on <html>; there is no dark theme). For every screen,
// width and theme: no horizontal page scroll, the key controls visible and not covered by another element, the
// contrast of the text against its effective background (WCAG AA: 4.5:1, 3:1 for large text), and a screenshot
// (`<report>/42-rust-<theme>-<width>-<screen>.png`).
//
// Known faults that are NOT fixed (they need a .tsx change) are listed in KNOWN and asserted as today's behaviour.
const SIZES = [{ width: 1024, height: 768 }, { width: 768, height: 1024 }];
const THEMES = ['default', 'bw'];

// Text that fails AA today and cannot be fixed from CSS: `${screen}: ${text}` -> why. Filled in from a run.
const KNOWN = {
  // inline `style={{ color: '#9AA8A0' }}` in ui/src/components/TicketModal.tsx (2.48:1 on white): the empty Due Date
  // and Estimate ('–', line ~3262 / ~3288), the 'Unassigned' option label and the dashed avatar (~1039), the
  // 'Add tag' button and the '0' counter. Fix: `var(--color-text-sec)` in those styles.
  'ticket modal: –': 'inline #9AA8A0',
  'ticket modal: Unassigned': 'inline #9AA8A0',
  'ticket modal: Add tag': 'inline #9AA8A0',
  'ticket modal: 0': 'inline #9AA8A0',
  // a tab count shown only in one of the two widths, inline colour as well
  'ticket modal: Comments': 'inline #8A998F (2.99:1)',
  // member avatars take an inline tint and text colour from a palette (3.16:1 on its tint): the palette in
  // ui/src/utils (avatar colours) needs a darker text colour
  'members: AD': 'avatar palette, inline',
  // the author chip's initials (4.42:1 on its tint), inline colour from the same palette
  'docs: ME': 'avatar palette, inline',
};
// Kept below AA on purpose (the owner's choice: the column colours stay as designed): the white count on each column's
// accent colour (Board.module.css .columnBadge; 2.2 to 3.9:1 on the grey, orange and green columns)
const KNOWN_CLASS = /columnBadge/;

export default {
  name: 'Responsive layout at tablet widths and in each theme',
  group: 'core',
  viewport: { width: 1024, height: 768 },
  async run(s) {
    const p = s.page;
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    const failures = []; // contrast failures not in KNOWN
    const seenKnown = new Set();

    const until = async (fn, what, ms = 15000) => {
      const t0 = Date.now();
      for (;;) {
        try { if (await fn()) return; } catch { /* look again */ }
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await p.waitForTimeout(100);
      }
    };

    // ---- in-page measurements
    const overflow = () => p.evaluate(() => {
      const de = document.documentElement;
      const off = [];
      if (de.scrollWidth > window.innerWidth) {
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > window.innerWidth + 1) {
            const cs = getComputedStyle(el);
            if (cs.position === 'fixed') continue;
            off.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} right=${Math.round(r.right)}`);
            if (off.length >= 6) break;
          }
        }
      }
      return { scrollWidth: de.scrollWidth, bodyScrollWidth: document.body.scrollWidth, innerWidth: window.innerWidth, off };
    });

    // The key control is in view and the element at its centre is the control (or inside / around it).
    const reachable = async (loc, what) => {
      await loc.first().waitFor({ state: 'visible' });
      await loc.first().scrollIntoViewIfNeeded();
      const r = await loc.first().evaluate((el) => {
        const b = el.getBoundingClientRect();
        const x = b.left + b.width / 2, y = b.top + b.height / 2;
        const top = document.elementFromPoint(x, y);
        return {
          inView: b.width > 0 && b.height > 0 && b.left >= -0.5 && b.right <= window.innerWidth + 0.5 && b.top >= -0.5 && b.bottom <= window.innerHeight + 0.5,
          hit: !!top && (el === top || el.contains(top) || top.contains(el)),
          rect: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)],
          top: top ? `${top.tagName.toLowerCase()}.${String(top.className).split(' ')[0]}` : null,
        };
      });
      if (!r.inView) throw new Error(`${what} is not inside the window: ${JSON.stringify(r.rect)}`);
      if (!r.hit) throw new Error(`${what} is covered by ${r.top}`);
    };

    // Contrast of the text on screen against its effective background, in the theme `theme` (Black & white is a CSS
    // filter on <html>, which getComputedStyle does not show: grayscale and contrast(1.05) are applied to the colours).
    const contrast = (theme) => p.evaluate((theme) => {
      const parse = (c) => { const m = c.match(/[\d.]+/g); return m ? { r: +m[0], g: +m[1], b: +m[2], a: m[3] === undefined ? 1 : +m[3] } : null; };
      const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
      const filt = (c) => {
        if (theme !== 'bw') return c;
        const g = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
        const k = (v) => Math.max(0, Math.min(255, ((v / 255 - 0.5) * 1.05 + 0.5) * 255));
        return { r: k(g), g: k(g), b: k(g), a: 1 };
      };
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
      const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      const bgOf = (el) => {
        const chain = [];
        for (let e = el; e; e = e.parentElement) chain.push(e);
        let acc = { r: 255, g: 255, b: 255, a: 1 };
        let unknown = false;
        for (const e of chain.reverse()) {
          const cs = getComputedStyle(e);
          const c = parse(cs.backgroundColor);
          if (c && c.a > 0) acc = over(c, acc);
          // a flat veil (a gradient from one colour to the same colour) is a colour over the background
          const veil = cs.backgroundImage.match(/^linear-gradient\((rgba?\([^)]*\)), \1\)$/);
          if (veil) acc = over(parse(veil[1]), acc);
          else if (cs.backgroundImage !== 'none') unknown = true;
          else if (c && c.a === 1) unknown = false; // an opaque colour hides what is behind it
        }
        return { bg: acc, unknown };
      };
      const opacityOf = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= +getComputedStyle(e).opacity; return o; };
      const out = [];
      const seen = new Set();
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const text = n.nodeValue.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const el = n.parentElement;
        if (!el || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue;
        if (el.closest(':disabled, [aria-disabled="true"]')) continue; // disabled controls are exempt from WCAG 1.4.3
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const rg = document.createRange(); rg.selectNodeContents(n);
        const r = rg.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        if (cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color && /transparent|rgba\(0, 0, 0, 0\)/.test(cs.webkitTextFillColor)) continue;
        const key = `${el.tagName}.${String(el.className)}|${cs.color}|${text.slice(0, 20)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { bg, unknown } = bgOf(el);
        let fg = parse(cs.color);
        const op = opacityOf(el);
        if (op < 0.05) continue; // faded out (a collapsed label, a tooltip not shown)
        fg = { ...fg, a: fg.a * op };
        const bgF = filt(bg);
        const fgF = filt(over(fg, bg));
        const size = parseFloat(cs.fontSize);
        const bold = +cs.fontWeight >= 700;
        const large = size >= 24 || (size >= 18.66 && bold);
        const need = large ? 3 : 4.5;
        const ratioV = ratio(fgF, bgF);
        if (ratioV + 0.005 < need && !unknown) {
          const fx = (c) => `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
          out.push({ text: text.slice(0, 40), cls: `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`, ratio: Math.round(ratioV * 100) / 100, need, fg: fx(fgF), bg: fx(bgF), size });
        }
      }
      return { checked: seen.size, out };
    }, theme);

    // Hard-coded colours: the app has no dark theme, and Black & white is a filter on <html> that turns every colour
    // (literal or token) to gray, so a literal white panel cannot be left behind in either look. What is checked is
    // that the filter is on in bw and off in Color. (The CSS holds ~4900 literal hex colours against ~830 uses of a
    // --color-* token: a real dark theme would first have to tokenize them.)
    const filterOf = () => p.evaluate(() => getComputedStyle(document.documentElement).filter);

    const record = async (screen, theme, size, opts = {}) => {
      const tag = `${theme}-${size.width}x${size.height}`;
      const ov = await overflow();
      if (!opts.scrollsInside && (ov.scrollWidth > ov.innerWidth || ov.bodyScrollWidth > ov.innerWidth)) {
        throw new Error(`${screen} @${tag}: horizontal page scroll (scrollWidth ${ov.scrollWidth}, body ${ov.bodyScrollWidth} > ${ov.innerWidth}): ${ov.off.join('; ')}`);
      }
      for (const [what, loc] of Object.entries(opts.controls || {})) await reachable(loc, `${screen} @${tag}: ${what}`);
      const c = await contrast(theme);
      for (const f of c.out) {
        if (process.env.E2E_42_VERBOSE) console.log(`42 ~ ${theme} ${tag} ${screen}: "${f.text}" (${f.cls}, ${f.size}px) ${f.ratio}:1 ${f.fg} on ${f.bg}`);
        const k = `${screen}: ${f.text}`;
        if (KNOWN[k]) { seenKnown.add(k); continue; }
        if (KNOWN_CLASS.test(f.cls || '')) continue;
        failures.push(`${theme} ${tag} ${screen}: "${f.text}" (${f.cls}, ${f.size}px) ${f.ratio}:1 < ${f.need}:1  ${f.fg} on ${f.bg}`);
      }
      const flt = await filterOf();
      if ((theme === 'bw') !== /grayscale/.test(flt)) throw new Error(`${screen} @${tag}: the page filter is "${flt}"`);
      console.log(`42 ${tag} ${screen}: scrollWidth ${ov.scrollWidth}/${ov.innerWidth}, ${c.checked} text samples, ${c.out.length} below AA`);
      await p.screenshot({ path: path.join(s.reportDir, `42-rust-${tag.replace('x', '-')}-${screen.replace(/\W+/g, '-').toLowerCase()}.png`) });
    };

    // Settings: a list of pages beside the content, or (narrow window) a dropdown above it.
    const openAppearance = async () => {
      const nav = p.getByRole('navigation', { name: 'Settings pages' });
      if (await nav.isVisible()) await nav.getByRole('button', { name: 'Appearance', exact: true }).click();
      else await p.getByRole('combobox').first().selectOption({ label: 'App · Appearance' });
      await p.getByRole('heading', { name: 'Appearance', level: 1 }).waitFor();
    };

    const bell = () => p.getByRole('button', { name: /^Notifications(, \d+ needs you)?$/ }).first();
    const goBoard = async () => {
      await home(s);
      await card(p, 'ALP-1').waitFor();
    };

    // ---------------------------------------------------------------- set up
    await s.step('set up: a project, members, tickets in several columns, a Docs page, ideas and a notification', async () => {
      await p.setViewportSize({ width: 1440, height: 900 }); // dragging cards needs every column in view
      await ensureProject(s);
      await addMember(s, 'Me');
      await addMember(s, 'Ada Lovelace');
      await createTicket(s, { title: 'Plan the release of version two with a long title that has to wrap', priority: 'High', tags: 'release, planning' });
      await createTicket(s, { title: 'Fix login', type: 'Bug', priority: 'Critical', tags: 'bug' });
      await createTicket(s, { title: 'Dark mode', type: 'Feature', priority: 'Low', tags: 'ui' });
      await createTicket(s, { title: 'Tidy the repo', type: 'Chore', priority: 'Medium' });
      await createTicket(s, { title: 'Write the docs', priority: 'Medium' });
      for (const k of ['ALP-1', 'ALP-2', 'ALP-3', 'ALP-4', 'ALP-5']) await card(p, k).waitFor();
      await dragCard(p, 'ALP-2', 'In Progress');
      await columnOf(p, 'In Progress').getByRole('button', { name: /ALP-2/ }).waitFor();
      await dragCard(p, 'ALP-3', 'Review');
      await columnOf(p, 'Review').getByRole('button', { name: /ALP-3/ }).waitFor();
      await dragCard(p, 'ALP-4', 'Done');
      await columnOf(p, 'Done').getByRole('button', { name: /ALP-4/ }).waitFor();
      await openDocs(s);
      await newDocPage(s, 'Handbook');
      await setMarkdown(s, '# Handbook\n\nBody text with a [link](https://example.com) and `code`.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> A quote.\n\n```js\nconst x = 1;\n```\n');
      await publishDoc(s, 'first');
      await newDocPage(s, 'Child page', { parent: 'Handbook' });
      await p.getByRole('textbox', { name: 'Write a comment on this page…' }).waitFor().catch(() => {});
      await p.getByRole('button', { name: 'Handbook' }).first().click().catch(() => {});
      await p.getByRole('textbox', { name: 'Write a comment on this page…' }).click();
      await p.keyboard.type('Please check this @Me');
      await p.getByRole('listbox', { name: 'Mention a member' }).waitFor();
      await p.keyboard.press('Enter');
      await Promise.all([
        p.waitForResponse((r) => r.request().method() === 'POST' && /comments/.test(r.url()), { timeout: 8000 }),
        p.getByRole('button', { name: 'Comment', exact: true }).click(),
      ]);
      await s.settle(2500);
      await p.getByRole('button', { name: 'Idea Space' }).click();
      await p.getByRole('heading', { name: 'No ideas here yet' }).waitFor();
      for (const t of ['Offline mode for the board', 'Keyboard shortcuts cheat sheet']) {
        await p.getByRole('button', { name: 'New idea' }).first().click();
        await p.getByRole('textbox', { name: 'Idea title' }).fill(t);
        await p.keyboard.press('Enter');
        await p.getByText(/^Added IDEA-\d+ to the Inbox/).waitFor();
      }
      await p.setViewportSize(SIZES[0]);
    });

    // ---------------------------------------------------------------- Appearance: both themes are offered
    await s.step('Appearance offers exactly two looks: Color and Black & white', async () => {
      await goBoard();
      await p.getByRole('button', { name: 'Settings' }).click();
      await openAppearance();
      const n = await p.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio').count();
      if (n !== 2) throw new Error(`expected 2 looks, found ${n}`);
    });

    const setTheme = async (theme) => {
      await goBoard();
      await p.getByRole('button', { name: 'Settings' }).click();
      await openAppearance();
      await p.getByRole('radio', { name: theme === 'bw' ? /^Black & white/ : /^Color/ }).click();
      await until(async () => (await p.evaluate(() => document.documentElement.getAttribute('data-theme'))) === theme, `theme ${theme}`);
    };

    for (const theme of THEMES) {
      await s.step(`switch to the ${theme} theme`, async () => { await setTheme(theme); });
      for (const size of SIZES) {
        const tag = `${theme} ${size.width}x${size.height}`;
        await s.step(`${tag}: board with tickets in several columns`, async () => {
          await p.setViewportSize(size);
          await goBoard();
          const controls = {
            'Search tickets': p.getByRole('textbox', { name: 'Search tickets' }),
            'New Ticket': p.getByRole('button', { name: 'New Ticket' }),
            'Settings': p.getByRole('button', { name: 'Settings' }),
            'Docs': p.getByRole('button', { name: 'Docs', exact: true }),
            'first card': card(p, 'ALP-1'),
          };
          // the columns scroll sideways inside their own container; the page itself must not
          await record('board', theme, size, { controls });
        });
        await s.step(`${tag}: ticket modal`, async () => {
          await p.setViewportSize(size);
          await goBoard();
          await openTicket(s, 'ALP-1');
          await record('ticket modal', theme, size, {
            controls: { Close: dlg().getByRole('button', { name: 'Close', exact: true }) },
          });
          await closeTicket(s);
        });
        await s.step(`${tag}: Docs tree and editor`, async () => {
          await p.setViewportSize(size);
          await goBoard();
          await openDocs(s);
          await p.getByRole('heading', { name: 'Handbook' }).first().waitFor();
          await record('docs', theme, size, {
            controls: {
              'Docs tree': p.getByRole('complementary', { name: /^Docs space/ }),
              'New page': p.getByRole('button', { name: 'New page' }).first(),
            },
          });
        });
        await s.step(`${tag}: Idea Space`, async () => {
          await p.setViewportSize(size);
          await goBoard();
          await p.getByRole('button', { name: 'Idea Space' }).click();
          await p.getByRole('button', { name: 'New idea' }).first().waitFor();
          await record('idea space', theme, size, {
            controls: { 'New idea': p.getByRole('button', { name: 'New idea' }).first() },
          });
        });
        await s.step(`${tag}: Settings`, async () => {
          await p.setViewportSize(size);
          await goBoard();
          await p.getByRole('button', { name: 'Settings' }).click();
          await openAppearance();
          await record('settings', theme, size, {
            controls: { 'Settings pages': p.getByRole('navigation', { name: 'Settings pages' }).or(p.getByRole('combobox')), 'Theme': p.getByRole('radiogroup', { name: 'Theme' }) },
          });
        });
        await s.step(`${tag}: notifications panel`, async () => {
          await p.setViewportSize(size);
          await goBoard();
          await bell().click();
          const centre = p.getByRole('dialog', { name: 'Notifications' });
          await centre.waitFor();
          await record('notifications', theme, size, {
            controls: { Close: centre.getByRole('button', { name: 'Close' }) },
          });
          await centre.getByRole('button', { name: 'Close' }).click();
        });
        await s.step(`${tag}: Members page`, async () => {
          await p.setViewportSize(size);
          await goBoard();
          await p.getByRole('button', { name: 'Members' }).first().click();
          await p.getByRole('heading', { name: 'Project Members' }).waitFor();
          await record('members', theme, size, {
            controls: {
              'Member name': p.getByPlaceholder('Member name…'),
              Add: p.getByRole('button', { name: 'Add', exact: true }),
              Close: p.getByRole('heading', { name: 'Project Members' }).locator('xpath=..').getByRole('button', { name: 'Close' }),
            },
          });
        });
      }
    }

    await s.step('back to the Color theme', async () => { await setTheme('default'); });

    await s.step('every text sample reaches WCAG AA, apart from the known faults', async () => {
      for (const k of Object.keys(KNOWN)) if (!seenKnown.has(k)) throw new Error(`the known fault "${k}" no longer shows: remove it from KNOWN`);
      for (const f of failures) console.log('42 AA ' + f);
      if (failures.length) throw new Error(`${failures.length} text samples below AA:\n${failures.join('\n')}`);
    });
  },
};
