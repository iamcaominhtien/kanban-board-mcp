// Prints an HTML file to a PDF with Chromium: node print_pdf.js <in.html> <out.pdf>
// The PDF is tagged (structure for screen readers) and has bookmarks made from the headings.
// Needs Playwright (npm i playwright && npx playwright install chromium); a Chromium found in
// /opt/pw-browsers or PLAYWRIGHT_BROWSERS_PATH is used as is.
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + path.resolve(process.argv[2]), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  // @page rules in the HTML decide size, margins, header and footer
  await page.pdf({ path: process.argv[3], preferCSSPageSize: true, printBackground: true, tagged: true, outline: true });
  await browser.close();
})();
