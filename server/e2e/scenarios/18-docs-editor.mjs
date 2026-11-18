import fs from 'node:fs';
import { ensureProject, openDocs, newDocPage, publishDoc, setMarkdown, getMarkdown } from '../lib/ui.mjs';
import { makeFixtures, cleanFixtures } from '../lib/fixtures.mjs';

// The Docs page editor: slash menu, formatting ribbon (colour, highlight, alignment), table, callout, math, code
// block, Find and replace, Preview, export, and the Page settings panel (width, theme, Reset).
export default {
  name: 'Docs editor: slash menu, formatting, table, callout, math, code, find and replace, preview, export, page settings',
  async run(s) {
    const p = s.page;
    const content = () => p.getByRole('textbox', { name: 'Page content' });
    const toolbar = () => p.getByRole('toolbar', { name: 'Formatting' });
    const tb = (name) => toolbar().getByRole('button', { name, exact: true });
    const saved = async () => { await p.getByTestId('save-state').getByText(/^Saved/).waitFor(); await s.settle(); };
    // Types "/" and the filter, and picks the first block of the menu
    const slash = async (filter, optionName) => {
      await p.keyboard.type('/' + filter);
      const menu = p.getByRole('listbox', { name: 'Insert block' });
      await menu.waitFor();
      await menu.getByRole('option', { name: optionName }).first().waitFor();
      await p.keyboard.press('Enter');
      await menu.waitFor({ state: 'detached' });
    };

    await s.step('set up: a project, Docs, a new page Editor tour in the visual editor', async () => {
      await ensureProject(s);
      await openDocs(s);
      await newDocPage(s, 'Editor tour');
      await content().waitFor();
      await toolbar().waitFor();
      // Rich Docs: the page is edited as rich text only (the Visual / Markdown switch is gone)
      if (await p.getByRole('group', { name: 'Editor mode' }).count()) throw new Error('the editor still has a Markdown mode');
      // the empty line's hint reads on one line (it shared a class name with the reading page's header, a flex column)
      const hint = content().locator('.dk-placeholder');
      await hint.waitFor();
      const hb = await hint.boundingBox();
      if (!hb || hb.height > 30) throw new Error('the hint is not one line: ' + JSON.stringify(hb));
    });
    await s.step('slash menu: lists the blocks and filters them as you type', async () => {
      await content().click();
      await p.keyboard.type('/');
      const menu = p.getByRole('listbox', { name: 'Insert block' });
      await menu.waitFor();
      for (const n of ['Heading 1', 'Bulleted list', 'Code block', 'Table', 'Callout: Info', 'Table of contents']) {
        await menu.getByRole('option', { name: new RegExp(n) }).first().waitFor();
      }
      await p.keyboard.type('callout');
      await menu.getByRole('option', { name: /Callout: Warning/ }).waitFor();
      if (await menu.getByRole('option', { name: /Heading 1/ }).count()) throw new Error('the filter did not narrow the menu');
      await p.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      // the typed text stays; clear the line
      await p.keyboard.press('Control+a');
      await p.keyboard.press('Backspace');
    });
    await s.step('slash menu: Heading 1 turns the line into a heading', async () => {
      await slash('h1', /Heading 1/);
      await p.keyboard.type('Tour of the editor');
      await content().getByRole('heading', { name: 'Tour of the editor', level: 1 }).waitFor();
      await p.keyboard.press('Enter');
    });
    await s.step('toolbar: bold, italic, strikethrough, inline code and highlight, one line each', async () => {
      // a line is typed, selected with Shift+Home, and the toolbar button applies the mark to it
      const format = async (button, text, selector) => {
        if ((await tb(button).getAttribute('aria-pressed')) === 'true') await tb(button).click(); // a mark carried over from the line above
        await p.keyboard.type(text);
        await p.keyboard.press('Shift+Home');
        await tb(button).click();
        await content().locator(selector, { hasText: text }).waitFor();
        await tb(button).and(p.locator('[aria-pressed="true"]')).waitFor();
        await p.keyboard.press('End');
        await tb(button).click(); // off for what follows
        await p.keyboard.press('Enter');
      };
      await format('Bold', 'Bold line', 'strong');
      await format('Italic', 'Italic line', 'em');
      await format('Strikethrough', 'Struck line', 's, del');
      await format('Inline code', 'code line', 'code');
      await format('Highlight', 'Marked line', 'mark');
      await saved();
    });
    await s.step('toolbar: a bulleted list and a quote', async () => {
      await p.keyboard.press('End');
      await p.keyboard.press('Enter');
      await tb('Bulleted list').click();
      await p.keyboard.type('first point');
      await p.keyboard.press('Enter');
      await p.keyboard.type('second point');
      await content().getByRole('listitem').filter({ hasText: 'second point' }).waitFor();
      await p.keyboard.press('Enter');
      await p.keyboard.press('Enter'); // leaves the list
      await tb('Quote').click();
      await p.keyboard.type('A quoted line');
      await content().locator('blockquote', { hasText: 'A quoted line' }).waitFor();
      await p.keyboard.press('Enter');
      await p.keyboard.press('Enter');
      await saved();
    });
    await s.step('table: inserted from the toolbar, filled in, a row and a column added', async () => {
      await tb('Table').click();
      const table = content().locator('table');
      await table.waitFor();
      if ((await table.locator('tr').count()) !== 3) throw new Error('expected a table of 3 rows');
      await table.locator('th').first().click();
      await p.keyboard.type('Name');
      await p.keyboard.press('Tab');
      await p.keyboard.type('Role');
      await p.keyboard.press('Tab');
      await p.keyboard.type('Team');
      await p.keyboard.press('Tab');
      await p.keyboard.type('Ada');
      await p.keyboard.press('Tab');
      await p.keyboard.type('Engineer');
      await table.getByText('Ada', { exact: true }).waitFor();
      await p.getByRole('button', { name: 'Add row' }).click();
      await p.getByRole('button', { name: 'Add column' }).click();
      await p.waitForFunction(() => {
        const t = document.querySelector('[aria-label="Page content"] table');
        return t && t.rows.length === 4 && t.rows[0].cells.length === 4;
      });
      await saved();
    });
    await s.step('code block: from the slash menu with a language', async () => {
      await p.keyboard.press('Control+End');
      if (await p.evaluate(() => !!window.getSelection()?.anchorNode?.parentElement?.closest('td,th'))) {
        await p.keyboard.press('ArrowDown');
        await p.keyboard.press('ArrowDown');
        await p.keyboard.press('ArrowDown');
      }
      await slash('code', /Code block/);
      await p.keyboard.type('fn main() {}');
      const code = content().locator('pre code');
      await code.getByText('fn main() {}').waitFor();
      // the language in the block's header opens its settings, where the language is picked (Embeds 33)
      await content().locator('.dk-code-wrap').last().getByRole('button', { name: 'Code block settings' }).click();
      await p.getByTestId('code-settings').getByRole('combobox', { name: 'Code language' }).selectOption({ label: 'Rust' });
      await p.getByTestId('code-settings').getByRole('button', { name: 'Done' }).click();
      await content().locator('.dk-code-wrap[data-language="rust"]').waitFor();
      await saved();
    });
    await s.step('callout: from the slash menu, then its type changed to Warning', async () => {
      await content().locator('pre code').click();
      await p.keyboard.press('Control+End');
      await p.keyboard.press('ArrowDown'); // leaves the code block into a new paragraph
      await slash('callout', /Callout: Info/);
      await p.keyboard.type('Remember to publish.');
      const callout = content().locator('[data-callout]').first();
      await callout.getByText('Remember to publish.').waitFor();
      await callout.hover();
      await callout.getByTestId('callout-type').click();
      // Callout properties (Blocks board, H 42): the kinds are coloured chips
      const props = p.getByTestId('callout-props');
      await props.getByRole('radio', { name: 'Warning', exact: true }).click();
      await p.locator('[data-callout="warning"]').getByText('Remember to publish.').waitFor();
      await props.getByRole('radio', { name: 'Custom', exact: true }).click();
      await props.getByRole('radio', { name: 'Violet' }).waitFor();
      await props.getByRole('radio', { name: 'Bulb icon' }).click();
      await p.locator('[data-callout="custom"]').getByText('Remember to publish.').waitFor();
      await props.getByRole('button', { name: 'Done' }).click();
      await props.waitFor({ state: 'detached' });
      await saved();
    });
    await s.step('math: an inline formula and a display formula render with KaTeX', async () => {
      const md = await getMarkdown(s);
      s.note('markdown source before the formulas', md);
      if (!/\| Name/.test(md) && !/Name/.test(md)) throw new Error('the Markdown source lacks the table: ' + md.slice(0, 200));
      await setMarkdown(s, md.trimEnd() + '\n\nEuler said $e^{i\\pi}+1=0$ once.\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n');
      await content().waitFor();
      await content().locator('.katex').first().waitFor({ timeout: 10000 });
      await p.waitForFunction(() => document.querySelectorAll('[aria-label="Page content"] .katex').length >= 2);
      await content().locator('.dk-math-block .katex-display').waitFor();
      await content().locator('.dk-math-inline').waitFor();
    });
    await s.step('math: click the formula to edit it', async () => {
      await content().locator('.dk-math-inline [role="button"]').dispatchEvent('click');
      const box = content().getByRole('textbox', { name: 'LaTeX formula' });
      await box.waitFor();
      await box.fill('x^2');
      await p.keyboard.press('Enter');
      await box.waitFor({ state: 'detached' });
      await content().locator('.dk-math-inline .katex').getByText('x').first().waitFor();
      await saved();
    });
    await s.step('Find in page: counts matches in the editor and steps through them', async () => {
      await content().click();
      await p.keyboard.press('Control+f');
      const bar = p.getByRole('search', { name: 'Find in page' });
      await bar.waitFor();
      await bar.getByRole('textbox', { name: 'Find' }).fill('point');
      await bar.getByText('1 of 2').waitFor();
      await bar.getByRole('button', { name: 'Next match' }).click();
      await bar.getByText('2 of 2').waitFor();
      await bar.getByRole('textbox', { name: 'Find' }).press('Enter');
      await bar.getByText('1 of 2').waitFor();
      await bar.getByRole('textbox', { name: 'Find' }).fill('zzzz');
      await bar.getByText('No results').waitFor();
      await bar.getByRole('textbox', { name: 'Find' }).fill('point');
      await bar.getByText('1 of 2').waitFor();
      await bar.getByRole('button', { name: 'Match case' }).click();
      await bar.getByRole('textbox', { name: 'Find' }).fill('POINT');
      await bar.getByText('No results').waitFor();
      await bar.getByRole('button', { name: 'Match case' }).click();
      await bar.getByRole('textbox', { name: 'Find' }).fill('point');
      await bar.getByText('1 of 2').waitFor();
    });
    await s.step('Find and replace: replace one match, then the rest', async () => {
      const bar = p.getByRole('search', { name: 'Find in page' });
      // Ctrl+F finds; Ctrl+H shows the replace row
      if (await bar.getByRole('textbox', { name: 'Replace with' }).count()) throw new Error('Ctrl+F opened the replace row');
      await bar.getByRole('textbox', { name: 'Find' }).press('Control+h');
      await bar.getByRole('textbox', { name: 'Replace with' }).fill('item');
      await bar.getByRole('button', { name: 'Replace', exact: true }).click();
      await content().getByText('first item').or(content().getByText('second item')).first().waitFor();
      await bar.getByText('1 of 1').waitFor();
      await bar.getByRole('button', { name: 'Replace all' }).click();
      await bar.getByText('Replaced 1 match').waitFor();
      await bar.getByRole('button', { name: 'Undo' }).waitFor();
      await content().getByText('first item').waitFor();
      await content().getByText('second item').waitFor();
      await bar.getByRole('button', { name: 'Close' }).click();
      await bar.waitFor({ state: 'detached' });
      await saved();
    });
    await s.step('ribbon: a text colour by name, a highlight colour and the alignment of a paragraph', async () => {
      // the start of the line: the middle of it is the formula's node view, which takes the click
      // the click must leave the caret in that paragraph (a click that lands while the page still scrolls can leave it
      // in the code block above): click again until it is there
      const euler = content().locator('p', { hasText: /Euler said/ }).first();
      const inEuler = () =>
        p.evaluate(() => {
          const n = document.getSelection()?.anchorNode;
          const el = n && (n.nodeType === 1 ? n : n.parentElement);
          return !!el?.closest('p') && /Euler said/.test(el.closest('p').textContent);
        });
      for (let i = 0; i < 4 && !(await inEuler()); i++) await euler.click({ position: { x: 4, y: 8 } });
      if (!(await inEuler())) throw new Error('the caret is not in the Euler paragraph');
      await p.keyboard.press('End');
      await p.keyboard.press('Enter');
      await p.keyboard.type('Colour line');
      await p.keyboard.press('Shift+Home');
      await tb('Text colour').click();
      await p.getByRole('menu', { name: 'Text colour' }).getByRole('menuitemradio', { name: 'Green' }).click();
      // stored by name, drawn through the page's palette variable
      const green = content().locator('span[data-color="green"]', { hasText: 'Colour line' });
      await green.waitFor();
      if (!/var\(--rd-c-green/.test((await green.getAttribute('style')) ?? '')) throw new Error('the colour is not drawn by name');
      await tb('Highlight colours').click();
      await p.getByRole('menu', { name: 'Highlight' }).getByRole('menuitemradio', { name: 'Teal' }).click();
      await content().locator('mark[data-color="teal"]', { hasText: 'Colour line' }).waitFor();
      await tb('Align centre').click();
      await content().locator('p[data-text-align="center"]', { hasText: 'Colour line' }).waitFor();
      await tb('Align centre').and(p.locator('[aria-pressed="true"]')).waitFor();
      await p.keyboard.press('Control+Shift+R');
      await content().locator('p[data-text-align="right"]', { hasText: 'Colour line' }).waitFor();
      await p.getByTestId('editor-status').getByText(/Selected: 2 words/).waitFor();
      await saved();
    });
    await s.step('ribbon: Drop cap opens its panel (lines, position, colour, font); Ctrl K opens the link panel', async () => {
      // Editor board F 25: the drop cap is a panel, not a list of three heights
      await tb('Drop cap').click();
      const drop = p.getByTestId('dropcap-menu');
      await drop.getByRole('switch', { name: 'Drop cap' }).click();
      await drop.getByRole('radio', { name: '4' }).click();
      await drop.getByRole('radio', { name: 'Raised' }).click();
      await content().locator('p.dk-dropcap-4.dk-dropcap-raised', { hasText: 'Colour line' }).waitFor();
      await drop.getByRole('switch', { name: 'Drop cap' }).click();
      await p.waitForFunction(() => !document.querySelector('[aria-label="Page content"] p.dk-dropcap'));
      await p.keyboard.press('Escape');
      // F 30: the link panel shows the selected text and offers pages for what is typed; Cancel leaves no link
      await content().locator('p', { hasText: 'Colour line' }).click();
      await p.keyboard.press('Shift+Home');
      await p.keyboard.press('Control+k');
      const panel = p.getByTestId('link-panel');
      await panel.getByRole('textbox', { name: 'Link text' }).and(p.locator('[value="Colour line"]')).waitFor();
      await panel.getByRole('textbox', { name: 'Link URL' }).fill('editor');
      await panel.getByRole('option', { name: /Editor tour/ }).waitFor();
      await panel.getByRole('button', { name: 'Cancel' }).click();
      await panel.waitFor({ state: 'detached' });
      await saved();
    });
    await s.step('Find and replace from Ctrl+H: whole word, No results, Replace all keeps the colour', async () => {
      await p.keyboard.press('End');
      await p.keyboard.press('Control+h');
      const bar = p.getByRole('search', { name: 'Find in page' });
      await bar.waitFor();
      const find = bar.getByRole('textbox', { name: 'Find' });
      await find.fill('Colou');
      await bar.getByText('1 of 1').waitFor();
      await bar.getByRole('button', { name: 'Whole word' }).click();
      await bar.getByText('No results').waitFor();
      await find.fill('Colour');
      await bar.getByText('1 of 1').waitFor();
      await bar.getByRole('textbox', { name: 'Replace with' }).fill('Color');
      await bar.getByRole('button', { name: 'Replace all' }).click();
      await bar.getByText('Replaced 1 match').waitFor();
      await content().locator('span[data-color="green"]', { hasText: 'Color line' }).waitFor();
      await bar.getByRole('button', { name: 'Whole word' }).click(); // back off for the steps after
      await bar.getByRole('button', { name: 'Close' }).click();
      await bar.waitFor({ state: 'detached' });
      await saved();
    });
    await s.step('Preview shows the page as readers will see it, then back to editing with the text kept', async () => {
      const toggle = p.getByTestId('preview-toggle');
      await toggle.click();
      const preview = p.getByTestId('editor-preview');
      await preview.waitFor();
      await preview.getByRole('heading', { name: 'Editor tour', level: 1 }).waitFor();
      await preview.getByText('Remember to publish.').waitFor();
      await preview.getByRole('table').getByText('Engineer').waitFor();
      if (await content().isVisible()) throw new Error('the editor is still shown during Preview');
      if ((await toggle.getAttribute('aria-pressed')) !== 'true') throw new Error('Preview is not shown as on');
      await toggle.click();
      await preview.waitFor({ state: 'detached' });
      await content().getByText('Remember to publish.').waitFor();
    });
    await s.step('publish the page and read it: every block is there', async () => {
      await publishDoc(s, 'Editor tour');
      await p.getByText('Published · v1').waitFor();
      await p.getByRole('heading', { name: 'Tour of the editor', level: 1 }).first().waitFor();
      await p.locator('strong', { hasText: 'Bold line' }).first().waitFor();
      await p.locator('s, del', { hasText: 'Struck line' }).first().waitFor();
      await p.getByRole('table').getByText('Engineer').waitFor();
      await p.getByText('Remember to publish.').waitFor();
      await p.locator('.katex').first().waitFor();
      // the colour and the alignment set in the ribbon reach the reader
      await p.locator('p', { hasText: 'Color line' }).and(p.locator('[style*="text-align: right"]')).first().waitFor();
      await p.locator('[style*="--rd-c-green"]', { hasText: 'Color line' }).first().waitFor();
    });
    await s.step('Find in page right after publishing finds the matches without reloading', async () => {
      await p.keyboard.press('Control+f');
      const bar = p.getByRole('search', { name: 'Find in page' });
      await bar.waitFor();
      await bar.getByRole('textbox', { name: 'Find' }).fill('item');
      await bar.getByText('1/2').waitFor();
      await bar.getByRole('button', { name: 'Close' }).click();
      await bar.waitFor({ state: 'detached' });
    });
    await s.step('reload, open the page, Find in page works on the published page', async () => {
      await p.reload();
      await p.getByRole('complementary', { name: 'Project navigation' }).waitFor({ timeout: 20000 });
      await p.getByRole('button', { name: 'Docs', exact: true }).click();
      await p.getByRole('complementary', { name: /^Docs space/ }).waitFor();
      await p.getByRole('tree').getByRole('treeitem', { name: /Editor tour/ }).first().click();
      await p.getByRole('heading', { name: 'Editor tour', level: 1 }).waitFor();
      await p.getByText('Remember to publish.').waitFor();
      await p.keyboard.press('Control+f');
      const bar = p.getByRole('search', { name: 'Find in page' });
      await bar.waitFor();
      await bar.getByRole('textbox', { name: 'Find' }).fill('item');
      await bar.getByText('1/2').waitFor();
      await bar.getByRole('button', { name: 'Next match' }).click();
      await bar.getByText('2/2').waitFor();
      if (await bar.getByRole('textbox', { name: 'Replace with' }).count()) throw new Error('a published page must not offer Replace');
      await bar.getByRole('button', { name: 'Close' }).click();
      await bar.waitFor({ state: 'detached' });
    });
    // Export goes through the export dialog: the header's Export menu picks the format where there is room,
    // "Export…" in More opens it with the last format otherwise; the file downloads by itself when it is ready
    const exportAs = async (format, setUp) => {
      const exportButton = p.getByTestId('export-button');
      if (await exportButton.count()) {
        await exportButton.click();
        await p.getByTestId(`export-${format}`).click();
      } else {
        await p.getByRole('button', { name: 'Page actions' }).click();
        await p.getByRole('menuitem', { name: /Export…/ }).click();
      }
      const dialog = p.getByTestId('export-dialog');
      await dialog.waitFor();
      await dialog.getByTestId(`export-format-${format}`).click();
      if ((await dialog.getByTestId(`export-format-${format}`).getAttribute('aria-pressed')) !== 'true') throw new Error(`${format} is not chosen`);
      if (setUp) await setUp(dialog);
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 60000 }), dialog.getByTestId('export-go').click()]);
      await dialog.getByTestId('export-ready').waitFor();
      s.note(`${format} export file name`, dl.suggestedFilename());
      const file = fs.readFileSync(await dl.path());
      await dialog.getByTestId('export-done').click();
      await dialog.waitFor({ state: 'detached' });
      return { name: dl.suggestedFilename(), file };
    };
    await s.step('export the page as Markdown through the dialog and compare the file', async () => {
      const { name, file } = await exportAs('md', async (dialog) => {
        // pictures inline keep it one .md file
        await dialog.getByTestId('export-images-inline').click();
        if (!(await dialog.getByTestId('export-file-name').inputValue()).startsWith('Editor tour')) throw new Error('the file name does not start as the page title');
      });
      const text = file.toString('utf8');
      s.note('export content', text);
      if (!name.endsWith('.md')) throw new Error('not a .md file: ' + name);
      for (const part of ['# Editor tour', 'Tour of the editor', '**Bold line**', '*Italic line*', '~~Struck line~~', '`code line`', '==Marked line==', 'first item', 'second item', 'Engineer', 'Remember to publish.', '```', 'fn main() {}', '$$']) {
        if (!text.includes(part)) throw new Error(`the export lacks ${JSON.stringify(part)}:\n${text}`);
      }
    });
    await s.step('export the page as one HTML file with the plain look', async () => {
      const { name, file } = await exportAs('html', async (dialog) => {
        await dialog.getByTestId('export-layout-single').click();
        await dialog.getByTestId('export-look-plain').click();
      });
      const html = file.toString('utf8');
      if (!name.endsWith('.html')) throw new Error('not a .html file: ' + name);
      if (!/<html/i.test(html)) throw new Error('not an HTML page: ' + html.slice(0, 200));
      for (const part of ['Editor tour', 'Tour of the editor', 'Remember to publish.', 'Engineer']) {
        if (!html.includes(part)) throw new Error(`the HTML export lacks ${JSON.stringify(part)}`);
      }
    });
    await s.step('export the page as a PDF: Fit to content turns orientation and page numbers off', async () => {
      const { name, file } = await exportAs('pdf', async (dialog) => {
        await dialog.getByTestId('export-pagesize-fit').click();
        if (!(await dialog.getByTestId('export-orientation-landscape').isDisabled())) throw new Error('orientation is not off with Fit to content');
        if (!(await dialog.getByTestId('export-pagenumbers').isDisabled())) throw new Error('page numbers are not off with Fit to content');
        await dialog.getByTestId('export-pagesize-a4').click();
        // the name is checked as you type; the extension stays
        const nameBox = dialog.getByTestId('export-file-name');
        await nameBox.fill('Editor tour / draft?');
        await dialog.getByText('A file name cannot contain').waitFor();
        if (!(await dialog.getByTestId('export-go').isDisabled())) throw new Error('Export works with a bad file name');
        await nameBox.fill('editor-tour');
      });
      if (name !== 'editor-tour.pdf') throw new Error('the PDF is named ' + name);
      if (file.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('not a PDF: ' + file.subarray(0, 20).toString('latin1'));
    });
    await s.step('History lists the three exports, ready to download again', async () => {
      const exportButton = p.getByTestId('export-button');
      if (await exportButton.count()) {
        await exportButton.click();
        await p.getByTestId('export-md').click();
      } else {
        await p.getByRole('button', { name: 'Page actions' }).click();
        await p.getByRole('menuitem', { name: /Export…/ }).click();
      }
      const dialog = p.getByTestId('export-dialog');
      await dialog.getByTestId('export-tab-history').click();
      await dialog.getByTestId('export-history').waitFor();
      const rows = dialog.getByTestId('export-row');
      await rows.nth(2).waitFor();
      for (const n of ['editor-tour.pdf', '.html', '.md']) await dialog.getByTestId('export-row').filter({ hasText: n }).first().waitFor();
      if ((await dialog.locator('[data-testid="export-row"][data-state="ready"]').count()) < 3) throw new Error('the exports are not all ready');
      const [dl] = await Promise.all([p.waitForEvent('download'), rows.first().getByTestId('export-row-download-btn').click()]);
      s.note('downloaded again', dl.suggestedFilename());
      await p.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
    });
    await s.step('Copy as Markdown puts the page on the clipboard', async () => {
      await p.getByRole('button', { name: 'Page actions' }).click();
      await p.getByRole('menuitem', { name: /Copy as Markdown/ }).click();
      await p.getByText('Markdown copied').waitFor();
      const clip = await p.evaluate(() => navigator.clipboard.readText());
      if (!clip.includes('# Editor tour') || !clip.includes('Engineer')) throw new Error('clipboard: ' + clip.slice(0, 120));
    });
    await s.step('Page settings: Wide folds the tree to its rail, Sepia colours the page, both kept after a reload', async () => {
      const patched = () => p.waitForResponse((r) => /\/docs\/pages\/[^/]+\/settings$/.test(r.url()) && r.request().method() === 'PATCH');
      await p.getByRole('button', { name: 'Page actions' }).click();
      await p.getByRole('menuitem', { name: 'Page settings…' }).click();
      const panel = p.getByRole('complementary', { name: 'Page settings' });
      await panel.waitFor();
      await panel.getByText('Applies to this page only.').waitFor();
      // the page changes as you choose, before the server has answered
      let saved = patched();
      await panel.getByRole('radio', { name: /^Wide/ }).click();
      await p.locator('[data-page-width="wide"]').waitFor();
      await p.getByRole('complementary', { name: 'Docs space (collapsed)' }).waitFor();
      // (the outline folds to a button too, but only a page with two headings or more has an outline: this one has one)
      if ((await saved).status() !== 200) throw new Error('saving the width failed');
      await panel.getByRole('tab', { name: 'Colour' }).click();
      saved = patched();
      await panel.getByRole('radio', { name: /Sepia/ }).click();
      await p.locator('[data-page-bg="sepia"]').waitFor();
      if ((await saved).status() !== 200) throw new Error('saving the background failed');
      await panel.getByRole('button', { name: 'Done' }).click();
      await panel.waitFor({ state: 'detached' });
      await p.reload();
      await p.getByRole('complementary', { name: 'Project navigation' }).waitFor({ timeout: 20000 });
      await p.getByRole('button', { name: 'Docs', exact: true }).click();
      await p.getByRole('heading', { name: 'Editor tour', level: 1 }).waitFor();
      await p.locator('[data-page-width="wide"][data-page-bg="sepia"]').waitFor();
    });
    await s.step('Page settings: Reset puts the page back to its defaults', async () => {
      await p.getByRole('button', { name: 'Page actions' }).click();
      await p.getByRole('menuitem', { name: 'Page settings…' }).click();
      const panel = p.getByRole('complementary', { name: 'Page settings' });
      await panel.waitFor();
      const saved = p.waitForResponse((r) => /\/settings$/.test(r.url()) && r.request().method() === 'PATCH');
      await panel.getByRole('button', { name: 'Reset' }).click();
      await p.locator('[data-page-width="normal"][data-page-bg="white"]').waitFor();
      if ((await saved).status() !== 200) throw new Error('Reset was not saved');
      await p.getByRole('complementary', { name: 'Docs space', exact: true }).waitFor();
      await panel.getByRole('button', { name: 'Close page settings' }).click();
      await panel.waitFor({ state: 'detached' });
    });

    await s.step('Page settings: a drop cap, justified text and a large right-aligned title reach the page (Start 12, 15)', async () => {
      await p.getByRole('button', { name: 'Page actions' }).click();
      await p.getByRole('menuitem', { name: 'Page settings…' }).click();
      const panel = p.getByRole('complementary', { name: 'Page settings' });
      await panel.waitFor();
      await panel.getByRole('tab', { name: 'Text' }).click();
      await panel.getByTestId('ps-drop-cap').click();
      await panel.getByTestId('ps-text-align-justify').click();
      await p.locator('.dk-paged.dk-page-dropcap.dk-ta-justify').first().waitFor();
      await panel.getByRole('tab', { name: 'Header' }).click();
      await panel.getByTestId('ps-title-size-large').click();
      await panel.getByTestId('ps-title-align-right').click();
      await p.locator('.dk-ph-right[data-title-size="large"]').first().waitFor();
      const saved = p.waitForResponse((r) => /\/settings$/.test(r.url()) && r.request().method() === 'PATCH');
      await panel.getByRole('button', { name: 'Reset' }).click();
      if ((await saved).status() !== 200) throw new Error('Reset was not saved');
      await p.locator('.dk-ph-left[data-title-size="standard"]').first().waitFor();
      await panel.getByRole('button', { name: 'Close page settings' }).click();
      await panel.waitFor({ state: 'detached' });
    });

    // Rich Docs phase 4: blocks and their properties (images, tables, columns, callouts), on a page of their own
    const fx = makeFixtures();
    // the caret at the end of the page, in its last paragraph: a click in the middle of the page can land on an
    // embed, and typing over a selected embed replaces it
    const atEnd = async () => {
      await content().locator(':scope > p').last().click();
      await p.keyboard.press('Control+End');
    };
    const insert = async (filter) => {
      await p.keyboard.type('/' + filter);
      const menu = p.getByRole('listbox', { name: 'Insert block' });
      await menu.waitFor();
      await p.keyboard.press('Enter');
    };
    await s.step('blocks: a new page Blocks tour, the Insert catalog with its groups', async () => {
      await newDocPage(s, 'Blocks tour');
      await content().click();
      await p.keyboard.type('/');
      const menu = p.getByRole('listbox', { name: 'Insert block' });
      await menu.waitFor();
      for (const g of ['Text', 'Lists', 'Media', 'Tables & layout', 'Embeds', 'Link to']) await menu.getByRole('tab', { name: g }).waitFor();
      await menu.getByRole('tab', { name: 'Tables & layout' }).click();
      await menu.getByRole('option', { name: /Columns/ }).first().waitFor();
      if (await menu.getByRole('option', { name: /Heading 1/ }).count()) throw new Error('the group did not narrow the catalog');
      await p.keyboard.press('Escape');
      await menu.waitFor({ state: 'detached' });
      await p.keyboard.press('Backspace');
    });
    await s.step('image: uploaded from the Insert image dialog, floated right at 50 %, alt text set', async () => {
      await insert('image');
      const dlg = p.getByRole('dialog', { name: 'Insert image' });
      await dlg.waitFor();
      await dlg.getByText('PNG, JPG, GIF, WebP or SVG, up to 10 MB.', { exact: false }).waitFor();
      await dlg.locator('input[type="file"]').setInputFiles(fx.png);
      await dlg.waitFor({ state: 'detached' });
      const img = content().getByTestId('docs-image').first();
      await img.locator('img[src*="/uploads/"]').waitFor({ timeout: 15000 });
      // a new picture is selected already; the size label covers a small one, so the click is forced
      await img.locator('img').click({ force: true });
      const bar = p.getByRole('toolbar', { name: 'Image' });
      await bar.waitFor();
      await bar.getByRole('button', { name: 'Float right' }).click();
      await content().locator('.dk-img-floatRight').waitFor();
      await bar.getByRole('button', { name: 'Width 50%' }).click();
      await p.waitForFunction(() => document.querySelector('[aria-label="Page content"] .dk-img-floatRight')?.getAttribute('style')?.includes('width:50%'));
      await bar.getByRole('button', { name: 'Alt text' }).click();
      const props = p.getByTestId('image-props');
      await props.waitFor();
      await props.getByRole('textbox', { name: 'Alt text' }).fill('A test pattern');
      await props.getByRole('button', { name: 'Done' }).click();
      await props.waitFor({ state: 'detached' });
      await saved();
    });
    await s.step('table: inserted with the size picker, two cells merged, then split again', async () => {
      // the focus is in the image properties that just closed: back into the text first
      await content().locator('p').last().click();
      await p.keyboard.press('Control+End');
      await p.keyboard.press('Enter');
      await insert('table');
      await p.getByTestId('table-size').waitFor();
      await p.getByText('3 columns x 3 rows').waitFor();
      await p.keyboard.press('ArrowRight');
      await p.getByText('4 columns x 3 rows').waitFor();
      await p.keyboard.press('Enter');
      const table = content().locator('table').first();
      await table.waitFor();
      if ((await table.locator('tr').first().locator('th,td').count()) !== 4) throw new Error('expected 4 columns');
      await table.locator('tr').nth(1).locator('td').first().click();
      await p.keyboard.type('Merged');
      // at the end of the cell, Shift+→ selects it and the next one
      await p.keyboard.press('Shift+ArrowRight');
      const merge = p.getByTestId('merge-cells');
      await merge.waitFor();
      // Blocks board F 28: the cell bar is white, the selected cells green with a 2 px frame, and the page itself
      // takes no focus ring (it drew a green frame round the whole page)
      const look = await p.evaluate(() => {
        const bar = getComputedStyle(document.querySelector('[data-testid="cell-toolbar"]'));
        const cell = getComputedStyle(document.querySelector('[aria-label="Page content"] .selectedCell'));
        const pm = getComputedStyle(document.querySelector('[aria-label="Page content"]'));
        return { bar: bar.backgroundColor, outline: cell.outlineWidth + ' ' + cell.outlineColor, page: pm.outlineStyle };
      });
      if (look.bar !== 'rgb(255, 255, 255)' || look.outline !== '2px rgb(46, 111, 64)' || look.page !== 'none')
        throw new Error('table selection look: ' + JSON.stringify(look));
      await merge.click();
      await content().locator('td[colspan="2"]').waitFor();
      await p.getByTestId('split-cell').click();
      await p.waitForFunction(() => !document.querySelector('[aria-label="Page content"] td[colspan="2"]'));
      // Table properties (F 31): banded rows reach the table at once (a new style used to show only after a reload)
      await p.getByRole('button', { name: 'Table properties' }).click();
      const props = p.getByTestId('table-props');
      await props.getByRole('switch', { name: 'Banded rows' }).click({ force: true });
      await props.getByRole('radiogroup', { name: 'Borders' }).getByRole('radio', { name: 'Rows' }).click();
      await content().locator('table[data-banded="true"][data-borders="rows"]').waitFor();
      await props.getByRole('button', { name: 'Done' }).click();
      await props.waitFor({ state: 'detached' });
      await saved();
    });
    await s.step('columns: two columns, the ratio set to 33 / 67 from the columns toolbar', async () => {
      await p.keyboard.press('Control+End');
      if (await p.evaluate(() => !!window.getSelection()?.anchorNode?.parentElement?.closest('td,th'))) {
        for (let i = 0; i < 4; i += 1) await p.keyboard.press('ArrowDown');
      }
      await insert('columns');
      const cols = content().getByTestId('docs-columns').last();
      await cols.waitFor();
      if ((await cols.locator('[data-rd-node="column"]').count()) !== 2) throw new Error('expected two columns');
      await p.keyboard.type('Left side');
      await p.getByRole('toolbar', { name: 'Columns' }).getByRole('button', { name: '33 / 67' }).click();
      await p.waitForFunction(() =>
        [...document.querySelectorAll('[aria-label="Page content"] .dk-colsv')].some((c) => c.style.getPropertyValue('--dk-cols').includes('2fr')),
      );
      await saved();
    });
    await s.step('callout: Danger from the catalog, then made Custom with its own colour and a left bar', async () => {
      await p.keyboard.press('Control+End');
      await p.keyboard.press('ArrowDown');
      await insert('danger');
      await p.keyboard.type('Deleting a project cannot be undone.');
      const callout = content().locator('[data-callout="danger"]').first();
      await callout.getByText('Deleting a project cannot be undone.').waitFor();
      await callout.hover();
      await callout.getByTestId('callout-type').click();
      await p.getByTestId('callout-props').getByRole('radio', { name: 'Custom', exact: true }).click();
      const custom = content().locator('[data-callout="custom"]').first();
      await custom.waitFor();
      await p.getByRole('radiogroup', { name: 'Colour' }).getByRole('radio', { name: 'Blue' }).click();
      await p.getByRole('radiogroup', { name: 'Style' }).getByRole('radio', { name: 'Left bar' }).click();
      await content().locator('[data-callout="custom"][data-callout-style="bar"]').waitFor();
      await saved();
    });
    await s.step('Preview shows the blocks as readers will see them', async () => {
      const toggle = p.getByTestId('preview-toggle');
      await toggle.click();
      const preview = p.getByTestId('editor-preview');
      await preview.waitFor();
      await preview.locator('.dk-img-floatRight img[alt="A test pattern"]').waitFor();
      await preview.locator('.dk-columns .dk-column').first().waitFor();
      await preview.locator('[data-callout="custom"][data-callout-style="bar"]').waitFor();
      if ((await preview.locator('table tr').first().locator('th,td').count()) !== 4) throw new Error('the table lost a column');
      await toggle.click();
      await preview.waitFor({ state: 'detached' });
      cleanFixtures(fx);
    });

    // Rich Docs phase 5: embeds and attachments (HTML in a sandbox, code options, files, video, links, references)
    const fx5 = makeFixtures();
    /** Every frame of an HTML embed: never the board's origin, top navigation or pop-ups. */
    const checkSandbox = async (root) => {
      for (const f of await root.locator('.dk-html-embed iframe').all()) {
        const sb = await f.getAttribute('sandbox');
        if (sb === null || /allow-same-origin|allow-top-navigation|allow-popups/.test(sb)) throw new Error(`unsafe sandbox: ${sb}`);
      }
    };
    await s.step('embeds: a new page Embeds tour; an HTML embed opens on its Code tab and previews in a sandbox', async () => {
      await newDocPage(s, 'Embeds tour');
      await content().click();
      await insert('html');
      const code = p.getByRole('textbox', { name: 'HTML code' });
      await code.waitFor();
      await code.fill('<div class="plans"><h3>Team</h3><p>$8 /user</p></div>');
      const embed = content().locator('.dk-html-embed').first();
      await embed.getByText('Runs in a sandbox: no access to this board.').waitFor();
      await p.waitForFunction(() => document.querySelector('.dk-html-embed iframe')?.getAttribute('srcdoc')?.includes('$8 /user'));
      if ((await embed.locator('iframe').getAttribute('sandbox')) !== '') throw new Error('a frame without scripts must allow nothing');
      await checkSandbox(content());
      await embed.getByRole('button', { name: 'What is blocked?' }).click();
      const sheet = p.getByTestId('sandbox-sheet');
      await sheet.getByText('Network requests from scripts').waitFor();
      await sheet.getByRole('button', { name: 'Close' }).click();
      await sheet.waitFor({ state: 'detached' });
      await saved();
    });
    await s.step('HTML embed: scripts run only after Run it, and saving says what was cleaned out', async () => {
      const embed = content().locator('.dk-html-embed').first();
      // Run scripts sits in the Embed size popover, opened from the block's header
      await embed.getByRole('button', { name: 'Embed size' }).click();
      const size = p.getByTestId('html-embed-size');
      await size.getByRole('switch', { name: 'Run scripts' }).check();
      await size.getByRole('button', { name: 'Done' }).click();
      await size.waitFor({ state: 'detached' });
      await p.getByRole('textbox', { name: 'HTML code' }).fill('<div onclick="track()" id="t">Team</div>\n<script>document.getElementById("t").textContent = "Ran"</script>');
      const run = embed.getByRole('button', { name: 'Run it' });
      await run.waitFor();
      if ((await embed.locator('iframe').getAttribute('sandbox')) !== '') throw new Error('scripts ran before Run it');
      await run.click();
      await p.waitForFunction(() => document.querySelector('.dk-html-embed iframe')?.getAttribute('sandbox') === 'allow-scripts');
      await checkSandbox(content());
      await saved();
      // the server removes the onclick attribute on save; the author is told, and the line is crossed out
      const note = embed.getByTestId('html-embed-removed');
      await note.getByText(/Saved\. 1 thing was removed/).waitFor();
      await note.getByText(/an onclick attribute/).waitFor();
      await embed.locator('.dk-ca-gutter .dk-ca-x').first().waitFor();
      await p.keyboard.press('Control+End');
    });
    await s.step('code block: file name, line numbers, a highlighted line and the light theme from its settings', async () => {
      await atEnd();
      await p.keyboard.press('Enter');
      await insert('code');
      await p.keyboard.type('def rotate_token(user, old):\n    return issue_token(user)');
      const block = content().locator('.dk-code-wrap').last();
      await block.getByRole('textbox', { name: 'File name' }).fill('tokens.py');
      await block.getByRole('button', { name: 'Code block settings' }).click();
      const panel = p.getByTestId('code-settings');
      await panel.getByRole('switch', { name: /Line numbers/ }).check();
      await panel.getByRole('textbox', { name: 'Highlight lines' }).fill('2');
      await panel.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Light' }).click();
      await panel.getByRole('button', { name: 'Done' }).click();
      await content().locator('.dk-code-wrap.dk-cv-light .dk-cv-edit-gutter').waitFor();
      await content().locator('.dk-code-wrap .dk-cv-edit-back .dk-cv-hl').waitFor();
      await saved();
    });
    await s.step('Focus mode: Ctrl Shift F covers the whole window, over the side bar; Esc leaves (Editor 56)', async () => {
      await content().locator('pre code').last().click();
      await p.keyboard.press('Control+Shift+F');
      const root = p.locator('.dk-editor-root.dk-focus-mode');
      await root.waitFor();
      // an inline position: relative used to keep it inside its pane, with the app's bars around it
      const box = await root.boundingBox();
      const vp = p.viewportSize();
      if (!box || box.x > 0 || box.y > 0 || box.width < vp.width) throw new Error(`Focus mode leaves the app around it: ${JSON.stringify(box)}`);
      await p.getByTestId('leave-focus').waitFor();
      await p.getByTestId('status-typewriter').waitFor();
      await p.keyboard.press('Escape');
      await root.waitFor({ state: 'detached' });
    });
    await s.step('file: a CSV attached as a file card, shown as a preview with its rows', async () => {
      await p.keyboard.press('Control+End');
      await p.keyboard.press('ArrowDown');
      await p.getByTestId('docs-attach-input').setInputFiles(fx5.previews.csv);
      const card = content().getByTestId('file-block').filter({ hasText: 'people.csv' });
      await card.locator('.dk-fc-name').waitFor();
      await card.getByRole('button', { name: 'More' }).click();
      await p.getByRole('menuitem', { name: 'Show as preview' }).click();
      const sheet = card.getByTestId('file-sheet-preview');
      await sheet.getByText('Ada').waitFor();
      await saved();
    });
    await s.step('video: by address; a poster and Play, and nothing plays before Play', async () => {
      await atEnd();
      await p.keyboard.press('Enter');
      await insert('video');
      const dlg = p.getByRole('dialog', { name: 'Insert video' });
      await dlg.getByText('Video is never played automatically.').waitFor();
      await dlg.getByRole('tab', { name: 'Link' }).click();
      await dlg.getByLabel('Video address').fill('https://cdn.example.com/demo.mp4');
      await dlg.getByText('demo.mp4').waitFor();
      await dlg.getByRole('button', { name: 'Insert video' }).click();
      const video = content().getByTestId('video-block').last();
      // only the metadata loads (the length, the first frame): an address the test machine cannot reach says so at
      // once instead of showing Play
      await video.getByRole('button', { name: /^Play/ }).or(video.getByText('This video could not be played')).first().waitFor();
      const playing = await video.locator('video').evaluateAll((vs) => vs.some((v) => !v.paused || v.autoplay || v.controls));
      if (playing) throw new Error('the video started, or showed its player, before Play');
      await saved();
    });
    await s.step('link: a pasted address on an empty line asks what it becomes; Link card makes a card', async () => {
      await atEnd();
      await p.keyboard.press('Enter');
      await p.evaluate(() => {
        const dt = new DataTransfer();
        dt.setData('text/plain', 'https://intranet.example.invalid/plans/q4');
        document.querySelector('[aria-label="Page content"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      });
      const menu = p.getByTestId('paste-link-menu');
      await menu.getByText('Esc keeps the plain link').waitFor();
      await menu.getByRole('menuitem', { name: /Link card/ }).click();
      // the server cannot read this address: the card keeps the address and says so
      await content().getByTestId('link-embed').getByText('Could not read this link. It may need a login.').waitFor();
      await saved();
    });
    await s.step('references: a page chip on its own line shown as a card, then back as a chip', async () => {
      await atEnd();
      await p.keyboard.press('Enter');
      await p.keyboard.type('[[Editor tour]]');
      await content().locator('.dk-chip-page').last().waitFor();
      const line = content().locator('p').filter({ has: p.locator('.dk-chip-page') }).last();
      await line.hover();
      await p.getByRole('button', { name: 'Drag to move' }).click();
      await p.getByTestId('block-menu').getByRole('menuitem', { name: 'Show as card' }).click();
      const card = content().getByTestId('page-card');
      await card.getByText('Editor tour').first().waitFor();
      await card.getByRole('button', { name: 'Show as chip' }).click();
      await card.waitFor({ state: 'detached' });
      await saved();
    });
    await s.step('Preview: the embeds read as readers will see them (sandboxed frame, poster, card, preview)', async () => {
      const toggle = p.getByTestId('preview-toggle');
      await toggle.click();
      const preview = p.getByTestId('editor-preview');
      await preview.waitFor();
      await preview.getByTestId('html-embed').getByRole('button', { name: 'View source' }).waitFor();
      await checkSandbox(preview);
      await preview.getByRole('button', { name: 'Run it' }).waitFor();
      await preview.locator('[data-testid="code-view"].dk-cv-light').getByText('tokens.py').waitFor();
      await preview.getByTestId('video-poster').or(preview.getByText('This video could not be played')).first().waitFor();
      const started = await preview.locator('video').evaluateAll((vs) => vs.some((v) => !v.paused || v.autoplay || v.controls));
      if (started) throw new Error('the reader started the video, or showed its player, before Play');
      await preview.getByTestId('link-unread').waitFor();
      await preview.getByTestId('file-sheet-preview').getByText('Ada').waitFor();
      await toggle.click();
      await preview.waitFor({ state: 'detached' });
      cleanFixtures(fx5);
    });

    // Touch frames of the Rich Docs boards (Editor 2, 6-10, 18; Blocks 59, 63; Embeds 10): the same page at the real
    // tablet (820) and phone (390) widths, checked by the sizes the boards give (44 px targets and the like).
    const near = (v, want, what) => {
      if (Math.abs(v - want) > 1)
        throw new Error(`${what}: ${v} px, the board says ${want}`);
    };
    const bbox = async (loc) => {
      const b = await loc.boundingBox();
      if (!b) throw new Error("no box for " + loc);
      return b;
    };
    await s.step(
      "tablet 820: the strip has 44 px buttons; Insert opens a 660 px palette with 44 px chips and 48 px rows",
      async () => {
        await p.setViewportSize({ width: 820, height: 1180 });
        const strip = p.locator(".dk-ribbon-strip");
        await strip.waitFor();
        near((await bbox(strip)).height, 52, "strip height");
        near(
          (await bbox(strip.getByRole("button", { name: "Bold", exact: true })))
            .height,
          44,
          "strip button",
        );
        await content().locator("p").last().click();
        await strip.getByTestId("ribbon-insert").click();
        const pal = p.getByRole("listbox", { name: "Insert block" });
        await pal.waitFor();
        near((await bbox(pal)).width, 660, "palette width");
        near(
          (await bbox(pal.getByRole("tab", { name: "All" }))).height,
          44,
          "group chip",
        );
        near(
          (await bbox(pal.locator(".dk-cat-row").first())).height,
          48,
          "palette row",
        );
        await pal.getByRole("button", { name: "Close" }).click();
        await pal.waitFor({ state: "detached" });
      },
    );
    await s.step(
      "phone 390: eight 44 px buttons over the keyboard; Aa, More and Text colour open their sheets",
      async () => {
        await p.setViewportSize({ width: 390, height: 844 });
        const bar = p.getByTestId("phone-bar");
        await bar.waitFor();
        near((await bbox(bar)).height, 52, "phone bar");
        const buttons = bar.getByRole("button");
        if ((await buttons.count()) !== 8)
          throw new Error("the phone bar should hold eight buttons");
        near((await bbox(buttons.first())).width, 44, "phone bar button");
        await content().locator("p").last().click();
        await p.getByTestId("phone-format").click();
        const fmt = p.getByTestId("phone-sheet-format");
        await fmt.getByRole("menuitemradio", { name: "Body" }).waitFor();
        near(
          (await bbox(fmt.getByRole("menuitemradio", { name: "Body" }))).height,
          40,
          "style chip",
        );
        near(
          (
            await bbox(
              fmt
                .getByRole("group", { name: "Character" })
                .getByRole("button", { name: "Bold" }),
            )
          ).height,
          44,
          "mark button",
        );
        await fmt.getByRole("group", { name: "Alignment" }).waitFor();
        await fmt.getByRole("group", { name: "Lists and indent" }).waitFor();
        await fmt.getByRole("button", { name: "Close" }).click();
        await fmt.waitFor({ state: "detached" });
        await p.getByTestId("phone-more").click();
        const more = p.getByTestId("phone-sheet-more");
        const find = more.getByRole("menuitem", { name: "Find and replace" });
        await find.waitFor();
        near((await bbox(find)).height, 44, "More row");
        await more.getByRole("menuitem", { name: "Indent" }).waitFor();
        await more.getByRole("button", { name: "Close" }).click();
        await more.waitFor({ state: "detached" });
        await bar.getByRole("button", { name: "Text colour" }).click();
        const colour = p.getByTestId("phone-sheet-color");
        await colour.getByText("Automatic").waitFor();
        near(
          (await bbox(colour.locator(".dk-cp-dot").first())).width,
          36,
          "colour swatch",
        );
        await colour.getByRole("button", { name: "Close" }).click();
        await colour.waitFor({ state: "detached" });
      },
    );
    await s.step(
      "phone: Insert is a sheet with a 44 px search and 84 px tiles four across",
      async () => {
        await p
          .getByTestId("phone-bar")
          .getByRole("button", { name: "Insert" })
          .click();
        const sheet = p.getByRole("listbox", { name: "Insert block" });
        await sheet.waitFor();
        near(
          (
            await bbox(
              sheet
                .getByRole("searchbox", { name: "Search blocks" })
                .locator("xpath=.."),
            )
          ).height,
          44,
          "search",
        );
        const cells = sheet.locator(".dk-cat-cell");
        near((await bbox(cells.first())).height, 84, "tile");
        const y = async (i) => (await bbox(cells.nth(i))).y;
        if ((await y(3)) !== (await y(0)) || (await y(4)) === (await y(0)))
          throw new Error("the tiles are not four across");
        await p.mouse.click(195, 60);
        await sheet.waitFor({ state: "detached" });
      },
    );
    await s.step(
      "phone: the HTML embed has no footer; Edit code and View source are 44 px under the card",
      async () => {
        const embed = content().getByTestId("html-embed");
        const under = embed.locator(".dk-emb-under");
        await under.scrollIntoViewIfNeeded();
        const card = await bbox(embed.locator(".dk-emb").first());
        const edit = await bbox(
          under.getByRole("button", { name: "Edit code" }),
        );
        near(edit.height, 44, "Edit code");
        near(edit.y, card.y + card.height + 10, "Edit code under the card");
        await under.getByRole("button", { name: "View source" }).waitFor();
        if (await embed.locator(".dk-emb-foot").isVisible())
          throw new Error("the phone card still shows its footer");
        // the phone header (Editor board, frame 3): back and Preview are 44 px
        near((await bbox(p.getByTestId("edit-back"))).width, 44, "back button");
        near((await bbox(p.getByTestId("preview-toggle-head"))).width, 44, "Preview button");
        await p.setViewportSize({ width: 1440, height: 900 });
        await toolbar().waitFor();
      },
    );
  },
};
