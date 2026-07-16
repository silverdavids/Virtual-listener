const { firefox } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

const SHOP_URL = 'https://globalbet.virtual-horizon.com/client/shop.jsp';
const DATA_DIR = 'data';
const OUTPUT_FILE = path.join(DATA_DIR, 'all-network.json');
const TARGET_HOST = 'globalbet.virtual-horizon.com';
const CAPTURE_MS = 45_000;
const BODY_URL_PATTERNS = [
  '/engine/shop/',
  '/client/',
  'feed',
  'event',
  'market',
  'coupon',
  'odds',
  'bet',
  'league',
];

function isTargetHost(url) {
  try {
    return new URL(url).hostname === TARGET_HOST;
  } catch {
    return false;
  }
}

function isBodyCaptureUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const pathAndQuery = `${parsedUrl.pathname}${parsedUrl.search}`.toLowerCase();
    return BODY_URL_PATTERNS.some((pattern) => pathAndQuery.includes(pattern));
  } catch {
    return false;
  }
}

function printTopUrls(results) {
  const counts = new Map();

  for (const entry of results) {
    counts.set(entry.url, (counts.get(entry.url) || 0) + 1);
  }

  const topUrls = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 100);

  console.log('Top URLs by frequency:');

  if (topUrls.length === 0) {
    console.log('No URLs captured.');
    return;
  }

  for (const [url, count] of topUrls) {
    console.log(`${count}x ${url}`);
  }
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const results = [];
  const bodyCapturePromises = [];
  const browser = await firefox.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  const rl = readline.createInterface({ input, output });

  function attachCaptureListeners() {
    page.on('response', (response) => {
      const request = response.request();
      const url = response.url();

      if (!isTargetHost(url)) {
        return;
      }

      const bodyCapturePromise = (async () => {
        const bodyCaptureUrl = isBodyCaptureUrl(url);
        const responseHeaders = response.headers();
        const captured = {
          url,
          method: request.method(),
          status: response.status(),
          contentType: responseHeaders['content-type'] || null,
          requestHeaders: request.headers(),
          bodyPreview: null,
        };

        try {
          const body = await response.text();
          captured.bodyPreview = body.slice(0, 1000);

          if (bodyCaptureUrl) {
            captured.body = body;
          }
        } catch (error) {
          captured.bodyError = error.message || String(error);
        }

        results.push(captured);
      })();

      bodyCapturePromises.push(bodyCapturePromise);
    });
  }

  try {
    await page.goto(SHOP_URL, { waitUntil: 'domcontentloaded' });

    console.log('Login, wait for fixtures to load, then press ENTER to start capture.');
    await rl.question('');

    attachCaptureListeners();

    console.log(`Capturing all ${TARGET_HOST} responses for ${CAPTURE_MS / 1000} seconds. You may click red arrows manually now.`);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch((error) => {
      console.log(`Reload failed after capture started: ${error.message || error}`);
    });
    await page.waitForTimeout(CAPTURE_MS);
    await Promise.allSettled(bodyCapturePromises);

    await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(results, null, 2)}\n`, 'utf8');

    console.log(`Captured ${results.length} responses from ${TARGET_HOST}.`);
    console.log(`Captured ${results.filter((entry) => Object.prototype.hasOwnProperty.call(entry, 'body')).length} full response bodies.`);
    console.log(`Saved results to ${OUTPUT_FILE}`);
    printTopUrls(results);

    await rl.question('Press ENTER to close the browser.');
  } finally {
    rl.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
