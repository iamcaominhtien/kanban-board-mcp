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
    const saved = async () => { await p.getByText(/^Saved/).waitFor(); await s.settle(); };
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
      await content().getByRole('combobox', { name: 'Code language' }).selectOption({ label: 'Rust' });
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
      await p.getByRole('menuitem', { name: 'Warning' }).click();
      await p.locator('[data-callout="warning"]').getByText('Remember to publish.').waitFor();
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
      await bar.getByText('1/2').waitFor();
      await bar.getByRole('button', { name: 'Next match' }).click();
      await bar.getByText('2/2').waitFor();
      await bar.getByRole('textbox', { name: 'Find' }).press('Enter');
      await bar.getByText('1/2').waitFor();
      await bar.getByRole('textbox', { name: 'Find' }).fill('zzzz');
      await bar.getByText('No results').waitFor();
      await bar.getByRole('textbox', { name: 'Find' }).fill('point');
      await bar.getByText('1/2').waitFor();
      await bar.getByRole('button', { name: 'Match case' }).click();
      await bar.getByRole('textbox', { name: 'Find' }).fill('POINT');
      await bar.getByText('No results').waitFor();
      await bar.getByRole('button', { name: 'Match case' }).click();
      await bar.getByRole('textbox', { name: 'Find' }).fill('point');
      await bar.getByText('1/2').waitFor();
    });
    await s.step('Find and replace: replace one match, then the rest', async () => {
      const bar = p.getByRole('search', { name: 'Find in page' });
      // Ctrl+F finds; Ctrl+H shows the replace row
      if (await bar.getByRole('textbox', { name: 'Replace with' }).count()) throw new Error('Ctrl+F opened the replace row');
      await bar.getByRole('textbox', { name: 'Find' }).press('Control+h');
      await bar.getByRole('textbox', { name: 'Replace with' }).fill('item');
      await bar.getByRole('button', { name: 'Replace', exact: true }).click();
      await content().getByText('first item').or(content().getByText('second item')).first().waitFor();
      await bar.getByText('1/1').waitFor();
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
      await content().locator('p', { hasText: /Euler said/ }).first().click({ position: { x: 4, y: 8 } });
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
    await s.step('Find and replace from Ctrl+H: whole word, No results, Replace all keeps the colour', async () => {
      await p.keyboard.press('End');
      await p.keyboard.press('Control+h');
      const bar = p.getByRole('search', { name: 'Find in page' });
      await bar.waitFor();
      const find = bar.getByRole('textbox', { name: 'Find' });
      await find.fill('Colou');
      await bar.getByText('1/1').waitFor();
      await bar.getByRole('button', { name: 'Whole word' }).click();
      await bar.getByText('No results').waitFor();
      await find.fill('Colour');
      await bar.getByText('1/1').waitFor();
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
    await s.step('export the page as Markdown and compare the file', async () => {
      await p.getByRole('button', { name: 'Page actions' }).click();
      const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('menuitem', { name: /Export as Markdown/ }).click()]);
      s.note('export file name', dl.suggestedFilename());
      const text = fs.readFileSync(await dl.path(), 'utf8');
      s.note('export content', text);
      if (!dl.suggestedFilename().endsWith('.md')) throw new Error('not a .md file: ' + dl.suggestedFilename());
      for (const part of ['# Editor tour', 'Tour of the editor', '**Bold line**', '*Italic line*', '~~Struck line~~', '`code line`', '==Marked line==', 'first item', 'second item', 'Engineer', 'Remember to publish.', '```', 'fn main() {}', '$$']) {
        if (!text.includes(part)) throw new Error(`the export lacks ${JSON.stringify(part)}:\n${text}`);
      }
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
      await p.getByTestId('toc-button').waitFor();
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

    // Rich Docs phase 4: blocks and their properties (images, tables, columns, callouts), on a page of their own
    const fx = makeFixtures();
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
      await merge.click();
      await content().locator('td[colspan="2"]').waitFor();
      await p.getByTestId('split-cell').click();
      await p.waitForFunction(() => !document.querySelector('[aria-label="Page content"] td[colspan="2"]'));
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
      await p.getByRole('menuitem', { name: 'Custom' }).click();
      const custom = content().locator('[data-callout="custom"]').first();
      await custom.waitFor();
      await p.getByRole('radiogroup', { name: 'Colour' }).getByRole('radio', { name: 'Teal' }).click();
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
  },
};
