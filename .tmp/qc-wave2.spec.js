const { test } = require('playwright/test');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://127.0.0.1:5174';
const OUT_DIR = '/Users/iamcaominhtien/coder/kanban-board-mcp/docs/ui-audit/qc-wave2';

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function ensureLoaded(page) {
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1200);
}

test('capture CSS wave 2 evidence', async ({ page }) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1200 });
  await ensureLoaded(page);

  const bodyText = await page.locator('body').innerText();
  console.log('BODY_START=' + JSON.stringify(bodyText.slice(0, 800)));

  const cardWrappers = page.locator('div[style*="cursor: grab"]');
  const cardCount = await cardWrappers.count();
  console.log('CARD_COUNT=' + cardCount);
  if (!cardCount) throw new Error('No ticket cards found.');

  const firstCard = cardWrappers.first();
  const firstCardBox = await firstCard.boundingBox();
  console.log('FIRST_CARD_BOX=' + JSON.stringify(firstCardBox));

  await firstCard.screenshot({ path: path.join(OUT_DIR, 'fix-01-ticket-secondary-text.png') });

  const defaultTransform = await firstCard.evaluate((el) => getComputedStyle(el.firstElementChild || el).transform);
  const defaultShadow = await firstCard.evaluate((el) => getComputedStyle(el.firstElementChild || el).boxShadow);
  await firstCard.hover();
  await page.waitForTimeout(250);
  const hoverTransform = await firstCard.evaluate((el) => getComputedStyle(el.firstElementChild || el).transform);
  const hoverShadow = await firstCard.evaluate((el) => getComputedStyle(el.firstElementChild || el).boxShadow);
  console.log('HOVER_DEFAULT=' + JSON.stringify({ defaultTransform, defaultShadow }));
  console.log('HOVER_ACTIVE=' + JSON.stringify({ hoverTransform, hoverShadow }));
  await firstCard.screenshot({ path: path.join(OUT_DIR, 'fix-02-ticket-hover.png') });

  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(200);
  const activeHtml = await page.evaluate(() => {
    const active = document.activeElement;
    return active ? active.outerHTML.slice(0, 500) : 'none';
  });
  console.log('ACTIVE_AFTER_TAB=' + JSON.stringify(activeHtml));
  const firstCardOutline = await firstCard.evaluate((el) => {
    const target = el.firstElementChild || el;
    const style = getComputedStyle(target);
    return {
      outline: style.outline,
      outlineColor: style.outlineColor,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow,
    };
  });
  console.log('FOCUS_STYLE=' + JSON.stringify(firstCardOutline));
  await firstCard.screenshot({ path: path.join(OUT_DIR, 'fix-03-ticket-focus.png') });

  const filterBar = page.locator('input[aria-label="Search tickets"]').locator('..');
  await filterBar.screenshot({ path: path.join(OUT_DIR, 'fix-04-filter-bar-separator.png') });

  const allCards = await cardWrappers.evaluateAll((nodes) => nodes.map((node) => ({ text: node.innerText, html: node.outerHTML.slice(0, 300) })));
  console.log('CARD_TEXTS=' + JSON.stringify(allCards.slice(0, 12)));

  let opened = false;
  for (let i = 0; i < Math.min(cardCount, 12); i += 1) {
    const card = cardWrappers.nth(i);
    await card.click();
    const dialog = page.locator('[role="dialog"]').first();
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(200);
    const dialogText = await dialog.innerText();
    console.log('DIALOG_' + i + '=' + JSON.stringify(dialogText.slice(0, 800)));
    if (dialogText.includes('Assignee') && dialogText.includes('Unassigned')) {
      await dialog.screenshot({ path: path.join(OUT_DIR, 'fix-05-unassigned-pill.png') });
      const timestamps = page.getByText(/Created: .*Updated:/).first();
      if (await timestamps.count()) {
        await timestamps.screenshot({ path: path.join(OUT_DIR, 'fix-06-inline-timestamps.png') });
      } else {
        await dialog.screenshot({ path: path.join(OUT_DIR, 'fix-06-inline-timestamps.png') });
      }
      const closeBtn = page.getByRole('button', { name: 'Close modal' }).first();
      await closeBtn.screenshot({ path: path.join(OUT_DIR, 'fix-07-close-button.png') });
      opened = true;
      break;
    }
    await page.getByRole('button', { name: 'Close modal' }).first().click();
    await page.waitForTimeout(200);
  }

  if (!opened) {
    throw new Error('Could not find a ticket modal with Unassigned assignee in first 12 cards.');
  }

  await page.getByRole('button', { name: 'Close modal' }).first().click();
  await page.waitForTimeout(200);

  const columns = page.locator('text=Backlog').first().locator('../../..');
  await page.screenshot({ path: path.join(OUT_DIR, 'fix-08-column-header-top-line.png'), fullPage: false });

  const metrics = await page.evaluate(() => {
    const searchInput = document.querySelector('input[aria-label="Search tickets"]');
    const filterBar = searchInput?.parentElement;
    const chips = filterBar ? Array.from(filterBar.querySelectorAll('div')).filter((el) => getComputedStyle(el).display === 'flex') : [];
    const backlogLabel = Array.from(document.querySelectorAll('span')).find((el) => el.textContent?.trim() === 'Backlog');
    const backlogColumn = backlogLabel?.closest('div[style]') || backlogLabel?.closest('div');
    const unassigned = Array.from(document.querySelectorAll('span')).find((el) => el.textContent?.trim() === 'Unassigned');
    const closeBtn = Array.from(document.querySelectorAll('button')).find((el) => el.getAttribute('aria-label') === 'Close modal');
    const created = Array.from(document.querySelectorAll('span')).find((el) => el.textContent?.includes('Created:'));
    return {
      filterBarText: filterBar ? filterBar.textContent : null,
      backlogBorderTop: backlogColumn ? getComputedStyle(backlogColumn).borderTop : null,
      unassignedStyle: unassigned ? {
        display: getComputedStyle(unassigned).display,
        fontStyle: getComputedStyle(unassigned).fontStyle,
        borderRadius: getComputedStyle(unassigned).borderRadius,
        backgroundColor: getComputedStyle(unassigned).backgroundColor,
        color: getComputedStyle(unassigned).color,
        padding: getComputedStyle(unassigned).padding,
      } : null,
      closeBtnStyle: closeBtn ? {
        width: getComputedStyle(closeBtn).width,
        height: getComputedStyle(closeBtn).height,
        display: getComputedStyle(closeBtn).display,
        alignItems: getComputedStyle(closeBtn).alignItems,
        justifyContent: getComputedStyle(closeBtn).justifyContent,
        lineHeight: getComputedStyle(closeBtn).lineHeight,
      } : null,
      createdRect: created ? created.getBoundingClientRect() : null,
      parentOfCreatedText: created?.parentElement ? getComputedStyle(created.parentElement).display : null,
    };
  });
  console.log('METRICS=' + JSON.stringify(metrics));
});