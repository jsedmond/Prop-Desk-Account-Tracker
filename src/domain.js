export const VERSION = 6;
// Keep the existing storage key so saved workspaces are migrated in place.
export const STORAGE_KEY = 'prop-desk.v1';
export const DEFAULT_SETTINGS = Object.freeze({
  startingEvaluations: 5,
  evaluationCostCents: 9000,
  evaluationStart: 50000,
  evaluationTarget: 53000,
  evaluationFailure: 48000,
  evaluationWin: 1500,
  evaluationLoss: 1000,
  fundedMainWin: 4000,
  initialFundedRisk: 1000,
  postPayoutSecondRisk: 800,
  qualifyingWin: 200,
  qualifyingLoss: 200,
  qualifyingWins: 4,
  payoutAmount: 3000,
});

export const STAGES = Object.freeze({
  WAITING: 'waiting', EVALUATION: 'evaluation', PASSED: 'passed',
  EVAL_FAILED: 'evaluation_failed', MAIN: 'main', QUALIFYING: 'qualifying',
  PAYOUT: 'payout_ready', FUNDED_FAILED: 'funded_failed',
});

export const MAX_ACCOUNT_NAME_LENGTH = 48;

export function defaultAccountName(account) {
  return `${account.type === 'funded' ? 'Funded' : 'Evaluation'} ${String(account.number).padStart(2, '0')}`;
}

export function accountName(account) {
  return account.customName || defaultAccountName(account);
}

function validateAccountName(value) {
  if (typeof value !== 'string' || value.length > MAX_ACCOUNT_NAME_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`Account name must be a single line of at most ${MAX_ACCOUNT_NAME_LENGTH} characters.`);
  }
  return value.trim();
}

export function isArchived(account) {
  return (account?.type === 'evaluation' && [STAGES.EVAL_FAILED, STAGES.PASSED].includes(account.stage))
    || (account?.type === 'funded' && account.stage === STAGES.FUNDED_FAILED);
}

export function evaluationFailureLevel(account) {
  if (account?.type !== 'evaluation') return null;
  const distance = account.rules.evaluationStart - account.rules.evaluationFailure;
  return Math.max(account.rules.evaluationFailure, Math.min(account.startingBalance, account.evaluationHighWater - distance));
}

export function qualifyingStartDate(account) {
  return account?.type === 'funded' && [STAGES.QUALIFYING, STAGES.PAYOUT].includes(account.stage)
    ? account.mainWinDate : null;
}

function validateQualifyingDate(account, date) {
  if (account.stage !== STAGES.QUALIFYING) return;
  const startDate = qualifyingStartDate(account);
  if (!startDate) throw new Error('The main profit win date is unavailable for this cycle.');
  if (date < startDate) throw new Error('Qualifying trades cannot be dated before the main profit win.');
}

export function validateSettings(settings) {
  if (!settings || typeof settings !== 'object') throw new Error('Missing account rules.');
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (key === 'evaluationCostCents') {
      if (!Number.isSafeInteger(settings[key]) || settings[key] < 0 || settings[key] > 100000000) {
        throw new Error('Evaluation cost must be a nonnegative dollar amount with at most two decimal places.');
      }
    } else if (!Number.isSafeInteger(settings[key]) || settings[key] <= 0 || settings[key] > 100000000) {
      throw new Error('Every rule must be a positive whole number.');
    }
  }
  if (settings.startingEvaluations > 100) throw new Error('Use between 1 and 100 evaluation accounts.');
  if (settings.qualifyingWins > 30) throw new Error('Use between 1 and 30 qualifying days.');
  if (settings.evaluationTarget <= settings.evaluationStart) throw new Error('Evaluation target must exceed the starting balance.');
  if (settings.evaluationFailure >= settings.evaluationStart) throw new Error('Evaluation failure balance must be below the starting balance.');
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, settings[key]]));
}

export function createState(settings = DEFAULT_SETTINGS) {
  const rules = validateSettings(settings);
  return {
    version: VERSION, settings: rules,
    accounts: Array.from({ length: rules.startingEvaluations }, (_, index) => ({
      id: `eval-${index + 1}`, number: index + 1, type: 'evaluation', customName: '',
      stage: index === 0 ? STAGES.EVALUATION : STAGES.WAITING,
      evaluationRole: index === 0 ? 'primary' : null, openTrade: null,
      balance: rules.evaluationStart, startingBalance: rules.evaluationStart, cycle: 0, mainAttempts: 0,
      evaluationHighWater: rules.evaluationStart,
      qualifyingDates: [], purchaseCostCents: rules.evaluationCostCents, rules: { ...rules },
    })),
    selectedId: 'eval-1', events: [], undoStack: [],
  };
}

export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function tradeTerms(account) {
  if (!account) return null;
  const r = account.rules;
  if (account.stage === STAGES.EVALUATION) return { win: r.evaluationWin, loss: r.evaluationLoss };
  if (account.stage === STAGES.MAIN) return {
    win: r.fundedMainWin,
    loss: account.cycle > 1 && account.mainAttempts === 1 ? r.postPayoutSecondRisk : r.initialFundedRisk,
  };
  if (account.stage === STAGES.QUALIFYING) return { win: r.qualifyingWin, loss: r.qualifyingLoss };
  return null;
}

export function canOpenContinuation(account) {
  return Boolean(account && !account.openTrade && (account.stage === STAGES.WAITING || tradeTerms(account)));
}

export function resultTerms(account) {
  if (account?.openTrade) return { win: account.openTrade.win, loss: account.openTrade.loss };
  if (account?.type === 'evaluation' && account.stage === STAGES.WAITING) {
    return { win: account.rules.evaluationWin, loss: account.rules.evaluationLoss };
  }
  return tradeTerms(account);
}

export function untradedEvaluations(state) {
  const reversed = reversedActions(state);
  const tradedAccounts = new Set(state.events
    .filter(event => event.type === 'trade' && !reversed.has(event.actionId))
    .map(event => event.accountId));
  return state.accounts.filter(account => account.type === 'evaluation'
    && [STAGES.WAITING, STAGES.EVALUATION].includes(account.stage)
    && !account.openTrade && !tradedAccounts.has(account.id)
    && account.balance === account.startingBalance && account.evaluationHighWater === account.startingBalance);
}

function advanceEvaluation(accounts) {
  const primary = accounts.find(account => account.stage === STAGES.EVALUATION && account.evaluationRole === 'primary');
  if (primary) return primary;
  const next = accounts.find(account => account.stage === STAGES.EVALUATION)
    || accounts.find(account => account.stage === STAGES.WAITING);
  if (next) {
    next.stage = STAGES.EVALUATION;
    next.evaluationRole = 'primary';
  }
  return next;
}

export function applyAction(state, action, context = {}) {
  if (action.type === 'undo') return undoAction(state, context);
  const timestamp = context.timestamp || new Date().toISOString();
  const actionId = context.actionId || globalThis.crypto.randomUUID();
  const today = localDate(new Date(timestamp));
  const date = action.date || today;
  if (['trade', 'record_result', 'close_trade', 'open_continuation'].includes(action.type)) {
    if (!validDate(date)) throw new Error('Choose a valid trade date.');
    if (date > today) throw new Error('Future trade dates are not allowed.');
  }
  const next = { ...state, accounts: structuredClone(state.accounts), events: [...state.events], undoStack: [...state.undoStack] };
  const account = next.accounts.find(item => item.id === action.accountId);
  const emit = (type, details = {}, subject = account) => next.events.push({
    id: `${actionId}:${next.events.length}`, actionId, timestamp, date,
    type, accountId: subject?.id ?? null, accountNumber: subject?.number ?? null,
    accountType: subject?.type ?? null, cycle: subject?.cycle ?? null,
    stage: subject?.stage ?? null, result: null, pnl: 0,
    balanceBefore: subject?.balance ?? null, balanceAfter: subject?.balance ?? null,
    ...details,
  });
  if (action.type === 'open_continuation') {
    if (!Array.isArray(action.accountIds) || !action.accountIds.length || new Set(action.accountIds).size !== action.accountIds.length) {
      throw new Error('Choose one or more different accounts.');
    }
    const participants = action.accountIds.map(id => {
      const participant = next.accounts.find(item => item.id === id);
      if (!participant) throw new Error('Account not found.');
      if (!canOpenContinuation(participant)) throw new Error('This account cannot open a continuation trade.');
      validateQualifyingDate(participant, date);
      return participant;
    });
    for (const participant of participants) {
      if (participant.stage === STAGES.WAITING) {
        participant.stage = STAGES.EVALUATION;
        participant.evaluationRole = 'continuation';
      }
      participant.openTrade = {
        id: `${actionId}:${participant.id}`, pattern: 'continuation', openedAt: timestamp,
        date, stage: participant.stage, cycle: participant.cycle,
        balanceBefore: participant.balance, ...tradeTerms(participant),
      };
      emit('trade_opened', {
        openTradeId: participant.openTrade.id, pattern: 'continuation', openedAt: timestamp,
        openedDate: date, win: participant.openTrade.win, loss: participant.openTrade.loss,
      }, participant);
    }
  } else if (action.type === 'trade' || action.type === 'close_trade' || action.type === 'record_result') {
    if (!account) throw new Error('Account not found.');
    if (action.result !== 'win' && action.result !== 'loss') throw new Error('Choose Win or Loss.');
    const opened = account.openTrade;
    if (action.type === 'close_trade' && !opened) throw new Error('This account has no open trade.');
    if (action.type === 'trade' && opened) throw new Error('Close this account\'s open trade before recording another result.');
    if (action.type === 'trade' && account.evaluationRole === 'continuation') throw new Error('Open a continuation trade for this evaluation.');
    const terms = action.type === 'record_result' ? resultTerms(account) : opened || tradeTerms(account);
    if (!terms) throw new Error('This account is not accepting trades.');
    validateQualifyingDate(account, date);
    if (account.stage === STAGES.QUALIFYING && action.result === 'win' && account.qualifyingDates.includes(date)) {
      throw new Error('This date already has a qualifying win. Choose another trading day.');
    }
    if (account.stage === STAGES.WAITING) {
      account.stage = STAGES.EVALUATION;
      account.evaluationRole = 'continuation';
    }
    const stageBefore = account.stage;
    const balanceBefore = account.balance;
    const pnl = action.result === 'win' ? terms.win : -terms.loss;
    account.balance += pnl;
    if (stageBefore === STAGES.EVALUATION) account.evaluationHighWater = Math.max(account.evaluationHighWater, account.balance);
    account.openTrade = null;
    emit('trade', {
      stage: stageBefore, result: action.result, pnl, balanceBefore, balanceAfter: account.balance,
      ...(opened ? { openTradeId: opened.id, pattern: opened.pattern, openedAt: opened.openedAt, openedDate: opened.date } : {}),
    });

    // Each trade is a transition from one explicit lifecycle stage.
    switch (stageBefore) {
      case STAGES.EVALUATION:
        if (account.balance >= account.rules.evaluationTarget) {
          account.stage = STAGES.PASSED;
          account.evaluationRole = null;
          emit('evaluation_pass');
          const funded = {
            id: `funded-${account.number}`, number: account.number, type: 'funded', customName: '',
            stage: STAGES.MAIN, balance: account.startingBalance, startingBalance: account.startingBalance, cycle: 1,
            mainAttempts: 0, mainWinDate: null, qualifyingDates: [], openTrade: null, rules: { ...state.settings },
          };
          next.accounts.push(funded);
          emit('funded_created', {}, funded);
          const waiting = advanceEvaluation(next.accounts);
          next.selectedId = waiting?.id || funded.id;
        } else if (account.balance <= evaluationFailureLevel(account)) {
          account.stage = STAGES.EVAL_FAILED;
          account.evaluationRole = null;
          emit('evaluation_failure');
          const waiting = advanceEvaluation(next.accounts);
          next.selectedId = waiting?.id || next.accounts.find(item => tradeTerms(item) || item.stage === STAGES.PAYOUT)?.id || account.id;
        }
        break;
      case STAGES.MAIN:
        account.mainAttempts += 1;
        if (action.result === 'win') {
          account.stage = STAGES.QUALIFYING;
          account.mainWinDate = date;
        }
        else if (account.mainAttempts === 2) {
          account.stage = STAGES.FUNDED_FAILED;
          emit('funded_failure');
        }
        break;
      case STAGES.QUALIFYING:
        if (action.result === 'win') {
          account.qualifyingDates.push(date);
          emit('qualifying_day', { result: 'win', balanceBefore, balanceAfter: account.balance });
          if (account.qualifyingDates.length >= account.rules.qualifyingWins) {
            account.stage = STAGES.PAYOUT;
            emit('payout_ready');
          }
        }
        break;
      default: throw new Error('Unknown trading stage.');
    }
  } else if (action.type === 'payout') {
    if (!account || account.stage !== STAGES.PAYOUT) throw new Error('Complete qualifying days before taking a payout.');
    const amount = account.rules.payoutAmount;
    const balanceBefore = account.balance;
    account.balance -= amount;
    emit('payout', { pnl: -amount, balanceBefore, balanceAfter: account.balance });
    account.cycle += 1;
    account.stage = STAGES.MAIN;
    account.mainAttempts = 0;
    account.mainWinDate = null;
    account.qualifyingDates = [];
    account.rules = { ...state.settings };
  } else if (action.type === 'add_evaluation') {
    const number = next.accounts.reduce((highest, item) => Math.max(highest, item.number), 0) + 1;
    if (!Number.isSafeInteger(number)) throw new Error('Account numbering limit reached.');
    const hasActiveEvaluation = next.accounts.some(item => item.stage === STAGES.EVALUATION);
    const added = {
      id: `eval-${number}`, number, type: 'evaluation', customName: '',
      stage: hasActiveEvaluation ? STAGES.WAITING : STAGES.EVALUATION,
      evaluationRole: hasActiveEvaluation ? null : 'primary', openTrade: null,
      balance: state.settings.evaluationStart, startingBalance: state.settings.evaluationStart,
      evaluationHighWater: state.settings.evaluationStart,
      cycle: 0, mainAttempts: 0, qualifyingDates: [],
      purchaseCostCents: state.settings.evaluationCostCents, rules: { ...state.settings },
    };
    next.accounts.push(added);
    if (!hasActiveEvaluation) next.selectedId = added.id;
    emit('evaluation_added', { costCents: added.purchaseCostCents }, added);
  } else if (action.type === 'rename_account') {
    if (!account) throw new Error('Account not found.');
    const customName = validateAccountName(action.name);
    if (customName === account.customName) throw new Error('This account already has that name.');
    const previousName = accountName(account);
    account.customName = customName;
    emit('account_renamed', { previousName, newName: accountName(account) });
  } else if (action.type === 'settings') {
    next.settings = validateSettings(action.settings);
    for (const evaluation of untradedEvaluations(next)) {
      evaluation.rules = { ...next.settings };
      evaluation.balance = next.settings.evaluationStart;
      evaluation.startingBalance = next.settings.evaluationStart;
      evaluation.evaluationHighWater = next.settings.evaluationStart;
    }
    emit('settings', {}, null);
  } else {
    throw new Error('Unknown action.');
  }
  next.undoStack.push({
    actionId, accounts: state.accounts, settings: state.settings,
    selectedId: state.selectedId,
  });
  return next;
}

export function undoAction(state, context = {}) {
  const snapshot = state.undoStack.at(-1);
  if (!snapshot) throw new Error('There is no action to undo.');
  const actionId = context.actionId || globalThis.crypto.randomUUID();
  return {
    ...state, accounts: structuredClone(snapshot.accounts), settings: { ...snapshot.settings },
    selectedId: snapshot.selectedId, undoStack: state.undoStack.slice(0, -1),
    // Reversals are appended, preserving the original events for the audit trail.
    events: [...state.events, {
      id: `${actionId}:${state.events.length}`, actionId,
      timestamp: context.timestamp || new Date().toISOString(), date: localDate(),
      type: 'undo', revertedActionId: snapshot.actionId, accountId: null,
      accountNumber: null, accountType: null, cycle: null, stage: null,
      result: null, pnl: 0, balanceBefore: null, balanceAfter: null,
    }],
  };
}

export function reversedActions(state) {
  return new Set(state.events.filter(event => event.type === 'undo').map(event => event.revertedActionId));
}

export function summarize(state) {
  const reversed = reversedActions(state);
  const events = state.events.filter(event => !reversed.has(event.actionId));
  const trades = events.filter(event => event.type === 'trade');
  const rate = type => {
    const group = trades.filter(event => event.accountType === type);
    return group.length ? group.filter(event => event.result === 'win').length / group.length * 100 : null;
  };
  const payouts = events.filter(event => event.type === 'payout');
  const evaluations = state.accounts.filter(account => account.type === 'evaluation');
  return {
    remaining: state.accounts.filter(account => [STAGES.WAITING, STAGES.EVALUATION].includes(account.stage)).length,
    passed: state.accounts.filter(account => account.stage === STAGES.PASSED).length,
    evalFailed: state.accounts.filter(account => account.stage === STAGES.EVAL_FAILED).length,
    funded: state.accounts.filter(account => account.type === 'funded' && account.stage !== STAGES.FUNDED_FAILED).length,
    fundedFailed: state.accounts.filter(account => account.stage === STAGES.FUNDED_FAILED).length,
    trades: trades.length, evalRate: rate('evaluation'), fundedRate: rate('funded'),
    openTrades: state.accounts.filter(account => account.openTrade).length,
    payouts: payouts.length, withdrawn: payouts.reduce((total, event) => total - event.pnl, 0),
    evaluationCount: evaluations.length,
    costCents: evaluations.reduce((total, account) => total + account.purchaseCostCents, 0),
  };
}

function validateAccounts(accounts, settings, selectedId) {
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('Invalid backup accounts.');
  const ids = new Set();
  const openIds = new Set();
  let active = 0;
  let primary = 0;
  let waiting = 0;
  const stagesByType = {
    evaluation: [STAGES.WAITING, STAGES.EVALUATION, STAGES.PASSED, STAGES.EVAL_FAILED],
    funded: [STAGES.MAIN, STAGES.QUALIFYING, STAGES.PAYOUT, STAGES.FUNDED_FAILED],
  };
  for (const account of accounts) {
    if (!account || !stagesByType[account.type]?.includes(account.stage) || !Number.isSafeInteger(account.number) || account.number < 1 || account.id !== `${account.type === 'evaluation' ? 'eval' : 'funded'}-${account.number}` || ids.has(account.id)) {
      throw new Error('Invalid account identity or stage.');
    }
    ids.add(account.id);
    if (validateAccountName(account.customName) !== account.customName) throw new Error('Invalid account name.');
    validateSettings(account.rules);
    if (account.type === 'evaluation' && (!Number.isSafeInteger(account.purchaseCostCents) || account.purchaseCostCents < 0 || account.purchaseCostCents > 100000000)) throw new Error('Invalid evaluation purchase cost.');
    if (!Number.isSafeInteger(account.balance) || !Number.isSafeInteger(account.startingBalance) || account.startingBalance <= 0 || !Number.isSafeInteger(account.cycle) || account.cycle < (account.type === 'funded' ? 1 : 0) || (account.type === 'evaluation' && account.cycle !== 0) || !Number.isSafeInteger(account.mainAttempts) || account.mainAttempts < 0 || account.mainAttempts > 2) throw new Error('Invalid account balance or cycle.');
    if (!Array.isArray(account.qualifyingDates) || account.qualifyingDates.some(date => !validDate(date)) || new Set(account.qualifyingDates).size !== account.qualifyingDates.length || account.qualifyingDates.length > account.rules.qualifyingWins) throw new Error('Invalid qualifying-day progress.');
    if (account.stage === STAGES.MAIN && (account.mainAttempts > 1 || account.qualifyingDates.length)) throw new Error('Invalid main profit phase.');
    if ([STAGES.QUALIFYING, STAGES.PAYOUT].includes(account.stage) && account.mainAttempts < 1) throw new Error('Invalid funded trade progress.');
    if (account.stage === STAGES.QUALIFYING && account.qualifyingDates.length >= account.rules.qualifyingWins) throw new Error('Invalid qualifying phase.');
    if (account.stage === STAGES.PAYOUT && account.qualifyingDates.length !== account.rules.qualifyingWins) throw new Error('Invalid payout-ready account.');
    if (account.stage === STAGES.FUNDED_FAILED && account.mainAttempts !== 2) throw new Error('Invalid failed funded account.');
    if (account.type === 'funded' && (account.mainWinDate === undefined
      || (account.mainWinDate !== null && !validDate(account.mainWinDate))
      || ([STAGES.MAIN, STAGES.FUNDED_FAILED].includes(account.stage) && account.mainWinDate !== null))) {
      throw new Error('Invalid funded main win date.');
    }
    if (account.type === 'evaluation' && (account.mainAttempts !== 0 || account.qualifyingDates.length)) throw new Error('Invalid evaluation progress.');
    if (account.type === 'evaluation') {
      const failureLevel = evaluationFailureLevel(account);
      if (!Number.isSafeInteger(account.evaluationHighWater) || account.evaluationHighWater < account.startingBalance
        || account.evaluationHighWater < account.balance || !Number.isSafeInteger(failureLevel)
        || failureLevel < account.rules.evaluationFailure || failureLevel > account.startingBalance
        || (account.stage === STAGES.WAITING && account.evaluationHighWater !== account.startingBalance)) {
        throw new Error('Invalid evaluation high-water balance.');
      }
      if (account.stage === STAGES.EVALUATION) {
        if (!['primary', 'continuation'].includes(account.evaluationRole)) throw new Error('Invalid evaluation role.');
        active += 1;
        if (account.evaluationRole === 'primary') primary += 1;
      } else if (account.evaluationRole !== null) throw new Error('Invalid evaluation role.');
    }
    if (account.openTrade !== null) {
      const opened = account.openTrade;
      const terms = tradeTerms(account);
      if (!opened || typeof opened !== 'object' || typeof opened.id !== 'string' || !opened.id || openIds.has(opened.id)
        || opened.pattern !== 'continuation' || typeof opened.openedAt !== 'string' || !Number.isFinite(Date.parse(opened.openedAt))
        || !validDate(opened.date) || !terms || opened.stage !== account.stage || opened.cycle !== account.cycle
        || opened.balanceBefore !== account.balance || opened.win !== terms.win || opened.loss !== terms.loss) {
        throw new Error('Invalid open trade.');
      }
      openIds.add(opened.id);
    }
    if (account.stage === STAGES.WAITING) waiting += 1;
  }
  if ((active ? primary !== 1 : primary !== 0 || waiting > 0) || !ids.has(selectedId)) throw new Error('Invalid active account queue.');
  for (const account of accounts.filter(item => item.type === 'funded')) {
    if (!accounts.some(item => item.id === `eval-${account.number}` && item.stage === STAGES.PASSED)) throw new Error('Funded account is missing its passed evaluation.');
  }
  for (const account of accounts.filter(item => item.stage === STAGES.PASSED)) {
    if (!ids.has(`funded-${account.number}`)) throw new Error('Passed evaluation is missing its funded account.');
  }
}

function migrateVersionOne(state) {
  // Version 1 purchases predate configurable costs and were priced at $90.20.
  const migrateSettings = settings => settings && ({ ...settings, evaluationCostCents: 9020 });
  const migrateAccounts = accounts => Array.isArray(accounts) ? accounts.map(account => account && ({
    ...account, rules: migrateSettings(account.rules),
    ...(account.type === 'evaluation' ? { purchaseCostCents: 9020 } : {}),
  })) : accounts;
  return {
    ...state, version: 2, settings: migrateSettings(state.settings),
    accounts: migrateAccounts(state.accounts),
    undoStack: Array.isArray(state.undoStack) ? state.undoStack.map(snapshot => snapshot && ({
      ...snapshot, settings: migrateSettings(snapshot.settings), accounts: migrateAccounts(snapshot.accounts),
    })) : state.undoStack,
  };
}

function migrateVersionTwo(state) {
  const migrateAccounts = accounts => Array.isArray(accounts) ? accounts.map(account => account && ({
    ...account, openTrade: null,
    ...(account.type === 'evaluation' ? { evaluationRole: account.stage === STAGES.EVALUATION ? 'primary' : null } : {}),
  })) : accounts;
  return {
    ...state, version: 3, accounts: migrateAccounts(state.accounts),
    undoStack: Array.isArray(state.undoStack) ? state.undoStack.map(snapshot => snapshot && ({
      ...snapshot, accounts: migrateAccounts(snapshot.accounts),
    })) : state.undoStack,
  };
}

function migrateVersionThree(state) {
  const history = Array.isArray(state.events) ? state.events : [];
  const migrateAccounts = (accounts, events) => {
    const reversed = new Set(events.filter(event => event?.type === 'undo').map(event => event.revertedActionId));
    const peaks = new Map();
    for (const event of events) {
      if (event?.type === 'trade' && event.accountType === 'evaluation' && !reversed.has(event.actionId)) {
        peaks.set(event.accountId, Math.max(peaks.get(event.accountId) ?? 0, event.balanceBefore, event.balanceAfter));
      }
    }
    return Array.isArray(accounts) ? accounts.map(account => account && ({
      ...account,
      ...(account.type === 'evaluation' ? {
        evaluationHighWater: account.stage === STAGES.WAITING ? account.startingBalance
          : Math.max(account.startingBalance, account.balance, peaks.get(account.id) ?? 0),
      } : {}),
    })) : accounts;
  };
  return {
    ...state, version: 4, accounts: migrateAccounts(state.accounts, history),
    undoStack: Array.isArray(state.undoStack) ? state.undoStack.map(snapshot => {
      if (!snapshot) return snapshot;
      // A snapshot predates its action, so later reversals cannot alter its peak.
      const actionIndex = history.findIndex(event => event?.actionId === snapshot.actionId);
      return { ...snapshot, accounts: migrateAccounts(snapshot.accounts, history.slice(0, Math.max(0, actionIndex))) };
    }) : state.undoStack,
  };
}

function migrateVersionFour(state) {
  const history = Array.isArray(state.events) ? state.events : [];
  const migrateAccounts = (accounts, events) => {
    const reversed = new Set(events.filter(event => event?.type === 'undo').map(event => event.revertedActionId));
    const wins = new Map();
    const qualifyingDates = new Map();
    for (const event of events) {
      if (event?.type !== 'trade' || event.accountType !== 'funded' || reversed.has(event.actionId)) continue;
      const key = `${event.accountId}:${event.cycle}`;
      if (event.stage === STAGES.MAIN && event.result === 'win') wins.set(key, event.date);
      if (event.stage === STAGES.QUALIFYING && validDate(event.date)) {
        const earliest = qualifyingDates.get(key);
        qualifyingDates.set(key, !earliest || event.date < earliest ? event.date : earliest);
      }
    }
    return Array.isArray(accounts) ? accounts.map(account => {
      if (!account || account.type !== 'funded') return account;
      const key = `${account.id}:${account.cycle}`;
      const dates = Array.isArray(account.qualifyingDates) ? account.qualifyingDates.filter(validDate) : [];
      if (qualifyingDates.has(key)) dates.push(qualifyingDates.get(key));
      return {
        ...account,
        mainWinDate: [STAGES.QUALIFYING, STAGES.PAYOUT].includes(account.stage)
          ? wins.get(key) ?? dates.sort()[0] ?? null : null,
      };
    }) : accounts;
  };
  return {
    ...state, version: 5, accounts: migrateAccounts(state.accounts, history),
    undoStack: Array.isArray(state.undoStack) ? state.undoStack.map(snapshot => {
      if (!snapshot) return snapshot;
      const actionIndex = history.findIndex(event => event?.actionId === snapshot.actionId);
      return { ...snapshot, accounts: migrateAccounts(snapshot.accounts, history.slice(0, Math.max(0, actionIndex))) };
    }) : state.undoStack,
  };
}

function migrateVersionFive(state) {
  const migrateAccounts = accounts => Array.isArray(accounts) ? accounts.map(account => account && ({ ...account, customName: '' })) : accounts;
  const migrateSettings = settings => settings && ({
    ...settings,
    startingEvaluations: settings.startingEvaluations === 10 ? DEFAULT_SETTINGS.startingEvaluations : settings.startingEvaluations,
    evaluationCostCents: settings.evaluationCostCents === 9020 ? DEFAULT_SETTINGS.evaluationCostCents : settings.evaluationCostCents,
  });
  return {
    ...state, version: VERSION, settings: migrateSettings(state.settings), accounts: migrateAccounts(state.accounts),
    undoStack: Array.isArray(state.undoStack) ? state.undoStack.map(snapshot => snapshot && ({
      ...snapshot, settings: migrateSettings(snapshot.settings), accounts: migrateAccounts(snapshot.accounts),
    })) : state.undoStack,
  };
}

export function parseBackup(text) {
  if (typeof text !== 'string' || text.length > 10000000) throw new Error('Backup must be smaller than 10 MB.');
  let state;
  try { state = JSON.parse(text); } catch { throw new Error('This file is not valid JSON.'); }
  if (state?.version === 1) state = migrateVersionOne(state);
  if (state?.version === 2) state = migrateVersionTwo(state);
  if (state?.version === 3) state = migrateVersionThree(state);
  if (state?.version === 4) state = migrateVersionFour(state);
  if (state?.version === 5) state = migrateVersionFive(state);
  if (!state || state.version !== VERSION) throw new Error('Unsupported backup version. Expected version 1, 2, 3, 4, 5, or 6.');
  const settings = validateSettings(state.settings);
  validateAccounts(state.accounts, settings, state.selectedId);
  if (!Array.isArray(state.events) || !Array.isArray(state.undoStack)) throw new Error('Invalid backup history.');
  const types = ['trade', 'trade_opened', 'evaluation_pass', 'evaluation_failure', 'evaluation_added', 'funded_created', 'funded_failure', 'qualifying_day', 'payout_ready', 'payout', 'account_renamed', 'settings', 'undo'];
  const ids = new Set();
  const actionIds = new Set();
  const reverted = new Set();
  const allReversed = reversedActions(state);
  const openedTrades = new Map();
  const closedTrades = new Set();
  for (const event of state.events) {
    if (!event || typeof event.id !== 'string' || ids.has(event.id) || typeof event.actionId !== 'string' || !types.includes(event.type) || typeof event.timestamp !== 'string' || !Number.isFinite(Date.parse(event.timestamp)) || !validDate(event.date) || !Number.isSafeInteger(event.pnl)) throw new Error('Invalid backup event.');
    ids.add(event.id);
    if (event.type === 'undo') {
      if (!actionIds.has(event.revertedActionId) || reverted.has(event.revertedActionId)) throw new Error('Invalid undo event.');
      reverted.add(event.revertedActionId);
    } else if (event.type !== 'settings') {
      const knownAccount = state.accounts.some(account => account.id === event.accountId);
      if (!knownAccount && !state.undoStack.some(snapshot => snapshot.accounts?.some(account => account.id === event.accountId)) && !allReversed.has(event.actionId)) throw new Error('Event references an unknown account.');
      if (!['evaluation', 'funded'].includes(event.accountType) || !Number.isSafeInteger(event.accountNumber) || !Number.isSafeInteger(event.cycle) || !Number.isSafeInteger(event.balanceBefore) || !Number.isSafeInteger(event.balanceAfter)) throw new Error('Invalid event account details.');
      if (event.type === 'trade' && (!['win', 'loss'].includes(event.result) || event.balanceBefore + event.pnl !== event.balanceAfter)) throw new Error('Invalid trade balance.');
      if (event.type === 'trade_opened') {
        if ((!knownAccount && !allReversed.has(event.actionId)) || typeof event.openTradeId !== 'string' || !event.openTradeId || openedTrades.has(event.openTradeId)
          || event.pattern !== 'continuation' || event.openedAt !== event.timestamp || event.openedDate !== event.date
          || ![STAGES.EVALUATION, STAGES.MAIN, STAGES.QUALIFYING].includes(event.stage)
          || !Number.isSafeInteger(event.win) || event.win <= 0 || !Number.isSafeInteger(event.loss) || event.loss <= 0
          || event.result !== null || event.pnl !== 0 || event.balanceBefore !== event.balanceAfter) throw new Error('Invalid trade opening event.');
        openedTrades.set(event.openTradeId, event);
      }
      if (event.type === 'trade' && event.openTradeId !== undefined) {
        const opened = openedTrades.get(event.openTradeId);
        if (!opened || event.pattern !== opened.pattern || event.openedAt !== opened.openedAt || event.openedDate !== opened.date
          || event.accountId !== opened.accountId || event.stage !== opened.stage || event.cycle !== opened.cycle
          || event.balanceBefore !== opened.balanceBefore || event.pnl !== (event.result === 'win' ? opened.win : -opened.loss)) throw new Error('Invalid trade closing event.');
        if (!allReversed.has(event.actionId)) {
          if (allReversed.has(opened.actionId) || closedTrades.has(event.openTradeId)) throw new Error('Invalid resolved trade.');
          closedTrades.add(event.openTradeId);
        }
      }
      if (event.type === 'payout' && (event.pnl >= 0 || event.balanceBefore + event.pnl !== event.balanceAfter)) throw new Error('Invalid payout balance.');
      if (event.type === 'evaluation_added' && (event.accountType !== 'evaluation' || !Number.isSafeInteger(event.costCents) || event.costCents < 0 || event.costCents > 100000000 || event.pnl !== 0 || event.balanceBefore !== event.balanceAfter)) throw new Error('Invalid evaluation purchase event.');
      if (event.type === 'account_renamed' && (!event.previousName || !event.newName
        || validateAccountName(event.previousName) !== event.previousName || validateAccountName(event.newName) !== event.newName
        || event.pnl !== 0 || event.balanceBefore !== event.balanceAfter)) throw new Error('Invalid account rename event.');
    }
    actionIds.add(event.actionId);
  }
  const validateOpenHistory = (accounts, current = false) => {
    for (const account of accounts.filter(item => item.openTrade)) {
      const pending = account.openTrade;
      const opened = openedTrades.get(pending.id);
      if (!opened || allReversed.has(opened.actionId) || (current && closedTrades.has(pending.id))
        || opened.accountId !== account.id || opened.stage !== pending.stage || opened.cycle !== pending.cycle
        || opened.balanceBefore !== pending.balanceBefore || opened.win !== pending.win || opened.loss !== pending.loss
        || opened.pattern !== pending.pattern || opened.openedAt !== pending.openedAt || opened.date !== pending.date) throw new Error('Open trade is missing its history.');
    }
  };
  validateOpenHistory(state.accounts, true);
  for (const opened of openedTrades.values()) {
    if (!allReversed.has(opened.actionId) && !closedTrades.has(opened.openTradeId)
      && !state.accounts.some(account => account.openTrade?.id === opened.openTradeId)) throw new Error('Unresolved opening is missing its open trade.');
  }
  const snapshotIds = new Set();
  for (const snapshot of state.undoStack) {
    if (!snapshot || !actionIds.has(snapshot.actionId) || reverted.has(snapshot.actionId) || snapshotIds.has(snapshot.actionId)) throw new Error('Invalid undo snapshot.');
    snapshotIds.add(snapshot.actionId);
    validateSettings(snapshot.settings);
    validateAccounts(snapshot.accounts, snapshot.settings, snapshot.selectedId);
    validateOpenHistory(snapshot.accounts);
  }
  return { version: VERSION, settings, accounts: state.accounts, selectedId: state.selectedId, events: state.events, undoStack: state.undoStack };
}

export function exportBackup(state) {
  return JSON.stringify(state, null, 2);
}
