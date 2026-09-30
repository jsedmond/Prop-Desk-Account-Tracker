import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { applyAction, createState, parseBackup, STORAGE_KEY, summarize, VERSION } from '../src/domain.js';

const url = process.env.TRACKER_URL || 'http://127.0.0.1:5173';
const today = '2026-09-29';
const anchor = '2026-09-27';
const beforeAnchor = '2026-09-26';
const browser = await chromium.launch({ channel: process.env.TRACKER_BROWSER || 'msedge', headless: true });
const errors = [];
const read = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
const funded = state => state.accounts.find(account => account.id === 'funded-1');
const panel = page => page.locator('.current-account');
const tile = page => page.locator('article.account-card[data-account-id="funded-1"]');
const result = (surface, value) => surface.getByRole('button', { name: value === 'win' ? /^WIN/ : /^LOSS/ });
const noOverflow = async page => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Horizontal overflow at ${page.viewportSize().width}px`);

function seed() {
  let state = createState({ ...createState().settings, startingEvaluations: 2, qualifyingWins: 2 });
  for (let index = 1; index <= 2; index += 1) {
    state = applyAction(state, { type: 'record_result', accountId: 'eval-1', result: 'win', date: '2026-09-24' }, {
      actionId: `qualifying-seed-${index}`, timestamp: '2026-09-29T12:00:00.000Z',
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
  await tile(page).getByRole('button', { name: 'View Funded 01', exact: true }).click();
  await expect(panel(page).getByRole('heading', { name: 'Funded 01', exact: true })).toBeVisible();
  return { context, page };
}

async function record(page, surface, label, value, date) {
  const before = await read(page);
  await surface.getByLabel(label, { exact: true }).fill(date);
  await result(surface, value).click();
  await page.waitForFunction(({ key, length }) => JSON.parse(localStorage.getItem(key)).events.length > length, { key: STORAGE_KEY, length: before.events.length });
  const after = await read(page);
  assert.equal(after.events.findLast(event => event.type === 'trade').date, date);
  for (const original of before.accounts.filter(account => account.id !== 'funded-1')) {
    assert.deepEqual(after.accounts.find(account => account.id === original.id), original, 'Another account changed with the qualifying result');
  }
  return after;
}

async function blocked(page, surface, label, date, minDate = anchor) {
  const before = await read(page);
  const input = surface.getByLabel(label, { exact: true });
  await expect(input).toHaveAttribute('min', minDate);
  await expect(input).toHaveAttribute('max', today);
  await input.fill(date);
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  for (const value of ['win', 'loss']) {
    await expect(result(surface, value)).toBeDisabled();
    await result(surface, value).evaluate(button => button.click());
  }
  await expect(surface.getByRole('alert')).toBeVisible();
  assert.deepEqual(await read(page), before, 'An invalid qualifying date changed the saved workspace');
  await noOverflow(page);
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
  const { context, page } = await workspace(seed(), { width: 1440, height: 1100 });
  desktopPage = page;
  assert.equal(await panel(page).getByLabel('Trade date', { exact: true }).getAttribute('min'), null);
  let current = await record(page, panel(page), 'Trade date', 'win', anchor);
  assert.equal(funded(current).stage, 'qualifying');
  assert.equal(funded(current).mainWinDate, anchor);
  assert.equal(funded(current).balance, 54000);
  const mainWinState = structuredClone(current);
  await blocked(page, panel(page), 'Trade date', beforeAnchor);
  await blocked(page, tile(page), 'Trade date for Funded 01', beforeAnchor);
  await screenshot(page, 'artifacts/qualifying-date-warning-desktop.png');

  current = await record(page, panel(page), 'Trade date', 'win', anchor);
  assert.deepEqual(funded(current).qualifyingDates, [anchor]);
  assert.equal(funded(current).balance, 54200);
  await expect(result(panel(page), 'win')).toBeDisabled();
  await expect(result(panel(page), 'loss')).toBeEnabled();
  const sameDayWin = structuredClone(current);
  current = await record(page, panel(page), 'Trade date', 'loss', anchor);
  assert.equal(funded(current).balance, 54000);
  assert.deepEqual(funded(current).qualifyingDates, [anchor]);
  await blocked(page, tile(page), 'Trade date for Funded 01', '2026-09-30');
  await expect(tile(page).getByRole('alert')).toContainText('Future');
  await blocked(page, tile(page), 'Trade date for Funded 01', beforeAnchor);
  current = await record(page, tile(page), 'Trade date for Funded 01', 'win', '2026-09-28');
  assert.equal(funded(current).stage, 'payout_ready');
  assert.equal(funded(current).mainWinDate, anchor);
  assert.deepEqual(funded(current).qualifyingDates, [anchor, '2026-09-28']);

  await panel(page).getByRole('button', { name: 'Take $3,000 payout', exact: true }).click();
  current = await read(page);
  assert.equal(funded(current).cycle, 2);
  assert.equal(funded(current).stage, 'main');
  assert.equal(funded(current).mainWinDate, null);
  assert.equal(summarize(current).withdrawn, 3000);
  assert.equal(await panel(page).getByLabel('Trade date', { exact: true }).getAttribute('min'), null);
  assert.equal(await tile(page).getByLabel('Trade date for Funded 01', { exact: true }).getAttribute('min'), null);
  current = await record(page, panel(page), 'Trade date', 'win', today);
  assert.equal(funded(current).mainWinDate, today);
  await blocked(page, panel(page), 'Trade date', '2026-09-28', today);
  await blocked(page, tile(page), 'Trade date for Funded 01', '2026-09-28', today);
  current = await record(page, tile(page), 'Trade date for Funded 01', 'win', today);
  assert.deepEqual(funded(current).qualifyingDates, [today]);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).click();
  await (await downloadPromise).saveAs('artifacts/qualifying-date-backup.json');
  const backup = parseBackup(await readFile('artifacts/qualifying-date-backup.json', 'utf8'));
  assert.equal(funded(backup).mainWinDate, today);
  await page.reload();
  await expect(panel(page).getByLabel('Trade date', { exact: true })).toHaveAttribute('min', today);
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal(funded(await read(page)).mainWinDate, today);
  assert.deepEqual(funded(await read(page)).qualifyingDates, []);
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal(funded(await read(page)).stage, 'main');
  assert.equal(funded(await read(page)).mainWinDate, null);
  assert.equal(await panel(page).getByLabel('Trade date', { exact: true }).getAttribute('min'), null);
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal(funded(await read(page)).stage, 'payout_ready');
  assert.equal(funded(await read(page)).mainWinDate, anchor);
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal(funded(await read(page)).stage, 'qualifying');
  await expect(panel(page).getByLabel('Trade date', { exact: true })).toHaveAttribute('min', anchor);

  const { context: mobileContext, page: mobile } = await workspace(mainWinState, { width: 390, height: 844 });
  await blocked(mobile, panel(mobile), 'Trade date', beforeAnchor);
  await blocked(mobile, tile(mobile), 'Trade date for Funded 01', beforeAnchor);
  await screenshot(mobile, 'artifacts/qualifying-date-warning-mobile.png');
  await mobile.setViewportSize({ width: 320, height: 844 });
  await noOverflow(mobile);
  await screenshot(mobile, 'artifacts/qualifying-date-warning-mobile-320.png');
  await mobileContext.close();
  const { context: backupContext, page: restored } = await workspace(backup, { width: 1440, height: 1100 });
  await blocked(restored, tile(restored), 'Trade date for Funded 01', '2026-09-28', today);
  assert.equal(summarize(await read(restored)).withdrawn, 3000);
  await backupContext.close();

  // Legacy histories retain earlier qualifying days while new actions use the recovered main-win anchor.
  const legacy = structuredClone(sameDayWin);
  legacy.version = 4;
  for (const accounts of [legacy.accounts, ...legacy.undoStack.map(snapshot => snapshot.accounts)]) {
    for (const account of accounts) delete account.mainWinDate;
  }
  funded(legacy).qualifyingDates = [beforeAnchor];
  const legacyQualifyingAction = legacy.events.findLast(event => event.type === 'trade' && event.stage === 'qualifying').actionId;
  for (const event of legacy.events.filter(event => event.actionId === legacyQualifyingAction)) event.date = beforeAnchor;
  const { context: legacyContext, page: legacyPage } = await workspace(legacy, { width: 1440, height: 1100 });
  assert.equal((await read(legacyPage)).version, VERSION);
  assert.equal(funded(await read(legacyPage)).mainWinDate, anchor);
  assert.deepEqual(funded(await read(legacyPage)).qualifyingDates, [beforeAnchor]);
  await blocked(legacyPage, tile(legacyPage), 'Trade date for Funded 01', beforeAnchor);
  await legacyPage.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal(funded(await read(legacyPage)).mainWinDate, anchor);
  assert.deepEqual(funded(await read(legacyPage)).qualifyingDates, []);
  await legacyPage.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal(funded(await read(legacyPage)).mainWinDate, null);
  assert.equal(funded(await read(legacyPage)).stage, 'main');
  await legacyContext.close();
  await context.close();
  assert.deepEqual(errors, []);
  console.log('Qualifying-date browser checks passed: main-win inclusive minimum, early Win/Loss blocked, same/later dates, duplicate/future guards, payout-cycle reset, reload, backups, undo, v4 migration, legacy earlier history, desktop and mobile warnings.');
} catch (error) {
  console.error('Page errors:', errors);
  await desktopPage?.screenshot({ path: 'artifacts/qualifying-date-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
