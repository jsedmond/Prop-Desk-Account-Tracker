import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { applyAction, createState, evaluationFailureLevel, parseBackup, STORAGE_KEY, summarize, VERSION } from '../src/domain.js';

const url = process.env.TRACKER_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: process.env.TRACKER_BROWSER || 'msedge', headless: true });
const errors = [];
const targetId = 'eval-2';
const account = (state, id = targetId) => state.accounts.find(item => item.id === id);
const tile = (page, id = targetId) => page.locator(`article.account-card[data-account-id="${id}"]`);
const read = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
const noOverflow = async page => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Horizontal overflow at ${page.viewportSize().width}px`);

function seedAccounts() {
  let state = createState({ ...createState().settings, startingEvaluations: 3 });
  for (let index = 1; index <= 2; index += 1) {
    state = applyAction(state, { type: 'record_result', accountId: 'eval-1', result: 'win', date: '2026-09-24' }, {
      actionId: `trailing-seed-${index}`, timestamp: '2026-09-29T12:00:00.000Z',
    });
  }
  return state;
}

async function workspace(state, viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true, timezoneId: 'America/Chicago' });
  await context.addInitScript(({ key, initial }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(initial));
  }, { key: STORAGE_KEY, initial: state });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-09-29T17:00:00Z'));
  await page.goto(url);
  await page.getByRole('heading', { name: 'Account overview' }).waitFor();
  return { context, page };
}

async function floor(page, value) {
  await expect(page.locator('.current-account .risk-note strong')).toHaveText(money(value));
  await expect(tile(page).locator('.evaluation-floor strong')).toHaveText(money(value));
}

async function record(page, result, date) {
  const before = await read(page);
  await tile(page).getByLabel('Trade date for Evaluation 02', { exact: true }).fill(date);
  await tile(page).getByRole('button', { name: result === 'win' ? /^WIN/ : /^LOSS/ }).click();
  await page.waitForFunction(({ key, length }) => JSON.parse(localStorage.getItem(key)).events.length > length, { key: STORAGE_KEY, length: before.events.length });
  const after = await read(page);
  assert.equal(after.events.findLast(event => event.type === 'trade').date, date);
  for (const original of before.accounts.filter(item => ![targetId, 'eval-3'].includes(item.id))) {
    assert.deepEqual(account(after, original.id), original, 'Another account changed when recording the evaluation result');
  }
  return after;
}

async function archivedView(page) {
  const nav = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /^Accounts/ });
  if (await page.locator('.sidebar').evaluate(sidebar => sidebar.getBoundingClientRect().right <= 0)) {
    await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
  }
  await nav.click();
  if (await page.getByRole('button', { name: 'Toggle navigation', exact: true }).isVisible()) {
    await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  }
  await page.locator('.account-filters').getByRole('button', { name: /^Archived/ }).click();
  await expect(tile(page, 'eval-1')).toBeVisible();
  await expect(tile(page, 'eval-1')).toContainText('Evaluation Passed');
  await expect(tile(page, 'eval-1')).toContainText('$53,000');
  await expect(tile(page, 'eval-1').locator('.evaluation-floor strong')).toHaveText('$50,000');
  await expect(tile(page, 'eval-1').getByRole('button')).toHaveCount(1);
  await expect(tile(page)).toBeVisible();
  await expect(tile(page).getByRole('button')).toHaveCount(1);
  await expect(tile(page).locator('.evaluation-floor strong')).toHaveText('$50,000');
}

async function screenshot(page, path) {
  const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await dismiss.count()) await dismiss.click();
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path, fullPage: true });
}

async function backup(page, path) {
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).click();
  await (await downloadPromise).saveAs(path);
  return parseBackup(await readFile(path, 'utf8'));
}

let desktopPage;
await mkdir('artifacts', { recursive: true });
try {
  const seed = seedAccounts();
  const { context, page } = await workspace(seed, { width: 1440, height: 1100 });
  desktopPage = page;
  await expect(tile(page, 'eval-1')).toHaveCount(0);
  await expect(tile(page, 'funded-1').getByRole('button', { name: /^WIN/ })).toBeEnabled();
  await floor(page, 48000);
  let current = await record(page, 'win', '2026-09-25');
  assert.equal(account(current).balance, 51500);
  assert.equal(account(current).evaluationHighWater, 51500);
  assert.equal(evaluationFailureLevel(account(current)), 49500);
  assert.deepEqual(account(current, 'eval-3'), account(seed, 'eval-3'));
  await floor(page, 49500);

  current = await record(page, 'loss', '2026-09-26');
  assert.equal(account(current).balance, 50500);
  assert.equal(account(current).evaluationHighWater, 51500);
  await floor(page, 49500);
  const afterLoss = structuredClone(current);

  current = await record(page, 'win', '2026-09-27');
  assert.equal(account(current).balance, 52000);
  assert.equal(account(current).evaluationHighWater, 52000);
  await floor(page, 50000);
  const capped = await backup(page, 'artifacts/trailing-capped-backup.json');
  assert.deepEqual(capped.accounts, current.accounts);
  await screenshot(page, 'artifacts/trailing-capped-desktop.png');
  await page.reload();
  await floor(page, 50000);

  current = await record(page, 'loss', '2026-09-28');
  assert.equal(account(current).balance, 51000);
  assert.equal(account(current).stage, 'evaluation');
  assert.equal(account(current).evaluationHighWater, 52000);
  await floor(page, 50000);
  current = await record(page, 'loss', '2026-09-29');
  assert.equal(account(current).balance, 50000);
  assert.equal(account(current).stage, 'evaluation_failed');
  assert.equal(account(current).evaluationHighWater, 52000);
  assert.equal(evaluationFailureLevel(account(current)), 50000);
  assert.equal(account(current, 'eval-3').evaluationRole, 'primary');
  assert.equal(evaluationFailureLevel(account(current, 'eval-3')), 48000);
  await expect(tile(page)).toHaveCount(0);
  assert.equal(summarize(current).costCents, summarize(seed).costCents);
  assert.equal(summarize(current).withdrawn, summarize(seed).withdrawn);
  await archivedView(page);
  await expect(tile(page)).toContainText('$50,000');
  await screenshot(page, 'artifacts/trailing-archived-desktop.png');
  const archived = await backup(page, 'artifacts/trailing-archived-backup.json');
  assert.equal(evaluationFailureLevel(account(archived)), 50000);
  await page.reload();
  await archivedView(page);

  // Undo restores both the balance and the high-water mark saved at each action.
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal(account(await read(page)).balance, 51000);
  assert.equal(account(await read(page)).stage, 'evaluation');
  assert.equal(evaluationFailureLevel(account(await read(page))), 50000);
  await expect(tile(page)).toHaveCount(0);
  await page.locator('.account-filters').getByRole('button', { name: /^All accounts/ }).click();
  await expect(tile(page).locator('.evaluation-floor strong')).toHaveText('$50,000');
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal(account(await read(page)).balance, 52000);
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal(account(await read(page)).balance, 50500);
  assert.equal(account(await read(page)).evaluationHighWater, 51500);
  await expect(tile(page).locator('.evaluation-floor strong')).toHaveText('$49,500');

  const { context: mobileContext, page: mobile } = await workspace(capped, { width: 390, height: 844 });
  await floor(mobile, 50000);
  await screenshot(mobile, 'artifacts/trailing-capped-mobile.png');
  await mobile.setViewportSize({ width: 320, height: 844 });
  await floor(mobile, 50000);
  await screenshot(mobile, 'artifacts/trailing-capped-mobile-320.png');
  await mobileContext.close();
  const { context: archiveContext, page: archiveMobile } = await workspace(archived, { width: 390, height: 844 });
  await archivedView(archiveMobile);
  await screenshot(archiveMobile, 'artifacts/trailing-archived-mobile.png');
  await archiveMobile.setViewportSize({ width: 320, height: 844 });
  await screenshot(archiveMobile, 'artifacts/trailing-archived-mobile-320.png');
  await archiveContext.close();

  // Version 3 histories reconstruct the peak after a loss and inside undo snapshots.
  const legacy = structuredClone(afterLoss);
  legacy.version = 3;
  for (const accounts of [legacy.accounts, ...legacy.undoStack.map(snapshot => snapshot.accounts)]) {
    for (const item of accounts) delete item.evaluationHighWater;
  }
  const { context: legacyContext, page: legacyPage } = await workspace(legacy, { width: 1440, height: 1100 });
  await floor(legacyPage, 49500);
  await legacyPage.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal((await read(legacyPage)).version, VERSION);
  assert.equal(account(await read(legacyPage)).balance, 51500);
  assert.equal(account(await read(legacyPage)).evaluationHighWater, 51500);
  await floor(legacyPage, 49500);
  await legacyPage.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal(account(await read(legacyPage)).balance, 50000);
  assert.equal(account(await read(legacyPage)).evaluationHighWater, 50000);
  await floor(legacyPage, 48000);
  await legacyContext.close();
  await context.close();
  assert.deepEqual(errors, []);
  console.log('Trailing evaluation browser checks passed: W/L/W high-water progression, fixed $2,000 distance, $50,000 cap, exact boundary archive, independent accounts, historical dates, reload, backups, undo, v3 migration, desktop and mobile.');
} catch (error) {
  console.error('Page errors:', errors);
  await desktopPage?.screenshot({ path: 'artifacts/trailing-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
