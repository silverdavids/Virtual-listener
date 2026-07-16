const { firefox } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) return;
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  });
}

loadEnvFile('.env');

const LOGIN_URL = 'https://globalbet.virtual-horizon.com/';
const SHOP_URL = 'https://globalbet.virtual-horizon.com/client/shop.jsp';
const AUTH_FILE = 'auth.json';
const OUTPUT_DIR = path.join('data', 'captured');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'layout-style.json');
const SCREENSHOT_FILE = path.join(OUTPUT_DIR, 'layout-screenshot.png');
const VH_USERNAME = process.env.VH_USERNAME;
const VH_PASSWORD = process.env.VH_PASSWORD;
const FORCE_MANUAL_LOGIN = /^(1|true|yes|y|on)$/i.test(String(process.env.FORCE_MANUAL_LOGIN || ''));

const USERNAME_SELECTORS = [
  'input[name="userName"]',
  'input.login-input',
  'input[name="username"]',
  'input[name="login"]',
  'input[name="user"]',
  'input[id*="user" i]',
  'input[placeholder*="user" i]',
  'input[placeholder*="login" i]',
  'input[type="text"]',
  'input:not([type])',
];

const PASSWORD_SELECTORS = [
  'input[name="pass"]',
  'input.password-input',
  'input[name="password"]',
  'input[id*="pass" i]',
  'input[placeholder*="pass" i]',
  'input[type="password"]',
];

async function getFirstVisibleLocator(page, selectors, timeout = 5000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.isVisible({ timeout: 250 })) return locator;
      } catch {
        // Try the next selector.
      }
    }
    await page.waitForTimeout(250);
  }

  return null;
}

async function fillLoginField(page, selectors, value, label) {
  const locator = await getFirstVisibleLocator(page, selectors);
  if (!locator) throw new Error(`Could not find ${label} field`);

  await locator.fill(value, { timeout: 5000 }).catch(async () => {
    await locator.click({ timeout: 5000 });
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.type(value, { delay: 35 });
  });
}

async function clickLoginButton(page) {
  const candidates = [
    page.locator('button.shop-login-button').first(),
    page.getByText('LOGIN', { exact: true }).first(),
    page.locator('button').filter({ hasText: /login/i }).first(),
  ];

  for (const candidate of candidates) {
    try {
      await candidate.click({ timeout: 5000 });
      return;
    } catch {
      // Try the next login strategy.
    }
  }

  await page.keyboard.press('Enter');
}

async function automaticLogin(page) {
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await fillLoginField(page, USERNAME_SELECTORS, VH_USERNAME, 'username');
  await fillLoginField(page, PASSWORD_SELECTORS, VH_PASSWORD, 'password');
  await clickLoginButton(page);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(5000);
}

async function ensureLoggedIn(page, rl) {
  if (!FORCE_MANUAL_LOGIN && VH_USERNAME && VH_PASSWORD) {
    await automaticLogin(page);
    await page.goto(SHOP_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    return;
  }

  await page.goto(SHOP_URL, { waitUntil: 'domcontentloaded' });
  console.log('Log in manually and wait for the Virtual Horizon board to load, then press ENTER here.');
  await rl.question('');
}

async function waitForBoard(page) {
  await page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    return /\b(?:LEAGUE|WEEK|MAIN|1X2|\d{1,2}:\d{2})\b/i.test(text);
  }, null, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

async function captureLayout(page) {
  return page.evaluate(() => {
    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= 0 &&
        rect.top <= window.innerHeight;
    };
    const rectOf = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
        top: Math.round(rect.top * 100) / 100,
        left: Math.round(rect.left * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
        bottom: Math.round(rect.bottom * 100) / 100,
      };
    };
    const computed = (element, selectorUsed) => {
      if (!element) {
        return {
          selectorUsed,
          found: false,
        };
      }

      const style = window.getComputedStyle(element);
      return {
        selectorUsed,
        found: true,
        tagName: element.tagName.toLowerCase(),
        id: element.id || '',
        className: String(element.className || ''),
        textSample: normalizeText(element.innerText || element.textContent).slice(0, 160),
        boundingClientRect: rectOf(element),
        computedStyles: {
          width: style.width,
          height: style.height,
          display: style.display,
          position: style.position,
          top: style.top,
          left: style.left,
          margin: style.margin,
          padding: style.padding,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing,
          color: style.color,
          backgroundColor: style.backgroundColor,
          border: style.border,
          borderRadius: style.borderRadius,
          transform: style.transform,
          zIndex: style.zIndex,
          overflow: style.overflow,
        },
      };
    };
    const firstVisible = (selectors) => {
      for (const selector of selectors) {
        const element = Array.from(document.querySelectorAll(selector)).find(isVisible);
        if (element) return { element, selector };
      }
      return { element: null, selector: selectors.join(', ') };
    };
    const all = Array.from(document.querySelectorAll('body *')).filter(isVisible);
    const items = all.map((element) => ({
      element,
      text: normalizeText(element.innerText || element.textContent),
      rect: rectOf(element),
      className: String(element.className || ''),
    }));
    const findByText = (pattern, options = {}) => {
      const maxTextLength = options.maxTextLength ?? 180;
      const minWidth = options.minWidth ?? 0;
      const maxHeight = options.maxHeight ?? Number.POSITIVE_INFINITY;
      const candidates = items
        .filter((item) => pattern.test(item.text))
        .filter((item) => item.text.length <= maxTextLength)
        .filter((item) => item.rect.width >= minWidth && item.rect.height <= maxHeight)
        .sort((left, right) => (
          (options.preferLower ? right.rect.top - left.rect.top : left.rect.top - right.rect.top) ||
          left.text.length - right.text.length ||
          (left.rect.width * left.rect.height) - (right.rect.width * right.rect.height)
        ));
      return candidates[0]?.element ?? null;
    };
    const findNearestCircle = (anchor, classPattern) => {
      const anchorRect = anchor?.getBoundingClientRect();
      const candidates = items
        .filter((item) => classPattern.test(item.className) || Math.abs(item.rect.width - item.rect.height) <= 8)
        .filter((item) => item.rect.width >= 12 && item.rect.width <= 80 && item.rect.height >= 12 && item.rect.height <= 80)
        .sort((left, right) => {
          if (!anchorRect) return left.rect.top - right.rect.top;
          const leftDistance = Math.hypot(left.rect.left - anchorRect.left, left.rect.top - anchorRect.top);
          const rightDistance = Math.hypot(right.rect.left - anchorRect.left, right.rect.top - anchorRect.top);
          return leftDistance - rightDistance;
        });
      return candidates[0]?.element ?? null;
    };

    const root = firstVisible(['.gbs_layout-page', '.gbs_layout-container.ext-mainContainer', 'body']);
    const topNav = firstVisible(['#gbs_layout-header', '.gbs_layout-header', '[class*="header"]']);
    const sportsTabs = firstVisible(['.gbs_top-menu', '.gbs_sports-tabs', '[class*="sport"]', '[class*="top-menu"]']);
    const weekTabs = firstVisible(['.gbs_events-panel.ext-events-panel', '.gbs_events-panel', '[class*="events-panel"]']);
    const leaguePanel = firstVisible(['#gbs-game-info', '.gbs_game-info.ext-game-info', '.gbs_game-info']);
    const logo = firstVisible(['[class*="logo"]', '[class*="emblem"]', 'img[src*="logo"]', 'img']);
    const countdownCircle = firstVisible(['.gbs_event-countdown.ext-event-countdown', '.gbs_event-countdown', '[class*="countdown"]']);
    const countdownText = firstVisible(['.gbs_event-countdown-timer.ext-event-countdown-timer', '.gbs_event-countdown-timer']);
    const secondaryRedTimerElement = (() => {
      const countdownData = firstVisible(['.gbs_event-countdown-data']).element;
      if (!countdownData) return null;
      return Array.from(countdownData.querySelectorAll('*'))
        .filter(isVisible)
        .map((element) => ({ element, text: normalizeText(element.innerText || element.textContent), rect: rectOf(element) }))
        .filter((item) => /^\d{1,2}:\d{2}$/.test(item.text))
        .sort((left, right) => right.rect.top - left.rect.top)[1]?.element ??
        Array.from(countdownData.querySelectorAll('*')).filter(isVisible).find((element) => /red|secondary/i.test(String(element.className || ''))) ??
        null;
    })();
    const marketHeaderRow = firstVisible(['.gbs_game-widget_bets-panel', '[class*="bets-panel"]']);
    const marketGroupTabs = firstVisible(['.gbs_game-widget_market-panel', '[class*="market-panel"]', '[class*="markets-panel"]']);
    const oddsTableContainer = firstVisible(['.gbs_game-widget', '.gbs_events-widget', '[class*="game-widget"]', '[class*="events-widget"]']);
    const matchRowElement = findByText(/\bVS\b/i, { maxTextLength: 80, minWidth: 120, preferLower: true });
    const teamBadge = findNearestCircle(matchRowElement, /badge|shirt|team|circle|flag/i);
    const teamNames = matchRowElement;
    const redArrow = firstVisible(['[class*="arrow"]', '[class*="navigation"]', '[class*="next"]', '[class*="prev"]']);
    const oddsCell = (() => {
      const oddsPattern = /^\d+(?:\.\d+)?$/;
      return items
        .filter((item) => oddsPattern.test(item.text))
        .filter((item) => item.rect.width >= 30 && item.rect.width <= 120 && item.rect.height >= 20 && item.rect.height <= 70)
        .sort((left, right) => left.rect.top - right.rect.top || left.rect.left - right.rect.left)[0]?.element ?? null;
    })();
    const betslip = firstVisible(['.gbs_betslip', '.gbs_layout-block-right', '[class*="betslip"]', '[class*="right"]']);
    const bottomButtons = firstVisible(['.gbs_coupon-buttons', '.gbs_betslip-buttons', '[class*="bottom"] button', '[class*="button-panel"]']);

    const elements = {
      appRootViewport: computed(root.element, root.selector),
      topNavigationBar: computed(topNav.element, topNav.selector),
      sportsTabs: computed(sportsTabs.element, sportsTabs.selector),
      weekTabs: computed(weekTabs.element, weekTabs.selector),
      leaguePanelCard: computed(leaguePanel.element, leaguePanel.selector),
      logoEmblem: computed(logo.element, logo.selector),
      countdownCircle: computed(countdownCircle.element, countdownCircle.selector),
      countdownText: computed(countdownText.element, countdownText.selector),
      secondaryRedTimer: computed(secondaryRedTimerElement, '.gbs_event-countdown-data timer candidate[2]'),
      marketHeaderRow: computed(marketHeaderRow.element, marketHeaderRow.selector),
      marketGroupTabs: computed(marketGroupTabs.element, marketGroupTabs.selector),
      oddsTableContainer: computed(oddsTableContainer.element, oddsTableContainer.selector),
      matchRow: computed(matchRowElement, 'text=/\\bVS\\b/i'),
      teamBadgeCircle: computed(teamBadge, 'nearest small circle/badge to match row'),
      teamNames: computed(teamNames, 'match row text=/\\bVS\\b/i'),
      redArrow: computed(redArrow.element, redArrow.selector),
      oddsCell: computed(oddsCell, 'numeric odds cell'),
      betslipRightPanel: computed(betslip.element, betslip.selector),
      bottomActionButtons: computed(bottomButtons.element, bottomButtons.selector),
    };

    return {
      capturedAt: new Date().toISOString(),
      url: window.location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      elements,
    };
  });
}

function compactSummary(label, entry) {
  if (!entry?.found) return `LAYOUT ${label}=not-found`;
  const rect = entry.boundingClientRect;
  const style = entry.computedStyles;
  return `LAYOUT ${label}=text="${entry.textSample}" rect=${rect.width}x${rect.height}@${rect.left},${rect.top} font=${style.fontSize}/${style.fontWeight} bg=${style.backgroundColor}`;
}

async function main() {
  await fs.promises.mkdir(OUTPUT_DIR, { recursive: true });

  const contextOptions = fs.existsSync(AUTH_FILE) && (!VH_USERNAME || !VH_PASSWORD || FORCE_MANUAL_LOGIN)
    ? { storageState: AUTH_FILE }
    : {};
  const browser = await firefox.launch({ headless: false });
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const rl = readline.createInterface({ input, output });

  try {
    await ensureLoggedIn(page, rl);
    await page.goto(SHOP_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await waitForBoard(page);

    const layout = await captureLayout(page);
    await page.screenshot({ path: SCREENSHOT_FILE, fullPage: false });
    layout.screenshot = SCREENSHOT_FILE;

    await fs.promises.writeFile(OUTPUT_FILE, `${JSON.stringify(layout, null, 2)}\n`, 'utf8');

    console.log(compactSummary('timer', layout.elements.countdownText));
    console.log(compactSummary('row', layout.elements.matchRow));
    console.log(compactSummary('oddsCell', layout.elements.oddsCell));
    console.log(compactSummary('marketHeader', layout.elements.marketHeaderRow));
    console.log(`Saved layout style capture to ${OUTPUT_FILE}`);
    console.log(`Saved layout screenshot to ${SCREENSHOT_FILE}`);
  } finally {
    rl.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
