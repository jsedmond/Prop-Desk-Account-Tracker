# Prop Desk

A local, single-user prop-firm account tracker built with React and Vite. All account data lives in your browser's localStorage. There is no backend, database, authentication, or external service connection.

## Open the app

On this Windows machine, double-click `Start Tracker.cmd`, or open http://127.0.0.1:5173 while the preview is running.

For other machines, install Node.js 20 or newer, then run:

```sh
npm install
npm run dev -- --port 5173
```

Use the same browser profile and URL each time. Browser storage is tied to the origin, including the port. Export JSON backups regularly; clearing browser data or using a different browser does not transfer your accounts.

## GitHub Pages

Repository: [Prop-Desk-Account-Tracker](https://github.com/jsedmond/Prop-Desk-Account-Tracker).

After a successful deployment, the hosted tracker is available at [Prop Desk](https://jsedmond.github.io/Prop-Desk-Account-Tracker/).

1. Push the project to the repository's `main` branch.
2. In the repository, open **Settings > Pages** and set **Build and deployment > Source** to **GitHub Actions**. This is a one-time setup.
3. Open **Actions > Deploy GitHub Pages** to check the deployment. If the first run happened before Pages was enabled, select **Run workflow** on `main` to retry.

The workflow uses Node.js 24, installs the lockfile's dependencies with `npm ci`, runs `npm test`, and builds the production site before deploying only `dist/`. Subsequent pushes to `main` automatically test, build, and redeploy. Other branches cannot deploy this workflow. GitHub's [custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) covers the hosting setup.

The hosted tracker still stores accounts only in your browser. GitHub receives the application files, not your saved trading data. There is no login, cloud backup, or device synchronization. To move your existing localhost accounts, export a backup from the local tracker, then use **Settings > Import backup** on the hosted tracker. The two URLs have separate browser storage; future changes do not transfer automatically. Keep exported account backups out of the public repository and continue backing up regularly.

## Rules

- Start with five $50,000 evaluations and one primary evaluation in the ordinary queue.
- Each evaluation costs $90.00 by default. The initial five cost $450.00. The dashboard tracks cumulative evaluation costs separately from withdrawals; passed and failed accounts retain their original purchase costs.
- Use **Add evaluation** on Dashboard or Accounts to add one new evaluation. It joins the queue, or becomes active immediately when there is no active evaluation. Passed and failed evaluations, along with failed funded accounts, move automatically to the **Archived** filter on Accounts, leaving the current portfolio. Archived accounts cannot trade or collect payouts, but their names can still be edited. Their costs, payout totals, and audit history are retained; active funded accounts remain in the current portfolio. Undoing a completion or failure restores the prior account state and visibility. The addition and its cost can also be undone.
- Evaluation wins add $1,500; losses subtract $1,000. Pass at $53,000 or higher. The initial failure level is $48,000, trailing $2,000 below the highest closed balance and capped at the original $50,000 starting balance. It rises with new highs and never falls after losses. A balance at or below the current failure level fails the evaluation.
- Passing creates a $50,000 funded account and activates the next waiting evaluation. Funded accounts can be selected independently from the active evaluation.
- In the first funded cycle, either of two main trade attempts can win $4,000. Each loss risks $1,000. Two main losses fail the account.
- Qualifying wins add $200 and count one qualifying day. Qualifying results must be dated on or after that cycle's main-profit win; same-day results are allowed. Only one qualifying win per selected calendar date counts in a cycle. A $200 loss preserves completed days. The same date can be reused in a later cycle if it meets that cycle's main-win date cutoff.
- Four qualifying days enable a $3,000 payout. The ideal first cycle leaves $51,800 after the withdrawal.
- Later cycles risk $1,000 on the first main loss and $800 on the second. Two losses fail the account; a win enters qualifying days again.
- There is no additional automatic failure threshold during qualifying days because the requested rules do not define one.

## Recording results

Each eligible account tile on Dashboard and Accounts has its own trade-date selector and **Win** and **Loss** buttons. Record results directly for any evaluation or funded account, including multiple accounts trading the same continuation pattern. No trade-opening step or dialog is required. Each result affects only that account; qualifying dates are tracked separately per funded account.

Trade dates may be today or any historical calendar day in your local time zone. Future dates are blocked by both the date controls and trade logic. Existing saved history is preserved.

Funded qualifying date selectors also begin at the current cycle's main-profit win date. Both qualifying Win and Loss are blocked before that date. A payout clears the cutoff for the new main phase; the next main win sets the next cycle's cutoff. Undo restores the prior cutoff. Existing historical entries are not retroactively rewritten.

For example, a $1,500 evaluation win raises the balance to $51,500 and failure level to $49,500. A $1,000 loss leaves $50,500 with the failure level still $49,500. Another $1,500 win reaches $52,000 and locks the failure level at $50,000. The drawdown distance comes from the account's initial starting balance minus its initial failure level, using its saved rules. Each evaluation tracks its own high-water mark from results in the order they are recorded, even when selecting historical dates. Open trades do not move the failure level. Funded-account rules are unchanged.

The buttons show the account's current win and loss amounts. Passed and failed evaluations and failed funded accounts are available in Accounts under **Archived**, including previously closed accounts. Archived tiles have no result or payout actions. Archiving is derived from the account's stage; no saved account, cost, payout, history, or undo data is deleted. Payout-ready funded tiles offer their payout action. Selecting a current account's name opens its detailed current-account panel, where the same result controls are available.

Use the pencil beside an account name to enter an actual account number, partial number, or name (up to 48 characters). Leading zeros are preserved. Evaluation and funded names are independent, including after an evaluation passes. Clearing the field or using **Use default name** restores its original label. Names appear in account tiles, the current-account panel, and history, and survive reloads and backups. Rename actions are recorded in history and can be undone without changing balances, purchase costs, or trade progress. Internal account IDs and queue numbers do not change.

The evaluation queue still has one primary account. Recording a result on a waiting evaluation starts that account without replacing the primary. When the primary passes or fails, an evaluation already trading becomes primary before an untouched waiting account. Evaluations with recorded results or open trades retain their rule snapshots.

Each result can be undone in one step, including its queue changes and milestones. Previously saved open trades remain compatible: use their tile's Win or Loss button to close them with their saved terms. Undo restores that pending trade. The tracker does not inspect market prices or detect patterns.

Every amount, the evaluation failure level, starting account count, and qualifying-day requirement is editable in Settings. Changes apply to evaluations with no recorded results or open trades, whether waiting or active, as well as newly created funded accounts and the next funded cycle. Untouched evaluations also update their starting balance and initial drawdown level. Evaluations that have traded and existing funded cycles retain their rule snapshots; saved history is unchanged. Undone results do not count as trades taken. Evaluations with existing balance or high-water progress remain protected even if legacy history is incomplete. If an untouched account still has older rules, **Save rules** remains available to apply the already-saved settings without changing any field. Evaluation fee changes apply only to future purchases or a fresh reset. Purchase prices are stored as integer cents to preserve exact totals. The starting account count applies when resetting the workspace. A newly funded balance comes from its evaluation's original starting balance.

## History and undo

Each action is an atomic state transition. Trades record the timestamp, selected trade date, account, account type, cycle, stage, result, P&L, and before/after balances. Milestones and payouts are recorded separately.

Undo restores the complete prior account state, selection, rules, queue, cycle, and payout totals. Original events stay in the audit trail and are marked **Undone** through an appended reversal event. Reversed events are excluded from metrics. Undo survives reload and JSON backup restoration. Reset clears history and cannot be undone; reset and import both require confirmation.

## Backup format

JSON schema version `6` contains `settings`, `accounts`, `selectedId`, `events`, and `undoStack`. Each account has a `customName` string, empty when using its default label. Each evaluation carries its purchase price in `purchaseCostCents`, queue role in `evaluationRole`, and highest closed balance in `evaluationHighWater`. Funded accounts store their current cycle's `mainWinDate`, or `null` in the main phase. Each account stores an `openTrade` snapshot or `null`. Existing versions `1` through `5` automatically migrate, preserving trades, costs, payouts, and undo snapshots. Saved settings matching the old defaults (ten starting evaluations and $90.20 per purchase) update to five and $90 for future purchases and resets; other configured counts and prices remain unchanged. Existing accounts are not removed and their purchase costs and rule snapshots are retained. Undo snapshots receive the same default-settings update. High-water marks and main-win dates are reconstructed from the relevant unreversed trade history for both current accounts and undo snapshots; old milestones and stages are not retroactively rewritten. For incomplete legacy histories, a known qualifying date supplies the cutoff; if no date can be recovered, the account remains loadable but qualifying results are blocked until a valid main-win date is available. Version `1` purchases retain their original $90.20 cost. The original browser storage key is retained. Imports are validated before replacing the workspace and limited to 10 MB. Unsupported versions are rejected instead of being guessed; future migration steps belong in `parseBackup` in `src/domain.js`. Damaged saved data is preserved and trading is disabled until importing a valid backup or resetting.

## Verification

```sh
npm test
npm run build
npm run test:browser
npm run test:continuation
npm run test:trailing
npm run test:qualifying-date
npm run test:account-names
npm run test:settings
```

Browser checks use a fresh headless Microsoft Edge context at http://127.0.0.1:5173 and do not change your normal browser's data. Set `TRACKER_BROWSER=chrome` or `TRACKER_URL` to use another installed Chromium browser or preview URL. Screenshots are written to the ignored `artifacts/` folder.

To verify the production GitHub Pages path locally, run `npm run build`, then `npm run preview -- --port 4173 --strictPort`. In another terminal, run `npm run test:pages`. This checks the built site at http://127.0.0.1:4173/Prop-Desk-Account-Tracker/, including assets, account actions, backups, and desktop/mobile layout in isolated browser contexts.

Business logic: `src/domain.js`. Persistence: `src/storage.js`. Dashboard and account tile controls: `src/App.jsx`. History, settings, and confirmations: `src/views.jsx`.
