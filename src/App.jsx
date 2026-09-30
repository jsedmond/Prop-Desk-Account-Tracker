import React, { useEffect, useRef, useState } from 'react';
import {
  BarChart3, LayoutDashboard, Layers3, History, SlidersHorizontal,
  Download, Upload, Undo2, Check, X, Wallet, TrendingUp, ChevronRight,
  CircleCheck, CircleDollarSign, ShieldCheck, Clock3, Monitor, Menu,
  TriangleAlert, ArrowDownToLine, RotateCcw, CalendarDays, Plus, Receipt, GitBranch, Archive,
} from 'lucide-react';
import { applyAction, createState, evaluationFailureLevel, exportBackup, isArchived, localDate, parseBackup,
  qualifyingStartDate, resultTerms, STAGES, STORAGE_KEY, summarize } from './domain.js';
import { loadState, saveState } from './storage.js';
import { BackupSummary, Confirmation, HistoryView, SettingsView } from './views.jsx';

const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
const costMoney = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const signed = value => `${value >= 0 ? '+' : '-'}${money(Math.abs(value))}`;
const rate = value => value === null ? '--' : `${Math.round(value)}%`;
const name = account => `${account.type === 'funded' ? 'Funded' : 'Evaluation'} ${String(account.number).padStart(2, '0')}`;
const stageNames = {
  waiting: 'Waiting', evaluation: 'Active Evaluation', passed: 'Evaluation Passed',
  evaluation_failed: 'Evaluation Failed', main: 'Main Profit Phase',
  qualifying: 'Qualifying Days', payout_ready: 'Payout Ready', funded_failed: 'Funded Failed',
};

function IconButton({ icon: Icon, label, ...props }) {
  return <button className="icon-button" aria-label={label} title={label} {...props}><Icon size={18} /></button>;
}

function Status({ stage }) {
  return <span className={`status status-${stage}`}>{stageNames[stage]}</span>;
}

function Metric({ label, icon: Icon, value, children }) {
  return <article className="metric"><div className="metric-top"><span>{label}</span><Icon size={18} /></div>
    <strong>{value}</strong><div className="metric-detail">{children}</div></article>;
}

function Checkpoints({ account, compact = false }) {
  return <div className={`checkpoints ${compact ? 'compact' : ''}`} aria-label={`${account.qualifyingDates.length} of ${account.rules.qualifyingWins} qualifying days`}>
    {Array.from({ length: account.rules.qualifyingWins }, (_, index) => <div className={`checkpoint ${index < account.qualifyingDates.length ? 'complete' : ''}`} key={index} title={account.qualifyingDates[index] || `Day ${index + 1}`}>
      <span>{index < account.qualifyingDates.length ? <Check size={compact ? 12 : 17} /> : index + 1}</span>{!compact && <small>Day {index + 1}</small>}
    </div>)}
  </div>;
}

function ResultControls({ account, onAction, date, setDate, disabled, compact = false }) {
  const terms = resultTerms(account);
  if (!terms) return null;
  const duplicateDay = account.stage === STAGES.QUALIFYING && account.qualifyingDates.includes(date);
  const today = localDate();
  const futureDate = date > today;
  const minimumDate = qualifyingStartDate(account);
  const missingStart = account.stage === STAGES.QUALIFYING && !minimumDate;
  const beforeMainWin = minimumDate && date && date < minimumDate;
  const dateError = futureDate ? 'Future trade dates are not allowed.'
    : missingStart ? 'The main profit win date is unavailable for this cycle.'
      : beforeMainWin ? `Qualifying trades cannot be dated before the main profit win (${minimumDate}).` : '';
  const invalidDate = !date || !!dateError;
  const dateId = compact ? `tile-date-${account.id}` : 'trade-date';
  return <div className={compact ? 'tile-trade-controls' : ''}>
    <div className={compact ? 'tile-trade-date' : 'trade-date'}>
      <label htmlFor={dateId}><CalendarDays size={14} />{account.openTrade ? 'Close date' : 'Trade date'}</label>
      <input id={dateId} aria-label={compact ? `Trade date for ${name(account)}` : undefined} aria-invalid={!!dateError || undefined} type="date" min={minimumDate || undefined} max={today} value={date} onChange={event => setDate(event.target.value)} required />
    </div>
    <div className="trade-actions">
      <button className="trade-button loss" disabled={disabled || invalidDate} title={dateError || `Record a loss for ${name(account)}`} onClick={() => onAction({ type: 'record_result', accountId: account.id, result: 'loss', date })}><X size={compact ? 16 : 20} /><span>LOSS <strong>-{money(terms.loss)}</strong></span></button>
      <button className="trade-button win" disabled={disabled || invalidDate || duplicateDay} title={dateError || (duplicateDay ? 'A qualifying win is already recorded for this date' : `Record a win for ${name(account)}`)} onClick={() => onAction({ type: 'record_result', accountId: account.id, result: 'win', date })}><Check size={compact ? 16 : 20} /><span>WIN <strong>+{money(terms.win)}</strong></span></button>
    </div>
    {dateError && <p className="inline-note" role="alert">{dateError}</p>}
    {duplicateDay && !dateError && <p className="inline-note">Qualifying win recorded for this date. Select another trading day.</p>}
  </div>;
}

function AccountCard({ account, selected, onSelect, onAction, disabled }) {
  const [date, setDate] = useState(() => account.openTrade?.date || localDate());
  const archived = isArchived(account);
  const isEval = account.type === 'evaluation';
  const progress = isEval ? Math.max(0, Math.min(100, (account.balance - account.rules.evaluationStart) / (account.rules.evaluationTarget - account.rules.evaluationStart) * 100)) : account.qualifyingDates.length / account.rules.qualifyingWins * 100;
  return <article className={`account-card ${selected ? 'selected' : ''} ${archived ? 'archived' : ''}`} data-account-id={account.id}>
    {archived ? <div className="account-card-top"><span className="account-mark">{isEval ? <Layers3 size={16} /> : <ShieldCheck size={16} />}</span><span>{name(account)}</span><Archive size={16} aria-label="Archived" /></div>
      : <button className="account-card-top" onClick={() => onSelect(account.id)} aria-label={`View ${name(account)}`} aria-pressed={selected}><span className="account-mark">{isEval ? <Layers3 size={16} /> : <ShieldCheck size={16} />}</span><span>{name(account)}</span><ChevronRight size={16} /></button>}
    <Status stage={account.stage} /><strong>{money(account.balance)}</strong>
    {isEval ? <><div className="mini-track"><div style={{ width: `${progress}%` }} /></div><div className="card-meta"><span>Target {money(account.rules.evaluationTarget)}</span><span>{Math.round(progress)}%</span></div></>
      : <><Checkpoints account={account} compact /><div className="card-meta"><span>Cycle {account.cycle}</span><span>{account.qualifyingDates.length}/{account.rules.qualifyingWins} days</span></div></>}
    {isEval && <><div className="evaluation-floor" title={`Highest closed balance: ${money(account.evaluationHighWater)}`}><span>Failure level</span><strong>{money(evaluationFailureLevel(account))}</strong></div><div className="purchase-cost">Evaluation cost <span>{costMoney(account.purchaseCostCents)}</span></div></>}
    {account.openTrade && <span className="account-open-label"><GitBranch size={13} />Trade open</span>}
    <ResultControls account={account} onAction={onAction} date={date} setDate={setDate} disabled={disabled} compact />
    {account.stage === STAGES.PAYOUT && <button className="primary tile-payout" disabled={disabled} onClick={() => onAction({ type: 'payout', accountId: account.id })}><ArrowDownToLine size={16} />Take {money(account.rules.payoutAmount)} payout</button>}
  </article>;
}

function CurrentAccount({ account, onAction, date, setDate, disabled }) {
  const opened = account.openTrade;
  const terms = resultTerms(account);
  const isEval = account.type === 'evaluation';
  const r = account.rules;
  const progress = Math.max(0, Math.min(100, (account.balance - r.evaluationStart) / (r.evaluationTarget - r.evaluationStart) * 100));
  return <section className="current-account panel">
    <div className="panel-heading"><div className="eyebrow"><span className="live-mark" />CURRENT ACCOUNT</div>{opened && <span className="open-trade-status"><GitBranch size={15} />Trade open</span>}<Status stage={account.stage} /></div>
    <div className="current-title"><span className="account-mark large">{isEval ? <Layers3 size={22} /> : <ShieldCheck size={22} />}</span><div><h2>{name(account)}</h2><span>{isEval ? `Evaluation account / Cost ${costMoney(account.purchaseCostCents)}` : `Funded account / Cycle ${account.cycle}`}</span></div></div>
    <div className="balance-block"><span className="field-label">Account balance</span><div className="balance">{money(account.balance)}<span>.00</span></div>
      <div className={`balance-change ${account.balance < account.startingBalance ? 'negative' : ''}`}><TrendingUp size={15} />{signed(account.balance - account.startingBalance)} <span>from starting balance</span></div>
    </div>
    {isEval ? <div className="evaluation-progress"><div className="progress-label"><span>Progress to funded</span><strong>{Math.round(progress)}%</strong></div><div className="progress-track"><div style={{ width: `${progress}%` }} /></div><div className="progress-extents"><span>Start {money(r.evaluationStart)}</span><span>Target <b>{money(r.evaluationTarget)}</b></span></div><div className="risk-note"><span>Failure level</span><strong>{money(evaluationFailureLevel(account))}</strong><span className="distance">{money(Math.max(0, r.evaluationTarget - account.balance))} to target</span></div></div>
      : <div className="funded-progress"><div className="progress-label"><span>Qualifying days</span><strong>{account.qualifyingDates.length} / {r.qualifyingWins}</strong></div><Checkpoints account={account} /><div className="risk-note"><span>{account.stage === STAGES.MAIN ? `Main trade ${account.mainAttempts + 1} of 2` : 'Cycle payout'}</span><strong>{money(r.payoutAmount)}</strong><span className="distance">{account.stage === STAGES.MAIN ? 'Main profit phase' : account.stage === STAGES.PAYOUT ? 'Ready to withdraw' : `${money(r.qualifyingWin)} per winning day`}</span></div></div>}
    {opened && <div className="current-open-detail"><GitBranch size={15} />Continuation trade opened {opened.date}</div>}
    <ResultControls account={account} onAction={onAction} date={date} setDate={setDate} disabled={disabled} />
    {account.stage === STAGES.PAYOUT && <button className="primary payout-button" disabled={disabled} onClick={() => onAction({ type: 'payout', accountId: account.id })}><ArrowDownToLine size={19} />Take {money(r.payoutAmount)} payout</button>}
    {!terms && account.stage !== STAGES.PAYOUT && <div className="closed-state"><CircleCheck size={20} /><span>{account.stage === STAGES.WAITING ? 'Queued for evaluation' : account.stage === STAGES.PASSED ? 'Evaluation complete. Funded account created.' : 'Account closed'}</span></div>}
  </section>;
}

function CyclePanel({ account, stats }) {
  const isEval = account.type === 'evaluation';
  const activeStage = isEval ? 0 : account.stage === STAGES.MAIN ? 1 : account.stage === STAGES.QUALIFYING ? 2 : account.stage === STAGES.PAYOUT ? 3 : 1;
  const steps = [
    { label: 'Pass evaluation', detail: `${money(account.rules.evaluationTarget)} target`, icon: Layers3 },
    { label: 'Build main profit', detail: `${signed(account.rules.fundedMainWin)} winning trade`, icon: TrendingUp },
    { label: 'Qualify for payout', detail: `${account.rules.qualifyingWins} separate winning days`, icon: CalendarDays },
    { label: 'Take your payout', detail: `${money(account.rules.payoutAmount)} withdrawal`, icon: Wallet },
  ];
  return <aside className="cycle-panel"><section className="panel cycle-roadmap"><div className="panel-heading"><h2>{isEval ? 'The path to payout' : `Payout cycle ${account.cycle}`}</h2><CircleDollarSign size={18} /></div><ol className="cycle-steps">{steps.map((step, index) => <li key={step.label} className={index === activeStage ? 'current-step' : index < activeStage ? 'done-step' : ''}><span className="step-icon">{index < activeStage ? <Check size={16} /> : <step.icon size={16} />}</span><div><strong>{step.label}</strong><small>{step.detail}</small></div>{index === activeStage && <span className="step-now">Now</span>}</li>)}</ol></section><section className="withdrawal-summary"><div><span className="field-label">Total withdrawn</span><strong>{money(stats.withdrawn)}</strong></div><span className="withdraw-icon"><Wallet size={25} /></span><div className="withdrawal-footer"><span>{stats.payouts} payout{stats.payouts !== 1 ? 's' : ''} collected</span><span>All accounts</span></div></section></aside>;
}

export default function App() {
  const [loaded] = useState(() => loadState());
  const [state, setState] = useState(loaded.state);
  const stateRef = useRef(state);
  const [storageError, setStorageError] = useState(loaded.error);
  const [view, setView] = useState('dashboard');
  const [date, setDate] = useState(localDate());
  const [toast, setToast] = useState('');
  const [mobileNav, setMobileNav] = useState(false);
  const [accountFilter, setAccountFilter] = useState('all');
  const [confirmation, setConfirmation] = useState(null);
  const stats = summarize(state);
  const currentAccounts = state.accounts.filter(item => !isArchived(item));
  const archivedAccounts = state.accounts.filter(isArchived);
  const selectedAccount = currentAccounts.find(item => item.id === state.selectedId);
  const account = selectedAccount || currentAccounts.find(item => item.evaluationRole === 'primary') || currentAccounts[0];
  const archivedView = view === 'accounts' && accountFilter === 'archived';
  const portfolioAccounts = view === 'dashboard'
    ? [...currentAccounts].sort((a, b) => (a.id === account?.id ? -1 : b.id === account?.id ? 1 : a.type === 'funded' && b.type !== 'funded' ? -1 : b.type === 'funded' && a.type !== 'funded' ? 1 : 0)).slice(0, 6)
    : archivedView ? archivedAccounts : currentAccounts.filter(item => accountFilter === 'all' || item.type === accountFilter);
  const commit = next => {
    saveState(next);
    stateRef.current = next;
    setState(next);
  };
  const notify = text => setToast(text);
  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    const sync = event => {
      if (event.key !== STORAGE_KEY) return;
      try {
        const next = event.newValue ? parseBackup(event.newValue) : createState();
        stateRef.current = next;
        setState(next);
        setStorageError(null);
        notify('Account data updated in another tab.');
      } catch (error) { setStorageError(error.message); }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  useEffect(() => {
    if (!mobileNav) return;
    const close = event => { if (event.key === 'Escape') setMobileNav(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [mobileNav]);
  const act = action => {
    if (storageError) return storageError;
    try {
      const next = applyAction(stateRef.current, action);
      commit(next);
      const latest = next.events.at(-1);
      notify(action.type === 'undo' ? 'Last action undone.' : action.type === 'add_evaluation' ? `Evaluation ${latest.accountNumber} added. ${costMoney(latest.costCents)} cost recorded.` : latest.type === 'evaluation_pass' || latest.type === 'funded_created' ? 'Evaluation passed and archived. Funded account created.' : latest.type === 'evaluation_failure' ? 'Evaluation failed and archived.' : latest.type === 'funded_failure' ? 'Funded account failed and archived.' : latest.type === 'payout_ready' ? 'Qualifying days complete. Payout ready.' : action.type === 'payout' ? 'Payout recorded. Next cycle started.' : action.type === 'settings' ? 'Rules saved.' : `${action.result === 'win' ? 'Win' : 'Loss'} recorded.`);
      return null;
    } catch (error) { notify(error.message); return error.message; }
  };
  const select = id => {
    if (storageError) { setState(previous => ({ ...previous, selectedId: id })); return; }
    try { commit({ ...stateRef.current, selectedId: id }); }
    catch (error) { notify(error.message); }
  };
  const navigate = next => { setView(next); setMobileNav(false); };
  const importFile = async file => {
    try {
      if (file.size > 10000000) throw new Error('Backup must be smaller than 10 MB.');
      const imported = parseBackup(await file.text());
      setConfirmation({ type: 'import', state: imported, filename: file.name });
    } catch (error) { notify(`Import failed: ${error.message}`); }
  };
  const confirmReplace = () => {
    try {
      commit(confirmation.type === 'import' ? confirmation.state : createState(stateRef.current.settings));
      setStorageError(null);
      setConfirmation(null);
      navigate('dashboard');
      notify(confirmation.type === 'import' ? 'Backup restored.' : 'Workspace reset. Fresh evaluations are ready.');
    } catch (error) { notify(error.message); }
  };
  const nav = [{ key: 'dashboard', label: 'Dashboard', icon: LayoutDashboard }, { key: 'accounts', label: 'Accounts', icon: Layers3 }, { key: 'history', label: 'History', icon: History }, { key: 'settings', label: 'Settings', icon: SlidersHorizontal }];
  return <div className="app-shell"><aside className={`sidebar ${mobileNav ? 'nav-open' : ''}`}><a className="brand" href="#" onClick={event => { event.preventDefault(); navigate('dashboard'); }}><span className="brand-mark"><BarChart3 size={23} /></span><span>prop<span className="brand-light">desk</span><small>ACCOUNT TRACKER</small></span></a><span className="nav-label">WORKSPACE</span><nav aria-label="Main navigation">{nav.map(item => <button key={item.key} className={view === item.key ? 'nav-item active' : 'nav-item'} onClick={() => navigate(item.key)}><item.icon size={19} />{item.label}{item.key === 'accounts' && <span className="nav-count">{currentAccounts.length}</span>}</button>)}</nav><div className="sidebar-bottom"><div className="local-badge"><Monitor size={17} /><div><strong>Local workspace</strong><small>Saved in this browser</small></div></div><div className="profile"><span>JD</span><div><strong>My trading desk</strong><small>Single-user workspace</small></div></div></div></aside>
    {mobileNav && <button className="nav-overlay" aria-label="Close navigation" title="Close navigation" onClick={() => setMobileNav(false)} />}
    <div className="main-shell"><header className="topbar"><div className="breadcrumb"><IconButton icon={Menu} label="Toggle navigation" className="icon-button mobile-menu" onClick={() => setMobileNav(!mobileNav)} /><span>Workspace</span><ChevronRight size={14} /><strong>{nav.find(item => item.key === view)?.label}</strong></div><div className="topbar-right"><span className={`saved-indicator ${storageError ? 'storage-warning' : ''}`}><span />{storageError ? 'Storage issue' : 'Saved locally'}</span><span className="topbar-date">{new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span></div></header>
    <main><div className="page-title">
      <div><div className="eyebrow">YOUR TRADING WORKSPACE</div><h1>{view === 'dashboard' ? 'Account overview' : view === 'accounts' ? 'Your accounts' : view === 'history' ? 'Activity history' : 'Account settings'}</h1></div>
      <div className="page-actions">
        {['dashboard', 'accounts'].includes(view) && <button className="secondary add-evaluation" title={`Add evaluation for ${costMoney(state.settings.evaluationCostCents)}`} aria-label={`Add evaluation for ${costMoney(state.settings.evaluationCostCents)}`} disabled={!!storageError} onClick={() => act({ type: 'add_evaluation' })}><Plus size={16} /><span>Add evaluation</span><span className="evaluation-price">{costMoney(state.settings.evaluationCostCents)}</span></button>}
        <button className="secondary" aria-label="Undo last action" title="Undo last action" disabled={!state.undoStack.length || !!storageError} onClick={() => act({ type: 'undo' })}><Undo2 size={16} /><span>Undo last action</span></button>
        <IconButton icon={Download} label="Export backup" onClick={() => downloadBackup(state)} />
      </div>
    </div>
    {storageError && <div className="error-banner" role="alert"><TriangleAlert size={20} /><p>{storageError}</p><button className="secondary" onClick={() => navigate('settings')}>Open settings</button></div>}
    {view === 'dashboard' && <><div className="metrics-grid"><Metric label="Evaluations remaining" icon={Layers3} value={stats.remaining}><span><b className="green">{stats.passed}</b> passed</span><span><b className="red">{stats.evalFailed}</b> failed</span></Metric><Metric label="Active funded accounts" icon={ShieldCheck} value={stats.funded}><span><b>{stats.fundedFailed}</b> failed funded accounts</span></Metric><Metric label="Total payouts" icon={Wallet} value={stats.payouts}><span><b className="green">{money(stats.withdrawn)}</b> withdrawn</span></Metric><Metric label="Evaluation costs" icon={Receipt} value={costMoney(stats.costCents)}><span>{stats.evaluationCount} evaluation{stats.evaluationCount !== 1 ? 's' : ''} purchased</span></Metric><Metric label="Total trades" icon={BarChart3} value={stats.trades}><span>Eval <b>{rate(stats.evalRate)}</b></span><span>Funded <b>{rate(stats.fundedRate)}</b></span>{stats.openTrades > 0 && <span><b>{stats.openTrades}</b> open</span>}</Metric></div>{account ? <div className="trading-grid"><CurrentAccount account={account} onAction={act} date={date} setDate={setDate} disabled={!!storageError} /><CyclePanel account={account} stats={stats} /></div> : <div className="empty-state"><Layers3 size={30} /><h2>No current accounts</h2></div>}</>}
    {(view === 'dashboard' || view === 'accounts') && <section className="account-section">
      <div className="section-heading"><h2>{archivedView ? 'Archived accounts' : 'Account portfolio'} <span>{archivedView ? archivedAccounts.length : currentAccounts.length}</span></h2>{view === 'dashboard' && <button className="text-button" onClick={() => navigate('accounts')}>View all accounts <Layers3 size={15} /></button>}</div>
      {view === 'accounts' && <div className="segmented account-filters" aria-label="Filter accounts">
        {[['all', 'All accounts'], ['evaluation', 'Evaluations'], ['funded', 'Funded']].map(([key, label]) => <button key={key} className={accountFilter === key ? 'selected' : ''} aria-pressed={accountFilter === key} onClick={() => setAccountFilter(key)}>{label}</button>)}
        <button className={archivedView ? 'selected' : ''} aria-pressed={archivedView} onClick={() => setAccountFilter('archived')}><Archive size={14} />Archived <span className="filter-count">{archivedAccounts.length}</span></button>
      </div>}
      <div className="accounts-grid">{portfolioAccounts.map(item => <AccountCard key={item.id} account={item} selected={!archivedView && item.id === account?.id} onAction={act} disabled={!!storageError} onSelect={id => { select(id); navigate('dashboard'); }} />)}</div>
      {view === 'accounts' && !portfolioAccounts.length && <div className="empty-state">{archivedView ? <Archive size={30} /> : <Layers3 size={30} />}<h2>{archivedView ? 'No archived accounts' : accountFilter === 'funded' ? 'No current funded accounts' : accountFilter === 'evaluation' ? 'No current evaluations' : 'No current accounts'}</h2></div>}
    </section>}
    {view === 'dashboard' && <section className="recent-activity"><div className="section-heading"><h2>Recent activity</h2><button className="text-button" onClick={() => navigate('history')}>Full history <History size={15} /></button></div><HistoryView state={state} compact /></section>}
    {view === 'history' && <HistoryView state={state} />}
    {view === 'settings' && <SettingsView state={state} onSave={settings => act({ type: 'settings', settings })} onExport={() => downloadBackup(state)} onImport={importFile} onReset={() => setConfirmation({ type: 'reset' })} disabled={!!storageError} />}
    <footer><span>Prop Desk</span><span>Local workspace <span className="footer-dot" /> {state.accounts.filter(item => item.type === 'evaluation').length} evaluation accounts</span></footer></main></div>
    {toast && <div className="toast" role="status"><CircleCheck size={19} /><span>{toast}</span><IconButton icon={X} label="Dismiss notification" onClick={() => setToast('')} /></div>}
    {confirmation && <Confirmation title={confirmation.type === 'import' ? 'Restore backup?' : 'Reset all account data?'} confirmLabel={confirmation.type === 'import' ? 'Restore backup' : 'Reset all data'} danger onConfirm={confirmReplace} onClose={() => setConfirmation(null)}>{confirmation.type === 'import' ? <><p>Replace this workspace with <strong>{confirmation.filename}</strong>. Your current balances, history, and undo state will be replaced.</p><BackupSummary state={confirmation.state} /></> : <p>This will clear all trades, payouts, and history, and create {state.settings.startingEvaluations} evaluations using your saved rules. This cannot be undone.</p>}<button className="secondary" onClick={() => downloadBackup(state)}><Download size={16} />Export current backup</button></Confirmation>}
  </div>;
}

function downloadBackup(state) {
  const url = URL.createObjectURL(new Blob([exportBackup(state)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `prop-desk-backup-${localDate()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
