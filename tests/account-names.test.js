import test from 'node:test';
import assert from 'node:assert/strict';
import { accountName, applyAction, createState, DEFAULT_SETTINGS, exportBackup, isArchived, MAX_ACCOUNT_NAME_LENGTH, parseBackup, summarize, VERSION } from '../src/domain.js';

let serial = 0;
const act = (state, action) => applyAction(state, action, { actionId: `names-${++serial}`, timestamp: '2026-09-29T18:00:00Z' });
const account = (state, id = 'eval-1') => state.accounts.find(item => item.id === id);
const rename = (state, id, name) => act(state, { type: 'rename_account', accountId: id, name });
const win = state => act(state, { type: 'record_result', accountId: 'eval-1', result: 'win' });

function versionFive(state) {
  const legacy = structuredClone(state);
  legacy.version = 5;
  for (const workspace of [legacy, ...legacy.undoStack]) {
    for (const item of workspace.accounts) delete item.customName;
  }
  return exportBackup(legacy);
}

test('new workspaces have five evaluations at $90 each and default names', () => {
  const state = createState();
  assert.equal(state.accounts.length, 5);
  assert.equal(state.settings.evaluationCostCents, 9000);
  assert.equal(summarize(state).costCents, 45000);
  assert.equal(accountName(account(state)), 'Evaluation 01');
  assert.equal(accountName(account(act(state, { type: 'add_evaluation' }), 'eval-6')), 'Evaluation 06');
});

test('renaming trims whitespace and preserves leading zeros, account identity and all financial metrics', () => {
  const original = win(createState());
  const renamed = rename(original, 'eval-1', '  000123-AB  ');
  assert.equal(account(renamed).customName, '000123-AB');
  assert.equal(accountName(account(renamed)), '000123-AB');
  assert.deepEqual({ ...account(renamed), customName: '' }, account(original));
  assert.deepEqual(summarize(renamed), summarize(original));
  assert.equal(accountName(account(original)), 'Evaluation 01');
  assert.equal(renamed.events.at(-1).type, 'account_renamed');
  assert.equal(renamed.events.at(-1).previousName, 'Evaluation 01');
  assert.equal(renamed.events.at(-1).newName, '000123-AB');
  assert.deepEqual(parseBackup(exportBackup(renamed)), renamed);
});

test('evaluation names survive passing and funded accounts have independently editable identifiers', () => {
  let state = win(win(rename(createState(), 'eval-1', 'EVAL-001')));
  assert.equal(accountName(account(state)), 'EVAL-001');
  assert.equal(accountName(account(state, 'funded-1')), 'Funded 01');
  const before = state;
  state = rename(state, 'funded-1', 'FUNDED-009');
  assert.equal(accountName(account(state)), 'EVAL-001');
  assert.equal(accountName(account(state, 'funded-1')), 'FUNDED-009');
  assert.deepEqual(account(state), account(before));
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('undo survives backup restore and blank names restore the original default', () => {
  let state = rename(createState(), 'eval-1', '1234');
  const named = state;
  state = rename(state, 'eval-1', '  ');
  assert.equal(accountName(account(state)), 'Evaluation 01');
  state = act(parseBackup(exportBackup(state)), { type: 'undo' });
  assert.deepEqual(state.accounts, named.accounts);
  state = act(state, { type: 'undo' });
  assert.equal(accountName(account(state)), 'Evaluation 01');
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('partial and duplicate display names never change internal account numbering', () => {
  let state = rename(createState(), 'eval-1', '...123');
  state = rename(state, 'eval-2', '...123');
  state = act(state, { type: 'add_evaluation' });
  assert.equal(account(state, 'eval-6').number, 6);
  assert.equal(account(state, 'eval-1').id, 'eval-1');
  assert.equal(account(state, 'eval-2').number, 2);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('invalid or unchanged names reject atomically and archived accounts may still be identified', () => {
  const original = createState();
  for (const value of [null, 123, 'x'.repeat(MAX_ACCOUNT_NAME_LENGTH + 1), 'two\nlines', 'bad\u0000name', '']) {
    assert.throws(() => rename(original, 'eval-1', value), /Account name|already has/);
    assert.deepEqual(original, createState());
  }
  assert.throws(() => rename(original, 'missing', '1234'), /not found/);
  const passed = win(win(original));
  const renamed = rename(passed, 'eval-1', 'Archived-123');
  assert.equal(isArchived(account(renamed)), true);
  assert.deepEqual(summarize(renamed), summarize(passed));
});

test('backups reject missing, untrimmed, multiline or overlong names and malformed rename events', () => {
  for (const corrupt of [
    state => { delete account(state).customName; },
    state => { account(state).customName = ' untrimmed '; },
    state => { account(state).customName = 'a\nb'; },
    state => { account(state).customName = 'x'.repeat(MAX_ACCOUNT_NAME_LENGTH + 1); },
    state => { state.undoStack[0].accounts[0].customName = 123; },
    state => { state.events.at(-1).previousName = ''; },
    state => { state.events.at(-1).newName = 'a\nb'; },
    state => { state.events.at(-1).pnl = 1; },
    state => { state.events.at(-1).balanceAfter += 1; },
  ]) {
    const state = rename(createState(), 'eval-1', '1234');
    corrupt(state);
    assert.throws(() => parseBackup(exportBackup(state)));
  }
});

test('version-five migration retains ten accounts, purchase costs, histories and snapshots while updating old defaults', () => {
  const original = win(createState({ ...DEFAULT_SETTINGS, startingEvaluations: 10, evaluationCostCents: 9020 }));
  const restored = parseBackup(versionFive(original));
  assert.equal(restored.version, VERSION);
  assert.equal(restored.settings.startingEvaluations, 5);
  assert.equal(restored.settings.evaluationCostCents, 9000);
  assert.deepEqual(restored.accounts, original.accounts);
  assert.deepEqual(restored.events, original.events);
  assert.equal(summarize(restored).costCents, 90200);
  const added = act(restored, { type: 'add_evaluation' });
  assert.equal(account(added, 'eval-11').purchaseCostCents, 9000);
  assert.equal(summarize(added).costCents, 99200);
  const undone = act(act(added, { type: 'undo' }), { type: 'undo' });
  assert.equal(undone.settings.startingEvaluations, 5);
  assert.equal(undone.settings.evaluationCostCents, 9000);
  assert.deepEqual(undone.accounts, createState({ ...DEFAULT_SETTINGS, startingEvaluations: 10, evaluationCostCents: 9020 }).accounts);
});

test('version-five migration retains custom fees and counts in current settings and undo snapshots', () => {
  const original = win(createState({ ...DEFAULT_SETTINGS, startingEvaluations: 7, evaluationCostCents: 9500 }));
  assert.deepEqual(parseBackup(versionFive(original)), original);
});
