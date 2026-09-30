import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createState, STORAGE_KEY, VERSION } from '../src/domain.js';

const url = process.env.TRACKER_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: process.env.TRACKER_BROWSER || 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const getWin = () => page.locator('.current-account').getByRole('button', { name: /^WIN/ });
const getLoss = () => page.locator('.current-account').getByRole('button', { name: /^LOSS/ });
const nav = label => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: label, exact: true });
const read = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
const funded = state => state.accounts.find(account => account.id === 'funded-1');
const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Unexpected horizontal overflow');
await mkdir('artifacts', { recursive: true });

try {
  await page.goto(url);
  await page.getByRole('heading', { name: 'Account overview' }).waitFor();
  assert.equal(await page.locator('.balance').innerText(), '$50,000.00');
  assert.equal(await page.locator('.account-card').count(), 5);
  assert.equal(await page.locator('.metric').filter({ hasText: 'Evaluation costs' }).locator('strong').innerText(), '$450.00');
  await noOverflow();
  await page.screenshot({ path: 'artifacts/dashboard-desktop.png', fullPage: true });

  const dates = await page.evaluate(() => {
    const now = new Date();
    const format = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return { today: format(now), tomorrow: format(tomorrow) };
  });
  const currentDate = page.getByLabel('Trade date', { exact: true });
  const beforeDateCheck = await read();
  assert.equal(await currentDate.getAttribute('max'), dates.today);
  await currentDate.fill(dates.tomorrow);
  assert.equal(await getWin().isDisabled(), true);
  assert.equal(await getLoss().isDisabled(), true);
  assert.deepEqual(await read(), beforeDateCheck);
  await page.locator('.current-account').getByRole('alert').filter({ hasText: 'Future trade dates are not allowed' }).waitFor();
  await currentDate.fill(dates.today);
  assert.equal(await getWin().isEnabled(), true);
  assert.equal(await getLoss().isEnabled(), true);

  await getWin().click();
  await getWin().click();
  assert.equal((await read()).selectedId, 'eval-2');
  assert.equal(await page.locator('.account-card[data-account-id="eval-1"]').count(), 0);
  assert.equal(await page.locator('.account-card[data-account-id="funded-1"]').count(), 1);
  await page.getByRole('button', { name: 'View Funded 01', exact: true }).click();
  await page.getByLabel('Trade date', { exact: true }).fill('2026-09-25');
  await getWin().click();
  for (const day of ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']) {
    await page.getByLabel('Trade date', { exact: true }).fill(day);
    await getWin().click();
    if (day !== '2026-09-28') assert.equal(await getWin().isDisabled(), true);
  }
  assert.equal(funded(await read()).balance, 54700);
  await page.screenshot({ path: 'artifacts/payout-ready-desktop.png', fullPage: true });
  await page.locator('.current-account').getByRole('button', { name: 'Take $3,000 payout' }).click();
  assert.equal(funded(await read()).balance, 51700);
  assert.equal(funded(await read()).cycle, 2);
  await getLoss().click();
  assert.match(await getLoss().innerText(), /\$800/);
  await getLoss().click();
  assert.equal(funded(await read()).stage, 'funded_failed');
  assert.equal(await page.locator('.account-card[data-account-id="funded-1"]').count(), 0);
  await page.getByRole('button', { name: 'Undo last action' }).click();
  assert.equal(funded(await read()).stage, 'main');
  assert.equal(await page.locator('.account-card[data-account-id="funded-1"]').count(), 1);
  assert.equal(funded(await read()).balance, 50700);
  await page.reload();
  assert.equal(funded(await read()).balance, 50700);

  await nav('History').click();
  await page.getByRole('heading', { name: 'Activity history' }).waitFor();
  assert.ok(await page.locator('.event-undone').count() > 0);
  await page.getByRole('button', { name: 'Payouts', exact: true }).click();
  assert.equal(await page.locator('.history-event').count(), 1);
  await page.screenshot({ path: 'artifacts/history-desktop.png', fullPage: true });
  await nav('Settings').click();
  await page.getByLabel('Main winning trade', { exact: true }).fill('4500');
  await page.getByRole('button', { name: 'Save rules' }).click();
  assert.equal((await read()).settings.fundedMainWin, 4500);
  assert.equal(funded(await read()).rules.fundedMainWin, 4000);
  await page.screenshot({ path: 'artifacts/settings-desktop.png', fullPage: true });

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).first().click();
  const download = await downloadPromise;
  await download.saveAs('artifacts/exported-backup.json');
  await page.getByRole('button', { name: 'Reset all data', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  assert.equal(funded(await read()).balance, 50700);
  await page.getByRole('button', { name: 'Reset all data', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset all data', exact: true }).click();
  assert.equal((await read()).events.length, 0);
  assert.equal((await read()).accounts.length, 5);

  await nav('Settings').click();
  await page.getByLabel('Choose backup file').setInputFiles('artifacts/exported-backup.json');
  await page.getByRole('dialog').getByRole('button', { name: 'Restore backup', exact: true }).click();
  assert.equal(funded(await read()).balance, 50700);
  await nav('Settings').click();
  await page.getByLabel('Choose backup file').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{invalid') });
  await page.getByRole('status').filter({ hasText: 'Import failed' }).waitFor();
  assert.equal(funded(await read()).balance, 50700);

  const mobile = await context.newPage();
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.goto(url);
  await mobile.getByRole('heading', { name: 'Account overview' }).waitFor();
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.screenshot({ path: 'artifacts/dashboard-mobile.png', fullPage: true });
  await mobile.getByRole('button', { name: 'Toggle navigation' }).click();
  await mobile.getByRole('navigation').getByRole('button', { name: 'Settings', exact: true }).click();
  await mobile.getByRole('heading', { name: 'Account settings' }).waitFor();
  await mobile.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mobile.screenshot({ path: 'artifacts/settings-mobile.png', fullPage: true });

  // Restored backups must also recover their undo snapshots.
  await page.getByRole('button', { name: 'Undo last action' }).click();
  assert.equal((await read()).settings.fundedMainWin, 4000);

  // A separate clean browser context exercises evaluation failure and recovery.
  const clean = await browser.newContext({ viewport: { width: 320, height: 700 } });
  const cleanPage = await clean.newPage();
  await cleanPage.goto(url);
  await cleanPage.locator('.current-account').getByRole('button', { name: /^LOSS/ }).click();
  await cleanPage.locator('.current-account').getByRole('button', { name: /^LOSS/ }).click();
  const failed = await cleanPage.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
  assert.equal(failed.accounts[0].stage, 'evaluation_failed');
  assert.equal(failed.selectedId, 'eval-2');
  assert.equal(await cleanPage.locator('.account-card[data-account-id="eval-1"]').count(), 0);
  await cleanPage.getByRole('button', { name: 'Add evaluation for $90.00', exact: true }).click();
  const replaced = await cleanPage.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
  assert.equal(replaced.accounts.length, 6);
  assert.equal(replaced.accounts.at(-1).stage, 'waiting');
  assert.equal(replaced.selectedId, 'eval-2');
  assert.equal(await cleanPage.locator('.metric').filter({ hasText: 'Evaluation costs' }).locator('strong').innerText(), '$540.00');
  await cleanPage.screenshot({ path: 'artifacts/replacement-mobile.png', fullPage: true });
  await cleanPage.getByRole('button', { name: 'Undo last action' }).click();
  assert.equal(await cleanPage.locator('.metric').filter({ hasText: 'Evaluation costs' }).locator('strong').innerText(), '$450.00');
  assert.equal(await cleanPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await clean.close();

  // Migrate an existing workspace, then exercise replacement purchase prices and backup restore.
  const legacy = createState({ ...createState().settings, startingEvaluations: 1 });
  legacy.version = 1;
  delete legacy.settings.evaluationCostCents;
  delete legacy.accounts[0].rules.evaluationCostCents;
  delete legacy.accounts[0].purchaseCostCents;
  delete legacy.accounts[0].evaluationHighWater;
  const migratedContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await migratedContext.addInitScript(({ key, state }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(state));
  }, { key: STORAGE_KEY, state: legacy });
  const migratedPage = await migratedContext.newPage();
  migratedPage.on('pageerror', error => errors.push(error.message));
  await migratedPage.goto(url);
  const costMetric = () => migratedPage.locator('.metric').filter({ hasText: 'Evaluation costs' }).locator('strong');
  const migratedRead = () => migratedPage.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
  assert.equal(await costMetric().innerText(), '$90.20');
  await migratedPage.locator('.current-account').getByRole('button', { name: /^LOSS/ }).click();
  await migratedPage.locator('.current-account').getByRole('button', { name: /^LOSS/ }).click();
  await migratedPage.getByRole('heading', { name: 'No current accounts', exact: true }).waitFor();
  assert.equal(await migratedPage.locator('.account-card').count(), 0);
  assert.equal(await costMetric().innerText(), '$90.20');
  await migratedPage.reload();
  await migratedPage.getByRole('heading', { name: 'No current accounts', exact: true }).waitFor();
  await migratedPage.getByRole('button', { name: 'Add evaluation for $90.00', exact: true }).click();
  assert.equal((await migratedRead()).version, VERSION);
  assert.equal((await migratedRead()).selectedId, 'eval-2');
  assert.equal(await costMetric().innerText(), '$180.20');
  await migratedPage.reload();
  assert.equal(await costMetric().innerText(), '$180.20');
  await migratedPage.getByRole('button', { name: 'Undo last action' }).click();
  assert.equal((await migratedRead()).selectedId, 'eval-1');
  assert.equal(await costMetric().innerText(), '$90.20');

  const migratedNav = label => migratedPage.getByRole('navigation').getByRole('button', { name: new RegExp(`^${label}`) });
  await migratedNav('Settings').click();
  assert.equal(await migratedPage.getByLabel('Cost per evaluation', { exact: true }).inputValue(), '90.00');
  await migratedPage.getByLabel('Cost per evaluation', { exact: true }).fill('91.25');
  await migratedPage.getByRole('button', { name: 'Save rules' }).click();
  assert.equal((await migratedRead()).settings.evaluationCostCents, 9125);
  await migratedNav('Dashboard').click();
  await migratedPage.getByRole('button', { name: 'Add evaluation for $91.25', exact: true }).click();
  assert.equal(await costMetric().innerText(), '$181.45');
  await migratedNav('Accounts').click();
  await migratedPage.getByRole('button', { name: 'Add evaluation for $91.25', exact: true }).click();
  assert.equal((await migratedRead()).accounts.length, 3);
  await migratedPage.screenshot({ path: 'artifacts/purchased-accounts-desktop.png', fullPage: true });
  await migratedNav('History').click();
  await migratedPage.getByRole('heading', { name: 'Activity history' }).waitFor();
  assert.ok(await migratedPage.locator('.history-event').filter({ hasText: 'Evaluation purchased' }).filter({ hasText: '-$91.25' }).count() >= 1);
  await migratedPage.screenshot({ path: 'artifacts/purchase-history-desktop.png', fullPage: true });

  const purchaseDownload = migratedPage.waitForEvent('download');
  await migratedPage.getByRole('button', { name: 'Export backup', exact: true }).click();
  await (await purchaseDownload).saveAs('artifacts/purchased-backup.json');
  await migratedNav('Settings').click();
  await migratedPage.getByRole('button', { name: 'Reset all data', exact: true }).click();
  await migratedPage.getByRole('dialog').getByRole('button', { name: 'Reset all data', exact: true }).click();
  assert.equal(await costMetric().innerText(), '$91.25');
  await migratedNav('Settings').click();
  await migratedPage.getByLabel('Choose backup file').setInputFiles('artifacts/purchased-backup.json');
  await migratedPage.getByRole('dialog').getByRole('button', { name: 'Restore backup', exact: true }).click();
  assert.equal(await costMetric().innerText(), '$272.70');
  await migratedPage.getByRole('button', { name: 'Undo last action' }).click();
  assert.equal(await costMetric().innerText(), '$181.45');
  await migratedContext.close();
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: trading lifecycle, exact evaluation costs, replacement accounts, v1 migration, purchase price settings, undo, backup restore, desktop and mobile.');
} catch (error) {
  console.error('Page errors:', errors);
  await page.screenshot({ path: 'artifacts/browser-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
