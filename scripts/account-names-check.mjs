import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createState, DEFAULT_SETTINGS, exportBackup, MAX_ACCOUNT_NAME_LENGTH, parseBackup, STORAGE_KEY, summarize, VERSION } from '../src/domain.js';

const url = process.env.TRACKER_URL || 'http://127.0.0.1:5173/';
const browser = await chromium.launch({ channel: process.env.TRACKER_BROWSER || 'msedge', headless: true });
const errors = [];
const tile = (page, id) => page.locator(`article.account-card[data-account-id="${id}"]`);
const read = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
const account = (state, id) => state.accounts.find(item => item.id === id);
await mkdir('artifacts', { recursive: true });

async function workspace(width = 1440, initial) {
  const context = await browser.newContext({ viewport: { width, height: width < 650 ? 844 : 1000 }, acceptDownloads: true, timezoneId: 'America/Chicago' });
  if (initial) await context.addInitScript(({ key, state }) => localStorage.setItem(key, JSON.stringify(state)), { key: STORAGE_KEY, state: initial });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-09-29T17:00:00Z'));
  await page.goto(url);
  await page.getByRole('heading', { name: 'Account overview', exact: true }).waitFor();
  return { context, page };
}

async function navigate(page, label) {
  if (await page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().right <= 0)) {
    await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
  }
  await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: new RegExp(`^${label}`) }).click();
  if (await page.getByRole('button', { name: 'Toggle navigation', exact: true }).isVisible()) {
    await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  }
}

async function rename(page, surface, value, enter = false) {
  await surface.getByRole('button', { name: /^Rename / }).click();
  const dialog = page.getByRole('dialog');
  const input = dialog.getByLabel('Account number or name', { exact: true });
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('maxlength', String(MAX_ACCOUNT_NAME_LENGTH));
  await input.fill(value);
  if (enter) await input.press('Enter');
  else await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function screenshot(page, path) {
  const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await dismiss.count()) await dismiss.click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${page.viewportSize().width}px`);
  for (const header of await page.locator('.account-card-header').all()) {
    assert.equal(await header.evaluate(element => {
      const title = element.querySelector('.account-card-top').getBoundingClientRect();
      const edit = element.querySelector('.icon-button').getBoundingClientRect();
      return title.right <= edit.left + 1;
    }), true, 'An account title overlaps its rename control');
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path, fullPage: false });
}

async function restore(page) {
  await navigate(page, 'Settings');
  await page.getByLabel('Choose backup file').setInputFiles('artifacts/account-names-backup.json');
  await page.getByRole('dialog').getByRole('button', { name: 'Restore backup', exact: true }).click();
  await page.getByRole('heading', { name: 'Account overview', exact: true }).waitFor();
}

try {
  const { context, page } = await workspace();
  assert.equal(await read(page), null, 'Checks must use a fresh isolated context');
  await expect(page.locator('.account-card')).toHaveCount(5);
  await expect(page.locator('.metric').filter({ hasText: 'Evaluation costs' }).locator('strong')).toHaveText('$450.00');
  await navigate(page, 'Settings');
  await expect(page.getByLabel('Starting evaluations', { exact: true })).toHaveValue('5');
  await expect(page.getByLabel('Cost per evaluation', { exact: true })).toHaveValue('90.00');
  await navigate(page, 'Dashboard');
  await page.getByRole('button', { name: 'Add evaluation for $90.00', exact: true }).click();
  assert.equal(account(await read(page), 'eval-6').purchaseCostCents, 9000);
  assert.equal(summarize(await read(page)).costCents, 54000);
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal((await read(page)).accounts.length, 5);

  const original = await read(page);
  await rename(page, page.locator('.current-account'), '  000123-AB  ', true);
  assert.equal(account(await read(page), 'eval-1').customName, '000123-AB');
  assert.deepEqual(summarize(await read(page)), summarize(original));
  await expect(page.locator('.current-account h2')).toHaveText('000123-AB');
  await expect(tile(page, 'eval-1').getByRole('button', { name: 'View 000123-AB', exact: true })).toBeVisible();
  await tile(page, 'eval-1').getByRole('button', { name: 'Rename 000123-AB', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Save name', exact: true })).toBeDisabled();
  await page.getByRole('dialog').getByLabel('Account number or name').fill('Do not save');
  await page.getByRole('dialog').getByLabel('Account number or name').press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(account(await read(page), 'eval-1').customName, '000123-AB');
  await tile(page, 'eval-1').getByRole('button', { name: /^WIN/ }).click();
  await tile(page, 'eval-1').getByRole('button', { name: /^WIN/ }).click();
  assert.equal(account(await read(page), 'eval-1').customName, '000123-AB');
  assert.equal(account(await read(page), 'funded-1').customName, '');
  await tile(page, 'funded-1').getByRole('button', { name: 'View Funded 01', exact: true }).click();
  await rename(page, tile(page, 'funded-1'), 'F-000789');
  await expect(page.locator('.current-account h2')).toHaveText('F-000789');
  await expect(tile(page, 'funded-1').getByLabel('Trade date for F-000789')).toBeVisible();
  await page.reload();
  assert.equal(account(await read(page), 'funded-1').customName, 'F-000789');
  await navigate(page, 'History');
  await expect(page.locator('.history-event').filter({ hasText: 'Evaluation passed' }).locator('.event-account strong')).toHaveText('000123-AB');
  await expect(page.locator('.history-event').filter({ hasText: 'Account renamed' })).toHaveCount(2);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).click();
  await (await download).saveAs('artifacts/account-names-backup.json');
  const backup = parseBackup(await readFile('artifacts/account-names-backup.json', 'utf8'));
  assert.equal(backup.version, VERSION);
  await navigate(page, 'Settings');
  await page.getByRole('button', { name: 'Reset all data', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reset all data', exact: true }).click();
  assert.equal((await read(page)).accounts.length, 5);
  assert.equal(summarize(await read(page)).costCents, 45000);
  await restore(page);
  assert.deepEqual((await read(page)).accounts, backup.accounts);
  await screenshot(page, 'artifacts/account-names-desktop.png');
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal(account(await read(page), 'funded-1').customName, '');
  assert.equal(account(await read(page), 'eval-1').customName, '000123-AB');
  await navigate(page, 'Accounts');
  await page.getByRole('button', { name: /^Archived/ }).click();
  await rename(page, tile(page, 'eval-1'), 'EVAL-ARCHIVED-000123');
  await expect(tile(page, 'eval-1').getByRole('button')).toHaveCount(1);
  await expect(tile(page, 'eval-1').getByRole('button', { name: /^WIN|^LOSS/ })).toHaveCount(0);
  assert.equal(account(await read(page), 'eval-1').stage, 'passed');

  const { context: mobileContext, page: mobile } = await workspace(390);
  await restore(mobile);
  const longName = '000123456789'.repeat(4);
  await rename(mobile, tile(mobile, 'funded-1'), longName);
  await expect(mobile.locator('.current-account h2')).toHaveText(longName);
  await screenshot(mobile, 'artifacts/account-names-mobile.png');
  await mobile.setViewportSize({ width: 320, height: 844 });
  await screenshot(mobile, 'artifacts/account-names-mobile-320.png');
  await tile(mobile, 'funded-1').getByRole('button', { name: /^Rename / }).click();
  await mobile.getByRole('dialog').getByRole('button', { name: 'Use default name', exact: true }).click();
  await mobile.getByRole('dialog').getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(mobile.locator('.current-account h2')).toHaveText('Funded 01');

  const legacy = createState({ ...DEFAULT_SETTINGS, startingEvaluations: 10, evaluationCostCents: 9020 });
  legacy.version = 5;
  legacy.accounts.forEach(item => { delete item.customName; });
  const { context: legacyContext, page: legacyPage } = await workspace(1440, JSON.parse(exportBackup(legacy)));
  await expect(legacyPage.locator('.metric').filter({ hasText: 'Evaluation costs' }).locator('strong')).toHaveText('$902.00');
  await legacyPage.getByRole('button', { name: 'Add evaluation for $90.00', exact: true }).click();
  const migrated = await read(legacyPage);
  assert.equal(migrated.accounts.length, 11);
  assert.equal(migrated.settings.startingEvaluations, 5);
  assert.equal(account(migrated, 'eval-1').purchaseCostCents, 9020);
  assert.equal(account(migrated, 'eval-11').purchaseCostCents, 9000);
  assert.equal(summarize(migrated).costCents, 99200);
  assert.deepEqual(parseBackup(exportBackup(migrated)), migrated);
  await legacyContext.close();
  await mobileContext.close();
  await context.close();
  assert.deepEqual(errors, []);
  console.log('Account name checks passed: five-account/$90 defaults, evaluation/funded/archive renames, keyboard/cancel/reset-name controls, unchanged financial state, history, reload, backup/undo, legacy prices and 390/320px layouts.');
} finally {
  await browser.close();
}
