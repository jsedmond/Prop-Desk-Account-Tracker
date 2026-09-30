import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createState, DEFAULT_SETTINGS, exportBackup, parseBackup, resultTerms, summarize, VERSION } from '../src/domain.js';

let serial = 0;
const act = (state, action) => applyAction(state, action, { actionId: `defaults-${++serial}`, timestamp: '2026-09-29T18:00:00.000Z' });
const trade = (state, accountId, result = 'win', date = '2026-09-29') => act(state, { type: 'record_result', accountId, result, date });
const account = (state, id = 'funded-1') => state.accounts.find(item => item.id === id);
const funded = settings => trade(trade(createState(settings), 'eval-1'), 'eval-1');

test('default qualifying wins and losses use $175 without changing qualifying-day counts or payout amounts', () => {
  assert.equal(DEFAULT_SETTINGS.qualifyingWin, 175);
  assert.equal(DEFAULT_SETTINGS.qualifyingLoss, 175);
  let state = trade(funded(), 'funded-1', 'win', '2026-09-25');
  assert.deepEqual(resultTerms(account(state)), { win: 175, loss: 175 });
  state = trade(state, 'funded-1', 'loss', '2026-09-25');
  assert.equal(account(state).balance, 53825);
  for (const date of ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']) state = trade(state, 'funded-1', 'win', date);
  assert.equal(account(state).balance, 54525);
  assert.equal(account(state).stage, 'payout_ready');
  const paid = act(state, { type: 'payout', accountId: 'funded-1' });
  assert.equal(account(paid).balance, 51525);
  assert.equal(summarize(paid).withdrawn, 3000);
});

test('restoring all settings to defaults preserves traded and funded accounts, names, costs and audit history', () => {
  const settings = { ...DEFAULT_SETTINGS, startingEvaluations: 7, evaluationCostCents: 9525,
    evaluationWin: 1500, evaluationLoss: 750, fundedMainWin: 4500, qualifyingWin: 225,
    qualifyingLoss: 125, qualifyingWins: 3, payoutAmount: 2500 };
  let state = trade(funded(settings), 'funded-1');
  state = trade(state, 'eval-2', 'loss');
  state = act(state, { type: 'rename_account', accountId: 'funded-1', name: '000987' });
  const restored = act(state, { type: 'settings', settings: { ...DEFAULT_SETTINGS } });
  assert.deepEqual(restored.settings, DEFAULT_SETTINGS);
  for (const id of ['eval-1', 'eval-2', 'funded-1']) assert.deepEqual(account(restored, id), account(state, id));
  assert.equal(restored.accounts.length, state.accounts.length);
  assert.equal(restored.selectedId, state.selectedId);
  assert.deepEqual(restored.events.slice(0, -1), state.events);
  assert.deepEqual(summarize(restored), summarize(state));
  assert.ok(restored.accounts.filter(item => item.type === 'evaluation').every(item => item.purchaseCostCents === 9525));
  assert.deepEqual(account(restored, 'eval-3').rules, DEFAULT_SETTINGS);
  assert.deepEqual(parseBackup(exportBackup(restored)), restored);
  const undone = act(parseBackup(exportBackup(restored)), { type: 'undo' });
  assert.deepEqual(undone.accounts, state.accounts);
  assert.deepEqual(undone.settings, state.settings);
});

test('restoring defaults preserves an open trade and its original frozen terms', () => {
  const initial = createState({ ...DEFAULT_SETTINGS, evaluationWin: 1000, qualifyingWin: 225 });
  const opened = act(initial, { type: 'open_continuation', accountIds: ['eval-1'] });
  const restored = act(opened, { type: 'settings', settings: { ...DEFAULT_SETTINGS } });
  assert.deepEqual(account(restored, 'eval-1'), account(opened, 'eval-1'));
  assert.deepEqual(resultTerms(account(restored, 'eval-1')), { win: 1000, loss: 1000 });
  assert.deepEqual(account(restored, 'eval-2').rules, DEFAULT_SETTINGS);
  assert.deepEqual(parseBackup(exportBackup(restored)), restored);
});

test('version-six default migration updates saved settings but preserves existing cycles, costs, history and snapshots', () => {
  const oldDefaults = { ...DEFAULT_SETTINGS, qualifyingWin: 200, qualifyingLoss: 200 };
  let original = trade(funded(oldDefaults), 'funded-1', 'win', '2026-09-25');
  for (const date of ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']) original = trade(original, 'funded-1', 'win', date);
  const legacy = { ...original, version: 6 };
  const migrated = parseBackup(exportBackup(legacy));
  assert.equal(migrated.version, VERSION);
  assert.deepEqual(migrated.settings, DEFAULT_SETTINGS);
  assert.deepEqual(migrated.accounts, original.accounts);
  assert.deepEqual(migrated.events, original.events);
  assert.equal(account(migrated).balance, 54800);
  assert.deepEqual(summarize(migrated), summarize(original));
  for (let index = 0; index < original.undoStack.length; index++) {
    assert.deepEqual(migrated.undoStack[index].accounts, original.undoStack[index].accounts);
    assert.deepEqual(migrated.undoStack[index].settings, DEFAULT_SETTINGS);
  }
  const paid = act(migrated, { type: 'payout', accountId: 'funded-1' });
  assert.equal(account(paid).balance, 51800);
  assert.equal(account(paid).rules.qualifyingWin, 175);
  assert.equal(account(paid).rules.qualifyingLoss, 175);
  assert.deepEqual(parseBackup(exportBackup(paid)), paid);
});

test('migration preserves custom qualifying amounts while updating each old default independently', () => {
  for (const [win, loss] of [[225, 125], [200, 125], [225, 200]]) {
    const initial = createState({ ...DEFAULT_SETTINGS, qualifyingWin: win, qualifyingLoss: loss });
    const original = trade(initial, 'eval-1');
    const migrated = parseBackup(exportBackup({ ...original, version: 6 }));
    assert.equal(migrated.settings.qualifyingWin, win === 200 ? 175 : win);
    assert.equal(migrated.settings.qualifyingLoss, loss === 200 ? 175 : loss);
    assert.deepEqual(migrated.accounts, original.accounts);
    assert.equal(migrated.undoStack[0].settings.qualifyingWin, win === 200 ? 175 : win);
    assert.equal(migrated.undoStack[0].settings.qualifyingLoss, loss === 200 ? 175 : loss);
  }
});

test('new-version backups keep an intentionally configured $200 amount unchanged', () => {
  const original = funded({ ...DEFAULT_SETTINGS, qualifyingWin: 200, qualifyingLoss: 200 });
  assert.deepEqual(parseBackup(exportBackup(original)), original);
});
