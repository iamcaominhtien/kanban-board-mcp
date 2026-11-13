import fs from 'node:fs';
import { ensureProject, openDocs, newDocPage, publishDoc, setMarkdown } from '../lib/ui.mjs';

// The Docs page editor: slash menu, formatting toolbar, table, callout, math, code block, Find in page, export.
export default {
  name: 'Docs editor: slash menu, formatting, table, callout, math, code, find and replace, export',
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
      await p.getByRole('group', { name: 'Editor mode' }).getByRole('button', { name: 'Visual' }).waitFor();
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
      await p.getByRole('button', { name: 'Markdown', exact: true }).click();
      const src = p.getByRole('textbox', { name: 'Markdown source' });
      const md = await src.inputValue();
      s.note('markdown source before the formulas', md);
      if (!/\| Name/.test(md) && !/Name/.test(md)) throw new Error('the Markdown source lacks the table: ' + md.slice(0, 200));
      await setMarkdown(s, md.trimEnd() + '\n\nEuler said $e^{i\\pi}+1=0$ once.\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$\n');
      await p.getByRole('button', { name: 'Visual', exact: true }).click();
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
      await bar.getByText('0/0').waitFor();
      await bar.getByRole('textbox', { name: 'Find' }).fill('point');
      await bar.getByText('1/2').waitFor();
      await bar.getByRole('button', { name: 'Match case' }).click();
      await bar.getByRole('textbox', { name: 'Find' }).fill('POINT');
      await bar.getByText('0/0').waitFor();
      await bar.getByRole('button', { name: 'Match case' }).click();
      await bar.getByRole('textbox', { name: 'Find' }).fill('point');
      await bar.getByText('1/2').waitFor();
    });
    await s.step('Find and replace: replace one match, then the rest', async () => {
      const bar = p.getByRole('search', { name: 'Find in page' });
      await bar.getByRole('textbox', { name: 'Replace with' }).fill('item');
      await bar.getByRole('button', { name: 'Replace', exact: true }).click();
      await content().getByText('first item').or(content().getByText('second item')).first().waitFor();
      await bar.getByText('1/1').waitFor();
      await bar.getByRole('button', { name: 'Replace all' }).click();
      await p.getByText('Replaced 1 match').waitFor();
      await content().getByText('first item').waitFor();
      await content().getByText('second item').waitFor();
      await bar.getByRole('button', { name: 'Close' }).click();
      await bar.waitFor({ state: 'detached' });
      await saved();
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
  },
};
