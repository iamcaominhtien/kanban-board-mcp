const fs = require('fs');
const path = require('path');
const { chromium } = require('/Users/iamcaominhtien/.npm/_npx/b234c773f454f454/node_modules/playwright');

const BASE_URL = 'http://127.0.0.1:5174';
const OUT_DIR = '/Users/iamcaominhtien/coder/kanban-board-mcp/docs/ui-audit/qc-wave2';
const REPORT_PATH = '/Users/iamcaominhtien/coder/kanban-board-mcp/.tmp/qc-wave2-report.json';

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  const report = {
    url: BASE_URL,
    generatedAt: new Date().toISOString(),
    screenshots: [],
    logs: {},
  };

  try {
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);

    report.logs.title = await page.title();
    report.logs.bodyStart = (await page.locator('body').innerText()).slice(0, 1200);

    const cardWrappers = page.locator('div[style*="cursor: grab"]');
    const cardCount = await cardWrappers.count();
    report.logs.cardCount = cardCount;
    if (!cardCount) throw new Error('No ticket cards found on board.');

    const subtaskMarker = page.getByText(/\b\d+\/\d+\b/).first();
    const secondaryCard = await subtaskMarker.count()
      ? subtaskMarker.locator('xpath=ancestor::div[@role="button"][1]')
      : cardWrappers.first();
    const firstCard = secondaryCard;
    await firstCard.scrollIntoViewIfNeeded();
    const firstCardBox = await firstCard.boundingBox();
    if (firstCardBox) {
      await page.screenshot({
        path: path.join(OUT_DIR, 'fix-01-ticket-secondary-text.png'),
        clip: {
          x: Math.max(0, firstCardBox.x - 6),
          y: Math.max(0, firstCardBox.y - 6),
          width: Math.min(1440 - Math.max(0, firstCardBox.x - 6), firstCardBox.width + 12),
          height: Math.min(1200 - Math.max(0, firstCardBox.y - 6), firstCardBox.height + 12),
        },
      });
    }
    report.screenshots.push('fix-01-ticket-secondary-text.png');

    const secondaryStyles = await firstCard.evaluate((el) => {
      const root = el.querySelector('[class]') || el;
      const spans = Array.from(root.querySelectorAll('span'));
      const pick = (predicate) => spans.find((span) => predicate(span.textContent || ''));
      const due = pick((text) => text.includes('📅') || text.includes('⚠️'));
      const sub = pick((text) => /\b\d+\/\d+\b/.test(text));
      const toStyle = (node) => {
        if (!node) return null;
        const s = getComputedStyle(node);
        return {
          text: node.textContent,
          color: s.color,
          opacity: s.opacity,
          fontWeight: s.fontWeight,
        };
      };
      return { due: toStyle(due), sub: toStyle(sub) };
    });
    report.logs.fix01 = secondaryStyles;

    const hoverBefore = await firstCard.evaluate((el) => {
      const target = el.querySelector('[class]') || el;
      const s = getComputedStyle(target);
      return { transform: s.transform, boxShadow: s.boxShadow, opacity: s.opacity };
    });
    await firstCard.hover();
    await page.waitForTimeout(300);
    const hoverAfter = await firstCard.evaluate((el) => {
      const target = el.querySelector('[class]') || el;
      const s = getComputedStyle(target);
      return { transform: s.transform, boxShadow: s.boxShadow, opacity: s.opacity };
    });
    report.logs.fix02 = { before: hoverBefore, after: hoverAfter };
    await firstCard.screenshot({ path: path.join(OUT_DIR, 'fix-02-ticket-hover.png') });
    report.screenshots.push('fix-02-ticket-hover.png');

    await firstCard.focus();
    await page.waitForTimeout(120);
    let activeHtml = await page.evaluate(() => {
      const active = document.activeElement;
      return active ? active.outerHTML.slice(0, 500) : 'none';
    });
    const focusState = await firstCard.evaluate((el) => {
      const card = el.querySelector('[class]') || el;
      const wrapper = el;
      const cardStyle = getComputedStyle(card);
      const wrapperStyle = getComputedStyle(wrapper);
      return {
        cardOutline: cardStyle.outline,
        cardOutlineColor: cardStyle.outlineColor,
        cardOutlineWidth: cardStyle.outlineWidth,
        cardBoxShadow: cardStyle.boxShadow,
        wrapperOutline: wrapperStyle.outline,
        wrapperBoxShadow: wrapperStyle.boxShadow,
      };
    });
    report.logs.fix03 = { activeHtml, focusState };
    if (firstCardBox) {
      await page.screenshot({
        path: path.join(OUT_DIR, 'fix-03-ticket-focus.png'),
        clip: {
          x: Math.max(0, firstCardBox.x - 6),
          y: Math.max(0, firstCardBox.y - 6),
          width: Math.min(1440 - Math.max(0, firstCardBox.x - 6), firstCardBox.width + 12),
          height: Math.min(1200 - Math.max(0, firstCardBox.y - 6), firstCardBox.height + 12),
        },
      });
    }
    report.screenshots.push('fix-03-ticket-focus.png');

    const filterBar = page.locator('input[aria-label="Search tickets"]').locator('..');
    await filterBar.screenshot({ path: path.join(OUT_DIR, 'fix-04-filter-bar-separator.png') });
    report.screenshots.push('fix-04-filter-bar-separator.png');
    report.logs.fix04 = await page.evaluate(() => {
      const search = document.querySelector('input[aria-label="Search tickets"]');
      const filter = search ? search.parentElement : null;
      if (!filter) return null;
      const chipGroups = Array.from(filter.children).filter((el) => getComputedStyle(el).display === 'flex' && el !== search);
      const second = chipGroups[1];
      const s = second ? getComputedStyle(second) : null;
      return s ? {
        borderLeft: s.borderLeft,
        paddingLeft: s.paddingLeft,
      } : null;
    });

    let modalFound = false;
    for (let i = 0; i < Math.min(cardCount, 16); i += 1) {
      const card = cardWrappers.nth(i);
      await card.click();
      const dialog = page.locator('[role="dialog"]').first();
      await dialog.waitFor({ state: 'visible', timeout: 5000 });
      await page.waitForTimeout(250);
      const dialogText = await dialog.innerText();
      const hasUnassigned = dialogText.includes('Assignee') && dialogText.includes('Unassigned');
      if (hasUnassigned) {
        modalFound = true;
        await dialog.screenshot({ path: path.join(OUT_DIR, 'fix-05-unassigned-pill.png') });
        report.screenshots.push('fix-05-unassigned-pill.png');

        const timestampRow = await page.evaluate(() => {
          const spans = Array.from(document.querySelectorAll('span'));
          const created = spans.find((el) => (el.textContent || '').includes('Created:'));
          const updated = spans.find((el) => (el.textContent || '').includes('Updated:'));
          if (!created || !updated) return null;
          const createdRect = created.getBoundingClientRect();
          const updatedRect = updated.getBoundingClientRect();
          const parent = created.parentElement;
          const parentStyle = parent ? getComputedStyle(parent) : null;
          return {
            createdText: created.textContent,
            updatedText: updated.textContent,
            createdTop: createdRect.top,
            updatedTop: updatedRect.top,
            createdLeft: createdRect.left,
            updatedLeft: updatedRect.left,
            parentDisplay: parentStyle ? parentStyle.display : null,
            parentFlexDirection: parentStyle ? parentStyle.flexDirection : null,
          };
        });
        report.logs.fix06 = timestampRow;
        const timestampLocator = page.getByText(/Created: .*Updated:/).first();
        if (await timestampLocator.count()) {
          await timestampLocator.screenshot({ path: path.join(OUT_DIR, 'fix-06-inline-timestamps.png') });
        } else {
          await dialog.screenshot({ path: path.join(OUT_DIR, 'fix-06-inline-timestamps.png') });
        }
        report.screenshots.push('fix-06-inline-timestamps.png');

        const closeBtn = page.getByRole('button', { name: 'Close modal' }).first();
        await closeBtn.screenshot({ path: path.join(OUT_DIR, 'fix-07-close-button.png') });
        report.screenshots.push('fix-07-close-button.png');
        report.logs.fix07 = await closeBtn.evaluate((el) => {
          const s = getComputedStyle(el);
          return {
            width: s.width,
            height: s.height,
            display: s.display,
            alignItems: s.alignItems,
            justifyContent: s.justifyContent,
            lineHeight: s.lineHeight,
            textAlign: s.textAlign,
          };
        });

        report.logs.fix05 = await page.evaluate(() => {
          const spans = Array.from(document.querySelectorAll('span'));
          const badge = spans.find((el) => (el.textContent || '').trim() === 'Unassigned');
          if (!badge) return null;
          const s = getComputedStyle(badge);
          return {
            display: s.display,
            fontStyle: s.fontStyle,
            backgroundColor: s.backgroundColor,
            color: s.color,
            borderRadius: s.borderRadius,
            padding: s.padding,
          };
        });
        break;
      }
      await page.getByRole('button', { name: 'Close modal' }).first().click();
      await page.waitForTimeout(200);
    }
    report.logs.modalFound = modalFound;

    if (modalFound) {
      await page.getByRole('button', { name: 'Close modal' }).first().click();
      await page.waitForTimeout(200);
    }

    await page.screenshot({ path: path.join(OUT_DIR, 'fix-08-column-header-top-line.png') });
    report.screenshots.push('fix-08-column-header-top-line.png');
    report.logs.fix08 = await page.evaluate(() => {
      const spans = Array.from(document.querySelectorAll('span'));
      const label = spans.find((el) => (el.textContent || '').trim() === 'Backlog');
      if (!label) return null;
      let node = label.parentElement;
      while (node && getComputedStyle(node).borderTopStyle === 'none') {
        node = node.parentElement;
      }
      if (!node) return null;
      const s = getComputedStyle(node);
      return {
        borderTop: s.borderTop,
        backgroundColor: s.backgroundColor,
      };
    });

    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});