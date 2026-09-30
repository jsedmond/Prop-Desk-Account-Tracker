import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { applyAction, createState, DEFAULT_SETTINGS, exportBackup, parseBackup, STORAGE_KEY, summarize, VERSION } from '../src/domain.js';

const url = process.env.TRACKER_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ channel: process.env.TRACKER_BROWSER || 'msedge', headless: true });
const errors = [];
let serial = 0;
const act = (state, action) => applyAction(state, action, { actionId: `browser-defaults-${++serial}` });
const trade = (state, accountId, result = 'win') => act(state, { type: 'record_result', accountId, result });
const custom = { startingEvaluations: 7, evaluationCostCents: 9250, evaluationStart: 60000,
  evaluationTarget: 65000, evaluationFailure: 57000, evaluationWin: 2000, evaluationLoss: 750,
  fundedMainWin: 5000, initialFundedRisk: 1200, postPayoutSecondRisk: 900,
  qualifyingWin: 225, qualifyingLoss: 125, qualifyingWins: 3, payoutAmount: 2500 };
let seed = createState(custom);
for (let index = 0; index < 3; index++) seed = trade(seed, 'eval-1');
seed = trade(seed, 'eval-2', 'loss');
seed = trade(trade(seed, 'funded-1'), 'funded-1');
seed = act(seed, { type: 'rename_account', accountId: 'funded-1', name: '000987' });
await mkdir('artifacts', { recursive: true });

try {
  for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 1100 : 844 } });
    await context.addInitScript(({ key, backup }) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, backup);
    }, { key: STORAGE_KEY, backup: exportBackup(seed) });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const read = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
    const navigate = async label => {
      if (width < 901) await page.getByRole('button', { name: 'Toggle navigation' }).click();
      await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: label, exact: true }).click();
      if (width < 901) await page.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().right <= 0);
    };
    const restore = () => page.getByRole('button', { name: 'Restore default settings', exact: true });
    const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const expectFields = async settings => {
      for (const [key, value] of Object.entries(settings)) {
        const expected = key === 'evaluationCostCents' ? (value / 100).toFixed(2) : String(value);
        await expect(page.locator(`#setting-${key}`), `${key} was not restored`).toHaveValue(expected);
      }
    };

    await page.goto(url);
    await navigate('Settings');
    await expectFields(custom);
    assert.equal(await restore().isEnabled(), true);
    await page.getByLabel('Winning trade', { exact: true }).fill('');
    await restore().click();
    await expectFields(DEFAULT_SETTINGS);
    const restored = await read();
    assert.deepEqual(restored.settings, DEFAULT_SETTINGS);
    assert.equal(restored.accounts.length, seed.accounts.length);
    assert.deepEqual(summarize(restored), summarize(seed));
    for (const id of ['eval-1', 'eval-2', 'funded-1']) {
      assert.deepEqual(restored.accounts.find(account => account.id === id), seed.accounts.find(account => account.id === id));
    }
    assert.deepEqual(restored.events.slice(0, -1), seed.events);
    assert.deepEqual(parseBackup(exportBackup(restored)), restored);
    assert.equal(await restore().isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Save rules', exact: true }).isDisabled(), true);
    await noOverflow();
    const dismiss = page.getByRole('button', { name: 'Dismiss notification', exact: true });
    if (await dismiss.count()) await dismiss.click();
    await page.locator('.reset-band').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/restore-defaults-${width}.png`, fullPage: false });

    await page.reload();
    await navigate('Settings');
    await expectFields(DEFAULT_SETTINGS);
    assert.deepEqual((await read()).accounts, restored.accounts);
    await page.getByRole('button', { name: 'Undo last action', exact: true }).click();
    await expectFields(custom);
    assert.deepEqual((await read()).accounts, seed.accounts);
    assert.equal(await restore().isEnabled(), true);
    await restore().click();
    await page.getByLabel('Qualifying winning day', { exact: true }).fill('350');
    assert.equal(await restore().isEnabled(), true);
    await restore().click();
    await expectFields(DEFAULT_SETTINGS);
    await noOverflow();
    await context.close();
  }

  const fresh = await browser.newContext();
  const page = await fresh.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  const currentWin = () => page.locator('.current-account').getByRole('button', { name: /^WIN/ });
  await currentWin().click();
  await currentWin().click();
  await page.getByRole('button', { name: 'View Funded 01', exact: true }).click();
  await currentWin().click();
  assert.match(await currentWin().innerText(), /\$175/);
  assert.match(await page.locator('.current-account').getByRole('button', { name: /^LOSS/ }).innerText(), /\$175/);
  await currentWin().click();
  const current = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
  assert.equal(current.accounts.find(account => account.id === 'funded-1').balance, 54175);
  await fresh.close();

  const legacyContext = await browser.newContext();
  const legacy = { ...seed, version: 6, settings: { ...seed.settings, qualifyingWin: 200, qualifyingLoss: 200 } };
  await legacyContext.addInitScript(({ key, backup }) => localStorage.setItem(key, backup), { key: STORAGE_KEY, backup: exportBackup(legacy) });
  const legacyPage = await legacyContext.newPage();
  await legacyPage.goto(url);
  await legacyPage.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await legacyPage.getByLabel('Qualifying winning day', { exact: true }).inputValue(), '175');
  assert.equal(await legacyPage.getByLabel('Qualifying losing day', { exact: true }).inputValue(), '175');
  const download = legacyPage.waitForEvent('download');
  await legacyPage.getByRole('button', { name: 'Export backup', exact: true }).first().click();
  await (await download).saveAs('artifacts/defaults-migrated-backup.json');
  const migrated = JSON.parse(await readFile('artifacts/defaults-migrated-backup.json', 'utf8'));
  assert.equal(migrated.version, VERSION);
  assert.equal(migrated.settings.qualifyingWin, 175);
  assert.equal(migrated.settings.qualifyingLoss, 175);
  assert.deepEqual(migrated.accounts, seed.accounts);
  assert.deepEqual(migrated.events, seed.events);
  await legacyContext.close();
  assert.deepEqual(errors, []);
  console.log('Default settings checks passed: $175 qualifying wins/losses, every default restored and persisted, invalid/unsaved drafts cleared, accounts/history/costs preserved, undo, v6 migration, desktop and 390/320px layouts.');
} finally {
  await browser.close();
}
