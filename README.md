# Golden Break Billiard Hall — POS & Inventory

Vanilla JavaScript (ES modules, no build step) + Firebase (Firestore + Auth).

## Run it

```bash
npm start
```

Then open http://localhost:5173. (ES modules won't load from `file://`, so use the bundled
zero-dependency server or any static server.)

### Demo mode (default)
With `js/firebase-config.js` left empty the app runs on a local real-time backend that
has the same API as Firestore. Data lives in `localStorage` and syncs live between tabs
through `BroadcastChannel`, so two tabs act like two terminals. Pick an Owner or Cashier
account on the sign-in screen. "Reset demo data" puts the seed data back.

To use demo mode while a real Firebase config is filled in, open **http://localhost:5173/?demo**. Local testing then never
writes to the live database. **Clear sales (start empty)** on the demo sign-in screen removes all demo sales, expenses and
open tables but keeps staff, tables and products.

### Firebase mode
1. Create a Firebase project. Enable **Authentication → Email/Password** and **Cloud Firestore**.
2. Paste your web app config into `js/firebase-config.js`.
3. Deploy the security rules: `firebase deploy --only firestore:rules` (or paste
   `firestore.rules` into the console).
4. Open the app. The first visitor sees **Set up your hall** and creates the owner account.
   After that, the owner adds cashiers from **Staff & Accounts**, then adds tables and products.

## Roles

| | Cashier | Owner |
|---|---|---|
| Tables (Open Time / Set Hours / Add time / Stop & Bill), log rounds, table light | ✓ | ✓ |
| Checkout & complete transactions | ✓ | ✓ |
| Quick Sale (walk-in items, no table) | ✓ | ✓ |
| Inventory | view only | add products, edit, add stock |
| Transactions | ✓ | ✓ |
| Shift Report (sales, cash to count), log expenses | ✓ | ✓ |
| Remove a mistaken expense, turn Day/Night shifts on or off | — | ✓ |
| Void the table fee (session used ≤5 min) | own sales | any sale |
| Owner Dashboard | — | ✓ |
| Reports (sales, payments, shifts) | — | ✓ |
| Staff & accounts, Manage Tables (names) | — | ✓ |

The UI hides owner-only screens, and `firestore.rules` enforces the same limits on the server.
For example, cashiers can only *decrease* product stock, and transactions are append-only.

## Data model (Firestore)

- `tables/{id}` — `name, number, light, status (available|in_use), session, lastTxId`
  - `session = { startedAt, ended, endedAt, plannedMs, rounds, items[], openedBy, openedByName }`
  - `plannedMs` is `0` for **Open Time**, or the booked length for **Set Hours** (15-minute steps; it can be extended, never cut)
  - `startedAt` and `endedAt` are **server timestamps**. Elapsed time = `endedAt − startedAt` once ended, otherwise
    server-synced now − `startedAt`.
  - Sessions can't be paused. **End Session** (or Complete Transaction) stops the clock once, and that is final.
- `products/{id}` — `name, category, price, stock, reorderLevel, lastRestockedAt`
- `restocks/{id}` — restock log (feeds "Restocked this week")
- `transactions/{id}` — `tableId`/`tableName`, `startedAt`/`endedAt`/`durationMs` copied from the session, `mode` (open | timed), `plannedMs`, `billedMs`, `pricing` used, table fee, rounds, line items, totals, `method` (cash | gcash | split), `payments {cash, gcash}`, cashier, `createdAt` (server time); a table-fee-voided sale also carries `tableFeeVoided`, `voidReason`, `voidNote`, `tableFeeVoidedBy…`, `originalTableFee`, `originalTotal`, `refundAmount`, `refundMethod`. A **Quick Sale** (walk-in) has `tableId: null` and no table-session fields — see below.
- `users/{uid}` — `name, email, role, active, online, lastSeen`
- `expenses/{id}` — `description, amount, cashierId, cashierName, createdAt` (server time). Cash taken from the drawer. Nobody edits one; only the owner can delete one.
- `settings/shifts` — `twoShifts` (owner-only). Off by default: one shift per business day.
- `meta/setup` — marks that the first owner exists
- `clock/{uid}` — private server-clock probe (lets each device show accurate timers)

## Shift Report & expenses

Adapted from the Marimar Inn daily sales report. **Shift Report** (all staff) lists every sale and expense for a business
day (6:00 AM to 6:00 AM) and reconciles the drawer:

- **Cash to count** = cash collected − expenses (expenses are paid out of the cash drawer)
- **Net sales** = sales − expenses

The cashier on duty logs expenses (several lines at once) from the same page. Each one is stamped with server time, so it
lands on the shift that was actually working. Export CSV and Print produce the end-of-shift sheet.

The hall runs **one shift** per business day. When a second shift starts, the owner ticks *Split the day into Day and Night
shifts* on the Shift Report page. The report then offers Day (6:00 AM–6:00 PM), Night (6:00 PM–6:00 AM) and Full day.
`SHIFT_SPLIT_HOUR` in `js/reporting.js` sets the split.

Reports (owner) show expenses and net on every tab: Sales (expenses, net sales, cash on hand), Payments (cash on hand per
day), By cashier (cash to hand over per cashier per day) and a new Expenses tab.

## Table rate

One rate for every table (`PRICING` in `js/billing.js`):

| Played | Table fee |
|---|---|
| up to 1:00:00 | ₱200 |
| each started 15 minutes after that | + ₱50 (partial brackets always round **up**) |

### Open Time vs Set Hours

- **Open Time:** the clock runs until the cashier stops it. Billed on the time actually played.
- **Set Hours:** the customer books a length, e.g. 1h, 2h, 3h, or a custom length in 15-minute steps. The card counts down
  "Time left" and turns amber with "Overtime +mm:ss" when the booking runs out.
  - **Booked time is the minimum charge.** The billed time is whichever is longer, booked or played. Stopping a 2h booking after
    45 minutes costs ₱400; playing 2:01 on a 2h booking costs ₱450.
  - **Add time** (at checkout) extends a booking. An Open Time table can also be switched to a booking there. The rules allow
    a booking to grow, never shrink.

Formula: `≤ 60 min → ₱200`, otherwise `₱200 + ceil((minutes − 60) / 15) × ₱50`, computed on exact milliseconds.
So 1:00:00 is ₱200, 1:00:01 is ₱250, 1:15:00 is ₱250, 1:15:01 is ₱300, and 2:01:00 is ₱450.
Checkout shows the breakdown and when the fee next goes up. `firestore.rules` holds a copy of the same numbers (`feeOk`),
so change both together.

## Time integrity (why a changed clock can't change a bill)

- **Server timestamps:** session start, session end, sale time, table-fee-void time and presence are written as server timestamps. The
  security rules require each one to equal `request.time`, so a device clock that is wrong or deliberately changed can't backdate anything.
- **Checkout stops the clock first:** the server stamps the end, then the sale is billed from the stored start and end. If that final total
  differs from what the cashier was looking at, nothing is saved and the app shows the final amount to confirm.
- **The rules re-check every sale:**
  - its start and end match the table's session;
  - its duration equals end − start;
  - its table fee matches the rate;
  - it is written in the same step that frees the table.

  A table can't be freed without a matching sale.
- **Locked session times:** start and end times can never be edited, and an ended clock can't restart. Voiding a sale's table fee never
  touches the table itself, so there's no "reopen" path for old stamps to leak back onto a table.
- **Server-synced timers:** on-screen timers use the server's clock, measured when you sign in, every 10 minutes and when the app returns to
  the foreground. A device whose clock is more than a minute off gets a warning.
- **Demo mode** has no server, so it uses the browser's clock. These protections only apply with Firebase.

Stock is checked when items are added to a bill and **deducted when the transaction is
completed**. That happens inside one Firestore transaction together with writing the
receipt and freeing the table, so two terminals can't oversell stock or bill a table twice.

## Screens: what lives where

- **Tables grid.** Each card is a small top-down pool table, built so you can scan the floor and act in one tap. Navy cloth with a green LED means In Use; pale cloth with an unlit display means Available. A free table offers **Open Time** or **Set Hours**. A live table has **Stop & Bill**, and the whole card opens Checkout. Booked tables show time left, or overtime in amber.
- **Checkout** (one table). This is where you manage a running table: **Add time** / **Set hours**, End Session, **Log Round** (a per-session game count, saved on the receipt), **Add Item**, the **Table light** switch, and payment.
- The navy "device display" look is used only for live table equipment (the table cards and the checkout timer). The rest of the app stays ivory and felt green, so a dark card always means a running table.

## Table-fee void

Voiding never touches items — anything a customer bought is always still owed, whoever ends up paying for it.
It only ever waives the **table fee**, for the case where a customer decides not to play after all.

- **Eligible only if the table was barely used:** the table fee can be waived if the session lasted **5 minutes or
  less** (`VOID_ELIGIBLE_DURATION_MS` in `js/billing.js`). Past 5 minutes of play, the table fee is final — there's no
  window to still act within, because eligibility depends on how long the table was used, not on how much time has
  passed since checkout.
- **Who:** the cashier who completed the sale, or the owner. No approval needed.
- **Reason required:** a reason is required, and so is a note when the reason is "Other".
- **Where you act on it:** the receipt right after checkout, and the Transactions list (both roles).
- **What it does:** the table fee is zeroed and refunded (through whichever payment channel — cash or GCash —
  covered it; the cashier picks the channel if the sale was split), the sale's total drops to just the items, and it
  stays on the totals for Tables, Transactions, Dashboard and Reports at that reduced amount. Items, their stock, and
  the table are never touched — there's no "reopen," since nothing about the table needs undoing.
- **Where the owner sees it, since no approval is required:**
  - **Transactions:** a "Table fee voided" badge on the row, with the reduced total.
  - **Owner Dashboard:** the Recent Transactions list carries the same badge, and a dedicated **Table fee voids
    today** card lists each one — table, cashier, reason, amount refunded — click to open its receipt.
  - **Reports → Sales:** a **Table fee voids** table for the selected date range, with a count and total refunded,
    and it's included in that tab's CSV export.

## Quick Sale (walk-in items, no table)

**Quick Sale** is for a walk-in customer buying items — drinks, snacks, merchandise — without
playing at a table: no timer, no table fee, just the items and a payment.

- **Where it lives:** its own nav item (between Checkout and Transactions, both roles), and an
  outlined **Quick Sale** button in the Tables top bar.
- **The screen:** the same items list and bill-summary layout as Checkout, minus everything about a
  table — no timer panel, no session tools, no table fee line, ever. The cart is built locally in the
  screen (not written to Firestore) until **Complete Sale**, at which point stock is checked and
  deducted in one transaction, exactly like a table checkout — so two terminals still can't oversell
  stock.
- **Data model:** a Quick Sale transaction has `tableId: null` (and no `tableName`, `startedAt`,
  `endedAt`, `durationMs`, `plannedMs`, `mode`, or `pricing` — none of those apply without a table),
  `tableFee: 0`, and `total == productTotal`. `firestore.rules` verifies exactly that shape
  (`quickSaleOk`) instead of the table-session checks a normal sale goes through.
- **Where it shows up:** the same Transactions list as table sales, tagged **Walk-in** instead of a
  table name/number (Dashboard's Recent Transactions and the receipt do the same). A Quick Sale can
  never be table-fee-voided — there's no table fee on it to waive.

## Payments

Checkout takes **Cash** (optional cash tendered → change), **GCash**, or **Split**. For Split the cashier enters the cash
portion and the rest of the total goes on GCash. Every transaction stores `payments.cash` and `payments.gcash`, so
reports can add up money by type whatever the method was. (Older `card` records still show up, as "Other".)

## Reports (owner)

Reports → **Sales / Payments / Shifts**, for Today, Yesterday, 7 or 30 days, or any range up to 92 days. Every tab can be
exported to CSV or printed.

- **Business day:** sales are grouped by business day, which starts at 6:00 AM, so a sale at 1:30 AM counts toward the night before.
  Change `BUSINESS_DAY_START_HOUR` in `js/reporting.js` to adjust it. The Dashboard and Transactions screens still use calendar days.
- **Sales:** gross, table revenue (hours played, rounds), product sales, daily breakdown, and top products.
- **Payments:** cash vs GCash collected (splits counted in both), a breakdown by method, and collections per day.
- **Shifts:** sales per cashier per business day: number of sales, items, table revenue, product sales, and cash vs GCash.

## Tests

```bash
npm install
npm test
```

- `tests/unit/`: pricing examples and edge cases, void rules, and report math (plain Node).
- `tests/rules/`: security rules on the Firestore emulator (needs Java). This covers allowed actions and attempted cheats: backdated starts,
  ends and sales, edited start times, restarting a clock, wrong fees, false durations, freeing a table without a sale, and late or
  unauthorized voids.

## Structure

```
index.html
css/styles.css          design tokens + all component styles
js/app.js               auth flow, shell (sidebar), router, live subscriptions
js/db.js                picks db-firebase.js or db-demo.js
js/services.js          business operations (sessions, checkout, stock, staff)
js/billing.js           pure billing rules (official table rate, elapsed time, voids)
js/clock.js             server-synced clock + SERVER_TIME write placeholder
js/reporting.js         pure report aggregation (business days, totals, shifts, CSV)
js/dialogs.js           add/edit table, product, stock, staff; receipt
js/views/*.js           tables, pool-card, checkout, quick-sale, reports, charts, inventory, transactions, dashboard, staff, auth, auth-balls
firestore.rules         role-based security rules, incl. server-time and fee checks
tests/                  unit tests + Firestore rules tests
assets/                 logo-golden-break.png (full lockup), logo-mark.png (cropped 8-ball, compact spots)
```

## Sign-in screen

The sign-in screen ("Golden Break Billiard Hall") is a deliberate visual departure from the rest of the app: a dark navy-to-black
atmosphere with gold and felt-green glows, ambient background billiard balls, and a glassmorphism card — built in `js/views/auth.js`,
`js/views/auth-balls.js` and the `.gb-*` rules in `css/styles.css`. It covers sign-in, first-run owner setup, the demo account picker,
and the "almost there" pending screen; only sign-in has "Remember me" (real session vs. persistent Firebase Auth persistence) and
"Forgot password?" (sends a real Firebase reset email). Past sign-in, the app switches to its everyday ivory/felt look — the dark/gold
atmosphere is a front-door effect, not the whole app's palette — but the **brand** (name and logo) is the same "Golden Break Billiard
Hall" everywhere: the full lockup (`assets/logo-golden-break.png`) in the sidebar and on sign-in, and a cropped 8-ball from that same
file (`assets/logo-mark.png`) wherever the full lockup won't fit, like the mobile topbar or the browser tab icon.

## Notes
- Staff presence is a heartbeat every 60 s. A user counts as online if they were seen in the last 3 minutes.
- Owners can deactivate accounts, which blocks access through the rules. Deleting the Firebase Auth user has to be done in the Firebase console.
