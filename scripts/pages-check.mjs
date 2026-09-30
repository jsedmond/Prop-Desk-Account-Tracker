import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { parseBackup, STORAGE_KEY, summarize, VERSION } from '../src/domain.js';

const url = process.env.TRACKER_URL || 'http://127.0.0.1:4173/Prop-Desk-Account-Tracker/';
const basePath = '/Prop-Desk-Account-Tracker/';
const today = '2026-09-29';
const browser = await chromium.launch({ channel: process.env.TRACKER_BROWSER || 'msedge', headless: true });
const errors = [];
const assetFailures = [];
const account = (state, id) => state.accounts.find(item => item.id === id);
const tile = (page, id) => page.locator(`article.account-card[data-account-id="${id}"]`);
const label = id => `${id.startsWith('funded-') ? 'Funded' : 'Evaluation'} ${id.split('-')[1].padStart(2, '0')}`;
const read = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
const result = (surface, value) => surface.getByRole('button', { name: value === 'win' ? /^WIN/ : /^LOSS/ });
const noOverflow = async page => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Horizontal overflow at ${page.viewportSize().width}px`);

async function workspace(viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true, timezoneId: 'America/Chicago' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) assetFailures.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', request => {
    if (!request.failure()?.errorText.includes('ERR_ABORTED')) assetFailures.push(`${request.failure()?.errorText} ${request.url()}`);
  });
  await page.clock.setFixedTime(new Date('2026-09-29T17:00:00Z'));
  const response = await page.goto(url);
  assert.equal(response.status(), 200);
  await page.getByRole('heading', { name: 'Account overview' }).waitFor();
  await expect(page).toHaveTitle('Prop Desk | Account Tracker');
  const assets = await page.locator('script[src], link[rel="stylesheet"], link[rel="icon"]').evaluateAll(elements => elements.map(element => element.src || element.href));
  assert.ok(assets.some(asset => new URL(asset).pathname.endsWith('.js')), 'Missing built JavaScript');
  assert.ok(assets.some(asset => new URL(asset).pathname.endsWith('.css')), 'Missing built stylesheet');
  for (const asset of assets) assert.equal(new URL(asset).pathname.startsWith(basePath), true, `Asset escaped the GitHub Pages subpath: ${asset}`);
  const favicon = await page.locator('link[rel="icon"]').getAttribute('href');
  const faviconResponse = await page.request.get(new URL(favicon, page.url()).href);
  assert.equal(faviconResponse.status(), 200, 'Favicon is unavailable');
  assert.match(faviconResponse.headers()['content-type'], /image\/svg\+xml/);
  assert.match(await faviconResponse.text(), /<svg[\s>]/);
  return { context, page };
}

async function navigate(page, destination) {
  const nav = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: new RegExp(`^${destination}`) });
  if (await page.locator('.sidebar').evaluate(sidebar => sidebar.getBoundingClientRect().right <= 0)) {
    await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
  }
  await nav.click();
  if (await page.getByRole('button', { name: 'Toggle navigation', exact: true }).isVisible()) {
    await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  }
}

async function record(page, id, value, date) {
  const before = await read(page);
  await tile(page, id).getByLabel(`Trade date for ${label(id)}`, { exact: true }).fill(date);
  await result(tile(page, id), value).click();
  await page.waitForFunction(({ key, length }) => JSON.parse(localStorage.getItem(key)).events.length > length, { key: STORAGE_KEY, length: before?.events.length || 0 });
  const after = await read(page);
  assert.equal(after.events.findLast(event => event.type === 'trade').date, date);
  return after;
}

async function blocked(page, surface, dateLabel, date) {
  const before = await read(page);
  await surface.getByLabel(dateLabel, { exact: true }).fill(date);
  for (const value of ['win', 'loss']) {
    await expect(result(surface, value)).toBeDisabled();
    await result(surface, value).evaluate(button => button.click());
  }
  await expect(surface.getByRole('alert')).toBeVisible();
  assert.deepEqual(await read(page), before, 'Blocked date changed production data');
}

async function archived(page) {
  await navigate(page, 'Accounts');
  await page.locator('.account-filters').getByRole('button', { name: /^Archived/ }).click();
  await expect(page.locator('article.account-card')).toHaveCount(3);
  for (const id of ['eval-1', 'eval-2', 'funded-1']) {
    await expect(tile(page, id)).toBeVisible();
    await expect(tile(page, id).getByRole('button')).toHaveCount(1);
  }
}

async function restore(page) {
  await navigate(page, 'Settings');
  await page.getByLabel('Choose backup file').setInputFiles('artifacts/pages-backup.json');
  await page.getByRole('dialog').getByRole('button', { name: 'Restore backup', exact: true }).click();
  await page.getByRole('heading', { name: 'Account overview' }).waitFor();
}

async function screenshot(page, path) {
  const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await dismiss.count()) await dismiss.click();
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path, fullPage: true });
}

let desktopPage;
await mkdir('artifacts', { recursive: true });
try {
  const { context, page } = await workspace({ width: 1440, height: 1100 });
  desktopPage = page;
  assert.equal(await read(page), null, 'Production check must use an isolated fresh browser');
  await expect(page.locator('.metric').filter({ hasText: 'Evaluation costs' }).locator('strong')).toHaveText('$450.00');
  await expect(page.locator('.current-account')).toContainText('Active Evaluation');
  await expect(result(tile(page, 'eval-1'), 'win')).toBeEnabled();
  await expect(result(tile(page, 'eval-2'), 'loss')).toBeEnabled();
  await blocked(page, page.locator('.current-account'), 'Trade date', '2026-09-30');
  let current = await record(page, 'eval-2', 'loss', '2026-09-26');
  assert.equal(account(current, 'eval-2').balance, 49000);
  assert.equal(account(current, 'eval-1').balance, 50000);
  current = await record(page, 'eval-1', 'win', '2026-09-24');
  assert.equal(account(current, 'eval-1').balance, 51500);
  assert.equal(account(current, 'eval-2').balance, 49000);
  current = await record(page, 'eval-3', 'loss', '2026-09-25');
  assert.equal(account(current, 'eval-3').balance, 49000);
  current = await record(page, 'eval-1', 'win', '2026-09-25');
  assert.equal(account(current, 'eval-1').stage, 'passed');
  assert.equal(account(current, 'funded-1').stage, 'main');
  await expect(tile(page, 'eval-1')).toHaveCount(0);
  current = await record(page, 'eval-2', 'loss', '2026-09-26');
  assert.equal(account(current, 'eval-2').stage, 'evaluation_failed');
  await expect(tile(page, 'eval-2')).toHaveCount(0);

  await tile(page, 'funded-1').getByRole('button', { name: 'View Funded 01', exact: true }).click();
  current = await record(page, 'funded-1', 'win', '2026-09-25');
  assert.equal(account(current, 'funded-1').mainWinDate, '2026-09-25');
  await expect(tile(page, 'funded-1').getByLabel('Trade date for Funded 01', { exact: true })).toHaveAttribute('min', '2026-09-25');
  await blocked(page, tile(page, 'funded-1'), 'Trade date for Funded 01', '2026-09-24');
  for (const date of ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']) {
    current = await record(page, 'funded-1', 'win', date);
    if (date !== '2026-09-28') await expect(result(tile(page, 'funded-1'), 'win')).toBeDisabled();
  }
  assert.equal(account(current, 'funded-1').stage, 'payout_ready');
  await tile(page, 'funded-1').getByRole('button', { name: 'Take $3,000 payout', exact: true }).click();
  assert.equal(account(await read(page), 'funded-1').mainWinDate, null);
  current = await record(page, 'funded-1', 'loss', today);
  await expect(result(tile(page, 'funded-1'), 'loss')).toContainText('$800');
  current = await record(page, 'funded-1', 'loss', today);
  assert.equal(account(current, 'funded-1').stage, 'funded_failed');
  assert.equal(account(current, 'funded-1').balance, 50000);
  assert.equal(summarize(current).withdrawn, 3000);
  await expect(tile(page, 'funded-1')).toHaveCount(0);
  await archived(page);
  await page.getByRole('button', { name: 'Add evaluation for $90.00', exact: true }).click();
  current = await read(page);
  assert.equal(account(current, 'eval-6').stage, 'waiting');
  assert.equal(summarize(current).costCents, 54000);
  await screenshot(page, 'artifacts/pages-archive-desktop.png');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).click();
  await (await downloadPromise).saveAs('artifacts/pages-backup.json');
  const backup = parseBackup(await readFile('artifacts/pages-backup.json', 'utf8'));
  assert.equal(backup.version, VERSION);
  assert.deepEqual(backup.accounts, current.accounts);
  await navigate(page, 'Settings');
  await page.getByRole('button', { name: 'Reset all data', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset all data', exact: true }).click();
  assert.equal((await read(page)).events.length, 0);
  await restore(page);
  await page.reload();
  assert.deepEqual((await read(page)).accounts, backup.accounts);
  assert.equal(summarize(await read(page)).withdrawn, 3000);
  await screenshot(page, 'artifacts/pages-desktop.png');
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal(summarize(await read(page)).costCents, 45000);
  assert.equal(account(await read(page), 'eval-6'), undefined);
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal(account(await read(page), 'funded-1').stage, 'main');
  await expect(result(page.locator('.current-account'), 'loss')).toContainText('$800');

  const { context: mobileContext, page: mobile } = await workspace({ width: 390, height: 844 });
  await restore(mobile);
  assert.deepEqual((await read(mobile)).accounts, backup.accounts);
  await screenshot(mobile, 'artifacts/pages-mobile.png');
  await mobile.setViewportSize({ width: 320, height: 844 });
  await screenshot(mobile, 'artifacts/pages-mobile-320.png');
  await archived(mobile);
  await screenshot(mobile, 'artifacts/pages-archive-mobile-320.png');
  await mobileContext.close();
  await context.close();
  assert.deepEqual(assetFailures, [], 'Production requests failed');
  assert.deepEqual(errors, [], 'Production browser errors');
  console.log('GitHub Pages production checks passed: subpath assets/favicon, independent historical results, future/qualifying date guards, evaluation/funded archive, costs/payouts, replacement accounts, backup restore, reload, undo, desktop and mobile.');
} catch (error) {
  console.error('Browser errors:', errors);
  console.error('Asset failures:', assetFailures);
  await desktopPage?.screenshot({ path: 'artifacts/pages-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
