import React, { useEffect, useRef, useState } from 'react';
import { Download, Upload, RotateCcw, Save, History, Check, X, Undo2, ChevronLeft, ChevronRight, Wallet, TrendingUp, TriangleAlert, Receipt, GitBranch, Pencil } from 'lucide-react';
import { accountName, defaultAccountName, DEFAULT_SETTINGS, MAX_ACCOUNT_NAME_LENGTH, reversedActions, STAGES, summarize, untradedEvaluations } from './domain.js';

const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value);
const costMoney = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const signed = value => `${value >= 0 ? '+' : '-'}${money(Math.abs(value))}`;
const stageLabels = { waiting: 'Waiting', evaluation: 'Evaluation', main: 'Main profit', qualifying: 'Qualifying days', payout_ready: 'Payout ready', passed: 'Passed', evaluation_failed: 'Failed', funded_failed: 'Failed' };

export function Confirmation({ title, children, confirmLabel, onConfirm, onClose, danger = false, confirmDisabled = false, focusRef }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog.showModal();
    focusRef?.current?.focus();
    return () => { if (dialog.open) dialog.close(); };
  }, []);
  return <dialog className="confirmation-dialog" ref={ref} onCancel={onClose} onClick={event => { if (event.target === ref.current) onClose(); }} aria-labelledby="confirmation-title">
    <div className="dialog-heading"><h2 id="confirmation-title">{title}</h2><button className="icon-button" aria-label="Close confirmation" title="Close confirmation" onClick={onClose}><X size={18} /></button></div>
    <div className="dialog-body">{children}</div>
    <div className="dialog-actions"><button className="secondary" onClick={onClose} autoFocus={!focusRef}>Cancel</button><button className={danger ? 'danger-button' : 'primary'} disabled={confirmDisabled} onClick={onConfirm}>{confirmLabel}</button></div>
  </dialog>;
}

export function RenameAccount({ account, onSave, onClose, disabled }) {
  const [draft, setDraft] = useState(account.customName);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const unchanged = draft.trim() === account.customName;
  const save = () => {
    if (unchanged || disabled) return;
    setError(onSave(draft) || '');
  };
  return <Confirmation title={`Rename ${defaultAccountName(account)}`} confirmLabel="Save name" onConfirm={save} onClose={onClose} confirmDisabled={unchanged || disabled} focusRef={inputRef}>
    <form className="rename-form" onSubmit={event => { event.preventDefault(); save(); }}>
      <label htmlFor="account-name">Account number or name</label>
      <div className="rename-input"><input ref={inputRef} id="account-name" type="text" value={draft} maxLength={MAX_ACCOUNT_NAME_LENGTH} placeholder={defaultAccountName(account)} autoComplete="off" disabled={disabled} onChange={event => { setDraft(event.target.value); setError(''); }} /><button className="icon-button" type="button" title="Use default name" aria-label="Use default name" disabled={!draft || disabled} onClick={() => { setDraft(''); setError(''); inputRef.current.focus(); }}><RotateCcw size={16} /></button></div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>
  </Confirmation>;
}

const fields = [
  { title: 'Evaluation accounts', description: 'Updated rules apply to evaluations with no trades taken, including the active account. Evaluation cost applies to new purchases; the starting count applies on reset.', items: [
    ['startingEvaluations', 'Starting evaluations', 'count'],
    ['evaluationCostCents', 'Cost per evaluation', 'cost'],
    ['evaluationStart', 'Starting balance', 'money'],
    ['evaluationTarget', 'Pass target', 'money'],
    ['evaluationFailure', 'Initial failure level', 'money'],
    ['evaluationWin', 'Winning trade', 'money'],
    ['evaluationLoss', 'Losing trade', 'money'],
  ] },
  { title: 'Funded main profit', description: 'Updated rules apply to new funded accounts and the next payout cycle.', items: [
    ['fundedMainWin', 'Main winning trade', 'money'],
    ['initialFundedRisk', 'First-trade loss / first-cycle second loss', 'money'],
    ['postPayoutSecondRisk', 'Post-payout second-trade loss', 'money'],
  ] },
  { title: 'Qualifying days & payouts', description: 'Qualifying wins require separate calendar dates within each cycle.', items: [
    ['qualifyingWin', 'Qualifying winning day', 'money'],
    ['qualifyingLoss', 'Qualifying losing day', 'money'],
    ['qualifyingWins', 'Required winning days', 'count'],
    ['payoutAmount', 'Payout amount', 'money'],
  ] },
];

const settingsDraft = settings => ({ ...settings, evaluationCostCents: (settings.evaluationCostCents / 100).toFixed(2) });
const draftValue = (key, value) => key === 'evaluationCostCents' ? Math.round(Number(value) * 100) : Number(value);

export function SettingsView({ state, onSave, onExport, onImport, onReset, disabled }) {
  const [draft, setDraft] = useState(() => settingsDraft(state.settings));
  const [error, setError] = useState('');
  const fileRef = useRef(null);
  useEffect(() => { setDraft(settingsDraft(state.settings)); setError(''); }, [state.settings]);
  const dirty = Object.keys(DEFAULT_SETTINGS).some(key => draftValue(key, draft[key]) !== state.settings[key]);
  const pendingAccountRules = untradedEvaluations(state).some(account =>
    Object.keys(DEFAULT_SETTINGS).some(key => account.rules[key] !== state.settings[key]));
  const submit = event => {
    event.preventDefault();
    const settings = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, draftValue(key, value)]));
    const issue = onSave(settings);
    setError(issue || '');
  };
  return <div className="settings-view"><form onSubmit={submit}>
    {fields.map(group => <section className="settings-band" key={group.title}><div className="settings-description"><h2>{group.title}</h2><p>{group.description}</p></div><div className="settings-fields">{group.items.map(([key, label, kind]) => <div className="setting-field" key={key}><label htmlFor={`setting-${key}`}>{label}</label><div className="number-field">{kind !== 'count' && <span aria-hidden="true">$</span>}<input id={`setting-${key}`} type="number" min={kind === 'cost' ? 0 : 1} max={key === 'startingEvaluations' ? 100 : key === 'qualifyingWins' ? 30 : kind === 'cost' ? 1000000 : 100000000} step={kind === 'cost' ? '0.01' : 1} value={draft[key]} required disabled={disabled} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} /></div></div>)}</div></section>)}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="settings-save"><span>{dirty ? 'Unsaved rule changes' : pendingAccountRules ? 'Account rules pending' : 'All rules saved'}</span><button className="secondary" type="button" disabled={!dirty || disabled} onClick={() => { setDraft(settingsDraft(state.settings)); setError(''); }}>Discard changes</button><button className="primary" disabled={(!dirty && !pendingAccountRules) || disabled} type="submit"><Save size={16} />Save rules</button></div>
  </form><section className="settings-band backup-band"><div className="settings-description"><h2>Backup & restore</h2><p>Backups include account balances, rules, history, and undo state.</p></div><div className="backup-actions"><button className="secondary" onClick={onExport}><Download size={17} />Export backup</button><button className="secondary" onClick={() => fileRef.current.click()}><Upload size={17} />Import backup</button><input ref={fileRef} className="visually-hidden" type="file" accept="application/json,.json" aria-label="Choose backup file" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) onImport(file); }} /></div></section>
  <section className="settings-band reset-band"><div className="settings-description"><h2>Reset workspace</h2><p>Start {state.settings.startingEvaluations} fresh evaluations using your saved rules. Current history and undo state will be cleared.</p></div><div><button className="danger-button" onClick={onReset}><RotateCcw size={16} />Reset all data</button></div></section>
  </div>;
}

function eventTitle(event) {
  if (event.type === 'trade') return `${event.stage === STAGES.QUALIFYING ? 'Qualifying' : event.accountType === 'funded' ? 'Main trade' : 'Evaluation'} ${event.result}`;
  return {
    evaluation_pass: 'Evaluation passed', evaluation_failure: 'Evaluation failed',
    evaluation_added: 'Evaluation purchased',
    account_renamed: 'Account renamed',
    trade_opened: 'Continuation trade opened',
    funded_created: 'Funded account opened', funded_failure: 'Funded account failed',
    qualifying_day: 'Qualifying day completed', payout_ready: 'Payout ready',
    payout: 'Payout collected', settings: 'Account rules updated', undo: 'Action undone',
  }[event.type];
}

export function HistoryView({ state, compact = false }) {
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(0);
  const reversed = reversedActions(state);
  const events = [...state.events].reverse().filter(event => filter === 'all' || filter === 'trades' && event.type === 'trade' || filter === 'payouts' && event.type === 'payout' || filter === 'milestones' && !['trade', 'undo', 'settings'].includes(event.type));
  const pageSize = compact ? 5 : 20;
  const maxPage = Math.max(0, Math.ceil(events.length / pageSize) - 1);
  const currentPage = Math.min(page, maxPage);
  const visible = events.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  return <section className={`history-view ${compact ? 'compact-history' : ''}`}>
    {!compact && <div className="history-toolbar"><div className="segmented" aria-label="Filter history">{[['all', 'All activity'], ['trades', 'Trades'], ['payouts', 'Payouts'], ['milestones', 'Milestones']].map(([key, label]) => <button key={key} aria-pressed={key === filter} className={key === filter ? 'selected' : ''} onClick={() => { setFilter(key); setPage(0); }}>{label}</button>)}</div><span>{events.length} event{events.length !== 1 ? 's' : ''}</span></div>}
    {!visible.length ? <div className="empty-state"><History size={30} /><h2>{state.events.length ? 'No matching activity' : 'A fresh start'}</h2><p>{state.events.length ? 'Activity will appear here as it happens.' : 'Your first trade will begin the account history.'}</p></div> : <><div className="history-column-labels"><span>Activity / date</span><span>Account / stage</span><span>Amount</span><span>Balance before / after</span></div><div className="history-list">{visible.map(event => {
      const undone = reversed.has(event.actionId);
      const Icon = event.type === 'undo' ? Undo2 : event.type === 'account_renamed' ? Pencil : event.type === 'trade_opened' ? GitBranch : event.type === 'evaluation_added' ? Receipt : event.type === 'payout' ? Wallet : event.result === 'loss' || event.type.includes('failure') ? X : event.result === 'win' ? TrendingUp : Check;
      const subject = state.accounts.find(account => account.id === event.accountId);
      const hasAmount = event.type === 'trade' || event.type === 'payout';
      return <article className={`history-event ${undone ? 'event-undone' : ''}`} key={event.id}>
        <div className="event-primary"><span className={`event-icon ${event.result === 'loss' || event.type.includes('failure') ? 'loss' : ''}`}><Icon size={17} /></span><div><strong>{eventTitle(event)} {undone && <span className="undone-tag">Undone</span>}</strong><time dateTime={event.timestamp} title={new Date(event.timestamp).toLocaleString()}>{new Date(event.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} <span>{new Date(event.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span></time>{event.type === 'trade' && <small>Trade date: {event.date}</small>}{event.pattern === 'continuation' && <small>Continuation / Opened {event.openedDate}</small>}{event.type === 'trade_opened' && <small>Win +{money(event.win)} / Loss -{money(event.loss)}</small>}</div></div>
        <div className="event-account"><strong>{subject ? accountName(subject) : event.accountNumber ? defaultAccountName({ type: event.accountType, number: event.accountNumber }) : 'Workspace'}</strong><span>{event.accountType === 'funded' ? `Cycle ${event.cycle} / ` : ''}{stageLabels[event.stage] || (event.type === 'undo' ? 'Balance and progress restored' : 'Account rules')}</span>{event.type === 'account_renamed' && <small>{event.previousName} to {event.newName}</small>}</div>
        <div className={`event-amount ${event.type === 'payout' ? 'payout' : event.type === 'evaluation_added' ? 'red' : event.pnl > 0 ? 'green' : event.pnl < 0 ? 'red' : ''}`}>{event.type === 'evaluation_added' ? `-${costMoney(event.costCents)}` : hasAmount ? event.type === 'payout' ? money(-event.pnl) : signed(event.pnl) : '--'}{event.type === 'payout' && <small>Withdrawn</small>}{event.type === 'evaluation_added' && <small>Evaluation cost</small>}</div>
        <div className="event-balances">{hasAmount ? <><span>{money(event.balanceBefore)}</span><strong>{money(event.balanceAfter)}</strong></> : <span>--</span>}</div>
      </article>;
    })}</div>{!compact && events.length > pageSize && <div className="history-pagination"><span>Page {currentPage + 1} of {maxPage + 1}</span><button className="icon-button" aria-label="Previous history page" title="Previous history page" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={18} /></button><button className="icon-button" aria-label="Next history page" title="Next history page" disabled={currentPage >= maxPage} onClick={() => setPage(currentPage + 1)}><ChevronRight size={18} /></button></div>}</>}
  </section>;
}

export function BackupSummary({ state }) {
  const stats = summarize(state);
  return <dl className="backup-summary"><div><dt>Evaluation accounts</dt><dd>{state.accounts.filter(account => account.type === 'evaluation').length}</dd></div><div><dt>Active funded accounts</dt><dd>{stats.funded}</dd></div><div><dt>Open trades</dt><dd>{stats.openTrades}</dd></div><div><dt>Recorded trades</dt><dd>{stats.trades}</dd></div><div><dt>Total withdrawn</dt><dd>{money(stats.withdrawn)}</dd></div><div><dt>Evaluation costs</dt><dd>{costMoney(stats.costCents)}</dd></div></dl>;
}
