const { firefox } = require('playwright');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');

const LOGIN_URL = 'https://globalbet.virtual-horizon.com/';
const AUTH_FILE = 'auth.json';

async function main() {
  const browser = await firefox.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  const rl = readline.createInterface({ input, output });
  await rl.question('Log in manually in the Firefox window, then press ENTER here to save the session.');
  rl.close();

  await context.storageState({ path: AUTH_FILE });
  await browser.close();

  console.log(`Saved authenticated session to ${AUTH_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
