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
| Tables (Open Time / Set Hours / Add time / Stop & Bill) | ✓ | ✓ |
| Checkout & complete transactions | ✓ | ✓ |
| Quick Sale (walk-in items, no table) | ✓ | ✓ |
| Inventory | view only | add products, edit, add stock |
| Transactions | ✓ | ✓ |
| Reports: Daily sales report & log expenses | ✓ | ✓ |
| Remove a mistaken expense, turn Day/Night shifts on or off | — | ✓ |
| Cancel a game in its first 5 minutes (no table fee) | ✓ | ✓ |
| Owner Dashboard | — | ✓ |
| Reports: Custom range & Monthly | — | ✓ |
| Staff & accounts, Manage Tables (names) | — | ✓ |
| Everything an owner can do, hidden from owners and cashiers (see below) | — | Superadmin only |

## Superadmin (hidden account with every owner function)

A **superadmin** can do everything an owner can (all screens, products, tables, reports, staff accounts, expenses) and is
**invisible to everyone else**. Owners and cashiers never see the account in Staff & Accounts, the Dashboard's staff list
or the role options, and this is enforced by `firestore.rules`, not just hidden on screen:

- only a superadmin can read a superadmin's profile (the app subscribes to the users list with
  `where('role', '!=', 'superadmin')`, and an unfiltered list is refused for everyone else);
- owners can't create, edit, deactivate or promote anyone to superadmin, and a cashier can't make themself one;
- only a superadmin sees the **Superadmin** option when adding or editing staff, and can manage other superadmins.

**Create the first superadmin (one time, in the Firebase console; it can't be done from the app):**

1. Firebase console → **Authentication → Users → Add user**: enter the superadmin's email and a password, then copy the new
   user's **User UID**.
2. **Firestore Database → `users` collection → Add document**. Use the copied UID as the **Document ID**, and add these fields:
   `name` (string), `email` (string), `role` = `superadmin` (string), `active` = `true` (boolean), `online` = `false`
   (boolean), `lastSeen` = `0` (number), `createdAt` (timestamp, now).
3. Sign in with that email and password on the normal sign-in screen.

Anything a superadmin *does* (a sale, an expense, a restock) is recorded under the account's display name, so give it a
neutral name if it shouldn't stand out in Transactions and Reports.

In demo mode a "System Admin" superadmin exists but is left out of the sign-in picker; open
`http://localhost:5173/?demo&superadmin` to sign in as it.

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
- `transactions/{id}` — `tableId`/`tableName`, `startedAt`/`endedAt`/`durationMs` copied from the session, `mode` (open | timed), `plannedMs`, `billedMs`, `pricing` used, table fee, rounds, line items, totals, `method` (cash | gcash | split, or none for a ₱0 cancelled game), `payments {cash, gcash}`, cashier, `createdAt` (server time); a cancelled game also carries `gameCancelled`, `cancelReason`, `cancelNote`, `cancelledById`, `cancelledByName` (older sales may carry the retired `tableFeeVoided…` fields). While a game is open, a cancel is stored as `session.cancelled = { reason, note, byId, byName, at }`. A **Quick Sale** (walk-in) has `tableId: null` and no table-session fields — see below.
- `users/{uid}` — `name, email, role, active, online, lastSeen`
- `expenses/{id}` — `description, amount, cashierId, cashierName, createdAt` (server time). Cash taken from the drawer. Nobody edits one; only the owner can delete one.
- `settings/shifts` — `twoShifts` (owner-only). Off by default: one shift per business day.
- `meta/setup` — marks that the first owner exists
- `clock/{uid}` — private server-clock probe (lets each device show accurate timers)

## Reports & expenses

Laid out like the Marimar Inn reports. Every tab has the same shape: pickers on the left, Export CSV / Print on the right,
one row of number cards, then plain tables.

- **Daily** (everyone; cashiers see only this tab): the paper-style **Daily Sales Report** for one business day
  (6:00 AM to 6:00 AM). It has one row per sale, the expenses, a cash/GCash line, the **Overall Sale** (sales minus
  expenses) and signature lines. Below it: **End of shift**, where cash to count = cash collected − expenses.
  The cashier on duty logs expenses (cash taken from the drawer) at the top of this tab.
- **Custom range** (owner): totals, sales by day, sales/expenses/net per day, every expense, and cancelled games.
- **Monthly** (owner): the month's totals, sales trend, revenue by table and top products.

**Hall time:** business days, shifts and every time shown or printed use the hall's own time (Philippines, UTC+8, no
daylight saving, `HALL_TZ` in `js/clock.js`), not the device's time zone. A sale is filed under the same day and shift
whichever device or country you look at it from. A sale belongs to the shift it was *paid* in (its checkout time), so a
game started at 5:30 PM and paid at 6:10 PM is on the Night shift. The Daily tab follows the clock across 6:00 AM and
6:00 PM unless you picked a day or shift yourself.

The hall runs **one shift** per business day. When a second shift starts, the owner ticks *Day and Night shifts* on the
Daily tab. The tab then offers Day (6:00 AM–6:00 PM), Night (6:00 PM–6:00 AM) and Full day.
`SHIFT_SPLIT_HOUR` in `js/reporting.js` sets the split.

## Table rate

One rate for every table (`PRICING` in `js/billing.js`):

| Played | Table fee |
|---|---|
| 0:00:00 – 1:05:59 | ₱200 (first hour, plus a **5-minute grace period**) |
| 1:06:00 – 1:20:59 | ₱250 |
| 1:21:00 – 1:35:59 | ₱300 |
| 1:36:00 – 1:50:59 | ₱350 |
| 1:51:00 – 2:05:59 | ₱400 |
| 2:06:00 and every 15 minutes after | + ₱50 each (₱450, ₱500, ₱550, …) |

The grace period exists so a customer who says "end na ko" at 1:00 isn't charged another ₱50 because the cashier was busy.
It is **not** free time: the clock keeps counting the real elapsed time (the table card shows e.g. `Overtime +00:04:30` next to
`Bill ₱200.00`, then `+00:06:00` next to `₱250.00`), and it is not transferable. One customer is one session is one
transaction; a new session always pays its own first hour.

### Open Time vs Set Hours

- **Open Time:** the clock runs until the cashier stops it. Billed on the time actually played.
- **Set Hours:** the customer books a length, e.g. 1h, 2h, 3h, or a custom length in 15-minute steps. The card counts down
  "Time left" and turns amber with "Overtime +mm:ss" when the booking runs out.
  - **Booked time is the minimum charge.** The billed time is whichever is longer, booked or played. Stopping a 2h booking after
    45 minutes costs ₱400; playing 2:05:59 on a 2h booking still costs ₱400 (grace), and 2:06:00 costs ₱450.
  - **Add time** (at checkout) extends a booking. An Open Time table can also be switched to a booking there. The rules allow
    a booking to grow, never shrink.

Formula, on exact milliseconds: `< 1:06:00 → ₱200`, otherwise `₱200 + (1 + floor((elapsed − 1:06:00) / 15 min)) × ₱50`.
It lives in **one** function, `calculateBilliardBill()` in `js/billing.js`. Open Time, Set Hours, the table card, checkout,
the booking preview and the sale that is saved all call it (through `billSession()`); reports, history, the dashboard and
receipts only read the fee stored on each sale. Old sales keep their old amounts: each sale stores a pricing snapshot, and one
without the grace field is read with the old round-up rule.
Checkout shows the breakdown and when the fee next goes up. `firestore.rules` holds a copy of the same numbers (`feeOk`),
so change both together, and **deploy the rules together with this change** (`npm run deploy:rules`), otherwise checkouts are rejected.

## Time integrity (why a changed clock can't change a bill)

- **Server timestamps:** session start, session end, sale time, cancel time and presence are written as server timestamps. The
  security rules require each one to equal `request.time`, so a device clock that is wrong or deliberately changed can't backdate anything.
- **Checkout stops the clock first:** the server stamps the end, then the sale is billed from the stored start and end. If that final total
  differs from what the cashier was looking at, nothing is saved and the app shows the final amount to confirm.
- **The rules re-check every sale:**
  - its start and end match the table's session;
  - its duration equals end − start;
  - its table fee matches the rate;
  - it is written in the same step that frees the table.

  A table can't be freed without a matching sale.
- **Locked session times:** start and end times can never be edited, and an ended clock can't restart. A completed sale can never be changed,
  so there's no "reopen" path for old stamps to leak back onto a table.
- **Server-synced timers:** on-screen timers use the server's clock, measured when you sign in, every 10 minutes and when the app returns to
  the foreground. A device whose clock is more than a minute off gets a warning.
- **Demo mode** has no server, so it uses the browser's clock. These protections only apply with Firebase.

Stock is checked when items are added to a bill and **deducted when the transaction is
completed**. That happens inside one Firestore transaction together with writing the
receipt and freeing the table, so two terminals can't oversell stock or bill a table twice.

## Screens: what lives where

- **Tables grid.** Each card is a small top-down pool table, built so you can scan the floor and act in one tap. Navy cloth with a green LED means In Use; pale cloth with an unlit display means Available. The cards show no buttons: tap a table to open its actions. A free table offers **Open Time** or **Set Hours**; a running table offers **Stop & Bill**, which opens Checkout (on the Checkout screen, tapping a running table goes straight to its bill). Booked tables show time left, or overtime in amber. A running table also warns before each whole hour (see *Hour-mark alert*).
- **Checkout** (one table). This is where you manage a running table: **Add time** / **Set hours**, End Session, **Add Item**, cancel a game in its first 5 minutes, and payment.
- **Top bar (phones and tablets).** Phones and tablets, in either orientation, get a top bar with **refresh**, the **thermal printer** and the **cash drawer**; the sidebar becomes a slide-out menu. On a desktop with a mouse the sidebar keeps labeled printer and cash drawer buttons.
- The navy "device display" look is used only for live table equipment (the table cards and the checkout timer). The rest of the app stays ivory and felt green, so a dark card always means a running table.

## Cancel game (first 5 minutes, before paying)

A customer who changes their mind in the first **5 minutes** isn't charged the table fee. Nobody pays first to be
refunded later: the cashier cancels on the table itself.

- **Where:** open the table (click it on Tables, which opens its Checkout page). While the game is 5 minutes or less,
  a **Cancel game** button shows with a countdown ("4:12 left"). A clock that was stopped within 5 minutes can still
  be cancelled. After 5 minutes the button disappears and the fee stands (`CANCEL_WINDOW_MS` in `js/billing.js`).
- **Reason required,** plus a note when the reason is "Other". No approval needed. Any staff member can cancel.
- **No items on the bill:** the clock stops, the table is freed, and a ₱0 sale marked *Game cancelled* is recorded.
- **Items on the bill:** the table fee becomes ₱0 and the cashier takes payment for the items only. They are still owed.
- **Enforced on the server:** `firestore.rules` (`cancelsGame`) allows it only within 5 minutes of server time, only
  once, and a checkout of a cancelled game must have a ₱0 table fee. A normal game can't claim ₱0.
- **A paid sale can't be changed.** Transactions are append-only, so there is no void after payment.
- **Where the owner sees it:** "Cancelled" on the Dashboard's recent transactions plus a **Cancelled games today**
  card, *Game cancelled* on the Transactions list and the Daily sales sheet, and a **Cancelled games** list in
  Reports → Custom range. Older sales whose table fee was voided after payment still show there too.
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
  table name/number (Dashboard's Recent Transactions and the receipt do the same). A Quick Sale has no
  table fee, so there's nothing to cancel.

## Hour-mark alert (table cards)

A running table warns the cashier as it nears each whole hour of play (1:00, 2:00, ...), so they can tell the customer
before the next rate step. It is a state layered on the card and changes nothing about billing:

- **Last 5 minutes:** amber wood rail with a slow pulse, amber timer, a bell badge (top-right), a × dismiss button
  (top-left), and one short chime.
- **Last minute:** the same in red, with a faster pulse and a fading timer. No extra sound.
- **Recovery:** it clears the moment the hour passes and re-arms for the next hour on its own. Stopping the table clears
  it too. The × hides that card's alert for that hour mark only (kept for the browser session, so a reload doesn't
  bring it back or repeat the chime).
- **Booked tables:** when the booking ends within 15 minutes, the existing booking chime already covers it, so the
  hour-mark chime stays quiet.
- **Reduced motion:** with `prefers-reduced-motion`, the rail and timer just change color, with no pulsing or rocking.

Timing rules are `hourAlert()` in `js/billing.js` (unit-tested); the on-screen state is in `js/hour-alerts.js`.

## Payments

Checkout takes **Cash** (optional cash tendered → change), **GCash**, or **Split**. For Split the cashier enters the cash
portion and the rest of the total goes on GCash. For **GCash and Split** the cashier must enter the **last 5 digits of the
GCash reference number** (`gcashRef`, required by `firestore.rules`). It shows on the receipt, in the Transactions list
(and search), and on the Daily sales report and its CSV. Every transaction stores `payments.cash` and `payments.gcash`, so
reports can add up money by type whatever the method was. (Older `card` records still show up, as "Other".)

## Thermal printer

Ported from Marimar Inn (`js/printer.js`). The **Thermal printer** button in the sidebar connects a 58mm or 80mm ESC/POS
receipt printer (the dot turns green when connected):

- **Bluetooth**: Web Bluetooth, for BLE printers (Chrome/Edge).
- **USB cable**: Web Serial, for a USB printer on a computer (Chrome/Edge).
- **RawBT app (Android)**: most cheap 58mm printers use classic Bluetooth, which browsers can't reach. Install the free
  RawBT app, pair the printer there, and the app hands each receipt to RawBT.

Paper width (58mm = 32 characters, 80mm = 48), Print test, and a paper-style **Preview** that shows the exact lines the
printer gets. Receipts have **Print receipt / Preview print**. The Daily report has **Print (thermal) / Preview
(thermal)**: a compact shift-end slip with each sale, expenses, cash to count, overall sale and signature lines. The last
printer reconnects on its own if the browser kept the permission. Receipts are plain ASCII ("P" instead of "₱") so
no-name printers print them correctly.

### Time-left alerts

For **Set Hours** (booked) tables, every signed-in screen plays a chime and shows an alert card when a table has
**15 minutes left**, and a louder chime and a red card at **5 minutes left** (`js/time-alerts.js`, sounds in
`js/alarm.js`, made with the Web Audio API like Marimar Inn's). Each alert plays once per table per game; the card
stays until someone taps OK or opens the table. Open Time tables have no end time, so they don't alert. Browsers only
allow sound after the screen has been tapped once, so tap anywhere after opening the app.

### Tablet app (full screen, direct Bluetooth)

`android-app/` is the Golden Break tablet app, copied from Marimar Inn. It's a small Android app that opens the live
site full screen and prints straight to a paired Bluetooth thermal printer, no RawBT. Inside it, the Thermal printer
panel lists the printers paired in Android Settings. See `android-app/README.md` for installing and building.
`sw.js` keeps a saved copy of the app so it still opens when the tablet loses internet.

### Cash drawer

Also from Marimar Inn. The drawer plugs into the printer's drawer (RJ11) port and opens through the printer, so the
thermal printer must be connected. **Cash drawer** in the sidebar:

- **On cash pay** (on by default, per device): the drawer opens after a sale that took cash, including the cash part
  of a split. GCash leaves it closed.
- **Open drawer**: the owner opens it directly; a cashier needs the **drawer PIN**. It's also on the Daily report's
  End of shift card, for counting cash.
- **Drawer PIN** (owner only): stored as a SHA-256 hash in `settings/cashDrawer`, never as the digits.

The kick is the same as Marimar Inn's: an ESC p pulse on pin 5, then pin 2 as a second job, because drawers are wired
to either pin.

## Business day

Reports group sales by business day, which starts at 6:00 AM, so a sale at 1:30 AM counts toward the night before.
Change `BUSINESS_DAY_START_HOUR` in `js/reporting.js` to adjust it. The Dashboard and Transactions screens still use calendar days.
See **Reports & expenses** above for what each report tab shows.

## Tests

```bash
npm install
npm test
```

- `tests/unit/`: pricing examples and edge cases, the 5-minute cancel rule, and report math (plain Node).
- `tests/rules/`: security rules on the Firestore emulator (needs Java). This covers allowed actions and attempted cheats: backdated starts,
  ends and sales, edited start times, restarting a clock, wrong fees, false durations, freeing a table without a sale, late cancels,
  and changing a paid sale.

## Structure

```
index.html
css/styles.css          design tokens + all component styles
js/app.js               auth flow, shell (sidebar), router, live subscriptions
js/db.js                picks db-firebase.js or db-demo.js
js/services.js          business operations (sessions, checkout, stock, staff)
js/billing.js           pure billing rules (official table rate, elapsed time, cancel game)
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
