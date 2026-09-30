import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { applyAction, createState, parseBackup, STORAGE_KEY, summarize } from '../src/domain.js';

const url = process.env.TRACKER_URL || 'http://127.0.0.1:5173';
const tradeDate = '2026-09-29';
const historicalDate = '2026-09-28';
const tomorrow = '2026-09-30';
const initialArchived = ['eval-1', 'eval-2', 'eval-3', 'eval-4'];
const passedArchived = [...initialArchived, 'eval-6'];
const allArchived = [...passedArchived, 'eval-7'];
const browser = await chromium.launch({ channel: process.env.TRACKER_BROWSER || 'msedge', headless: true });
const errors = [];
const account = (state, id) => state.accounts.find(item => item.id === id);
const name = id => `${id.startsWith('funded') ? 'Funded' : 'Evaluation'} ${id.split('-')[1].padStart(2, '0')}`;
const tile = (page, id) => page.locator(`article.account-card[data-account-id="${id}"]`);
const button = (page, id, result) => tile(page, id).getByRole('button', { name: result === 'win' ? /^WIN/ : /^LOSS/ });
const filter = (page, label) => page.locator('.account-filters').getByRole('button', { name: new RegExp(`^${label}`) });
const read = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
const noOverflow = async page => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Horizontal overflow at ${page.viewportSize().width}px`);

function seedAccounts() {
  let state = createState({ ...createState().settings, startingEvaluations: 8 });
  let actionNumber = 0;
  const trade = (accountId, result, date = tradeDate) => {
    state = applyAction(state, { type: 'record_result', accountId, result, date }, {
      actionId: `tile-seed-${++actionNumber}`, timestamp: '2026-09-29T12:00:00.000Z',
    });
  };
  for (const number of [1, 2]) {
    trade(`eval-${number}`, 'win');
    trade(`eval-${number}`, 'win');
  }
  trade('funded-2', 'win', '2026-09-27');
  trade('eval-3', 'loss');
  trade('eval-3', 'loss');
  trade('eval-4', 'win');
  trade('eval-4', 'win');
  trade('funded-4', 'win', '2026-09-24');
  for (const date of ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']) trade('funded-4', 'win', date);
  trade('eval-5', 'win');
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

async function accountsView(page) {
  const nav = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: /^Accounts/ });
  const sidebarClosed = await page.locator('.sidebar').evaluate(sidebar => sidebar.getBoundingClientRect().right <= 0);
  if (sidebarClosed) await page.getByRole('button', { name: 'Toggle navigation', exact: true }).click();
  await nav.click();
  await expect(page.getByRole('heading', { name: 'Your accounts' })).toBeVisible();
  if (await page.getByRole('button', { name: 'Toggle navigation', exact: true }).isVisible()) {
    await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
  }
}

function unchanged(before, after, changedIds) {
  for (const original of before.accounts.filter(item => !changedIds.includes(item.id))) {
    assert.deepEqual(account(after, original.id), original, `${original.id} changed when another account recorded a result`);
  }
}

async function record(page, id, result, date = tradeDate) {
  const before = await read(page);
  await tile(page, id).getByLabel(`Trade date for ${name(id)}`, { exact: true }).fill(date);
  await button(page, id, result).click();
  await page.waitForFunction(({ key, length }) => JSON.parse(localStorage.getItem(key)).events.length > length, { key: STORAGE_KEY, length: before.events.length });
  const after = await read(page);
  unchanged(before, after, [id]);
  return after;
}

async function closedTile(page, id) {
  for (const result of ['win', 'loss']) {
    for (const item of await button(page, id, result).all()) await expect(item).toBeDisabled();
  }
}

async function archivedView(page, ids) {
  await filter(page, 'Archived').click();
  await expect(page.locator('article.account-card')).toHaveCount(ids.length);
  for (const id of ids) {
    const funded = id.startsWith('funded-');
    const passed = !funded && !['eval-3', 'eval-7'].includes(id);
    await expect(tile(page, id)).toBeVisible();
    await expect(tile(page, id).locator(':scope > strong')).toHaveText(funded && id === 'funded-4' ? '$49,900' : passed ? '$53,000' : '$48,000');
    await expect(tile(page, id)).toContainText(funded ? 'Funded Failed' : passed ? 'Evaluation Passed' : 'Evaluation Failed');
    if (funded) {
      await expect(tile(page, id)).toContainText(id === 'funded-4' ? 'Cycle 2' : 'Cycle 1');
      await expect(tile(page, id)).toContainText('0/4 days');
      await expect(tile(page, id).locator('[aria-label="0 of 4 qualifying days"]')).toBeVisible();
      await expect(tile(page, id).locator('.evaluation-floor')).toHaveCount(0);
      await expect(tile(page, id).locator('.purchase-cost')).toHaveCount(0);
    } else {
      await expect(tile(page, id).locator('.evaluation-floor strong')).toHaveText(passed ? '$50,000' : '$48,000');
      await expect(tile(page, id)).toContainText('$90.00');
    }
    await expect(tile(page, id).getByRole('button')).toHaveCount(1);
    await expect(tile(page, id).locator('input')).toHaveCount(0);
  }
}

async function futureBlocked(page, surface, dateLabel) {
  const before = await read(page);
  const input = surface.getByLabel(dateLabel, { exact: true });
  await expect(input).toHaveAttribute('max', tradeDate);
  await input.fill(tomorrow);
  for (const result of [/^WIN/, /^LOSS/]) {
    const action = surface.getByRole('button', { name: result });
    await expect(action).toBeDisabled();
    await action.evaluate(element => element.click());
  }
  await expect(surface.locator('.inline-note').filter({ hasText: /future|today/i })).toBeVisible();
  assert.deepEqual(await read(page), before, 'A future-date attempt must not change saved balances or history');
  await input.fill(historicalDate);
  await expect(surface.getByRole('button', { name: /^LOSS/ })).toBeEnabled();
  await input.fill(tradeDate);
  await expect(surface.getByRole('button', { name: /^LOSS/ })).toBeEnabled();
}

let desktopPage;
await mkdir('artifacts', { recursive: true });
try {
  const seed = seedAccounts();
  const { context, page } = await workspace(seed, { width: 1440, height: 1100 });
  desktopPage = page;
  await expect(page.getByRole('button', { name: 'Open continuation', exact: true })).toHaveCount(0);
  for (const id of initialArchived) await expect(tile(page, id)).toHaveCount(0);
  const panel = page.locator('.current-account');
  await futureBlocked(page, panel, 'Trade date');
  await panel.getByLabel('Trade date', { exact: true }).fill(historicalDate);
  await panel.getByRole('button', { name: /^LOSS/ }).click();
  assert.equal(account(await read(page), 'eval-5').balance, 50500);
  assert.equal((await read(page)).events.findLast(event => event.type === 'trade').date, historicalDate);
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.deepEqual((await read(page)).accounts, seed.accounts);
  await accountsView(page);
  await expect(page.locator('article.account-card')).toHaveCount(7);
  await expect(page.locator('.nav-count')).toHaveText('7');
  await expect(tile(page, 'eval-3')).toHaveCount(0);
  await closedTile(page, 'funded-4');
  await filter(page, 'Evaluations').click();
  await expect(tile(page, 'eval-3')).toHaveCount(0);
  await expect(tile(page, 'eval-1')).toHaveCount(0);
  await archivedView(page, initialArchived);
  await expect(tile(page, 'funded-1')).toHaveCount(0);
  assert.deepEqual((await read(page)).accounts, seed.accounts, 'Archive filters must preserve all stored accounts');
  await filter(page, 'All accounts').click();
  for (const id of ['eval-5', 'eval-6', 'eval-7', 'funded-1', 'funded-2']) {
    await expect(button(page, id, 'win')).toBeEnabled();
    await expect(button(page, id, 'loss')).toBeEnabled();
  }
  await futureBlocked(page, tile(page, 'eval-6'), 'Trade date for Evaluation 06');

  // Results on waiting evaluations leave the ordinary primary account running.
  const before = await read(page);
  let current = await record(page, 'eval-6', 'win');
  assert.equal(account(current, 'eval-6').balance, 51500);
  assert.equal(account(current, 'eval-6').stage, 'evaluation');
  assert.equal(account(current, 'eval-6').evaluationRole, 'continuation');
  assert.equal(account(current, 'eval-5').evaluationRole, 'primary');
  assert.equal(current.accounts.filter(item => item.evaluationRole === 'primary').length, 1);
  assert.equal(current.accounts.some(item => item.openTrade), false);
  await page.reload();
  await accountsView(page);
  assert.equal(account(await read(page), 'eval-6').balance, 51500);
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.deepEqual((await read(page)).accounts, before.accounts);
  await record(page, 'eval-6', 'win');
  current = await record(page, 'eval-7', 'loss');
  assert.equal(account(current, 'eval-7').balance, 49000);
  current = await record(page, 'funded-1', 'loss');
  assert.equal(account(current, 'funded-1').balance, 49000);
  assert.equal(account(current, 'funded-1').mainAttempts, 1);
  current = await record(page, 'eval-6', 'win');
  assert.equal(account(current, 'eval-6').stage, 'passed');
  assert.equal(account(current, 'funded-6').stage, 'main');
  assert.equal(account(current, 'eval-5').evaluationRole, 'primary');
  assert.equal(account(current, 'eval-6').evaluationHighWater, 53000);
  assert.equal(account(current, 'eval-6').purchaseCostCents, 9000);
  await expect(tile(page, 'eval-6')).toHaveCount(0);
  await expect(button(page, 'funded-6', 'win')).toBeEnabled();
  await archivedView(page, passedArchived);
  assert.ok((await read(page)).events.some(event => event.type === 'evaluation_pass' && event.accountId === 'eval-6'));
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  await expect(tile(page, 'eval-6')).toHaveCount(0);
  assert.equal(account(await read(page), 'eval-6').stage, 'evaluation');
  assert.equal(account(await read(page), 'eval-6').balance, 51500);
  assert.equal(account(await read(page), 'eval-6').evaluationHighWater, 51500);
  assert.equal(account(await read(page), 'funded-6'), undefined);
  await filter(page, 'All accounts').click();
  await expect(button(page, 'eval-6', 'win')).toBeEnabled();
  await expect(tile(page, 'funded-6')).toHaveCount(0);
  current = await record(page, 'eval-6', 'win');
  await tile(page, 'funded-6').getByRole('button', { name: 'View Funded 06', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Account overview' })).toBeVisible();
  await expect(tile(page, 'eval-6')).toHaveCount(0);
  await expect(button(page, 'funded-6', 'win')).toBeEnabled();
  await accountsView(page);

  current = await record(page, 'funded-2', 'win', historicalDate);
  assert.equal(account(current, 'funded-2').balance, 54175);
  assert.deepEqual(account(current, 'funded-2').qualifyingDates, [historicalDate]);
  await expect(button(page, 'funded-2', 'win')).toBeDisabled();
  await expect(button(page, 'funded-2', 'loss')).toBeEnabled();
  await tile(page, 'funded-2').getByLabel('Trade date for Funded 02', { exact: true }).fill(tradeDate);
  await expect(button(page, 'funded-2', 'win')).toBeEnabled();
  current = await record(page, 'funded-2', 'win');
  assert.deepEqual(account(current, 'funded-2').qualifyingDates, [historicalDate, tradeDate]);
  assert.equal(account(current, 'funded-2').balance, 54350);
  current = await record(page, 'eval-7', 'loss');
  assert.equal(account(current, 'eval-7').stage, 'evaluation_failed');
  assert.equal(account(current, 'eval-7').balance, 48000);
  await expect(tile(page, 'eval-7')).toHaveCount(0);
  await expect(page.locator('article.account-card')).toHaveCount(6);
  await expect(filter(page, 'Archived')).toContainText('6');
  assert.ok(current.events.some(event => event.type === 'evaluation_failure' && event.accountId === 'eval-7'));
  assert.equal(summarize(current).costCents, summarize(seed).costCents);
  assert.equal(summarize(current).withdrawn, summarize(seed).withdrawn);
  await noOverflow(page);
  const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await dismiss.count()) await dismiss.click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'artifacts/continuation-desktop.png', fullPage: true });
  await archivedView(page, allArchived);
  assert.deepEqual((await read(page)).events, current.events, 'Archiving must preserve the full history');
  await noOverflow(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'artifacts/archive-desktop.png', fullPage: true });
  await filter(page, 'All accounts').click();

  // Exported results retain balances, date progress, and undo snapshots.
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export backup', exact: true }).click();
  await (await downloadPromise).saveAs('artifacts/continuation-backup.json');
  const backup = parseBackup(await readFile('artifacts/continuation-backup.json', 'utf8'));
  assert.deepEqual(backup.accounts, current.accounts);
  await page.reload();
  await accountsView(page);
  assert.deepEqual((await read(page)).accounts, current.accounts);
  await expect(tile(page, 'eval-7')).toHaveCount(0);
  await archivedView(page, allArchived);
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.equal(account(await read(page), 'eval-7').stage, 'evaluation');
  assert.equal(account(await read(page), 'eval-7').balance, 49000);
  await expect(tile(page, 'eval-7')).toHaveCount(0);
  await expect(page.locator('article.account-card')).toHaveCount(5);
  await filter(page, 'All accounts').click();
  await expect(button(page, 'eval-7', 'loss')).toBeEnabled();
  await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.deepEqual(account(await read(page), 'funded-2').qualifyingDates, [historicalDate]);

  const { context: mobileContext, page: mobile } = await workspace(backup, { width: 390, height: 844 });
  await accountsView(mobile);
  await noOverflow(mobile);
  await mobile.evaluate(() => window.scrollTo(0, 0));
  await mobile.screenshot({ path: 'artifacts/continuation-mobile.png', fullPage: true });
  await archivedView(mobile, allArchived);
  assert.equal(summarize(await read(mobile)).costCents, summarize(seed).costCents);
  await noOverflow(mobile);
  await mobile.evaluate(() => window.scrollTo(0, 0));
  await mobile.screenshot({ path: 'artifacts/archive-mobile.png', fullPage: true });
  await filter(mobile, 'All accounts').click();
  for (const width of [390, 320]) {
    await mobile.setViewportSize({ width, height: 844 });
    await noOverflow(mobile);
    await expect(button(mobile, 'eval-8', 'win')).toBeEnabled();
    await expect(button(mobile, 'eval-8', 'loss')).toBeEnabled();
    if (width === 320) {
      await mobile.evaluate(() => window.scrollTo(0, 0));
      await mobile.screenshot({ path: 'artifacts/continuation-mobile-320.png', fullPage: true });
      await archivedView(mobile, allArchived);
      await noOverflow(mobile);
      await mobile.evaluate(() => window.scrollTo(0, 0));
      await mobile.screenshot({ path: 'artifacts/archive-mobile-320.png', fullPage: true });
      await filter(mobile, 'All accounts').click();
    }
  }
  const mobileResult = await record(mobile, 'eval-8', 'loss');
  assert.equal(account(mobileResult, 'eval-8').balance, 49000);
  await noOverflow(mobile);
  await futureBlocked(mobile, tile(mobile, 'eval-8'), 'Trade date for Evaluation 08');
  await mobileContext.close();

  // Pending trades saved by the previous UI still resolve with their original terms.
  let legacy = applyAction(seed, { type: 'open_continuation', accountIds: ['eval-6', 'funded-1'], date: tradeDate }, {
    actionId: 'legacy-open', timestamp: '2026-09-29T12:00:00.000Z',
  });
  legacy = applyAction(legacy, { type: 'settings', settings: { ...legacy.settings, evaluationWin: 2000, fundedMainWin: 4500 } }, {
    actionId: 'legacy-rules', timestamp: '2026-09-29T12:01:00.000Z',
  });
  // Emulate future dates already saved by the previous release without creating a new future action.
  legacy = structuredClone(legacy);
  for (const accounts of [legacy.accounts, ...legacy.undoStack.map(snapshot => snapshot.accounts)]) {
    for (const item of accounts) if (item.openTrade?.id.startsWith('legacy-open:')) item.openTrade.date = tomorrow;
  }
  for (const event of legacy.events) {
    if (event.actionId === 'legacy-open') { event.date = tomorrow; event.openedDate = tomorrow; }
  }
  legacy.events.find(event => event.type === 'trade').date = tomorrow;
  const { context: legacyContext, page: legacyPage } = await workspace(legacy, { width: 1440, height: 1100 });
  assert.equal((await read(legacyPage)).events.find(event => event.type === 'trade').date, tomorrow);
  await accountsView(legacyPage);
  await expect(button(legacyPage, 'eval-6', 'win')).toContainText('$1,500');
  await expect(button(legacyPage, 'funded-1', 'win')).toContainText('$4,000');
  await futureBlocked(legacyPage, tile(legacyPage, 'eval-6'), 'Trade date for Evaluation 06');
  const legacyResult = await record(legacyPage, 'eval-6', 'win');
  assert.equal(account(legacyResult, 'eval-6').balance, 51500);
  assert.equal(account(legacyResult, 'eval-6').openTrade, null);
  assert.deepEqual(account(legacyResult, 'funded-1').openTrade, account(legacy, 'funded-1').openTrade);
  await legacyPage.reload();
  await accountsView(legacyPage);
  await legacyPage.getByRole('button', { name: 'Undo last action', exact: true }).click();
  assert.deepEqual(account(await read(legacyPage), 'eval-6').openTrade, account(legacy, 'eval-6').openTrade);
  await record(legacyPage, 'funded-1', 'loss');
  assert.equal(account(await read(legacyPage), 'funded-1').balance, 49000);
  assert.equal(account(await read(legacyPage), 'funded-1').openTrade, null);
  await record(legacyPage, 'funded-1', 'loss');
  assert.equal(account(await read(legacyPage), 'funded-1').stage, 'funded_failed');
  await expect(tile(legacyPage, 'funded-1')).toHaveCount(0);
  await filter(legacyPage, 'Funded').click();
  await expect(tile(legacyPage, 'funded-1')).toHaveCount(0);
  await archivedView(legacyPage, [...initialArchived, 'funded-1']);
  await legacyPage.getByRole('button', { name: 'Undo last action', exact: true }).click();
  await expect(tile(legacyPage, 'funded-1')).toHaveCount(0);
  await filter(legacyPage, 'All accounts').click();
  await expect(button(legacyPage, 'funded-1', 'loss')).toBeEnabled();
  await expect(button(legacyPage, 'funded-1', 'loss')).toContainText('$1,000');
  assert.equal(account(await read(legacyPage), 'funded-1').stage, 'main');
  assert.equal(account(await read(legacyPage), 'funded-1').mainAttempts, 1);
  await legacyContext.close();

  // A failed later payout cycle keeps its collected payout and original risk terms.
  const { context: payoutContext, page: payoutPage } = await workspace(seed, { width: 1440, height: 1100 });
  await accountsView(payoutPage);
  await tile(payoutPage, 'funded-4').getByRole('button', { name: 'Take $3,000 payout', exact: true }).click();
  assert.equal(account(await read(payoutPage), 'funded-4').cycle, 2);
  assert.equal(account(await read(payoutPage), 'funded-4').balance, 51700);
  assert.equal(summarize(await read(payoutPage)).withdrawn, 3000);
  await tile(payoutPage, 'funded-4').getByRole('button', { name: 'View Funded 04', exact: true }).click();
  await record(payoutPage, 'funded-4', 'loss');
  await expect(button(payoutPage, 'funded-4', 'loss')).toContainText('$800');
  const beforeFundedFailure = await read(payoutPage);
  const fundedFailure = await record(payoutPage, 'funded-4', 'loss');
  assert.equal(account(fundedFailure, 'funded-4').stage, 'funded_failed');
  assert.equal(account(fundedFailure, 'funded-4').balance, 49900);
  assert.equal(account(fundedFailure, 'funded-4').cycle, 2);
  assert.equal(summarize(fundedFailure).withdrawn, 3000);
  assert.equal(summarize(fundedFailure).costCents, summarize(seed).costCents);
  for (const event of beforeFundedFailure.events) assert.deepEqual(fundedFailure.events.find(item => item.id === event.id), event);
  await expect(tile(payoutPage, 'funded-4')).toHaveCount(0);
  await expect(payoutPage.locator('.current-account').getByRole('heading', { name: 'Evaluation 05', exact: true })).toBeVisible();
  await accountsView(payoutPage);
  await expect(tile(payoutPage, 'funded-4')).toHaveCount(0);
  await filter(payoutPage, 'Funded').click();
  await expect(tile(payoutPage, 'funded-4')).toHaveCount(0);
  await archivedView(payoutPage, [...initialArchived, 'funded-4']);
  const fundedDismiss = payoutPage.getByRole('button', { name: 'Dismiss notification', exact: true });
  if (await fundedDismiss.count()) await fundedDismiss.click();
  await noOverflow(payoutPage);
  await payoutPage.evaluate(() => window.scrollTo(0, 0));
  await payoutPage.screenshot({ path: 'artifacts/funded-archive-desktop.png', fullPage: true });
  const fundedDownload = payoutPage.waitForEvent('download');
  await payoutPage.getByRole('button', { name: 'Export backup', exact: true }).click();
  await (await fundedDownload).saveAs('artifacts/funded-archive-backup.json');
  const fundedBackup = parseBackup(await readFile('artifacts/funded-archive-backup.json', 'utf8'));
  assert.deepEqual(fundedBackup.accounts, fundedFailure.accounts);
  assert.equal(summarize(fundedBackup).withdrawn, 3000);
  await payoutPage.reload();
  await accountsView(payoutPage);
  await archivedView(payoutPage, [...initialArchived, 'funded-4']);
  await payoutPage.getByRole('button', { name: 'Undo last action', exact: true }).click();
  await expect(tile(payoutPage, 'funded-4')).toHaveCount(0);
  await filter(payoutPage, 'All accounts').click();
  await expect(button(payoutPage, 'funded-4', 'loss')).toBeEnabled();
  await expect(button(payoutPage, 'funded-4', 'loss')).toContainText('$800');
  assert.equal(account(await read(payoutPage), 'funded-4').balance, 50700);
  assert.equal(account(await read(payoutPage), 'funded-4').mainAttempts, 1);
  assert.equal(summarize(await read(payoutPage)).withdrawn, 3000);
  const { context: fundedMobileContext, page: fundedMobile } = await workspace(fundedBackup, { width: 390, height: 844 });
  await accountsView(fundedMobile);
  await archivedView(fundedMobile, [...initialArchived, 'funded-4']);
  await noOverflow(fundedMobile);
  await fundedMobile.evaluate(() => window.scrollTo(0, 0));
  await fundedMobile.screenshot({ path: 'artifacts/funded-archive-mobile.png', fullPage: true });
  await fundedMobile.setViewportSize({ width: 320, height: 844 });
  await noOverflow(fundedMobile);
  await fundedMobile.screenshot({ path: 'artifacts/funded-archive-mobile-320.png', fullPage: true });
  await fundedMobileContext.close();
  await payoutContext.close();
  await context.close();
  assert.deepEqual(errors, []);
  console.log('Account tile browser checks passed: automatic evaluation/funded archive, funded first/later-cycle risk and undo, preserved payouts/peaks/costs/history, archive reload/backups, future guards, independent results, legacy future data, desktop and mobile.');
} catch (error) {
  console.error('Page errors:', errors);
  await desktopPage?.screenshot({ path: 'artifacts/continuation-failure.png', fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
