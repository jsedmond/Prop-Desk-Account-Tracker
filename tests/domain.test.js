import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, canOpenContinuation, createState, DEFAULT_SETTINGS, evaluationFailureLevel, exportBackup, isArchived, parseBackup, qualifyingStartDate, resultTerms, STAGES, STORAGE_KEY, summarize, tradeTerms, validateSettings, VERSION } from '../src/domain.js';
import { loadState, saveState } from '../src/storage.js';

let serial = 0;
function act(state, action) {
  return applyAction(state, action, { actionId: `test-${++serial}`, timestamp: '2026-09-29T18:00:00.000Z' });
}
const trade = (state, accountId, result, date = '2026-09-29') => act(state, { type: 'trade', accountId, result, date });
const get = (state, id = 'funded-1') => state.accounts.find(account => account.id === id);
function fundedState() {
  return trade(trade(createState(), 'eval-1', 'win'), 'eval-1', 'win');
}
function readyState(state = fundedState(), dates = ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']) {
  state = trade(state, 'funded-1', 'win', dates[0]);
  for (const date of dates) state = trade(state, 'funded-1', 'win', date);
  return state;
}

test('starts ten $50,000 evaluations with only one active', () => {
  const state = createState();
  assert.equal(state.accounts.length, 10);
  assert.equal(state.accounts.filter(account => account.stage === STAGES.EVALUATION).length, 1);
  assert.ok(state.accounts.every(account => account.balance === 50000));
});

test('evaluation wins and losses update the balance without mutating the original state', () => {
  const original = createState();
  const win = trade(original, 'eval-1', 'win');
  const loss = trade(win, 'eval-1', 'loss');
  assert.equal(get(win, 'eval-1').balance, 51500);
  assert.equal(get(loss, 'eval-1').balance, 50500);
  assert.equal(original.accounts[0].balance, 50000);
  assert.equal(original.events.length, 0);
  assert.deepEqual(loss.events.at(-1), {
    id: `${loss.events.at(-1).actionId}:1`, actionId: loss.events.at(-1).actionId,
    timestamp: '2026-09-29T18:00:00.000Z', date: '2026-09-29', type: 'trade',
    accountId: 'eval-1', accountNumber: 1, accountType: 'evaluation', cycle: 0,
    stage: 'evaluation', result: 'loss', pnl: -1000, balanceBefore: 51500, balanceAfter: 50500,
  });
});

test('evaluation passes at exactly $53,000, creates funded account and advances queue', () => {
  const state = fundedState();
  assert.equal(get(state, 'eval-1').stage, STAGES.PASSED);
  assert.equal(get(state).balance, 50000);
  assert.equal(get(state).cycle, 1);
  assert.equal(get(state).stage, STAGES.MAIN);
  assert.equal(get(state, 'eval-2').stage, STAGES.EVALUATION);
  assert.equal(state.selectedId, 'eval-2');
});

test('evaluation passes above target', () => {
  const state = trade(createState({ ...DEFAULT_SETTINGS, evaluationWin: 4000 }), 'eval-1', 'win');
  assert.equal(get(state, 'eval-1').balance, 54000);
  assert.equal(get(state, 'eval-1').stage, STAGES.PASSED);
});

test('evaluation fails at $48,000 and advances queue', () => {
  const state = trade(trade(createState(), 'eval-1', 'loss'), 'eval-1', 'loss');
  assert.equal(get(state, 'eval-1').balance, 48000);
  assert.equal(get(state, 'eval-1').stage, STAGES.EVAL_FAILED);
  assert.equal(state.selectedId, 'eval-2');
  assert.equal(summarize(state).evalFailed, 1);
  assert.throws(() => trade(state, 'eval-1', 'win'), /not accepting/);
});

test('first funded cycle first loss remains in main phase', () => {
  const state = trade(fundedState(), 'funded-1', 'loss');
  assert.equal(get(state).balance, 49000);
  assert.equal(get(state).mainAttempts, 1);
  assert.equal(get(state).stage, STAGES.MAIN);
  assert.deepEqual(tradeTerms(get(state)), { win: 4000, loss: 1000 });
});

test('first funded cycle two losses fails at $48,000', () => {
  const state = trade(trade(fundedState(), 'funded-1', 'loss'), 'funded-1', 'loss');
  assert.equal(get(state).balance, 48000);
  assert.equal(get(state).stage, STAGES.FUNDED_FAILED);
  assert.equal(state.events.at(-1).type, 'funded_failure');
  assert.equal(summarize(state).fundedFailed, 1);
  assert.throws(() => trade(state, 'funded-1', 'win'), /not accepting/);
});

test('first or second main trade win moves into qualifying phase', () => {
  const first = trade(fundedState(), 'funded-1', 'win');
  const second = trade(trade(fundedState(), 'funded-1', 'loss'), 'funded-1', 'win');
  assert.equal(get(first).balance, 54000);
  assert.equal(get(second).balance, 53000);
  assert.equal(get(first).stage, STAGES.QUALIFYING);
  assert.equal(get(second).stage, STAGES.QUALIFYING);
});

test('four separate qualifying wins reaches payout ready at $54,800', () => {
  const state = readyState();
  assert.equal(get(state).balance, 54800);
  assert.equal(get(state).qualifyingDates.length, 4);
  assert.equal(get(state).stage, STAGES.PAYOUT);
  assert.equal(state.events.filter(event => event.type === 'qualifying_day').length, 4);
  assert.throws(() => trade(state, 'funded-1', 'win'), /not accepting/);
});

test('qualifying loss preserves completed qualifying-day count', () => {
  let state = trade(fundedState(), 'funded-1', 'win', '2026-09-27');
  state = trade(state, 'funded-1', 'win', '2026-09-27');
  state = trade(state, 'funded-1', 'loss', '2026-09-28');
  assert.equal(get(state).balance, 54000);
  assert.deepEqual(get(state).qualifyingDates, ['2026-09-27']);
  assert.equal(get(state).stage, STAGES.QUALIFYING);
});

test('qualifying wins cannot count twice on one date, but losses remain recordable', () => {
  const main = trade(fundedState(), 'funded-1', 'win');
  const oneDay = trade(main, 'funded-1', 'win');
  assert.throws(() => trade(oneDay, 'funded-1', 'win'), /already has a qualifying win/);
  assert.equal(get(trade(oneDay, 'funded-1', 'loss')).qualifyingDates.length, 1);
  assert.throws(() => trade(main, 'funded-1', 'win', '2026-02-30'), /valid trade date/);
});

test('$3,000 payout leaves $51,800 and restarts the cycle', () => {
  const state = act(readyState(), { type: 'payout', accountId: 'funded-1' });
  assert.equal(get(state).balance, 51800);
  assert.equal(get(state).cycle, 2);
  assert.equal(get(state).stage, STAGES.MAIN);
  assert.equal(get(state).mainAttempts, 0);
  assert.deepEqual(get(state).qualifyingDates, []);
  assert.equal(summarize(state).withdrawn, 3000);
  assert.equal(summarize(state).payouts, 1);
  assert.throws(() => act(state, { type: 'payout', accountId: 'funded-1' }), /Complete qualifying/);
});

test('post-payout first risk is $1,000 and second risk is $800; second loss fails', () => {
  const paid = act(readyState(), { type: 'payout', accountId: 'funded-1' });
  assert.equal(tradeTerms(get(paid)).loss, 1000);
  const first = trade(paid, 'funded-1', 'loss');
  assert.equal(get(first).balance, 50800);
  assert.equal(tradeTerms(get(first)).loss, 800);
  const failed = trade(first, 'funded-1', 'loss');
  assert.equal(get(failed).balance, 50000);
  assert.equal(get(failed).stage, STAGES.FUNDED_FAILED);
});

test('post-payout second trade win enters qualifying and later payouts repeat', () => {
  let state = act(readyState(), { type: 'payout', accountId: 'funded-1' });
  state = trade(state, 'funded-1', 'loss');
  state = trade(state, 'funded-1', 'win', '2026-09-25');
  assert.equal(get(state).balance, 54800);
  for (const date of ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']) state = trade(state, 'funded-1', 'win', date);
  state = act(state, { type: 'payout', accountId: 'funded-1' });
  assert.equal(get(state).balance, 52600);
  assert.equal(get(state).cycle, 3);
  assert.equal(summarize(state).withdrawn, 6000);
});

test('undo evaluation pass restores balance, queue, selection and removes funded account', () => {
  const before = trade(createState(), 'eval-1', 'win');
  const after = trade(before, 'eval-1', 'win');
  const undone = act(after, { type: 'undo' });
  assert.deepEqual(undone.accounts, before.accounts);
  assert.equal(undone.selectedId, 'eval-1');
  assert.equal(summarize(undone).trades, 1);
  assert.equal(summarize(undone).passed, 0);
  assert.equal(undone.events.length, after.events.length + 1);
  assert.equal(undone.events.at(-1).type, 'undo');
});

test('undo payout restores ready state, qualifying days and payout totals', () => {
  const before = readyState();
  const after = act(before, { type: 'payout', accountId: 'funded-1' });
  const undone = act(after, { type: 'undo' });
  assert.deepEqual(undone.accounts, before.accounts);
  assert.equal(summarize(undone).withdrawn, 0);
  assert.equal(summarize(undone).payouts, 0);
  assert.equal(get(undone).qualifyingDates.length, 4);
});

test('undo failures and qualifying win restores previous lifecycle stage', () => {
  const firstLoss = trade(fundedState(), 'funded-1', 'loss');
  assert.deepEqual(act(trade(firstLoss, 'funded-1', 'loss'), { type: 'undo' }).accounts, firstLoss.accounts);
  const mainWin = trade(fundedState(), 'funded-1', 'win');
  const qualifying = trade(mainWin, 'funded-1', 'win');
  assert.deepEqual(act(qualifying, { type: 'undo' }).accounts, mainWin.accounts);
});

test('repeated undo followed by a new action keeps audit history and correct stats', () => {
  let state = trade(trade(createState(), 'eval-1', 'win'), 'eval-1', 'loss');
  state = act(act(state, { type: 'undo' }), { type: 'undo' });
  assert.equal(summarize(state).trades, 0);
  state = trade(state, 'eval-1', 'loss');
  assert.equal(summarize(state).trades, 1);
  assert.equal(summarize(state).evalRate, 0);
  assert.equal(get(state, 'eval-1').balance, 49000);
  assert.equal(parseBackup(exportBackup(state)).events.length, state.events.length);
});

test('settings change waiting evaluations and future cycles while active rules are retained', () => {
  const initial = createState();
  const updated = act(initial, { type: 'settings', settings: { ...DEFAULT_SETTINGS, evaluationWin: 2000, fundedMainWin: 5000 } });
  assert.equal(get(updated, 'eval-1').rules.evaluationWin, 1500);
  assert.equal(get(updated, 'eval-2').rules.evaluationWin, 2000);
  assert.deepEqual(act(updated, { type: 'undo' }).settings, initial.settings);
  const paid = act(act(readyState(), { type: 'settings', settings: { ...DEFAULT_SETTINGS, fundedMainWin: 5000 } }), { type: 'payout', accountId: 'funded-1' });
  assert.equal(get(paid).rules.fundedMainWin, 5000);
  assert.equal(get(paid).balance, 51800);
});

test('backup round-trip includes undo and preserved reversed events', () => {
  const state = act(act(readyState(), { type: 'payout', accountId: 'funded-1' }), { type: 'undo' });
  assert.deepEqual(parseBackup(exportBackup(state)), state);
  const removedFunded = act(fundedState(), { type: 'undo' });
  assert.deepEqual(parseBackup(exportBackup(removedFunded)), removedFunded);
});

test('changing evaluation starting balance never changes an existing funded balance baseline', () => {
  let state = trade(createState(), 'eval-1', 'win');
  state = act(state, { type: 'settings', settings: { ...DEFAULT_SETTINGS, evaluationStart: 60000, evaluationTarget: 63000 } });
  state = trade(state, 'eval-1', 'win');
  assert.equal(get(state).balance, 50000);
  assert.equal(get(state).startingBalance, 50000);
  assert.equal(get(state, 'eval-2').balance, 60000);
  assert.equal(get(state, 'eval-2').startingBalance, 60000);
  state = readyState(state);
  state = act(state, { type: 'payout', accountId: 'funded-1' });
  assert.equal(get(state).balance, 51800);
  assert.equal(get(state).startingBalance, 50000);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('invalid backups reject bad JSON, versions, stages, queue, dates, histories and snapshots', () => {
  assert.throws(() => parseBackup('no'), /valid JSON/);
  assert.throws(() => parseBackup(JSON.stringify({ version: 20 })), /version/);
  for (const corrupt of [
    state => { state.accounts[0].balance = '50000'; },
    state => { state.accounts[1].stage = STAGES.EVALUATION; },
    state => { state.accounts[0].stage = 'unexpected'; },
    state => { state.accounts[0].rules.evaluationTarget = 100; },
    state => { state.events[0].pnl = 123; },
    state => { state.undoStack[0].accounts = []; },
    state => { state.events[0].date = '2026-02-30'; },
  ]) {
    const state = trade(createState(), 'eval-1', 'win');
    corrupt(state);
    assert.throws(() => parseBackup(JSON.stringify(state)));
  }
});

test('only active evaluations can be traded and last evaluation advances to funded', () => {
  assert.throws(() => trade(createState(), 'eval-2', 'win'), /not accepting/);
  const initial = createState({ ...DEFAULT_SETTINGS, startingEvaluations: 1 });
  const passed = trade(trade(initial, 'eval-1', 'win'), 'eval-1', 'win');
  assert.equal(passed.selectedId, 'funded-1');
  const failed = trade(trade(initial, 'eval-1', 'loss'), 'eval-1', 'loss');
  assert.equal(failed.selectedId, 'eval-1');
  assert.equal(summarize(failed).remaining, 0);
});

test('storage failures are reported and malformed saved data is preserved', () => {
  const memory = new Map();
  const storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
  const state = fundedState();
  saveState(state, storage);
  assert.deepEqual(loadState(storage).state, state);
  const failing = { getItem: () => '{invalid', setItem: () => { throw new Error('quota'); } };
  assert.match(loadState(failing).error, /could not be loaded/);
  assert.throws(() => saveState(state, failing), /unavailable or full/);
});

test('initial ten evaluations cost exactly $902.00; passing and failing retain purchase costs', () => {
  let state = fundedState();
  state = trade(trade(state, 'eval-2', 'loss'), 'eval-2', 'loss');
  assert.equal(summarize(state).costCents, 90200);
  assert.equal(summarize(state).evaluationCount, 10);
  assert.equal(get(state, 'eval-1').purchaseCostCents, 9020);
  assert.equal(get(state, 'eval-2').purchaseCostCents, 9020);
  assert.equal(summarize(state).trades, 4);
});

test('adding one evaluation records cost and queues it without changing the active evaluation', () => {
  const original = createState();
  const state = act(original, { type: 'add_evaluation' });
  const added = get(state, 'eval-11');
  assert.equal(state.accounts.length, 11);
  assert.equal(added.balance, 50000);
  assert.equal(added.stage, STAGES.WAITING);
  assert.equal(added.purchaseCostCents, 9020);
  assert.equal(state.selectedId, 'eval-1');
  assert.equal(summarize(state).costCents, 99220);
  assert.equal(summarize(state).trades, 0);
  assert.equal(state.events.at(-1).type, 'evaluation_added');
  assert.equal(state.events.at(-1).costCents, 9020);
  assert.equal(state.events.at(-1).pnl, 0);
  assert.equal(original.accounts.length, 10);
});

test('a replacement activates when the last evaluation fails and keeps the failed account', () => {
  const initial = createState({ ...DEFAULT_SETTINGS, startingEvaluations: 1 });
  const failed = trade(trade(initial, 'eval-1', 'loss'), 'eval-1', 'loss');
  const state = act(failed, { type: 'add_evaluation' });
  assert.equal(get(state, 'eval-1').stage, STAGES.EVAL_FAILED);
  assert.equal(get(state, 'eval-2').stage, STAGES.EVALUATION);
  assert.equal(state.selectedId, 'eval-2');
  assert.equal(summarize(state).costCents, 18040);
  assert.equal(summarize(state).evalFailed, 1);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('replacement evaluations also work after funded failure and pass into new funded accounts', () => {
  let state = createState({ ...DEFAULT_SETTINGS, startingEvaluations: 1 });
  state = trade(trade(state, 'eval-1', 'win'), 'eval-1', 'win');
  state = trade(trade(state, 'funded-1', 'loss'), 'funded-1', 'loss');
  state = act(state, { type: 'add_evaluation' });
  state = trade(trade(state, 'eval-2', 'win'), 'eval-2', 'win');
  assert.equal(get(state, 'funded-1').stage, STAGES.FUNDED_FAILED);
  assert.equal(get(state, 'funded-2').stage, STAGES.MAIN);
  assert.equal(summarize(state).costCents, 18040);
  assert.equal(summarize(state).funded, 1);
});

test('undoing an addition restores costs, active selection and queue while keeping an audit reversal', () => {
  const before = trade(trade(createState({ ...DEFAULT_SETTINGS, startingEvaluations: 1 }), 'eval-1', 'loss'), 'eval-1', 'loss');
  const after = act(before, { type: 'add_evaluation' });
  const undone = act(after, { type: 'undo' });
  assert.deepEqual(undone.accounts, before.accounts);
  assert.equal(undone.selectedId, before.selectedId);
  assert.equal(summarize(undone).costCents, 9020);
  assert.equal(undone.events.at(-1).revertedActionId, after.events.at(-1).actionId);
  assert.deepEqual(parseBackup(exportBackup(undone)), undone);
  const readded = act(undone, { type: 'add_evaluation' });
  assert.equal(get(readded, 'eval-2').stage, STAGES.EVALUATION);
  assert.equal(summarize(readded).costCents, 18040);
  assert.deepEqual(parseBackup(exportBackup(readded)), readded);
});

test('price changes affect future purchases only, retain exact cents and preserve withdrawn totals', () => {
  let state = act(readyState(), { type: 'payout', accountId: 'funded-1' });
  state = act(state, { type: 'settings', settings: { ...DEFAULT_SETTINGS, evaluationCostCents: 9125 } });
  assert.equal(summarize(state).costCents, 90200);
  state = act(state, { type: 'add_evaluation' });
  assert.equal(summarize(state).costCents, 99325);
  assert.equal(get(state, 'eval-11').purchaseCostCents, 9125);
  assert.equal(get(state, 'eval-2').purchaseCostCents, 9020);
  assert.equal(summarize(state).withdrawn, 3000);
  const restored = parseBackup(exportBackup(state));
  assert.deepEqual(restored, state);
  assert.equal(summarize(act(restored, { type: 'undo' })).costCents, 90200);
});

function legacyBackup(state) {
  const legacy = JSON.parse(exportBackup(state));
  legacy.version = 1;
  const stripCosts = snapshot => {
    delete snapshot.settings.evaluationCostCents;
    for (const account of snapshot.accounts) {
      delete account.purchaseCostCents;
      delete account.rules.evaluationCostCents;
      delete account.openTrade;
      delete account.evaluationRole;
      delete account.evaluationHighWater;
      delete account.mainWinDate;
    }
  };
  stripCosts(legacy);
  legacy.undoStack.forEach(stripCosts);
  return JSON.stringify(legacy);
}

test('version-one data migrates without changing trades, payouts, undo or the storage key', () => {
  const before = readyState();
  const paid = act(before, { type: 'payout', accountId: 'funded-1' });
  const legacy = legacyBackup(paid);
  const migrated = parseBackup(legacy);
  assert.deepEqual(migrated, paid);
  assert.equal(migrated.version, VERSION);
  assert.equal(summarize(migrated).costCents, 90200);
  assert.deepEqual(act(migrated, { type: 'undo' }).accounts, before.accounts);
  const storage = { getItem: key => { assert.equal(key, 'prop-desk.v1'); return legacy; } };
  assert.equal(STORAGE_KEY, 'prop-desk.v1');
  assert.deepEqual(loadState(storage).state, paid);
  assert.equal(loadState(storage).error, null);
});

test('migration supports reversed actions and imported snapshots', () => {
  const state = act(fundedState(), { type: 'undo' });
  assert.deepEqual(parseBackup(legacyBackup(state)), state);
  const restored = act(parseBackup(legacyBackup(state)), { type: 'undo' });
  assert.equal(restored.accounts[0].balance, 50000);
  assert.equal(summarize(restored).costCents, 90200);
});

test('more than 100 lifetime evaluations retain unique IDs and backup support', () => {
  let state = createState({ ...DEFAULT_SETTINGS, startingEvaluations: 100 });
  state = act(act(state, { type: 'add_evaluation' }), { type: 'add_evaluation' });
  assert.equal(get(state, 'eval-101').number, 101);
  assert.equal(get(state, 'eval-102').number, 102);
  assert.equal(summarize(state).costCents, 920040);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('invalid evaluation costs and purchase events are rejected; free promotions are supported', () => {
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, evaluationCostCents: 90.20 }), /Evaluation cost/);
  assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, evaluationCostCents: -1 }), /Evaluation cost/);
  const free = createState({ ...DEFAULT_SETTINGS, evaluationCostCents: 0 });
  assert.equal(summarize(act(free, { type: 'add_evaluation' })).costCents, 0);
  for (const corrupt of [
    state => { delete state.accounts[0].purchaseCostCents; },
    state => { state.accounts[0].purchaseCostCents = -1; },
    state => { state.events.at(-1).costCents = 90.2; },
    state => { state.undoStack[0].accounts[0].purchaseCostCents = -1; },
  ]) {
    const state = structuredClone(act(createState(), { type: 'add_evaluation' }));
    corrupt(state);
    assert.throws(() => parseBackup(JSON.stringify(state)));
  }
});

const open = (state, accountIds, date = '2026-09-29') => act(state, { type: 'open_continuation', accountIds, date });
const close = (state, accountId, result, date = '2026-09-29') => act(state, { type: 'close_trade', accountId, result, date });

test('continuation opening supports evaluation and funded accounts without realizing results or costs', () => {
  const original = fundedState();
  const state = open(original, ['eval-2', 'eval-3', 'funded-1']);
  assert.equal(get(state, 'eval-2').evaluationRole, 'primary');
  assert.equal(get(state, 'eval-3').evaluationRole, 'continuation');
  assert.equal(get(state, 'eval-3').stage, STAGES.EVALUATION);
  for (const id of ['eval-2', 'eval-3', 'funded-1']) {
    const account = get(state, id);
    assert.equal(account.balance, get(original, id).balance);
    assert.equal(account.mainAttempts, get(original, id).mainAttempts);
    assert.deepEqual(account.qualifyingDates, get(original, id).qualifyingDates);
    assert.deepEqual(account.openTrade, {
      id: `${state.events.at(-1).actionId}:${id}`, pattern: 'continuation',
      openedAt: '2026-09-29T18:00:00.000Z', date: '2026-09-29', stage: account.stage,
      cycle: account.cycle, balanceBefore: account.balance, ...tradeTerms(account),
    });
  }
  assert.equal(summarize(state).openTrades, 3);
  assert.equal(summarize(state).trades, summarize(original).trades);
  assert.equal(summarize(state).costCents, summarize(original).costCents);
  assert.equal(summarize(state).withdrawn, 0);
  assert.equal(state.events.filter(event => event.type === 'trade_opened').length, 3);
  assert.equal(summarize(original).openTrades, 0);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('continuation accounts close independently with frozen per-account terms', () => {
  const opened = open(fundedState(), ['eval-2', 'eval-3', 'funded-1']);
  const first = close(opened, 'funded-1', 'win');
  assert.equal(get(first).balance, 54000);
  assert.equal(get(first).stage, STAGES.QUALIFYING);
  assert.equal(get(first).openTrade, null);
  assert.deepEqual(get(first, 'eval-2'), get(opened, 'eval-2'));
  assert.deepEqual(get(first, 'eval-3'), get(opened, 'eval-3'));
  const state = close(first, 'eval-3', 'loss');
  assert.equal(get(state, 'eval-3').balance, 49000);
  assert.equal(get(state, 'eval-3').evaluationRole, 'continuation');
  assert.equal(summarize(state).openTrades, 1);
  assert.equal(summarize(state).trades, 4);
  const event = state.events.at(-1);
  assert.equal(event.type, 'trade');
  assert.equal(event.openTradeId, get(opened, 'eval-3').openTrade.id);
  assert.equal(event.pattern, 'continuation');
  assert.equal(event.openedDate, '2026-09-29');
  assert.equal(event.openedAt, '2026-09-29T18:00:00.000Z');
  assert.throws(() => trade(state, 'eval-3', 'win'), /Open a continuation/);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('passing the primary promotes an open continuation evaluation without activating another waiting account', () => {
  const initial = trade(createState(), 'eval-1', 'win');
  const opened = open(initial, ['eval-1', 'eval-2']);
  const promoted = close(opened, 'eval-1', 'win');
  assert.equal(get(promoted, 'eval-1').evaluationRole, null);
  assert.equal(get(promoted, 'eval-2').evaluationRole, 'primary');
  assert.deepEqual(get(promoted, 'eval-2').openTrade, get(opened, 'eval-2').openTrade);
  assert.equal(get(promoted, 'eval-3').stage, STAGES.WAITING);
  assert.equal(promoted.selectedId, 'eval-2');
  const closed = close(promoted, 'eval-2', 'win');
  const passed = trade(closed, 'eval-2', 'win');
  assert.equal(get(passed, 'eval-3').stage, STAGES.EVALUATION);
  assert.equal(get(passed, 'eval-3').evaluationRole, 'primary');
  assert.deepEqual(parseBackup(exportBackup(promoted)), promoted);
});

test('a secondary evaluation passing or failing preserves the current primary and other open trades', () => {
  let state = createState({ ...DEFAULT_SETTINGS, evaluationWin: 3000, evaluationLoss: 2000 });
  state = open(state, ['eval-1', 'eval-2', 'eval-3']);
  const primary = structuredClone(get(state, 'eval-1'));
  state = close(state, 'eval-3', 'loss');
  assert.equal(get(state, 'eval-3').stage, STAGES.EVAL_FAILED);
  assert.equal(get(state, 'eval-3').evaluationRole, null);
  assert.deepEqual(get(state, 'eval-1'), primary);
  assert.ok(get(state, 'eval-2').openTrade);
  state = close(state, 'eval-2', 'win');
  assert.equal(get(state, 'eval-2').stage, STAGES.PASSED);
  assert.equal(get(state, 'funded-2').openTrade, null);
  assert.deepEqual(get(state, 'eval-1'), primary);
  assert.equal(get(state, 'eval-4').stage, STAGES.WAITING);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('a continuation participant can reopen after closing without promoting other waiting accounts', () => {
  const original = close(open(createState(), ['eval-2']), 'eval-2', 'loss');
  const state = close(open(original, ['eval-2']), 'eval-2', 'win');
  assert.equal(get(state, 'eval-2').balance, 50500);
  assert.equal(get(state, 'eval-1').evaluationRole, 'primary');
  assert.equal(get(state, 'eval-3').stage, STAGES.WAITING);
  assert.equal(summarize(state).trades, 2);
  assert.equal(summarize(state).openTrades, 0);
});

test('invalid group openings reject all participants atomically', () => {
  const base = fundedState();
  const opened = open(base, ['funded-1']);
  const ready = readyState();
  for (const [state, ids] of [
    [base, []], [base, ['eval-2', 'eval-2']], [base, ['eval-2', 'missing']],
    [base, ['eval-2', 'eval-1']], [opened, ['eval-3', 'funded-1']],
    [ready, ['eval-2', 'funded-1']],
  ]) {
    const before = exportBackup(state);
    assert.throws(() => open(state, ids));
    assert.equal(exportBackup(state), before);
  }
  assert.throws(() => open(base, ['eval-2'], '2026-02-30'), /valid trade date/);
  assert.throws(() => act(base, { type: 'open_continuation', accountIds: 'eval-2' }), /Choose one or more/);
  assert.equal(canOpenContinuation(get(base, 'eval-3')), true);
  assert.equal(canOpenContinuation(get(base)), true);
  assert.equal(canOpenContinuation(get(opened)), false);
  assert.equal(canOpenContinuation(get(ready)), false);
  assert.equal(canOpenContinuation(get(base, 'eval-1')), false);
});

test('closing requires an open trade and direct results cannot resolve an open trade', () => {
  const original = open(fundedState(), ['eval-2', 'funded-1']);
  const before = exportBackup(original);
  assert.throws(() => trade(original, 'funded-1', 'win'), /Close this account/);
  assert.throws(() => close(original, 'eval-3', 'loss'), /no open trade/);
  assert.throws(() => close(original, 'missing', 'loss'), /not found/);
  assert.throws(() => close(original, 'funded-1', 'other'), /Choose Win or Loss/);
  assert.equal(exportBackup(original), before);
});

test('settings retain open continuation rules and terms while updating waiting accounts', () => {
  const opened = open(fundedState(), ['eval-3', 'funded-1']);
  const state = act(opened, { type: 'settings', settings: {
    ...DEFAULT_SETTINGS, evaluationStart: 60000, evaluationTarget: 65000, evaluationWin: 2000, fundedMainWin: 5000,
  } });
  assert.equal(get(state, 'eval-3').balance, 50000);
  assert.equal(get(state, 'eval-3').rules.evaluationWin, 1500);
  assert.equal(get(state, 'eval-4').balance, 60000);
  assert.equal(get(close(state, 'eval-3', 'win'), 'eval-3').balance, 51500);
  assert.equal(get(close(state, 'funded-1', 'win')).balance, 54000);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('funded continuation closes preserve second-attempt risk and failure rules', () => {
  let state = act(readyState(), { type: 'payout', accountId: 'funded-1' });
  state = trade(state, 'funded-1', 'loss');
  state = open(state, ['funded-1', 'eval-2']);
  assert.equal(get(state).openTrade.loss, 800);
  state = close(state, 'funded-1', 'loss');
  assert.equal(get(state).balance, 50000);
  assert.equal(get(state).stage, STAGES.FUNDED_FAILED);
  assert.ok(get(state, 'eval-2').openTrade);
  assert.equal(canOpenContinuation(get(state)), false);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('qualifying continuation closes use independently selected dates and preserve distinct-day rules', () => {
  const main = trade(fundedState(), 'funded-1', 'win', '2026-09-28');
  const opened = open(main, ['funded-1', 'eval-2'], '2026-09-28');
  const oneDay = close(opened, 'funded-1', 'win', '2026-09-29');
  assert.deepEqual(get(oneDay).qualifyingDates, ['2026-09-29']);
  const repeated = open(oneDay, ['funded-1']);
  assert.throws(() => close(repeated, 'funded-1', 'win'), /already has a qualifying win/);
  assert.ok(get(repeated).openTrade);
  const loss = close(repeated, 'funded-1', 'loss');
  assert.deepEqual(get(loss).qualifyingDates, ['2026-09-29']);
  assert.ok(get(loss, 'eval-2').openTrade);
  assert.deepEqual(parseBackup(exportBackup(loss)), loss);
});

test('different funded accounts can qualify on the same date while closing independently', () => {
  let state = trade(trade(fundedState(), 'eval-2', 'win'), 'eval-2', 'win');
  state = trade(trade(state, 'funded-1', 'win'), 'funded-2', 'win');
  state = open(state, ['funded-1', 'funded-2']);
  const first = close(state, 'funded-2', 'win');
  assert.deepEqual(get(first, 'funded-2').qualifyingDates, ['2026-09-29']);
  assert.deepEqual(get(first).qualifyingDates, []);
  assert.ok(get(first).openTrade);
  const both = close(first, 'funded-1', 'win');
  assert.deepEqual(get(both).qualifyingDates, ['2026-09-29']);
  assert.deepEqual(get(both, 'funded-2').qualifyingDates, ['2026-09-29']);
  assert.equal(summarize(both).openTrades, 0);
  assert.deepEqual(parseBackup(exportBackup(both)), both);
});

test('undo opening restores the queue and undo closing restores every pending trade', () => {
  const original = fundedState();
  const opened = open(original, ['eval-2', 'eval-3', 'funded-1']);
  assert.deepEqual(act(opened, { type: 'undo' }).accounts, original.accounts);
  const closed = close(opened, 'funded-1', 'win');
  const undone = act(closed, { type: 'undo' });
  assert.deepEqual(undone.accounts, opened.accounts);
  assert.equal(summarize(undone).openTrades, 3);
  assert.equal(summarize(undone).trades, summarize(original).trades);
  assert.deepEqual(parseBackup(exportBackup(undone)), undone);
  const reopened = act(undone, { type: 'undo' });
  assert.deepEqual(reopened.accounts, original.accounts);
  assert.deepEqual(parseBackup(exportBackup(reopened)), reopened);
});

test('undo an open-trade evaluation pass restores its primary role and other participant roles', () => {
  const initial = trade(createState(), 'eval-1', 'win');
  const opened = open(initial, ['eval-1', 'eval-2']);
  const passed = close(opened, 'eval-1', 'win');
  const undone = act(passed, { type: 'undo' });
  assert.deepEqual(undone.accounts, opened.accounts);
  assert.equal(undone.selectedId, opened.selectedId);
  assert.deepEqual(parseBackup(exportBackup(undone)), undone);
});

test('new evaluations join the waiting queue while continuation trades remain open', () => {
  const state = act(open(createState(), ['eval-2']), { type: 'add_evaluation' });
  assert.equal(get(state, 'eval-11').stage, STAGES.WAITING);
  assert.equal(get(state, 'eval-11').evaluationRole, null);
  assert.equal(get(state, 'eval-11').openTrade, null);
  assert.equal(get(state, 'eval-1').evaluationRole, 'primary');
  assert.ok(get(state, 'eval-2').openTrade);
  assert.equal(summarize(state).costCents, 99220);
});

test('version-two data and snapshots migrate to closed trades and original primary evaluation roles', () => {
  const current = act(readyState(), { type: 'payout', accountId: 'funded-1' });
  const legacy = JSON.parse(exportBackup(current));
  legacy.version = 2;
  for (const snapshot of [legacy, ...legacy.undoStack]) {
    for (const account of snapshot.accounts) {
      delete account.openTrade;
      delete account.evaluationRole;
      delete account.evaluationHighWater;
      delete account.mainWinDate;
    }
  }
  const restored = parseBackup(JSON.stringify(legacy));
  assert.equal(restored.version, VERSION);
  assert.deepEqual(restored, current);
  assert.deepEqual(act(restored, { type: 'undo' }).accounts, readyState().accounts);
});

test('backups reject malformed open trades, roles, opening events, and pending history', () => {
  for (const corrupt of [
    state => { delete state.accounts[0].openTrade; },
    state => { state.accounts[0].evaluationRole = 'continuation'; },
    state => { state.accounts[1].evaluationRole = 'primary'; },
    state => { state.accounts[2].evaluationRole = 'continuation'; },
    state => { state.accounts[1].openTrade.id = state.accounts[0].openTrade.id; },
    state => { state.accounts[1].openTrade.stage = STAGES.MAIN; },
    state => { state.accounts[1].openTrade.cycle = 1; },
    state => { state.accounts[1].openTrade.balanceBefore = 49000; },
    state => { state.accounts[1].openTrade.win = 3000; },
    state => { state.accounts[1].openTrade.date = '2026-02-30'; },
    state => { state.accounts[1].openTrade.openedAt = 'invalid'; },
    state => { state.accounts[1].openTrade = null; },
    state => { state.events[0].pnl = 1500; },
    state => { state.events[0].openTradeId = 'missing'; },
    state => { state.events[0].accountId = 'missing'; },
    state => { state.events[0].pattern = 'other'; },
    state => { state.events[0].openedDate = '2026-09-28'; },
    state => { state.events[0].win = -1; },
    state => { state.events[1].openTradeId = state.events[0].openTradeId; },
    state => { state.undoStack[0].accounts[0].evaluationRole = null; },
  ]) {
    const state = structuredClone(open(createState(), ['eval-1', 'eval-2']));
    corrupt(state);
    assert.throws(() => parseBackup(exportBackup(state)));
  }
});

test('backups validate closing links and retain reversed opening history for removed added accounts', () => {
  const opened = open(createState(), ['eval-1']);
  for (const corrupt of [
    state => { state.events.at(-1).openTradeId = 'missing'; },
    state => { state.events.at(-1).openedDate = '2026-09-28'; },
    state => { state.events.at(-1).pattern = 'other'; },
    state => { state.accounts[0].openTrade = opened.accounts[0].openTrade; },
  ]) {
    const state = structuredClone(close(opened, 'eval-1', 'win'));
    corrupt(state);
    assert.throws(() => parseBackup(exportBackup(state)));
  }
  let state = act(createState(), { type: 'add_evaluation' });
  state = open(state, ['eval-11']);
  state = act(act(state, { type: 'undo' }), { type: 'undo' });
  assert.equal(get(state, 'eval-11'), undefined);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

const record = (state, accountId, result, date = '2026-09-29') => act(state, { type: 'record_result', accountId, result, date });

test('recording a waiting evaluation result activates it without touching the primary or creating an opening event', () => {
  const original = createState();
  const state = record(original, 'eval-3', 'win');
  assert.equal(get(state, 'eval-3').balance, 51500);
  assert.equal(get(state, 'eval-3').stage, STAGES.EVALUATION);
  assert.equal(get(state, 'eval-3').evaluationRole, 'continuation');
  assert.equal(get(state, 'eval-3').openTrade, null);
  assert.deepEqual(get(state, 'eval-1'), get(original, 'eval-1'));
  assert.deepEqual(get(state, 'eval-2'), get(original, 'eval-2'));
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].type, 'trade');
  assert.equal(state.events[0].openTradeId, undefined);
  assert.equal(state.undoStack.length, 1);
  assert.equal(summarize(state).trades, 1);
  assert.equal(summarize(state).openTrades, 0);
  assert.equal(summarize(state).costCents, summarize(original).costCents);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
  assert.deepEqual(act(state, { type: 'undo' }).accounts, original.accounts);
});

test('secondary evaluation tiles accept repeated results and preserve independent balances', () => {
  let state = record(createState(), 'eval-2', 'loss');
  const first = structuredClone(get(state, 'eval-2'));
  state = record(state, 'eval-3', 'win');
  assert.deepEqual(get(state, 'eval-2'), first);
  state = record(state, 'eval-2', 'win');
  assert.equal(get(state, 'eval-2').balance, 50500);
  assert.equal(get(state, 'eval-3').balance, 51500);
  assert.equal(get(state, 'eval-1').balance, 50000);
  assert.equal(get(state, 'eval-1').evaluationRole, 'primary');
  assert.equal(state.undoStack.length, 3);
  assert.equal(state.events.filter(event => event.type === 'trade_opened').length, 0);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('direct waiting results may pass or fail and retain the ordinary primary queue', () => {
  const original = createState({ ...DEFAULT_SETTINGS, evaluationWin: 3000, evaluationLoss: 2000 });
  const passed = record(original, 'eval-2', 'win');
  assert.equal(get(passed, 'eval-2').stage, STAGES.PASSED);
  assert.equal(get(passed, 'eval-2').evaluationRole, null);
  assert.equal(get(passed, 'funded-2').balance, 50000);
  assert.equal(get(passed, 'funded-2').openTrade, null);
  assert.deepEqual(get(passed, 'eval-1'), get(original, 'eval-1'));
  assert.equal(get(passed, 'eval-3').stage, STAGES.WAITING);
  assert.equal(passed.undoStack.length, 1);
  const failed = record(passed, 'eval-3', 'loss');
  assert.equal(get(failed, 'eval-3').stage, STAGES.EVAL_FAILED);
  assert.equal(get(failed, 'eval-3').evaluationRole, null);
  assert.deepEqual(get(failed, 'eval-1'), get(original, 'eval-1'));
  assert.deepEqual(parseBackup(exportBackup(failed)), failed);
});

test('a primary tile result promotes an existing secondary evaluation before starting another waiting account', () => {
  let state = record(createState(), 'eval-2', 'win');
  state = record(record(state, 'eval-1', 'win'), 'eval-1', 'win');
  assert.equal(get(state, 'eval-1').stage, STAGES.PASSED);
  assert.equal(get(state, 'eval-2').evaluationRole, 'primary');
  assert.equal(get(state, 'eval-3').stage, STAGES.WAITING);
  state = record(state, 'eval-2', 'win');
  assert.equal(get(state, 'eval-2').stage, STAGES.PASSED);
  assert.equal(get(state, 'eval-3').evaluationRole, 'primary');
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('tile results close legacy pending trades with frozen terms and a single undo snapshot', () => {
  const opened = open(fundedState(), ['funded-1', 'eval-3']);
  const pending = get(opened).openTrade;
  const state = record(opened, 'funded-1', 'win');
  assert.equal(get(state).openTrade, null);
  assert.equal(get(state).balance, 54000);
  assert.equal(get(state).stage, STAGES.QUALIFYING);
  assert.deepEqual(get(state, 'eval-3'), get(opened, 'eval-3'));
  assert.equal(state.undoStack.length, opened.undoStack.length + 1);
  const result = state.events.findLast(event => event.type === 'trade');
  assert.equal(result.openTradeId, pending.id);
  assert.equal(result.pattern, 'continuation');
  assert.equal(result.openedAt, pending.openedAt);
  assert.equal(result.openedDate, pending.date);
  assert.equal(state.events.filter(event => event.type === 'trade_opened').length, 2);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
  assert.deepEqual(act(state, { type: 'undo' }).accounts, opened.accounts);
});

test('funded tile results preserve distinct qualifying dates and each account closes independently', () => {
  let state = record(record(fundedState(), 'eval-2', 'win'), 'eval-2', 'win');
  state = record(record(state, 'funded-1', 'win', '2026-09-28'), 'funded-2', 'win', '2026-09-28');
  state = record(state, 'funded-2', 'win', '2026-09-28');
  state = record(state, 'funded-1', 'win', '2026-09-28');
  assert.deepEqual(get(state).qualifyingDates, ['2026-09-28']);
  assert.deepEqual(get(state, 'funded-2').qualifyingDates, ['2026-09-28']);
  const before = exportBackup(state);
  assert.throws(() => record(state, 'funded-1', 'win', '2026-09-28'), /already has a qualifying win/);
  assert.equal(exportBackup(state), before);
  const updated = record(state, 'funded-1', 'loss', '2026-09-28');
  assert.deepEqual(get(updated).qualifyingDates, ['2026-09-28']);
  assert.deepEqual(get(updated, 'funded-2'), get(state, 'funded-2'));
  assert.deepEqual(parseBackup(exportBackup(updated)), updated);
});

test('tile results and result terms reject ineligible accounts while preserving input state', () => {
  const state = readyState();
  assert.equal(resultTerms(get(state)), null);
  assert.equal(resultTerms(get(state, 'eval-1')), null);
  assert.equal(resultTerms(undefined), null);
  assert.deepEqual(resultTerms(get(state, 'eval-3')), { win: 1500, loss: 1000 });
  const opened = open(fundedState(), ['funded-1']);
  assert.deepEqual(resultTerms(get(opened)), { win: 4000, loss: 1000 });
  for (const [accountId, result, date] of [
    ['funded-1', 'win', '2026-09-29'], ['eval-1', 'loss', '2026-09-29'],
    ['missing', 'win', '2026-09-29'], ['eval-3', 'other', '2026-09-29'],
    ['eval-3', 'win', '2026-02-30'],
  ]) {
    const before = exportBackup(state);
    assert.throws(() => record(state, accountId, result, date));
    assert.equal(exportBackup(state), before);
  }
});

test('all result routes accept today and historical dates', () => {
  for (const date of ['2026-09-29', '2026-09-28', '2025-12-31']) {
    const initial = createState();
    const direct = trade(initial, 'eval-1', 'win', date);
    assert.equal(get(direct, 'eval-1').balance, 51500);
    assert.equal(direct.events[0].date, date);
    const tile = record(initial, 'eval-2', 'loss', date);
    assert.equal(get(tile, 'eval-2').balance, 49000);
    assert.equal(tile.events[0].date, date);
    const opened = open(initial, ['eval-1', 'eval-2'], date);
    assert.equal(get(opened, 'eval-1').openTrade.date, date);
    const closed = close(opened, 'eval-2', 'win', date);
    assert.equal(get(closed, 'eval-2').balance, 51500);
    assert.equal(closed.events.at(-1).date, date);
  }
});

test('tomorrow is rejected atomically for Win and Loss through every result route', () => {
  const initial = createState();
  const opened = open(initial, ['eval-1', 'eval-2']);
  for (const result of ['win', 'loss']) {
    for (const [state, action] of [
      [initial, { type: 'trade', accountId: 'eval-1', result }],
      [initial, { type: 'record_result', accountId: 'eval-2', result }],
      [opened, { type: 'record_result', accountId: 'eval-1', result }],
      [opened, { type: 'close_trade', accountId: 'eval-2', result }],
    ]) {
      const before = exportBackup(state);
      assert.throws(() => act(state, { ...action, date: '2026-09-30' }), { message: 'Future trade dates are not allowed.' });
      assert.equal(exportBackup(state), before);
    }
  }
  const before = exportBackup(initial);
  assert.throws(() => open(initial, ['eval-1', 'eval-2'], '2026-09-30'), { message: 'Future trade dates are not allowed.' });
  assert.equal(exportBackup(initial), before);
});

test('new action dates default to the supplied current timestamp rather than the real test execution date', () => {
  const state = applyAction(createState(), { type: 'record_result', accountId: 'eval-2', result: 'win' }, {
    actionId: `test-${++serial}`, timestamp: '2026-08-20T18:00:00.000Z',
  });
  assert.equal(state.events[0].date, '2026-08-20');
  assert.equal(get(state, 'eval-2').balance, 51500);
});

test('future dates use the local calendar at UTC midnight boundaries', () => {
  const previousTimezone = process.env.TZ;
  const originalTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    for (const [timezone, timestamp, today, tomorrow] of [
      ['America/Chicago', '2026-09-30T03:30:00.000Z', '2026-09-29', '2026-09-30'],
      ['Asia/Tokyo', '2026-09-29T16:30:00.000Z', '2026-09-30', '2026-10-01'],
    ]) {
      process.env.TZ = timezone;
      const context = { timestamp, actionId: `test-${++serial}` };
      const action = { type: 'record_result', accountId: 'eval-2', result: 'win', date: today };
      assert.equal(applyAction(createState(), action, context).events[0].date, today);
      assert.throws(() => applyAction(createState(), { ...action, date: tomorrow }, context), { message: 'Future trade dates are not allowed.' });
      const defaulted = applyAction(createState(), { type: 'trade', accountId: 'eval-1', result: 'loss' }, context);
      assert.equal(defaulted.events[0].date, today);
    }
  } finally {
    process.env.TZ = previousTimezone ?? originalTimezone;
    if (previousTimezone === undefined) delete process.env.TZ;
  }
});

test('previously saved future-dated trades and open trades remain loadable without rewriting their dates', () => {
  let state = applyAction(createState(), { type: 'open_continuation', accountIds: ['eval-1', 'eval-2'], date: '2099-01-02' }, {
    actionId: `test-${++serial}`, timestamp: '2099-01-02T18:00:00.000Z',
  });
  state = applyAction(state, { type: 'close_trade', accountId: 'eval-1', result: 'win', date: '2099-01-03' }, {
    actionId: `test-${++serial}`, timestamp: '2099-01-03T18:00:00.000Z',
  });
  const backup = exportBackup(state);
  assert.deepEqual(parseBackup(backup), state);
  const memory = new Map([[STORAGE_KEY, backup]]);
  const storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
  const loaded = loadState(storage);
  assert.equal(loaded.error, null);
  assert.deepEqual(loaded.state, state);
  assert.equal(memory.get(STORAGE_KEY), backup);
  assert.equal(get(loaded.state, 'eval-2').openTrade.date, '2099-01-02');
  assert.equal(loaded.state.events.findLast(event => event.type === 'trade').date, '2099-01-03');
});

test('completed evaluations and failed funded accounts are archived across all lifecycle stages', () => {
  for (const stage of [STAGES.WAITING, STAGES.EVALUATION, STAGES.PASSED, STAGES.EVAL_FAILED]) {
    assert.equal(isArchived({ type: 'evaluation', stage }), [STAGES.PASSED, STAGES.EVAL_FAILED].includes(stage));
  }
  for (const stage of [STAGES.MAIN, STAGES.QUALIFYING, STAGES.PAYOUT, STAGES.FUNDED_FAILED]) {
    assert.equal(isArchived({ type: 'funded', stage }), stage === STAGES.FUNDED_FAILED);
  }
  assert.equal(isArchived({ type: 'funded', stage: STAGES.EVAL_FAILED }), false);
  assert.equal(isArchived({ type: 'funded', stage: STAGES.PASSED }), false);
  assert.equal(isArchived(undefined), false);
  assert.equal(isArchived(null), false);
});

test('archived evaluations preserve purchase costs and history and undo restores them to the portfolio', () => {
  const initial = createState({ ...DEFAULT_SETTINGS, startingEvaluations: 1 });
  const firstLoss = record(initial, 'eval-1', 'loss');
  const failed = record(firstLoss, 'eval-1', 'loss');
  assert.equal(isArchived(get(failed, 'eval-1')), true);
  assert.equal(failed.accounts.length, 1);
  assert.equal(failed.selectedId, 'eval-1');
  assert.equal(summarize(failed).costCents, 9020);
  assert.equal(summarize(failed).evaluationCount, 1);
  assert.equal(summarize(failed).evalFailed, 1);
  assert.equal(summarize(failed).trades, 2);
  assert.equal(failed.events.filter(event => event.type === 'trade').length, 2);
  assert.equal(failed.events.at(-1).type, 'evaluation_failure');
  assert.deepEqual(parseBackup(exportBackup(failed)), failed);
  const undone = act(failed, { type: 'undo' });
  assert.equal(isArchived(get(undone, 'eval-1')), false);
  assert.deepEqual(undone.accounts, firstLoss.accounts);
  assert.equal(summarize(undone).costCents, 9020);
  assert.equal(summarize(undone).evalFailed, 0);
  assert.equal(summarize(undone).trades, 1);
  assert.equal(undone.events.length, failed.events.length + 1);
  assert.equal(undone.events.at(-1).type, 'undo');
  assert.deepEqual(parseBackup(exportBackup(undone)), undone);
});

test('evaluation drawdown follows the closed-balance peak through the requested Win Loss Win sequence', () => {
  let state = createState();
  assert.equal(get(state, 'eval-1').evaluationHighWater, 50000);
  assert.equal(evaluationFailureLevel(get(state, 'eval-1')), 48000);
  state = record(state, 'eval-1', 'win');
  assert.equal(get(state, 'eval-1').balance, 51500);
  assert.equal(get(state, 'eval-1').evaluationHighWater, 51500);
  assert.equal(evaluationFailureLevel(get(state, 'eval-1')), 49500);
  state = record(state, 'eval-1', 'loss');
  assert.equal(get(state, 'eval-1').balance, 50500);
  assert.equal(get(state, 'eval-1').evaluationHighWater, 51500);
  assert.equal(evaluationFailureLevel(get(state, 'eval-1')), 49500);
  state = record(state, 'eval-1', 'win');
  assert.equal(get(state, 'eval-1').balance, 52000);
  assert.equal(get(state, 'eval-1').evaluationHighWater, 52000);
  assert.equal(evaluationFailureLevel(get(state, 'eval-1')), 50000);
  assert.equal(get(state, 'eval-1').stage, STAGES.EVALUATION);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('evaluation drawdown holds after losses and fails when balance reaches the capped floor exactly', () => {
  let state = record(record(record(createState(), 'eval-1', 'win'), 'eval-1', 'loss'), 'eval-1', 'win');
  state = record(state, 'eval-1', 'loss');
  assert.equal(get(state, 'eval-1').balance, 51000);
  assert.equal(evaluationFailureLevel(get(state, 'eval-1')), 50000);
  const failed = record(state, 'eval-1', 'loss');
  assert.equal(get(failed, 'eval-1').balance, 50000);
  assert.equal(get(failed, 'eval-1').evaluationHighWater, 52000);
  assert.equal(evaluationFailureLevel(get(failed, 'eval-1')), 50000);
  assert.equal(isArchived(get(failed, 'eval-1')), true);
  assert.equal(get(failed, 'eval-2').evaluationRole, 'primary');
  assert.equal(summarize(failed).costCents, 90200);
  assert.deepEqual(parseBackup(exportBackup(failed)), failed);
  const undone = act(failed, { type: 'undo' });
  assert.deepEqual(undone.accounts, state.accounts);
  assert.equal(isArchived(get(undone, 'eval-1')), false);
  assert.equal(evaluationFailureLevel(get(undone, 'eval-1')), 50000);
});

test('the uncapped trailing floor also fails at equality or below, even above the original failure balance', () => {
  let state = record(createState(), 'eval-1', 'win');
  state = record(record(state, 'eval-1', 'loss'), 'eval-1', 'loss');
  assert.equal(get(state, 'eval-1').balance, 49500);
  assert.equal(evaluationFailureLevel(get(state, 'eval-1')), 49500);
  assert.equal(isArchived(get(state, 'eval-1')), true);
  const custom = createState({ ...DEFAULT_SETTINGS, evaluationLoss: 2600 });
  const below = record(record(custom, 'eval-1', 'win'), 'eval-1', 'loss');
  assert.equal(get(below, 'eval-1').balance, 48900);
  assert.equal(evaluationFailureLevel(get(below, 'eval-1')), 49500);
  assert.equal(isArchived(get(below, 'eval-1')), true);
});

test('all result APIs trail evaluations while opening alone leaves peaks unchanged', () => {
  for (const resolve of [
    (state, result) => trade(state, 'eval-1', result),
    (state, result) => record(state, 'eval-1', result),
    (state, result) => close(open(state, ['eval-1']), 'eval-1', result),
  ]) {
    let state = resolve(createState(), 'win');
    assert.equal(get(state, 'eval-1').evaluationHighWater, 51500);
    state = resolve(state, 'loss');
    assert.equal(get(state, 'eval-1').evaluationHighWater, 51500);
    assert.equal(evaluationFailureLevel(get(state, 'eval-1')), 49500);
    assert.deepEqual(parseBackup(exportBackup(state)), state);
  }
  const opened = open(createState(), ['eval-1', 'eval-2']);
  assert.equal(get(opened, 'eval-1').evaluationHighWater, 50000);
  assert.equal(get(opened, 'eval-2').evaluationHighWater, 50000);
});

test('evaluation peaks and floors remain independent across accounts and do not affect funded rules', () => {
  let state = record(createState(), 'eval-2', 'win');
  state = record(state, 'eval-3', 'loss');
  assert.equal(evaluationFailureLevel(get(state, 'eval-1')), 48000);
  assert.equal(evaluationFailureLevel(get(state, 'eval-2')), 49500);
  assert.equal(evaluationFailureLevel(get(state, 'eval-3')), 48000);
  assert.equal(get(state, 'eval-3').evaluationHighWater, 50000);
  state = record(state, 'eval-2', 'win');
  assert.equal(get(state, 'eval-2').evaluationHighWater, 53000);
  assert.equal(evaluationFailureLevel(get(state, 'eval-2')), 50000);
  assert.equal(get(state, 'funded-2').evaluationHighWater, undefined);
  assert.equal(evaluationFailureLevel(get(state, 'funded-2')), null);
  assert.equal(evaluationFailureLevel(undefined), null);
  state = record(record(state, 'funded-2', 'loss'), 'funded-2', 'loss');
  assert.equal(get(state, 'funded-2').stage, STAGES.FUNDED_FAILED);
  assert.equal(get(state, 'funded-2').balance, 48000);
  assert.equal(evaluationFailureLevel(get(state, 'eval-1')), 48000);
});

test('undo restores the previous peak and floor while retaining the reversed trade history', () => {
  const initial = createState();
  const won = record(initial, 'eval-1', 'win');
  const undone = act(won, { type: 'undo' });
  assert.deepEqual(undone.accounts, initial.accounts);
  assert.equal(get(undone, 'eval-1').evaluationHighWater, 50000);
  assert.equal(evaluationFailureLevel(get(undone, 'eval-1')), 48000);
  assert.equal(undone.events[0].balanceAfter, 51500);
  assert.equal(undone.events.at(-1).type, 'undo');
  assert.deepEqual(parseBackup(exportBackup(undone)), undone);
});

test('custom drawdown distances, new evaluations and waiting settings use their own starting balances', () => {
  let state = record(createState(), 'eval-1', 'win');
  state = open(state, ['eval-3']);
  state = act(state, { type: 'settings', settings: {
    ...DEFAULT_SETTINGS, evaluationStart: 60000, evaluationTarget: 65000, evaluationFailure: 57500,
  } });
  assert.equal(get(state, 'eval-1').evaluationHighWater, 51500);
  assert.equal(evaluationFailureLevel(get(state, 'eval-1')), 49500);
  assert.equal(get(state, 'eval-3').evaluationHighWater, 50000);
  assert.equal(evaluationFailureLevel(get(state, 'eval-3')), 48000);
  assert.equal(get(state, 'eval-2').evaluationHighWater, 60000);
  assert.equal(evaluationFailureLevel(get(state, 'eval-2')), 57500);
  state = act(state, { type: 'add_evaluation' });
  assert.equal(get(state, 'eval-11').evaluationHighWater, 60000);
  state = record(state, 'eval-11', 'win');
  assert.equal(get(state, 'eval-11').balance, 61500);
  assert.equal(evaluationFailureLevel(get(state, 'eval-11')), 59000);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

function versionThreeBackup(state) {
  const legacy = JSON.parse(exportBackup(state));
  legacy.version = 3;
  for (const snapshot of [legacy, ...legacy.undoStack]) {
    for (const account of snapshot.accounts) {
      delete account.evaluationHighWater;
      delete account.mainWinDate;
    }
  }
  return JSON.stringify(legacy);
}

test('version-three migration rebuilds peaks in audit order and restricts every snapshot to its preceding history', () => {
  let state = record(createState(), 'eval-1', 'win', '2026-09-29');
  state = record(state, 'eval-1', 'loss', '2026-09-28');
  state = record(state, 'eval-1', 'win', '2026-09-27');
  const migrated = parseBackup(versionThreeBackup(state));
  assert.deepEqual(migrated, state);
  assert.equal(migrated.version, VERSION);
  assert.equal(get(migrated, 'eval-1').evaluationHighWater, 52000);
  assert.equal(migrated.undoStack[0].accounts[0].evaluationHighWater, 50000);
  assert.equal(migrated.undoStack[1].accounts[0].evaluationHighWater, 51500);
  assert.equal(migrated.undoStack[2].accounts[0].evaluationHighWater, 51500);
  const undone = act(migrated, { type: 'undo' });
  assert.equal(get(undone, 'eval-1').balance, 50500);
  assert.equal(get(undone, 'eval-1').evaluationHighWater, 51500);
  assert.equal(evaluationFailureLevel(get(undone, 'eval-1')), 49500);
});

test('migration excludes reversed trades in current state and each snapshot prefix', () => {
  let state = record(createState(), 'eval-1', 'win');
  state = act(state, { type: 'undo' });
  state = record(state, 'eval-1', 'loss');
  state = record(state, 'eval-1', 'win');
  const migrated = parseBackup(versionThreeBackup(state));
  assert.deepEqual(migrated, state);
  assert.equal(get(migrated, 'eval-1').evaluationHighWater, 50500);
  assert.equal(migrated.undoStack[0].accounts[0].evaluationHighWater, 50000);
  assert.equal(migrated.undoStack[1].accounts[0].evaluationHighWater, 50000);
  assert.equal(evaluationFailureLevel(get(act(migrated, { type: 'undo' }), 'eval-1')), 48000);
});

test('migration handles reused account IDs and reverted waiting-account settings without carrying old peaks', () => {
  let state = act(createState(), { type: 'add_evaluation' });
  state = record(state, 'eval-11', 'win');
  state = act(act(state, { type: 'undo' }), { type: 'undo' });
  state = act(state, { type: 'settings', settings: { ...DEFAULT_SETTINGS, evaluationStart: 60000, evaluationTarget: 65000 } });
  state = act(state, { type: 'undo' });
  state = act(state, { type: 'add_evaluation' });
  state = record(state, 'eval-11', 'loss');
  const migrated = parseBackup(versionThreeBackup(state));
  assert.deepEqual(migrated, state);
  assert.equal(get(migrated, 'eval-11').evaluationHighWater, 50000);
  assert.equal(evaluationFailureLevel(get(migrated, 'eval-11')), 48000);
  assert.equal(get(migrated, 'eval-2').evaluationHighWater, 50000);
});

test('migration preserves an old active account at its raised floor until a new result enforces trailing drawdown', () => {
  let state = record(record(record(createState(), 'eval-1', 'win'), 'eval-1', 'loss'), 'eval-1', 'loss');
  const legacy = JSON.parse(versionThreeBackup(state));
  legacy.accounts[0].stage = STAGES.EVALUATION;
  legacy.accounts[0].evaluationRole = 'primary';
  legacy.accounts[1].stage = STAGES.WAITING;
  legacy.accounts[1].evaluationRole = null;
  legacy.selectedId = 'eval-1';
  legacy.events = legacy.events.filter(event => event.type !== 'evaluation_failure');
  const migrated = parseBackup(JSON.stringify(legacy));
  assert.equal(get(migrated, 'eval-1').stage, STAGES.EVALUATION);
  assert.equal(get(migrated, 'eval-1').balance, 49500);
  assert.equal(get(migrated, 'eval-1').evaluationHighWater, 51500);
  assert.equal(evaluationFailureLevel(get(migrated, 'eval-1')), 49500);
  assert.deepEqual(migrated.events, legacy.events);
  assert.equal(isArchived(get(migrated, 'eval-1')), false);
  const enforced = record(migrated, 'eval-1', 'loss');
  assert.equal(get(enforced, 'eval-1').balance, 48500);
  assert.equal(isArchived(get(enforced, 'eval-1')), true);
});

test('version-four backups reject malformed peaks in current accounts and undo snapshots', () => {
  for (const corrupt of [
    state => { delete state.accounts[0].evaluationHighWater; },
    state => { state.accounts[0].evaluationHighWater = '51500'; },
    state => { state.accounts[0].evaluationHighWater = 51499; },
    state => { state.accounts[0].evaluationHighWater = 51500.5; },
    state => { state.accounts[0].evaluationHighWater = Number.MAX_SAFE_INTEGER + 1; },
    state => { state.accounts[1].evaluationHighWater = 51500; },
    state => { state.undoStack[0].accounts[0].evaluationHighWater = 49000; },
    state => { state.accounts[0].rules.evaluationFailure = 50500; state.accounts[0].rules.evaluationStart = 51000; state.accounts[0].rules.evaluationTarget = 55000; },
  ]) {
    const state = structuredClone(record(createState(), 'eval-1', 'win'));
    corrupt(state);
    assert.throws(() => parseBackup(exportBackup(state)), /evaluation high-water/);
  }
});

test('passed evaluations archive without hiding funded accounts or losing costs, history, and trailing progress', () => {
  const before = record(createState(), 'eval-1', 'win');
  const passed = record(before, 'eval-1', 'win');
  assert.equal(isArchived(get(passed, 'eval-1')), true);
  assert.equal(isArchived(get(passed, 'funded-1')), false);
  assert.equal(get(passed, 'funded-1').stage, STAGES.MAIN);
  assert.equal(get(passed, 'funded-1').balance, 50000);
  assert.equal(get(passed, 'eval-1').evaluationHighWater, 53000);
  assert.equal(evaluationFailureLevel(get(passed, 'eval-1')), 50000);
  assert.equal(summarize(passed).costCents, 90200);
  assert.equal(summarize(passed).evaluationCount, 10);
  assert.equal(summarize(passed).passed, 1);
  assert.equal(summarize(passed).funded, 1);
  assert.equal(summarize(passed).trades, 2);
  assert.equal(passed.events.filter(event => event.type === 'evaluation_pass').length, 1);
  assert.equal(passed.events.filter(event => event.type === 'funded_created').length, 1);
  assert.deepEqual(parseBackup(exportBackup(passed)), passed);
  const undone = act(passed, { type: 'undo' });
  assert.equal(isArchived(get(undone, 'eval-1')), false);
  assert.equal(get(undone, 'funded-1'), undefined);
  assert.deepEqual(undone.accounts, before.accounts);
  assert.equal(get(undone, 'eval-1').evaluationHighWater, 51500);
  assert.equal(evaluationFailureLevel(get(undone, 'eval-1')), 49500);
  assert.equal(summarize(undone).costCents, 90200);
  assert.equal(summarize(undone).passed, 0);
  assert.equal(summarize(undone).funded, 0);
  assert.equal(summarize(undone).trades, 1);
  assert.deepEqual(undone.events.slice(0, -1), passed.events);
  assert.equal(undone.events.at(-1).type, 'undo');
  assert.deepEqual(parseBackup(exportBackup(undone)), undone);
});

test('failed funded accounts archive while retaining payouts, costs, history and undoable attempt risk', () => {
  const paid = act(readyState(), { type: 'payout', accountId: 'funded-1' });
  assert.equal(isArchived(get(paid)), false);
  assert.equal(isArchived(get(paid, 'eval-1')), true);
  const firstLoss = record(paid, 'funded-1', 'loss');
  assert.equal(isArchived(get(firstLoss)), false);
  assert.equal(get(firstLoss).mainAttempts, 1);
  assert.deepEqual(resultTerms(get(firstLoss)), { win: 4000, loss: 800 });
  const failed = record(firstLoss, 'funded-1', 'loss');
  assert.equal(isArchived(get(failed)), true);
  assert.equal(get(failed).stage, STAGES.FUNDED_FAILED);
  assert.equal(get(failed).balance, 50000);
  assert.equal(get(failed).mainAttempts, 2);
  assert.equal(isArchived(get(failed, 'eval-1')), true);
  assert.deepEqual(get(failed, 'eval-1'), get(paid, 'eval-1'));
  assert.equal(get(failed, 'eval-1').evaluationHighWater, 53000);
  assert.equal(evaluationFailureLevel(get(failed, 'eval-1')), 50000);
  assert.equal(summarize(failed).withdrawn, 3000);
  assert.equal(summarize(failed).payouts, 1);
  assert.equal(summarize(failed).costCents, 90200);
  assert.equal(summarize(failed).fundedFailed, 1);
  assert.equal(failed.events.at(-1).type, 'funded_failure');
  assert.deepEqual(parseBackup(exportBackup(failed)), failed);
  const undone = act(failed, { type: 'undo' });
  assert.equal(isArchived(get(undone)), false);
  assert.deepEqual(undone.accounts, firstLoss.accounts);
  assert.equal(get(undone).stage, STAGES.MAIN);
  assert.equal(get(undone).mainAttempts, 1);
  assert.deepEqual(resultTerms(get(undone)), { win: 4000, loss: 800 });
  assert.equal(summarize(undone).withdrawn, 3000);
  assert.equal(summarize(undone).payouts, 1);
  assert.equal(summarize(undone).costCents, 90200);
  assert.equal(summarize(undone).fundedFailed, 0);
  assert.deepEqual(undone.events.slice(0, -1), failed.events);
  assert.equal(undone.events.at(-1).type, 'undo');
  assert.deepEqual(parseBackup(exportBackup(undone)), undone);
  const recovered = record(undone, 'funded-1', 'win');
  assert.equal(get(recovered).stage, STAGES.QUALIFYING);
  assert.equal(isArchived(get(recovered)), false);
});

test('funded cycles begin without an anchor and record the selected main-win date', () => {
  const initial = fundedState();
  assert.equal(get(initial).mainWinDate, null);
  assert.equal(qualifyingStartDate(get(initial)), null);
  assert.equal(qualifyingStartDate(get(initial, 'eval-1')), null);
  assert.equal(qualifyingStartDate(undefined), null);
  const firstLoss = record(initial, 'funded-1', 'loss', '2026-09-25');
  assert.equal(get(firstLoss).mainWinDate, null);
  const mainWin = record(firstLoss, 'funded-1', 'win', '2026-09-27');
  assert.equal(get(mainWin).mainWinDate, '2026-09-27');
  assert.equal(qualifyingStartDate(get(mainWin)), '2026-09-27');
  const undone = act(mainWin, { type: 'undo' });
  assert.deepEqual(undone.accounts, firstLoss.accounts);
  assert.equal(get(undone).mainWinDate, null);
  const failed = record(firstLoss, 'funded-1', 'loss');
  assert.equal(get(failed).mainWinDate, null);
  assert.equal(qualifyingStartDate(get(failed)), null);
});

test('qualifying Win and Loss reject earlier dates atomically and allow the main-win day across every result API', () => {
  const main = record(fundedState(), 'funded-1', 'win', '2026-09-27');
  for (const result of ['win', 'loss']) {
    for (const type of ['trade', 'record_result', 'close_trade']) {
      const state = type === 'close_trade' ? open(main, ['funded-1'], '2026-09-27') : main;
      const before = exportBackup(state);
      assert.throws(() => act(state, { type, accountId: 'funded-1', result, date: '2026-09-26' }), {
        message: 'Qualifying trades cannot be dated before the main profit win.',
      });
      assert.equal(exportBackup(state), before);
      const sameDay = act(state, { type, accountId: 'funded-1', result, date: '2026-09-27' });
      assert.equal(get(sameDay).mainWinDate, '2026-09-27');
      assert.deepEqual(get(sameDay).qualifyingDates, result === 'win' ? ['2026-09-27'] : []);
      assert.equal(get(sameDay).openTrade, null);
      const later = act(state, { type, accountId: 'funded-1', result, date: '2026-09-28' });
      assert.equal(later.events.findLast(event => event.type === 'trade').date, '2026-09-28');
      assert.deepEqual(parseBackup(exportBackup(sameDay)), sameDay);
    }
  }
});

test('qualifying anchors remain independent between funded accounts', () => {
  let state = record(record(fundedState(), 'eval-2', 'win'), 'eval-2', 'win');
  state = record(state, 'funded-1', 'win', '2026-09-25');
  state = record(state, 'funded-2', 'win', '2026-09-27');
  const other = structuredClone(get(state, 'funded-2'));
  state = record(state, 'funded-1', 'win', '2026-09-26');
  assert.deepEqual(get(state, 'funded-2'), other);
  assert.equal(qualifyingStartDate(get(state)), '2026-09-25');
  assert.equal(qualifyingStartDate(get(state, 'funded-2')), '2026-09-27');
  assert.throws(() => record(state, 'funded-2', 'loss', '2026-09-26'), /before the main profit win/);
  assert.deepEqual(parseBackup(exportBackup(state)), state);
});

test('payout resets the anchor, later cycles capture new dates and undo restores each phase anchor', () => {
  let state = createState({ ...DEFAULT_SETTINGS, qualifyingWins: 1 });
  state = record(record(state, 'eval-1', 'win'), 'eval-1', 'win');
  state = record(state, 'funded-1', 'win', '2026-09-20');
  const ready = record(state, 'funded-1', 'win', '2026-09-21');
  assert.equal(get(ready).stage, STAGES.PAYOUT);
  assert.equal(qualifyingStartDate(get(ready)), '2026-09-20');
  const paid = act(ready, { type: 'payout', accountId: 'funded-1' });
  assert.equal(get(paid).cycle, 2);
  assert.equal(get(paid).mainWinDate, null);
  const nextCycle = record(paid, 'funded-1', 'win', '2026-09-25');
  assert.equal(qualifyingStartDate(get(nextCycle)), '2026-09-25');
  assert.throws(() => record(nextCycle, 'funded-1', 'win', '2026-09-24'), /before the main profit win/);
  const sameDay = record(nextCycle, 'funded-1', 'win', '2026-09-25');
  assert.equal(get(sameDay).stage, STAGES.PAYOUT);
  assert.deepEqual(get(sameDay).qualifyingDates, ['2026-09-25']);
  const undoneMain = act(nextCycle, { type: 'undo' });
  assert.deepEqual(undoneMain.accounts, paid.accounts);
  const undonePayout = act(undoneMain, { type: 'undo' });
  assert.deepEqual(undonePayout.accounts, ready.accounts);
  assert.equal(qualifyingStartDate(get(undonePayout)), '2026-09-20');
  assert.deepEqual(parseBackup(exportBackup(sameDay)), sameDay);
});

test('qualifying date bounds retain future-date rejection and distinct qualifying-day limits', () => {
  const main = record(fundedState(), 'funded-1', 'win');
  for (const result of ['win', 'loss']) {
    assert.throws(() => record(main, 'funded-1', result, '2026-09-30'), { message: 'Future trade dates are not allowed.' });
    assert.throws(() => record(main, 'funded-1', result, '2026-09-28'), /before the main profit win/);
  }
  const sameDay = record(main, 'funded-1', 'win');
  assert.throws(() => record(sameDay, 'funded-1', 'win'), /already has a qualifying win/);
  assert.deepEqual(get(record(sameDay, 'funded-1', 'loss')).qualifyingDates, ['2026-09-29']);
});

function versionFourBackup(state) {
  const legacy = JSON.parse(exportBackup(state));
  legacy.version = 4;
  for (const snapshot of [legacy, ...legacy.undoStack]) {
    for (const account of snapshot.accounts) delete account.mainWinDate;
  }
  return JSON.stringify(legacy);
}

test('version-four migration rebuilds main-win anchors for current state and preceding snapshot histories', () => {
  let state = record(fundedState(), 'funded-1', 'win', '2026-09-25');
  state = record(state, 'funded-1', 'win', '2026-09-26');
  const migrated = parseBackup(versionFourBackup(state));
  assert.deepEqual(migrated, state);
  assert.equal(migrated.version, 5);
  assert.equal(qualifyingStartDate(get(migrated)), '2026-09-25');
  assert.equal(migrated.undoStack.at(-2).accounts.find(account => account.id === 'funded-1').mainWinDate, null);
  assert.equal(migrated.undoStack.at(-1).accounts.find(account => account.id === 'funded-1').mainWinDate, '2026-09-25');
  const undoneQualifying = act(migrated, { type: 'undo' });
  assert.equal(qualifyingStartDate(get(undoneQualifying)), '2026-09-25');
  const undoneMain = act(undoneQualifying, { type: 'undo' });
  assert.equal(get(undoneMain).mainWinDate, null);
});

test('migration excludes reversed main wins and uses the replacement date within the same funded cycle', () => {
  let state = record(fundedState(), 'funded-1', 'win', '2026-09-25');
  state = act(state, { type: 'undo' });
  state = record(state, 'funded-1', 'win', '2026-09-27');
  state = record(state, 'funded-1', 'win', '2026-09-28');
  const migrated = parseBackup(versionFourBackup(state));
  assert.deepEqual(migrated, state);
  assert.equal(get(migrated).mainWinDate, '2026-09-27');
  assert.equal(migrated.undoStack.at(-2).accounts.find(account => account.id === 'funded-1').mainWinDate, null);
  assert.equal(migrated.undoStack.at(-1).accounts.find(account => account.id === 'funded-1').mainWinDate, '2026-09-27');
});

test('migration isolates anchors across funded cycles and reused funded IDs after undoing evaluation passes', () => {
  const paid = act(readyState(), { type: 'payout', accountId: 'funded-1' });
  const next = record(paid, 'funded-1', 'win', '2026-09-29');
  assert.equal(get(parseBackup(versionFourBackup(paid))).mainWinDate, null);
  assert.deepEqual(parseBackup(versionFourBackup(next)), next);
  let reused = record(fundedState(), 'funded-1', 'win', '2026-09-25');
  reused = act(act(reused, { type: 'undo' }), { type: 'undo' });
  reused = record(reused, 'eval-1', 'win');
  assert.equal(get(reused).mainWinDate, null);
  reused = record(reused, 'funded-1', 'win', '2026-09-27');
  const migrated = parseBackup(versionFourBackup(reused));
  assert.deepEqual(migrated, reused);
  assert.equal(get(migrated).mainWinDate, '2026-09-27');
});

test('migration preserves existing earlier qualifying days and payout milestones while enforcing the reconstructed date on new results', () => {
  const qualifying = record(record(fundedState(), 'funded-1', 'win', '2026-09-25'), 'funded-1', 'win', '2026-09-25');
  const legacy = JSON.parse(versionFourBackup(qualifying));
  legacy.events.find(event => event.type === 'trade' && event.accountId === 'funded-1' && event.stage === STAGES.MAIN).date = '2026-09-29';
  const migrated = parseBackup(JSON.stringify(legacy));
  assert.equal(get(migrated).mainWinDate, '2026-09-29');
  assert.deepEqual(get(migrated).qualifyingDates, ['2026-09-25']);
  assert.deepEqual(migrated.events, legacy.events);
  assert.throws(() => record(migrated, 'funded-1', 'loss', '2026-09-28'), /before the main profit win/);
  assert.equal(get(record(migrated, 'funded-1', 'loss')).balance, get(migrated).balance - 200);
  const readyLegacy = JSON.parse(versionFourBackup(readyState()));
  readyLegacy.events.find(event => event.type === 'trade' && event.accountId === 'funded-1' && event.stage === STAGES.MAIN).date = '2026-09-29';
  const readyMigrated = parseBackup(JSON.stringify(readyLegacy));
  assert.equal(get(readyMigrated).stage, STAGES.PAYOUT);
  assert.equal(get(readyMigrated).mainWinDate, '2026-09-29');
  assert.deepEqual(get(readyMigrated).qualifyingDates, ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']);
  assert.deepEqual(readyMigrated.events, readyLegacy.events);
});

test('incomplete-history migration infers the earliest known qualifying date without inventing the current date', () => {
  let state = record(fundedState(), 'funded-1', 'win', '2026-09-25');
  state = record(record(state, 'funded-1', 'win', '2026-09-27'), 'funded-1', 'win', '2026-09-26');
  const legacy = JSON.parse(versionFourBackup(state));
  legacy.undoStack = [];
  legacy.events = legacy.events.filter(event => !(event.type === 'trade' && event.accountId === 'funded-1' && event.stage === STAGES.MAIN));
  const migrated = parseBackup(JSON.stringify(legacy));
  assert.equal(get(migrated).mainWinDate, '2026-09-26');
  assert.deepEqual(get(migrated).qualifyingDates, ['2026-09-27', '2026-09-26']);
  assert.deepEqual(migrated.events, legacy.events);
  assert.throws(() => record(migrated, 'funded-1', 'loss', '2026-09-25'), /before the main profit win/);
  assert.deepEqual(parseBackup(exportBackup(migrated)), migrated);
});

test('legacy qualifying accounts with unknown dates remain loadable but new results cannot bypass the chronology rule', () => {
  const known = record(fundedState(), 'funded-1', 'win', '2026-09-25');
  const legacy = JSON.parse(versionFourBackup(known));
  legacy.undoStack = [];
  legacy.events = legacy.events.filter(event => !(event.type === 'trade' && event.accountId === 'funded-1' && event.stage === STAGES.MAIN));
  const migrated = parseBackup(JSON.stringify(legacy));
  assert.equal(get(migrated).mainWinDate, null);
  assert.equal(get(migrated).stage, STAGES.QUALIFYING);
  assert.equal(qualifyingStartDate(get(migrated)), null);
  assert.deepEqual(parseBackup(exportBackup(migrated)), migrated);
  assert.throws(() => open(migrated, ['eval-2', 'funded-1']), { message: 'The main profit win date is unavailable for this cycle.' });
  const pendingLegacy = JSON.parse(versionFourBackup(open(known, ['funded-1'], '2026-09-25')));
  pendingLegacy.undoStack = [];
  pendingLegacy.events = pendingLegacy.events.filter(event => !(event.type === 'trade' && event.accountId === 'funded-1' && event.stage === STAGES.MAIN));
  const pending = parseBackup(JSON.stringify(pendingLegacy));
  assert.equal(get(pending).mainWinDate, null);
  assert.ok(get(pending).openTrade);
  for (const result of ['win', 'loss']) {
    for (const type of ['trade', 'record_result', 'close_trade']) {
      const state = type === 'close_trade' ? pending : migrated;
      const before = exportBackup(state);
      assert.throws(() => act(state, { type, accountId: 'funded-1', result, date: '2026-09-29' }), {
        message: 'The main profit win date is unavailable for this cycle.',
      });
      assert.equal(exportBackup(state), before);
    }
  }
});

test('qualifying continuation opening validates every participant before mutating a mixed-account batch', () => {
  const state = record(fundedState(), 'funded-1', 'win', '2026-09-27');
  const before = exportBackup(state);
  assert.throws(() => open(state, ['eval-3', 'funded-1'], '2026-09-26'), /before the main profit win/);
  assert.equal(exportBackup(state), before);
  const valid = open(state, ['eval-3', 'funded-1'], '2026-09-27');
  assert.equal(get(valid, 'eval-3').stage, STAGES.EVALUATION);
  assert.equal(get(valid).openTrade.date, '2026-09-27');
});

test('legacy pre-anchor pending qualifying trades remain loadable and can close on an allowed date', () => {
  const main = record(fundedState(), 'funded-1', 'win', '2026-09-25');
  const legacy = JSON.parse(versionFourBackup(open(main, ['funded-1'], '2026-09-25')));
  legacy.events.find(event => event.type === 'trade' && event.accountId === 'funded-1' && event.stage === STAGES.MAIN).date = '2026-09-29';
  const migrated = parseBackup(JSON.stringify(legacy));
  assert.equal(get(migrated).mainWinDate, '2026-09-29');
  assert.equal(get(migrated).openTrade.date, '2026-09-25');
  assert.deepEqual(parseBackup(exportBackup(migrated)), migrated);
  assert.throws(() => close(migrated, 'funded-1', 'win', '2026-09-28'), /before the main profit win/);
  const closed = close(migrated, 'funded-1', 'win', '2026-09-29');
  assert.deepEqual(get(closed).qualifyingDates, ['2026-09-29']);
  assert.equal(get(closed).openTrade, null);
});

test('configurable main-win amounts still establish dates and migrate by stage rather than dollar amount', () => {
  let state = createState({ ...DEFAULT_SETTINGS, fundedMainWin: 5000 });
  state = record(record(state, 'eval-1', 'win'), 'eval-1', 'win');
  state = record(state, 'funded-1', 'win', '2026-09-26');
  assert.equal(get(state).balance, 55000);
  assert.equal(get(state).mainWinDate, '2026-09-26');
  assert.deepEqual(parseBackup(versionFourBackup(state)), state);
  assert.throws(() => record(state, 'funded-1', 'win', '2026-09-25'), /before the main profit win/);
});

test('new backups validate funded date presence, calendar format and phase consistency in accounts and snapshots', () => {
  for (const corrupt of [
    state => { delete get(state).mainWinDate; },
    state => { get(state).mainWinDate = '2026-02-30'; },
    state => { get(state).mainWinDate = 20260925; },
    state => { const account = state.undoStack.at(-1).accounts.find(item => item.id === 'funded-1'); account.mainWinDate = '2026-09-25'; },
  ]) {
    const state = structuredClone(record(fundedState(), 'funded-1', 'win', '2026-09-25'));
    corrupt(state);
    assert.throws(() => parseBackup(exportBackup(state)), /funded main win date/);
  }
  for (const state of [fundedState(), record(record(fundedState(), 'funded-1', 'loss'), 'funded-1', 'loss')]) {
    get(state).mainWinDate = '2026-09-25';
    assert.throws(() => parseBackup(exportBackup(state)), /funded main win date/);
  }
});
