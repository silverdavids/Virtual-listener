const { firefox } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim().replace(/^['"]|['"]$/g, '');

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

loadEnvFile('.env');

const LOGIN_URL = 'https://globalbet.virtual-horizon.com/';
const SHOP_URL = 'https://globalbet.virtual-horizon.com/client/shop.jsp';
const AUTH_FILE = 'auth.json';
const OUTPUT_DIR = path.join('data', 'captured');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'timer-style.json');
const TIMER_SCREENSHOT_FILE = path.join(OUTPUT_DIR, 'timer-style.png');
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
        if (await locator.isVisible({ timeout: 250 })) {
          return locator;
        }
      } catch {
        // Try the next selector until timeout.
      }
    }

    await page.waitForTimeout(250);
  }

  return null;
}

async function fillLoginField(page, selectors, value, label) {
  const locator = await getFirstVisibleLocator(page, selectors);

  if (!locator) {
    throw new Error(`Could not find ${label} field`);
  }

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

function stableRect(rect) {
  if (!rect) {
    return null;
  }

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
}

async function waitForBoard(page) {
  await page.waitForFunction(() => {
    const text = document.body?.innerText || '';
    return /\b(?:LEAGUE|WEEK|NO MORE BETS|\d{1,2}:\d{2})\b/i.test(text);
  }, null, { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3000);
}

async function inspectStyles(page) {
  return page.evaluate(() => {
    const roleAttr = 'data-timer-style-role';
    document.querySelectorAll(`[${roleAttr}]`).forEach((element) => element.removeAttribute(roleAttr));

    const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= 0 &&
        rect.top <= window.innerHeight
      );
    };
    const rectOf = (element) => {
      if (!element) {
        return null;
      }

      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
      };
    };
    const pickStyle = (element) => {
      if (!element) {
        return null;
      }

      const style = window.getComputedStyle(element);
      const rect = rectOf(element);

      return {
        tagName: element.tagName.toLowerCase(),
        id: element.id || '',
        className: String(element.className || ''),
        text: normalizeText(element.innerText || element.textContent).slice(0, 180),
        rect,
        width: style.width,
        height: style.height,
        fontSize: style.fontSize,
        fontFamily: style.fontFamily,
        fontWeight: style.fontWeight,
        letterSpacing: style.letterSpacing,
        lineHeight: style.lineHeight,
        color: style.color,
        background: style.background,
        backgroundColor: style.backgroundColor,
        border: style.border,
        borderRadius: style.borderRadius,
        transform: style.transform,
        scale: style.scale,
        position: style.position,
        top: style.top,
        left: style.left,
        display: style.display,
        alignItems: style.alignItems,
        justifyContent: style.justifyContent,
        padding: style.padding,
        margin: style.margin,
      };
    };
    const parentStyles = (element, levels = 4) => {
      const parents = [];
      let current = element?.parentElement || null;

      while (current && parents.length < levels) {
        parents.push(pickStyle(current));
        current = current.parentElement;
      }

      return parents;
    };
    const all = Array.from(document.querySelectorAll('body *')).filter(isVisible);
    const candidates = all.map((element) => ({
      element,
      text: normalizeText(element.innerText || element.textContent),
      rect: rectOf(element),
    }));
    const scoreTimerCandidate = (item) => {
      let score = 0;
      const exactTimer = /^(?:NO MORE BETS,?\s*GAME IS KICKING OFF|\d{1,2}:\d{2})$/i.test(item.text);
      const compactTimer = /^(?:\d{1,2}:\d{2}\s+){0,2}\d{1,2}:\d{2}$/i.test(item.text);
      const inBoard = item.rect.top >= 45;
      const huge = item.rect.width > 220 || item.rect.height > 120;

      if (exactTimer) score += 1000;
      if (compactTimer) score += 500;
      if (inBoard) score += 300;
      if (/game-info|timer|countdown|clock/i.test(String(item.element.className || ''))) score += 200;
      if (huge) score -= 800;
      if (item.rect.top < 45) score -= 600;
      score -= item.text.length * 4;
      score -= Math.max(0, item.rect.width - 120);
      return score;
    };
    const timerCandidates = candidates
      .filter((item) => /(?:NO MORE BETS|GAME IS KICKING OFF|\b\d{1,2}:\d{2}\b)/i.test(item.text))
      .filter((item) => item.text.length <= 120)
      .map((item) => ({ ...item, score: scoreTimerCandidate(item) }))
      .sort((left, right) => right.score - left.score);
    const timer = timerCandidates[0]?.element ?? null;
    const leaguePanel = (() => {
      let current = timer;

      while (current && current !== document.body) {
        const text = normalizeText(current.innerText || current.textContent);
        const rect = current.getBoundingClientRect();
        if (/\b(?:LEAGUE|WEEK)\b/i.test(text) && rect.width >= 120 && rect.height >= 40) {
          return current;
        }
        current = current.parentElement;
      }

      return candidates
        .filter((item) => /\bLEAGUE\b/i.test(item.text) && item.rect.width >= 80)
        .sort((left, right) => (left.rect.width * left.rect.height) - (right.rect.width * right.rect.height))[0]?.element ?? null;
    })();
    const leagueNumber = candidates
      .filter((item) => /\bLEAGUE\s*\d+\b/i.test(item.text) || /^LEAGUE\b/i.test(item.text))
      .sort((left, right) => left.text.length - right.text.length)[0]?.element ?? null;
    const weekTabs = candidates
      .filter((item) => /\bWEEK\s*\d+\b/i.test(item.text) || /^WEEK\b/i.test(item.text))
      .slice(0, 12)
      .map((item) => item.element);
    const marketHeader = candidates
      .filter((item) => /(?:\b1\b.*\bX\b.*\b2\b|1X.*12.*X2|GG.*NG|OV.*UN)/i.test(item.text))
      .filter((item) => item.text.length <= 160)
      .sort((left, right) => left.rect.top - right.rect.top || left.text.length - right.text.length)[0]?.element ?? null;

    timer?.setAttribute(roleAttr, 'timer');
    leaguePanel?.setAttribute(roleAttr, 'league-panel');
    leagueNumber?.setAttribute(roleAttr, 'league-number');
    marketHeader?.setAttribute(roleAttr, 'market-header');
    weekTabs.forEach((element, index) => element.setAttribute(roleAttr, `week-tab-${index + 1}`));

    return {
      capturedAt: new Date().toISOString(),
      url: window.location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
      TIMER_STYLE: pickStyle(timer),
      TIMER_PARENT_STYLE: parentStyles(timer),
      LEAGUE_PANEL_STYLE: pickStyle(leaguePanel),
      LEAGUE_PANEL_PARENT_STYLE: parentStyles(leaguePanel),
      LEAGUE_NUMBER_STYLE: pickStyle(leagueNumber),
      WEEK_TABS_STYLE: weekTabs.map((element) => pickStyle(element)),
      MARKET_HEADER_STYLE: pickStyle(marketHeader),
      MARKET_HEADER_PARENT_STYLE: parentStyles(marketHeader),
      candidates: {
        timer: timerCandidates.slice(0, 8).map((item) => ({
          text: item.text,
          rect: item.rect,
          tagName: item.element.tagName.toLowerCase(),
          className: String(item.element.className || ''),
        })),
      },
    };
  });
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

    const result = await inspectStyles(page);
    let screenshotPath = null;
    const timer = page.locator('[data-timer-style-role="timer"]').first();

    if (await timer.count()) {
      try {
        await timer.screenshot({ path: TIMER_SCREENSHOT_FILE });
        screenshotPath = TIMER_SCREENSHOT_FILE;
      } catch (error) {
        result.timerScreenshotError = error.message || String(error);
      }
    }

    result.timerScreenshot = screenshotPath;
    await fs.promises.writeFile(OUTPUT_FILE, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

    console.log(`TIMER_STYLE ${JSON.stringify(result.TIMER_STYLE, null, 2)}`);
    console.log(`TIMER_PARENT_STYLE ${JSON.stringify(result.TIMER_PARENT_STYLE, null, 2)}`);
    console.log(`LEAGUE_PANEL_STYLE ${JSON.stringify(result.LEAGUE_PANEL_STYLE, null, 2)}`);
    console.log(`LEAGUE_NUMBER_STYLE ${JSON.stringify(result.LEAGUE_NUMBER_STYLE, null, 2)}`);
    console.log(`WEEK_TABS_STYLE ${JSON.stringify(result.WEEK_TABS_STYLE, null, 2)}`);
    console.log(`MARKET_HEADER_STYLE ${JSON.stringify(result.MARKET_HEADER_STYLE, null, 2)}`);
    console.log(`Saved style capture to ${OUTPUT_FILE}`);
    if (screenshotPath) {
      console.log(`Saved timer screenshot to ${screenshotPath}`);
    }
  } finally {
    rl.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
