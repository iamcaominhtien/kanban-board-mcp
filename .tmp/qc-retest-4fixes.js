const { chromium } = require('/Users/iamcaominhtien/.npm/_npx/b234c773f454f454/node_modules/playwright');
const fs = require('fs');
const path = require('path');

const baseUrl = 'http://127.0.0.1:5174';
const screenshotDir = '/Users/iamcaominhtien/coder/kanban-board-mcp/docs/ui-audit/qc-wave2/retest';

fs.mkdirSync(screenshotDir, { recursive: true });

function parseRgb(color) {
  const srgbMatch = color && color.match(/color\(srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+))?\)/i);
  if (srgbMatch) {
    return [
      Math.round(Number.parseFloat(srgbMatch[1]) * 255),
      Math.round(Number.parseFloat(srgbMatch[2]) * 255),
      Math.round(Number.parseFloat(srgbMatch[3]) * 255),
    ];
  }
  const match = color && color.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1].split(',').slice(0, 3).map((part) => Number.parseFloat(part.trim()));
  if (parts.some((part) => Number.isNaN(part))) return null;
  return parts;
}

function luminance([r, g, b]) {
  const values = [r, g, b].map((value) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
}

function contrastRatio(colorA, colorB) {
  const rgbA = parseRgb(colorA);
  const rgbB = parseRgb(colorB);
  if (!rgbA || !rgbB) return null;
  const lumA = luminance(rgbA);
  const lumB = luminance(rgbB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

function sanitizeClip(box, pageSize, padding = 12) {
  const x = Math.max(0, Math.floor(box.x - padding));
  const y = Math.max(0, Math.floor(box.y - padding));
  const width = Math.min(pageSize.width - x, Math.ceil(box.width + padding * 2));
  const height = Math.min(pageSize.height - y, Math.ceil(box.height + padding * 2));
  return { x, y, width, height };
}

async function getCardInfos(page) {
  return page.locator('div[tabindex="0"]').evaluateAll((nodes) => nodes.map((node, index) => {
    const text = (node.innerText || '').trim();
    const rect = node.getBoundingClientRect();
    return {
      index,
      text,
      width: rect.width,
      height: rect.height,
    };
  }).filter((item) => item.text && item.width > 120 && item.height > 60));
}

async function openCardByIndex(page, index) {
  const card = page.locator('div[tabindex="0"]').nth(index);
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await page.getByRole('dialog').waitFor({ state: 'visible', timeout: 10000 });
  return card;
}

async function closeModal(page) {
  const closeButton = page.getByRole('button', { name: 'Close modal' });
  if (await closeButton.count()) {
    await closeButton.click();
    await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 10000 });
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 }, deviceScaleFactor: 1 });
  const report = {
    generatedAt: new Date().toISOString(),
    screenshots: {},
    results: {},
    oddities: [],
  };

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1200);

    const cards = await getCardInfos(page);
    if (!cards.length) {
      throw new Error('No ticket-card candidates found on the board');
    }

    const fix01Candidate = cards.find((card) => /\b\d+\/\d+\b/.test(card.text) || /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\b/.test(card.text));
    if (!fix01Candidate) {
      report.results.fix01 = { pass: false, reason: 'No card with due date or sub-task count found' };
    } else {
      const card = page.locator('div[tabindex="0"]').nth(fix01Candidate.index);
      await card.scrollIntoViewIfNeeded();
      const screenshotPath = path.join(screenshotDir, 'fix-01-secondary-text-card.png');
      await card.screenshot({ path: screenshotPath });
      const styleInfo = await card.evaluate((node) => {
        const spans = Array.from(node.querySelectorAll('span, div')).map((el) => {
          const text = (el.textContent || '').trim();
          const style = window.getComputedStyle(el);
          return { text, color: style.color, fontWeight: style.fontWeight };
        }).filter((item) => item.text);
        const secondary = spans.find((item) => /\b\d+\/\d+\b/.test(item.text))
          || spans.find((item) => /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\b/.test(item.text));
        const cardStyle = window.getComputedStyle(node);
        return {
          secondary,
          cardBackground: cardStyle.backgroundColor,
        };
      });
      const contrast = styleInfo.secondary ? contrastRatio(styleInfo.secondary.color, styleInfo.cardBackground) : null;
      report.screenshots.fix01 = screenshotPath;
      report.results.fix01 = {
        pass: Boolean(styleInfo.secondary && contrast && contrast >= 3),
        targetText: styleInfo.secondary?.text || null,
        color: styleInfo.secondary?.color || null,
        background: styleInfo.cardBackground,
        contrast,
      };
      if (contrast !== null && contrast < 3.5) {
        report.oddities.push('FIX-01 secondary text contrast is only moderately separated from the card background.');
      }
    }

    await page.keyboard.press('Home').catch(() => {});
    await page.locator('body').click({ position: { x: 20, y: 20 } }).catch(() => {});
    let focusedCardIndex = null;
    let focusedCardText = null;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await page.keyboard.press('Tab');
      const active = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        return {
          tag: el.tagName,
          text: (el.textContent || '').trim().slice(0, 200),
          tabIndex: el.tabIndex,
          isCard: el.matches('div[tabindex="0"]'),
        };
      });
      if (active && active.isCard) {
        const liveCards = await getCardInfos(page);
        const activeText = active.text || '';
        const match = liveCards.find((card) => activeText === card.text.slice(0, activeText.length) || card.text.startsWith(activeText) || activeText.startsWith(card.text.slice(0, 80)));
        if (match) {
          focusedCardIndex = match.index;
          focusedCardText = match.text;
        } else {
          focusedCardText = activeText;
        }
        break;
      }
    }

    if (!focusedCardText) {
      report.results.fix03 = { pass: false, reason: 'Could not focus a ticket card via Tab navigation' };
    } else {
      const focusedCard = focusedCardIndex !== null
        ? page.locator('div[tabindex="0"]').nth(focusedCardIndex)
        : page.locator('div[tabindex="0"]:focus').first();
      const box = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      });
      if (!box) throw new Error('Focused card has no bounding box');
      const clip = sanitizeClip(box, page.viewportSize());
      const focusShot = path.join(screenshotDir, 'fix-03-focus-ring.png');
      await page.screenshot({ path: focusShot, clip });
      const outline = await focusedCard.evaluate((node) => {
        const style = window.getComputedStyle(node);
        return {
          outlineColor: style.outlineColor,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
          outlineOffset: style.outlineOffset,
        };
      });
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      let modalOpened = true;
      try {
        await dialog.waitFor({ state: 'visible', timeout: 10000 });
      } catch {
        modalOpened = false;
      }
      const modalShot = path.join(screenshotDir, 'fix-03-enter-opened-modal.png');
      if (modalOpened) {
        await dialog.screenshot({ path: modalShot });
      }
      report.screenshots.fix03 = focusShot;
      report.screenshots.fix03Modal = modalShot;
      report.results.fix03 = {
        pass: modalOpened && outline.outlineStyle !== 'none' && /rgb\(232, 68, 26\)|#E8441A/i.test(outline.outlineColor),
        focusedCardText,
        outline,
        modalOpened,
      };
      if (!modalOpened) {
        report.oddities.push('FIX-03 Enter key did not open the modal from the focused card.');
      }
    }

    let modalOpen = await page.getByRole('dialog').isVisible().catch(() => false);
    let selectedUnassignedIndex = null;
    if (!modalOpen) {
      for (const cardInfo of cards) {
        await openCardByIndex(page, cardInfo.index);
        modalOpen = true;
        const hasUnassigned = await page.getByRole('dialog').getByText('Unassigned', { exact: true }).isVisible().catch(() => false);
        if (hasUnassigned) {
          selectedUnassignedIndex = cardInfo.index;
          break;
        }
        await closeModal(page);
        modalOpen = false;
      }
    } else {
      const hasUnassigned = await page.getByRole('dialog').getByText('Unassigned', { exact: true }).isVisible().catch(() => false);
      if (hasUnassigned) {
        selectedUnassignedIndex = focusedCardIndex;
      }
    }

    if (selectedUnassignedIndex === null) {
      report.results.fix05 = { pass: false, reason: 'No openable ticket with Unassigned badge found' };
    } else {
      const dialog = page.getByRole('dialog');
      const aside = dialog.locator('aside').first();
      const unassigned = dialog.getByText('Unassigned', { exact: true }).first();
      const sidebarShot = path.join(screenshotDir, 'fix-05-unassigned-sidebar.png');
      await aside.screenshot({ path: sidebarShot });
      const badgeStyles = await unassigned.evaluate((node) => {
        const style = window.getComputedStyle(node);
        return {
          display: style.display,
          borderRadius: style.borderRadius,
          borderWidth: style.borderTopWidth,
          borderStyle: style.borderTopStyle,
          fontStyle: style.fontStyle,
          padding: style.padding,
          backgroundColor: style.backgroundColor,
          color: style.color,
        };
      });
      const borderWidthNum = Number.parseFloat(badgeStyles.borderWidth);
      report.screenshots.fix05 = sidebarShot;
      report.results.fix05 = {
        pass: badgeStyles.display.includes('flex') && badgeStyles.fontStyle !== 'italic' && borderWidthNum >= 1 && Number.parseFloat(badgeStyles.borderRadius) >= 20,
        badgeStyles,
      };
      if (badgeStyles.fontStyle !== 'normal') {
        report.oddities.push('FIX-05 Unassigned badge is not using normal font style.');
      }
    }

    const dialog = page.getByRole('dialog');
    const closeButton = dialog.getByRole('button', { name: 'Close modal' });
    if (!await closeButton.isVisible().catch(() => false)) {
      report.results.fix07 = { pass: false, reason: 'Close button was not visible in an open modal' };
    } else {
      const closeShot = path.join(screenshotDir, 'fix-07-close-button.png');
      await closeButton.screenshot({ path: closeShot });
      const closeMetrics = await closeButton.evaluate((node) => {
        const style = window.getComputedStyle(node);
        const buttonRect = node.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(node);
        const textRect = range.getBoundingClientRect();
        return {
          width: buttonRect.width,
          height: buttonRect.height,
          display: style.display,
          alignItems: style.alignItems,
          justifyContent: style.justifyContent,
          fontSize: style.fontSize,
          lineHeight: style.lineHeight,
          padding: style.padding,
          textOffsetX: Number((textRect.left + textRect.width / 2) - (buttonRect.left + buttonRect.width / 2)).toFixed(2),
          textOffsetY: Number((textRect.top + textRect.height / 2) - (buttonRect.top + buttonRect.height / 2)).toFixed(2),
        };
      });
      report.screenshots.fix07 = closeShot;
      report.results.fix07 = {
        pass: Math.abs(closeMetrics.width - closeMetrics.height) <= 1 && closeMetrics.display.includes('flex') && closeMetrics.alignItems === 'center' && closeMetrics.justifyContent === 'center' && Math.abs(closeMetrics.textOffsetX) <= 2 && Math.abs(closeMetrics.textOffsetY) <= 3,
        closeMetrics,
      };
      if (Math.abs(closeMetrics.textOffsetY) > 1.5) {
        report.oddities.push('FIX-07 close icon is not perfectly vertically centered, though still within tolerance.');
      }
    }

    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message, stack: error.stack }, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
