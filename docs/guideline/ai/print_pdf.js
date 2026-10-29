// Prints an HTML file to PDF with Chromium: node print_pdf.js <in.html> <out.pdf>
// Needs Playwright (npm i playwright && npx playwright install chromium).
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + require('path').resolve(process.argv[2]), { waitUntil: 'load' });
  // @page rules in the HTML decide the size, margins and page numbers
  await page.pdf({ path: process.argv[3], preferCSSPageSize: true, printBackground: true });
  await browser.close();
})();
