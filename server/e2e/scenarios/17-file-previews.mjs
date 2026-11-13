import { ensureProject, createTicket, openTicket } from '../lib/ui.mjs';
import fs from 'node:fs';
import { makeFixtures, cleanFixtures, zipStored } from '../lib/fixtures.mjs';

// Local helper: the shared xlsx() fixture writes cells without their A1 references, which the reader does not place
// (it shows an empty grid). This workbook gives every cell its reference.
function xlsxWithRefs(rows) {
  const CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const col = (i) => String.fromCharCode(65 + i);
  const cell = (v, r, c) => (typeof v === 'number' ? `<c r="${col(c)}${r}"><v>${v}</v></c>` : `<c r="${col(c)}${r}" t="inlineStr"><is><t>${v}</t></is></c>`);
  const sheet = rows.map((row, i) => `<row r="${i + 1}">${row.map((v, c) => cell(v, i + 1, c)).join('')}</row>`).join('');
  return zipStored([
    ['[Content_Types].xml', `${CT}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ['_rels/.rels', `${CT}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${CT}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${CT}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ['xl/worksheets/sheet1.xml', `${CT}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheet}</sheetData></worksheet>`],
  ]);
}

// Every kind of attachment opens in the preview viewer with the reader of its type.
export default {
  name: 'File previews: attach each file type to a ticket and read it in the viewer',
  async run(s) {
    const p = s.page;
    const fx = makeFixtures();
    const pv = fx.previews;
    fs.writeFileSync(pv.xlsx, xlsxWithRefs([['Item', 'Cost'], ['Hosting', 42]]));
    const dlg = () => p.getByRole('dialog', { name: /^Ticket / });
    const viewer = () => p.getByRole('dialog', { name: /^Preview of / });
    const chip = (name) => dlg().locator(`[title="Click to preview ${name}"]`);
    // open the preview of an attachment of the ticket; resolves with the viewer
    const openPreview = async (name) => {
      await chip(name).scrollIntoViewIfNeeded();
      await chip(name).click();
      const v = p.getByRole('dialog', { name: `Preview of ${name}` });
      await v.waitFor();
      return v;
    };
    const closePreview = async () => {
      await viewer().getByRole('button', { name: 'Close', exact: true }).click();
      await viewer().waitFor({ state: 'detached' });
    };
    const attach = async (name) => {
      const file = Object.values(pv).find((x) => x.endsWith('/' + name));
      await dlg().locator('input[type="file"][accept="*/*"]').first().setInputFiles(file);
      await dlg().getByText(name).first().waitFor({ timeout: 15000 });
      await s.settle();
    };
    try {
      await s.step('set up: a ticket with a description in the editor', async () => {
        await ensureProject(s);
        await createTicket(s, { title: 'Files to read' });
        await openTicket(s, 'ALP-1');
        await dlg().getByRole('button', { name: 'Edit description' }).click();
        await dlg().locator('[contenteditable="true"]').first().click();
        await p.keyboard.type('Files for the release:');
        await p.keyboard.press('Enter');
      });
      await s.step('attach the ten files, one after the other', async () => {
        for (const n of ['brief.pdf', 'notes.docx', 'budget.xlsx', 'deck.pptx', 'people.csv', 'config.json', 'readme.md', 'page.html', 'tone.wav', 'bundle.zip']) {
          await attach(n);
        }
      });
      await s.step('leave the editor: the Attachments zone lists all ten', async () => {
        await dlg().getByRole('heading', { level: 2 }).click();
        await s.settle(2500);
        await dlg().getByText('ATTACHMENTS · 10').waitFor({ timeout: 10000 });
        for (const n of ['brief.pdf', 'notes.docx', 'budget.xlsx', 'deck.pptx', 'people.csv', 'config.json', 'readme.md', 'page.html', 'tone.wav', 'bundle.zip']) {
          await chip(n).waitFor();
        }
      });
      await s.step('PDF: the reader opens the page and its search finds the text', async () => {
        const v = await openPreview('brief.pdf');
        await v.getByLabel('PDF pages').waitFor({ timeout: 20000 });
        await v.getByText('/ 1', { exact: false }).first().waitFor();
        await v.locator('canvas[aria-label="Page 1"]').first().waitFor({ timeout: 20000 });
        await v.getByRole('searchbox', { name: 'Search in PDF' }).fill('Release');
        await v.getByText(/page 1 · 1 of 1/).waitFor({ timeout: 15000 });
        await v.getByRole('button', { name: 'Zoom in' }).click();
        await v.getByText(/^\d+%$/).waitFor();
        await closePreview();
      });
      await s.step('Word: the simplified reading view shows the paragraph', async () => {
        const v = await openPreview('notes.docx');
        await v.getByText('Simplified preview.').waitFor({ timeout: 15000 });
        await v.getByText('Word notes for the release').waitFor();
        await v.getByRole('searchbox', { name: 'Search' }).fill('release');
        await v.locator('mark').first().waitFor();
        await closePreview();
      });
      await s.step('Excel: the sheet shows its cells', async () => {
        const v = await openPreview('budget.xlsx');
        await v.getByLabel('Sheet1 sheet').waitFor({ timeout: 15000 });
        await v.getByText(/budget\.xlsx · 2 columns/).waitFor();
        await v.getByText('Formulas show their last saved result.').waitFor();
        await v.getByText('Hosting').first().waitFor();
        await v.getByText('Cost').first().waitFor();
        await v.getByText('42').first().waitFor();
        await v.getByRole('searchbox', { name: 'Search cells' }).fill('Hosting');
        await v.getByText('Hosting').first().waitFor();
        await closePreview();
      });
      await s.step('PowerPoint: the slides view, then the outline with its notes', async () => {
        const v = await openPreview('deck.pptx');
        await v.getByText(/Slide 1 of 1/).waitFor({ timeout: 15000 });
        await v.getByRole('button', { name: /^Slide 1: Release deck slide/ }).waitFor();
        await v.getByTestId('slides-mode').click();
        await v.getByText('Showing the outline.').waitFor();
        await v.getByRole('heading', { name: 'Release deck slide' }).waitFor();
        await v.getByText('No notes on this slide.').waitFor();
        await closePreview();
      });
      await s.step('CSV: the table with its header and rows, and cell search', async () => {
        const v = await openPreview('people.csv');
        const table = v.getByLabel(/ table$/);
        await table.waitFor({ timeout: 15000 });
        for (const t of ['name', 'role', 'Ada', 'dev', 'Lin', 'qa']) await table.getByText(t, { exact: true }).first().waitFor();
        await v.getByTestId('csv-delimiter').waitFor();
        await v.getByRole('searchbox', { name: 'Search cells' }).fill('Lin');
        await v.getByText('1 of 1').waitFor();
        await v.locator('td[data-hit]').getByText('Lin').waitFor();
        await v.getByText(/people\.csv · 2 columns · 2 rows/).waitFor();
        await closePreview();
      });
      await s.step('JSON: formatted, tree and raw views', async () => {
        const v = await openPreview('config.json');
        await v.getByText(/valid JSON/).waitFor({ timeout: 15000 });
        await v.getByText('release').first().waitFor();
        await v.getByRole('tab', { name: 'Tree' }).click();
        await v.getByText('steps').first().waitFor();
        await v.getByRole('tab', { name: 'Raw' }).click();
        await v.getByText(/"name": "release"/).first().waitFor();
        await closePreview();
      });
      await s.step('Markdown: rendered, then source', async () => {
        const v = await openPreview('readme.md');
        await v.getByRole('heading', { name: 'Readme preview' }).waitFor({ timeout: 15000 });
        await v.locator('strong', { hasText: 'bold' }).waitFor();
        await v.getByRole('tab', { name: 'Source' }).click();
        await v.getByText(/# Readme preview/).first().waitFor();
        await closePreview();
      });
      await s.step('HTML: the live page in its frame, then the source', async () => {
        const v = await openPreview('page.html');
        await v.getByText('Live page').waitFor({ timeout: 15000 });
        await v.frameLocator('iframe[title="page.html (page)"]').getByRole('heading', { name: 'HTML preview' }).waitFor();
        await v.getByRole('button', { name: 'Phone' }).click();
        await v.getByRole('tab', { name: 'Source' }).click();
        await v.getByText(/<h1>HTML preview<\/h1>/).first().waitFor();
        await closePreview();
      });
      await s.step('WAV: an audio player that knows the length of the tone', async () => {
        const v = await openPreview('tone.wav');
        const audio = v.locator('audio');
        await audio.waitFor({ state: 'attached' });
        await p.waitForFunction(() => {
          const a = document.querySelector('[role="dialog"] audio');
          return a && a.readyState >= 1 && Math.abs(a.duration - 0.5) < 0.05;
        }, null, { timeout: 15000 });
        await closePreview();
      });
      await s.step('ZIP: the listing, a folder and a file opened inside', async () => {
        const v = await openPreview('bundle.zip');
        await v.getByText(/2 files/).waitFor({ timeout: 15000 });
        await v.getByRole('button', { name: /a\.txt/ }).waitFor();
        await v.getByRole('button', { name: /dir/ }).click();
        await v.getByRole('button', { name: /b\.txt/ }).click();
        await v.getByText('second file').waitFor();
        await closePreview();
      });
      await s.step('walk through the files with Next and the details panel', async () => {
        const v = await openPreview('brief.pdf');
        await v.getByText('1 of 10').waitFor();
        await v.getByRole('button', { name: 'Next', exact: true }).click();
        await p.getByRole('dialog', { name: 'Preview of notes.docx' }).waitFor();
        await p.keyboard.press('ArrowRight');
        await p.getByRole('dialog', { name: 'Preview of budget.xlsx' }).waitFor();
        await p.getByRole('dialog', { name: /^Preview of / }).getByRole('button', { name: 'Details' }).click();
        const aside = p.getByRole('complementary', { name: 'Details' });
        await aside.getByText('budget.xlsx').or(aside.getByText('Type')).first().waitFor();
        await aside.getByText('Used in').waitFor();
        await aside.getByText(/ALP-1/).waitFor();
        await closePreview();
      });
      await s.step('download link of a preview points at the file', async () => {
        const v = await openPreview('people.csv');
        const href = await v.getByRole('link', { name: /Download/ }).first().getAttribute('href');
        const res = await p.request.get(href);
        const body = await res.text();
        if (!body.startsWith('name,role')) throw new Error('unexpected CSV download: ' + body.slice(0, 40));
        await closePreview();
      });
    } finally {
      cleanFixtures(fx);
    }
  },
};
