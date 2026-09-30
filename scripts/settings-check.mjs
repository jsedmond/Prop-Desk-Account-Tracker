import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createState, exportBackup, parseBackup, STORAGE_KEY } from '../src/domain.js';

const url = process.env.TRACKER_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: process.env.TRACKER_BROWSER || 'msedge', headless: true });
const errors = [];
await mkdir('artifacts', { recursive: true });

try {
  for (const width of [1440, 320]) {
    const context = await browser.newContext({ viewport: { width, height: width === 320 ? 844 : 1100 } });
    // Reproduce settings saved before untouched active evaluations could update.
    const seed = createState();
    seed.settings.evaluationWin = 1000;
    for (const account of seed.accounts.slice(1)) account.rules.evaluationWin = 1000;
    await context.addInitScript(({ key, backup }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, backup);
    }, { key: STORAGE_KEY, backup: exportBackup(seed) });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const read = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
    const navigate = async label => {
      if (width === 320) await page.getByRole('button', { name: 'Toggle navigation' }).click();
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: label, exact: true }).click();
      if (width === 320) await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
    };
    const currentWin = () => page.locator('.current-account').getByRole('button', { name: /^WIN/ });
    const tileWin = id => page.locator(`.account-card[data-account-id="${id}"]`).getByRole('button', { name: /^WIN/ });
    const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    await page.goto(url);
    await page.getByRole('heading', { name: 'Account overview' }).waitFor();
    assert.match(await currentWin().innerText(), /\$1,500/);
    await navigate('Settings');
    assert.equal(await page.getByLabel('Winning trade', { exact: true }).inputValue(), '1000');
    assert.equal(await page.getByRole('button', { name: 'Save rules', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Discard changes', exact: true }).isDisabled(), true);
    await noOverflow();
    await page.getByRole('button', { name: 'Save rules', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Save rules', exact: true }).isDisabled(), true);
    await navigate('Dashboard');
    assert.match(await currentWin().innerText(), /\$1,000/);
    for (const account of seed.accounts) assert.match(await tileWin(account.id).innerText(), /\$1,000/);
    assert.equal((await read()).accounts[0].balance, 50000);
    assert.equal((await read()).accounts[0].purchaseCostCents, 9000);
    await noOverflow();
    await page.screenshot({ path: `artifacts/settings-untraded-${width === 320 ? 'mobile' : 'desktop'}.png`, fullPage: true });
    await page.reload();
    assert.match(await currentWin().innerText(), /\$1,000/);
    await currentWin().click();
    const traded = await read();
    assert.equal(traded.accounts[0].balance, 51000);

    await navigate('Settings');
    await page.getByLabel('Winning trade', { exact: true }).fill('2000');
    await page.getByRole('button', { name: 'Save rules', exact: true }).click();
    await navigate('Dashboard');
    assert.match(await currentWin().innerText(), /\$1,000/);
    assert.match(await tileWin('eval-1').innerText(), /\$1,000/);
    assert.match(await tileWin('eval-2').innerText(), /\$2,000/);
    const frozen = await read();
    assert.deepEqual(frozen.accounts[0], traded.accounts[0]);
    assert.deepEqual(frozen.events.slice(0, -1), traded.events);
    assert.deepEqual(parseBackup(exportBackup(frozen)), frozen);
    await page.reload();
    assert.match(await currentWin().innerText(), /\$1,000/);
    assert.match(await tileWin('eval-2').innerText(), /\$2,000/);

    await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
    await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
    assert.equal((await read()).accounts[0].balance, 50000);
    await navigate('Settings');
    await page.getByLabel('Winning trade', { exact: true }).fill('1200');
    await page.getByRole('button', { name: 'Save rules', exact: true }).click();
    await navigate('Dashboard');
    assert.match(await currentWin().innerText(), /\$1,200/);
    assert.match(await tileWin('eval-1').innerText(), /\$1,200/);
    assert.deepEqual(parseBackup(exportBackup(await read())), await read());
    await noOverflow();
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log('Settings checks passed: untouched active/waiting evaluation tiles, re-saving existing settings, traded rule protection, unchanged history/costs, undo, backup/reload, desktop and 320px mobile.');
} finally {
  await browser.close();
}
