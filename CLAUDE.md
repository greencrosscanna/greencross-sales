# Sales / Cashflow (app key `sales`) — GX app

Part of the Green Cross app suite. The **GX Command Center** (GX Core) is the shared "brain": shared
sign-on, the stores registry, the Dutchie connector, and the centralized bug-report + release-note logs
all live there. This app is being integrated with it. Owner: **Sky** — Shawn is a USER of this app, not its
owner (corrected by Sky 2026-08-20; the shared brain's app-owner list still says otherwise). Backend:
`dutchie_proxy.gs` (Dutchie + QuickBooks proxy). Frontend: `index.html`, deployed via **GitHub Pages**. Its
app key in GX Core is **`sales`**.

## Stack & local loop

**No build step — the file on disk IS the app.**

| | |
|---|---|
| frontend | `index.html` — a **monolith with inline JS**, on GitHub Pages |
| backend | `dutchie_proxy.gs` — the Dutchie **and QuickBooks** proxy, deployed with clasp |
| version | the **`APP_VERSION` constant** in `index.html` (no `?v=` cache-buster — there's no external `.js`) |
| run | `python3 serve.py` → <http://localhost:3000> |
| ship | commit → push (Pages) → `./deploy.sh` records the release to `version_history` |
| tests | `tests/*_test.js` — **56 suites, 1,975 assertions** (2026-09-17), run by the **pre-push hook** via `gx-preflight.sh`; a failure blocks the push. Also verify live with the `gxpin` / `authprobe` routes below |

The dev server talks to the **live** backend; `gx-dev.js` blocks writes until armed — which matters more
here than elsewhere, since this app's writes now run through a fail-closed auth guard. `gx-preflight.sh`
runs as a **pre-push hook** and refuses dev leftovers — and it also runs every `tests/*_test.js`, so a
failing test blocks the push exactly like a dev leftover does.

**Run them yourself with `ls tests/*_test.js | xargs -n1 node`.** Most of them read this repo's real
`index.html` / `dutchie_proxy.gs` — none of them tests a copy, which is what stops coverage rotting
silently. Six EXECUTE the shipped source: `pnl_statement`, `deposit_reconciliation`, `pacing_staleness`,
`qb_deposits_shape` and `goal_attainment` `grab()` named functions out of the file and run them in a `vm`
context, and `write_guard` rebuilds them with `new Function` — so a renamed function fails the suite instead of quietly
falling out of coverage. The other two, `orphan_css_classes` and `dev_guard_actions`, analyze the source
text rather than running it. `.claude/gx-posttool-tests.sh` reruns all of them after every edit to those
two files, which is why a broken edit surfaces mid-session instead of at push time.

What they cover, before you assume a change is untested: `orphan_css_classes` (every class used in the
markup is defined, and every class defined is used), `pnl_statement` (the P&L build **and** the store-pill
state machine), `deposit_reconciliation`, `write_guard` (the auth guard's log / enforce / off modes),
`goal_attainment` (`attainprobe`'s two refusals — see below), `dev_guard_actions` (every `action=` the app fetches is declared in `GX_DEV_READS`, so a new read cannot
break localhost only), `pacing_staleness` (the two-clock bug — `paceFracs` going stale against a live
poll), `qb_deposits_shape`.

**Two are wrappers, and they SKIP — not fail — when `greencross-command-center` is not a
sibling checkout.** `cross_app_contract` (the Leaderboard → Sales goal payload) and `store_palette_drift`
(this app's hardcoded store palette against the hub's) both live canonically in the hub, because they span
repos and neither side owns them. On a lone clone two of them say `SKIP` —
read it, don't assume green means covered.

*Corrected 2026-08-25: this row previously read "no automated suite — verify with the `gxpin` /
`authprobe` routes". There were 9 suites behind two hooks at the time it said that. A doc that tells a
session there is nothing to run invites skipping a gate that works: on the period-selector change,
`orphan_css_classes` caught dead `.dsk-pfield`/`.dsk-chip` rules left mid-refactor and `pnl_statement`
caught `refreshCompare` being undefined in the pill handlers. Both would have shipped.*

**Shared files** (`deploy.sh`, `serve.py`, `gx-preflight.sh`, `.claude/gx-brain-notes.sh`) come from
**gx-theme** via `./gx-sync.sh`, filled from `.gx_app`. Edit them **there**, then re-sync. This CLAUDE.md is
intentionally **not** synced.

## The store VOCABULARY is GX Core's now, and River Rd is the store that proves it

`knownStore_` decides whether `?store=X` is a store at all. Until v2.558 the list was the keys of
this app's own Dutchie credential map — Sales' internal names. Moving the keys into GX Core replaced
it with the registry's **`dutchie_name`** values, and five of six stores are spelled identically
both ways. **River is the one that is not**: the frontend sends `River`, the registry says
`River Rd`, so on 2026-08-31 every sales load answered `Unknown store: River` and that store
disappeared from every tab, total and goal comparison.

**It never looked like an outage.** The status grid marked one store red and the pill read `5/6`,
which reads as a slow store rather than a missing one, while the company figure was short a store
all day. That is the shape to watch for: a per-store failure degrades into a smaller number, not an
error.

- **The second chance goes through `GXCore.resolveStore`, never a local alias table.** An alias
  table here makes Sales look right while the same mismatch stays wrong for every other reader, and
  a spelling added in Command Center never reaches us — the same lesson as the v223 `getPeriodGoals`
  fix. The prototype guard survives: `resolveStore`'s answer is accepted only when it carries a
  `store_id` the registry actually lists, so `constructor` / `__proto__` still fail.
- **The registry's `display_name` for river-rd is `River`**, which is why `GXCore.getSalesDaily`
  never had this problem — it resolves on store_id / dutchie_name / display_name. Only the exact
  string gate did.
- **`?action=storekeys&store=…&secret=…`** now reports `known` / `exact` / `store_id`. The bare
  label list looked complete and correct while River was being refused; ask with the name the caller
  actually sends.
- `tests/store_vocabulary_test.js` runs every name in `index.html`'s `STORES` through the SHIPPED
  `knownStore_`. **The two lists live in different repos and nothing compared them** — that, not the
  spelling, is the defect. Verified to fail against the old gate.

### The store LIST is GX Core's too — a new store is added, not skipped (v2.595, 2026-09-14)

The vocabulary above was fixed; the LIST was not. The six stores were typed out in `index.html` and
four more times in `dutchie_proxy.gs` (goals by date, the pay-period walk + `attainprobe`, pacing,
COGS), and the client's registry merge **skipped** any store it did not already know. A store added
in Command Center would have loaded nowhere, and every total, goal and Gross Profit figure would have
read one store short — the River shape again. Found by a read-only audit, not by it happening.

- **Backend: `salesStores_()` is the only list.** Registry rows (`gxStoreRegistry_`) → `{core, dutchie,
  sales}`. `SALES_STORES_FALLBACK_` is used only when the registry cannot answer. Don't add a fifth copy.
- **Frontend: `addOrUpdateStore_` ADDS unknown stores** to `STORES` / `STORE_MAP` / `STORE_TO_VEL`.
  The hardcoded `STORES` is the offline fallback. Keep `name` then `display` first on each row: the
  hub's cross-app contract test parses that shape.
- **Matched on `store_id`**, which is why `?action=stores` now sends it (cache key `stores_meta_v2`).
  A Command Center rename updates the row instead of adding a second one.
- **`sales` (the internal key) is never renamed.** Reconciliation state, caches and deposit rules are
  written under it. `SALES_KEY_BY_DUTCHIE_` / `GX_DUTCHIE_TO_SALES` hold the one legacy exception
  (`River Rd` → `River`); a new store keys on its dutchie_name with no entry.
- **Not automatic, and cannot be:** a new store's QuickBooks class (`RECON_STORE_BY_CLASS_`), ATM
  machines (`ATM_MACHINE_MAP`) and deposit week start (Reconcile settings, default Wednesday) are
  real per-store facts. Until set, its deposits land on the visible *not included* list.
- **Removing** a store deactivated in Command Center is deliberately NOT done: dropping it would erase
  its history from every past-period total.
- `tests/store_list_test.js` (27 assertions) executes both halves; each half verified by mutation.
  Browser-checked: six stores unchanged, and a seventh injected into the registry payload rendered as
  its own pill and row with the pill reading `6/7`.

### The mismatch came back as a FREQUENCY, not an outage (fixed v2.570, 2026-09-04)

Sky, 2026-09-03: *"things are much faster now, on polo it seems that River is the one that fails
most frequently. is this a name mismatch River vs River-Rd?"* **The name is fine** — measured on the
live deployment, `?action=storekeys&store=River` answers `known:true, exact:false, store_id:river-rd`
every time. But the mismatch was still the cause, one level down, and the tell is in the word
*frequently*: a vocabulary error fails every single time, which is exactly what August 31 looked
like. An intermittent one is a different bug wearing the same message.

`knownStore_` short-circuits on the first line for the five names the registry spells identically.
`River` is the only one that goes on to `GXCore.resolveStore` — and from there into `gxStoreIds_`,
which called `resolveStore` **again, once per store**, to rediscover ids the registry rows were
already carrying. **Eight registry calls for River, one for the other five**, each in a `try` that
swallowed its own failure.

**The swallow was the defect, not the count.** A dropped id is not a neutral loss: `knownStore_`
accepts a resolved name only when its id is in that list, so losing `river-rd` for one execution
makes River alone answer `Unknown store: River` while the other five load normally. Demonstrated
against the pre-fix source with a single transient on `resolveStore('River Rd')` — id list five
long, `knownStore_('River')` false, `knownStore_('Bend')` true.

- **Ids now come off `GXCore.getStores()`'s own rows** (`gxStoreRegistry_`, memoized per execution).
  The rows carry `store_id` and `dutchie_name` together, so six `resolveStore` calls per River
  request became zero and the list cannot lose a store.
- **The second chance still goes through `resolveStore`, never a local alias table** — that rule is
  unchanged and load-bearing. It is now memoized in the SCRIPT cache for an hour, shared by every
  viewer, so it is one lookup per name per hour rather than one per request per tab. A Command
  Center rename still reaches us within the hour.
- **A registry failure THROWS; it no longer returns `false`.** "That is not a store" and "the
  registry did not answer" were wearing one message and only the first is permanent. Throwing makes
  River's failure mode match the other five — whose `gxStoreNames_()` already threw before that
  `try` was entered — and the client's existing retry then recovers the load instead of painting a
  red square. `storeGateError_` gives the write and inventory routes the same distinction;
  `knownStoreSafe_` keeps the probes from dying on it.
- **A throw is never cached. A null answer is**, because a registry that says "I don't know this
  name" has answered.
- `tests/store_vocabulary_test.js` is 31 assertions now: the five exact names never reach
  `resolveStore`, River reaches it once rather than once per store, the id list stays complete, a
  hiccup throws and names the registry, a real miss still just returns `false`, and a hiccup leaves
  the memo empty.

**`?action=loadprobe&store=…&from=…&to=…&nocache=1&secret=…`** is what made this findable and is
the route to re-run next time a store "feels slow". It calls `getStoreSales_` itself — not a copy —
and reports per-phase timings: `known_store`, `settled_cache_hit` / `settled_getSalesDaily`,
`live_today`, and every `gxDutchieGet_` attempt with its HTTP code and body size. `over_client_timeout`
flags a store against the 15s the browser actually allows one attempt (`gasFetchJson(url, 2, 15000)`),
which is the number that decides whether a slow store renders as a broken one. Omit `store` to walk
all six and compare — one store's timing means nothing without the five it is being judged against.

Measured 2026-09-04, all six healthy and River unremarkable: sequential fresh pulls 2.7–4.2s
(River 3.0s, mid-pack), six in parallel 3.4–4.9s, a full settled August month 2.4–4.0s. **That is
the point of the measurement — it ruled out "River is slow" and "River is big", which is what sent
the search to the gate.** Also ruled out: the client cache write (`writeSalesCache` guards its own
quota throw and cannot fail a store) and latency from the extra resolve (`known_store` measured the
same for River as for the others, because GX Core caches the registry).

Measured 2026-08-31: Core's `dutchie_get` resolves both `River` and `River Rd` to `river-rd`;
`sales_coverage` shows river-rd holding 974 days, 2024-01-01 → 2026-08-31, **zero missing**. The
data was always there.

## The budget sheet is GONE — everything comes from this script's own properties

**Severed 2026-08-30 (Sky's call). `dutchie_proxy.gs` contains ZERO `SpreadsheetApp` calls.** The
legacy "2026 GX2 Dashboard" workbook is no longer read, and `BUDGET_SHEET_ID` / the sheet gids /
`ATM_SHEET_CONFIG_` are deleted rather than merely unused — while they exist, the next session adds
"just one quick read" and the dependency grows back. `tests/sheet_severance_test.js` (26 assertions)
asserts the ABSENCE, so it cannot creep back unnoticed.

Done as **freeze-then-cut**, and the freeze was VERIFIED against the live sheet before anything was
deleted: 6 store goal rows, 22 expense categories, 9 QB mapping pairs — May total $685,700, Jun
$664,946, matching an independent read. That check earned its keep: the sheet has more than one row
per store label and the parse takes the LAST match, which is exactly how a wrong figure gets frozen
permanently and silently. Each store's row proved to be its own.

Now serving from ScriptProperties: `frozen_goals` · `frozen_expbudgets` · `frozen_qbmapping` ·
`otherrev_data` · `rev_atm_*`. `?action=freezestatus&secret=…` reports all of it.

- **The ATM bootstrap was still live** — `ATM_SHEET_CONFIG_['2026'].sid` *was* `BUDGET_SHEET_ID`.
  Had `rev_atm_2026` not already existed, the cut would have silently blanked ATM revenue. Check
  properties before removing a "one-time" bootstrap; one-time does not mean spent.
- **The `spreadsheets` OAuth scope STAYS, deliberately — do not "tidy" it away.** An Apps Script
  library runs under the CALLING project's authorization, and `GXCore` reads the GX Core
  spreadsheet for `getPeriodGoals` and `roleForApp`. Dropping that scope severs GX Core too,
  including the fail-closed write guard, which would then refuse every write.
- **There were no pre-2026 budget goals to preserve.** The sheet holds ONE year; `getGoals` tags its
  response `BUDGET_YEAR` and the frontend returns 0 for any other year. What the freeze preserves is
  the 2026 fallback for windows the pay-period ledger does not cover.

## Smart budget — the expense budget is now derived, not typed

**`?action=budget_proposal`** proposes a 12-month budget per category from **24 complete months** of
QuickBooks actuals (the month in progress is excluded — on the 30th it holds 29 days and would drag
every figure down). All 22 categories are applied as of 2026-08-30. Apply writes a `smart_budget`
ScriptProperties overlay that `getExpenseBudgets()` merges per-category over `frozen_expbudgets`;
`clear_budget` reverts one category or all.

- **COGS / Payroll are % of projected revenue**, not their own history — budgeting them off last
  year's spend holds them flat against a sales plan that isn't.
- **A category with no history gets NO proposal.** That refusal is the point: a made-up figure reads
  as analyzed, which is worse than a visibly missing one.
- **Sparse categories (no spend in half their months) get a run rate**, not a typical month. With
  the median at 0 every month that DID spend read as an outlier and Meals & Entertainment came out
  at **$0/yr against $7,014 of real spend**. A confident zero is the worst answer available.
- **Cleaning is recurrence-aware and one-sided.** A point is set aside only if it is far from the
  overall median AND its own calendar month in other years AND the months either side of it. That is
  what tells a real seasonal peak (July sits on last July) from a one-off (March's rent spike), and
  what stops a recent step change — a new lease, a new store — from being erased back to the old
  level. Thresholds (`SB_LOCAL_W` 3, `SB_LIMIT_FLOOR` 15%) were chosen by running the REAL series
  through the candidates, not by taste.
- **Level from the trailing 12, seasonality from the full 24**, and both are means over the CLEANED
  series — a budget has to total correctly, and 12x the median month under-budgets a 9-month/3-month
  category by 20%.
- **`?action=budgetprobe&secret=…`** is the secret-gated twin — method/confidence spread across all
  22 categories without logging in. Re-run it after any GXCore re-pin.
- **`admin_apply_proposed`** applies the engine's own figures for named categories, for scripted
  rollouts with no browser session. It takes NAMES only and fills them from a fresh proposal — there
  is no parameter through which a fabricated number could reach the budget, which is the entire
  reason secret-gating a financial write is defensible here.

## The Expenses tab compares against EXPECTED-TO-DATE, and the budget line sits at 80%

Redesigned v2.556/v2.557 (`design_handoff_expenses_variance_table`). The old tab compared
month-to-date spend against a **full-month** budget, so on 30 August it read "102% of budget" —
which sounds mild — while the company was well ahead of where day 30 should be. Same data, opposite
impression. Expected-to-date is the primary comparison now.

**Every bar puts the full-period budget at 80% of its track, not 100%**, so overspend can visibly
CROSS the line instead of saturating at it. The hero bar and every row bar share that geometry;
change one and change the other.

- **One pace fraction, read once** from `getPacingPct()`, divides every "expected to date" on the
  screen. Two roundings of the same number is two answers in one view.
- **A category with no budget renders `—`, never 0**, and is counted in NEITHER the off-pace nor
  the under tally. Rendering 0 makes every unbudgeted dollar read as overspend. It also sorts
  **last** rather than as zero, which would bury real overspend beneath it.
- **`fmtSigned`, not `fmtK`**, for anything signed — `fmtK` puts the `$` before the sign and renders
  `$-27,200`.
- **Category exclusion moved into the expanded panel.** The row click expands now; two meanings on
  one click was not an option.
- Desktop and phone are two renderings picked by **`matchMedia`**, not one markup with CSS hiding
  the other — two `#expChart` canvases in the DOM and Chart.js binds the hidden one. The phone keeps
  the old `.kpi-grid`/`.srow` layout deliberately.

**`?action=expense_breakdown&start=…&end=…` — what is BEHIND a category.** The accounts under it and
the per-store (QB class) split, both from ONE report: the P&L summarized by **`Classes`** (the QB
enum is `Classes`, not `Class`). One report is the point — a breakdown fetched separately from the
total it sits under is a breakdown that can disagree with it, on a panel nobody reconciles by hand.

- **`qbBreakdownWalk_` copies `walkQBRows_`'s map semantics exactly.** A matched section summary IS
  the category's total and its children are listed but **never re-summed**. The first version missed
  that guard (`walkQBRows_` spells it `if (result)`) and double-counted a mapped section inside a
  mapped section: $566,667 of August came out as $692,056. **It did not fire in production** — the
  live custom mapping happens to nest nothing, so every live probe tied out perfectly — and it was
  caught only by running the walk against the real report with the HARDCODED map. The mapping UI
  lets any section be mapped, so it was one custom override from silently doubling a category.
  `tests/expense_breakdown_test.js` pins it.
- **`residual` is reported, never absorbed.** A QB section can carry money its child accounts do not
  explain — ~$47k across Payroll, Software and Taxes in 2025. Folding it into the last account is a
  wrong number wearing a real account's name.
- **CORPORATE is a class like any other and must keep its row.** It is not a store, but it carried
  $297,833 of August COGS and all $73,200 of Management. The store bars scale to the largest
  **STORE**, not the largest row, or all six collapse to a few pixels; Corporate's bar clamps.
- **`?action=expbreakprobe&start=…&end=…&secret=…`** diffs the breakdown against the by=Month figures
  the tab already renders, in the live runtime. Measured: Aug $566,667.32 · March $634,816.64 · YTD
  $4,937,907.44 · 2025 $7,492,302.07, zero delta each. Re-run it after any GXCore re-pin.
- The expand's payload is **tagged with the range it was fetched for**, so a period change shows
  loading rather than the previous range's split, and a failure renders once instead of re-fetching
  forever. Same rule `reconData` follows.

## The budget planner never writes a closed month

**`applyBudget_` used to write all twelve.** A quarterly re-cut in September rewrote January — and
every variance the Expenses tab had already shown for January was measured against the budget that
stood then. No error, no warning, nothing looks different; the tab just starts drawing a different
line. The window now comes from **`sbOpenMonths_`**, and a closed month **KEEPS** what it already
had (the overlay's figure if applied before, else the frozen one).

- **The month IN PROGRESS is closed**, same reason `sbHistoryWindow_` excludes it: a partial month
  cannot be budgeted.
- **The window is decided SERVER-side** and the client's months are filtered against it. A stale tab
  left open into a new month must not reach a closed month by sending it.
- **The overlay row stays a full twelve months.** `getExpenseBudgets` replaces the WHOLE category row
  with it, so a partial row would blank every month it omitted — the read-merge-write hazard again.
- **A $0 proposal is APPLIED, not skipped.** Skipping it is how a stale figure survives: the old
  number stays because nothing overwrote it.
- **Typing an annual below the closed-month floor cannot lower the year.** Correct, and it used to be
  silent, which reads as a broken input — the row flags `at floor` and the caption names the figure.
- `tests/budget_apply_window_test.js` (29 assertions) executes the shipped `applyBudget_`.

**`bills_once` is a SERVER-side flag because its consumer is the EXPENSES tab.** Rent, insurance,
licenses and management bill at a point in the period, so pacing them against a day-30 fraction calls
them "over" by construction every month — Rent read +$2,608 over on 30 August where the honest figure
is +$1,324. A flag kept only in the planner would leave that wrong on the screen people read. It
rides along on `expbudgets` (and through that cache) so the tab needs no second call.

`budget_proposal` also returns `open_months`, `bills_once`, `current`, `overlay` and a `prior_year`
per proposal, so the planner never re-derives the server's date rules and promise an Apply the write
would refuse. `budgetprobe` reports all of it.

**`#dsk-subnav` is hidden on the planner** — a budget is annual and company-wide, and the period bar
otherwise renders as a second header above the planner's own. Derived from state in ONE place
(`syncSubnavVisibility`): toggling it on the way in means every exit must undo it, and the top-nav
exit did not, which left the period bar hidden on every other tab. The rule needs
`#dsk-subnav.dsk-subnav-off` — the desktop query's `.gx-subnav.dsk-chrome{display:flex!important}`
out-specifies a lone class even with `!important` on both.

## `defer` is a bug in this app, and the boot block must survive its own decorations

**Fixed v2.559 (2026-09-02) — reported three times before anyone caught it.** The dashboard hung on
"Connecting…" on every load; pressing **Load live data** in Settings fixed it every time.

`gx-client.js` carried `defer`. A deferred script runs only after the whole document is parsed —
but **this app is a monolith with INLINE js**, so all of its own startup code runs *during*
parsing, ahead of the deferred file. `paintSalesUserTray()` builds the avatar-editor config with an
eager `GXClient(GXCORE)` call; that threw `ReferenceError`, and because the boot block was a bare
sequence with `paintSalesUserTray()` ahead of `loadAllStores()`, the throw took the rest of the
block with it. The load never started. The Settings button worked because it calls the one
statement the throw had skipped.

- **Never put `defer` (or `async`) on a shared script this app's inline code calls.** The rule that
  makes gx-theme's async loading safe elsewhere is exactly wrong here, and the failure is silent:
  one console error, no UI, and an app that looks merely slow.
- **The boot block starts the data load FIRST and wraps every decoration in its own try/catch.**
  Ordering alone would have fixed that one throw; the guards are what stop the *next* decoration
  doing the same thing. Painting a name chip is not worth a blank dashboard — the same rule
  `loadAllStores()` already followed internally, applied one level up where it was missing.
- **It only ever bit a RETURNING session,** which is why it read as intermittent. A fresh login
  happens seconds later, by which point the deferred script has long since run. Anyone with a
  stored token — i.e. Sky, always — hit it every single load.
- **`avatarEdit` now tests for `GXClient` before building one.** A gx-theme outage should cost the
  avatar row, not the app.
- Dropping `defer` also removed the reason the **maintenance gate** needed gx-theme's 6-second poll
  here; `GXMaintenance.init()` runs after the tag now, so the GX Core kv lever is reachable on the
  first try. `tests/maintenance_wiring_test.js` asserted the *defer* as a fact about this app and
  had to invert — it now pins the fix. Don't "restore" it.
- `tests/boot_sequence_test.js` (15 assertions) pins all three guards against the shipped
  `index.html`. **Verified to fail against the pre-fix source** (10 of 15).

## The 60-second poll rebuilt the whole page — one line, one level down from the v2.560 fix

Sky, 2026-09-06: *"can we make the 60s refresh feel less jumpy on mobile too?"*

`refreshLiveData` goes to real trouble NOT to blank `liveData` — that is the v2.560 fix, and its
comment is the longest in the file — and then called **`_invalidateDerivedCaches()`, which set
`_incomeMounted = false`.** That forces `renderIncome` down its full-mount path: `#main-content`
replaced wholesale, both chart canvases destroyed and redrawn, and `animateStorePacingBars(true)`
re-running, which collapses all six bars to 0% and grows them back 120ms apart. Correct numbers,
quiet data path, and the reader still watched the page rebuild itself every minute.

**It is the same shape as the bug it was hiding behind.** v2.560 moved the wipe out of one call
site; this defeated it from another. A guard is only as good as the paths that reach it.

**Measured in a real browser, identical simulated polls on both builds:** v2.572 did **1 full mount
per poll**, and the store-breakdown container, the chart canvas and `#main-content`'s first child
were all **different nodes** afterwards. v2.573 does **0**, and all three survive.

- **The remount belongs with the BLANKING, not with the cache reset.** It is right when there is
  genuinely nothing left to patch and wrong whenever numbers are merely being refreshed, so it now
  lives in `clearLiveData()` — which `clearAllCache`, `clearDutchieCache` and `hardReset` go
  through and which the poll deliberately does not.
- **`_invalidateDerivedCaches` still has to do its real job.** Dropping the `liveDateMaps` and
  day-of-week weight resets would make a poll render new sales through stale derived numbers.

Two smaller things moved with it, same complaint:

- **The row order re-sorted mid-poll.** `pending` means no data AT ALL, and a re-poll has none —
  `liveData` is kept — so every row looked landed while only some carried this minute's figure, and
  the list re-sorted on each of the six progressive renders against a mix of new and one-minute-old
  numbers. **`_bdHoldOrder`** holds the order for the whole load and is released immediately before
  the final render, so the list settles ONCE, on complete data. A cold start does not set it: there
  is no order to preserve and sorting as stores land is the documented behavior there. Released in
  `finally` as well — a hold that survives a failed load freezes the list until the next good one.
- **The end-of-load `scrollTo` was unconditional.** A load takes seconds; scroll down during one
  and you were yanked back to where you started — mid-flick, on a phone, the most jarring thing the
  poll did. It now fires only if the page moved on its own AND the reader did not move it, keyed on
  **input events (`touchmove`/`wheel`/`keydown`), never on `scroll`** — which fires for programmatic
  movement too and would mark every restore as a user scroll.

`tests/poll_quiet_test.js` — 29 assertions, executes `_invalidateDerivedCaches`, `clearLiveData` and
`_bdApplyOrder`, verified to fail against the pre-fix `index.html`.

*One measurement note, so nobody repeats it: `requestAnimationFrame` does not run in a hidden tab,
and the browser pane counts as hidden. Attempts to observe the bar re-animation and the chart redraw
that way returned zeros on BOTH builds and proved nothing. The mount count is synchronous and is
what actually discriminates.*

## The landing view is TODAY, and it is today from the first frame (fixed v2.572, 2026-09-06)

Sky, 2026-09-06: *"why does it load the month first then switch over to the current day once things
have been loaded? this is visually confusing."*

It booted on the month, loaded the month, rendered the month, and then — at the very END of
`loadAllStores`, after every store had answered — set `activeDay`, rebuilt the period bar and
re-rendered. So the reward for waiting out the load was the number you had been reading being
replaced by a much smaller one, with the period label, the goal, the pace line and the chart all
changing under it. **Neither figure was wrong.** They answer different questions, and the app asked
the second one only after showing the answer to the first.

- **`selectDefaultPeriod_()` is called in the top-level init block, before `buildTimeNav()` and
  before the boot block's `loadAllStores()`.** The selection is a startup decision, not a
  correction applied to a finished load.
- **Nothing about the fetching changed, and the test pins that.** Sales are pulled a whole month at
  a time either way — `fetchMonthData` keys on year+month and `_liveDataKey` with it — so the day
  is a slice of what was already on its way. Only the moment of CHOOSING moved.
- **Only the current month.** A deep link or a restored view into any other period keeps what it
  asked for; auto-selecting a day inside a month the reader picked deliberately is the same
  confusion pointing the other way.
- **Do not seed `activeDay`/`activeWeek` on their `let` lines.** Those run during parsing, ahead of
  the date helpers, and a period fixed there cannot be re-picked or skipped for a deep link.
- **What stayed in the end-of-load block is the pair of day-scoped loads the month path does not
  make** (`loadPeriodGoals(activeDay)`, `loadPaceFracs()`). Both re-render, so they belong after
  the stores have landed. The `refreshCompare()` that block used to redo is gone — it was only
  there because the block moved the period.
- `tests/landing_period_test.js` — 20 assertions, EXECUTES `selectDefaultPeriod_` both ways,
  verified to fail against the pre-fix `index.html`.

## "No data available" was never a verdict — it meant "not asked yet" (fixed v2.571, 2026-09-06)

Sky, 2026-09-06: *"on mobile i just get a spinning connected for awhile, then no data avaialbe,
then it eventually loads."* All three phases were one screen doing the wrong thing, and the
middle one is the bug.

`loadAllStores` paints progressively — `render()` runs after EVERY store settles, **including the
first one to fail**, because that call sits after the per-store `catch`. `render()` then found
`liveData` empty and replaced the entire dashboard with the flat text `No data loaded yet.`
**Measured on the live deployment**: that text appeared **1.3s** into a cold load and held for
**8.7 seconds** before the first store's numbers arrived. On a phone, where the first answer is
slower, it is most of the load.

- **It reads as an answer and it is a question.** The same string is correct when nothing is
  running — that is what it was written for — and wrong the moment a load is in flight. `render()`
  now gates it on **`salesPending()`** (`_loadAllStoresInFlight` AND no store landed).
- **The replacement is the app's own rule, not a new one.** Shimmer means "we have nothing YET"
  and belongs to the FIRST load — the same sentence `_liveDataKey` and the goal shimmer are built
  on. The income view mounts for real with skeletons, so the numbers **patch into it** (same card
  ids) rather than replacing a block of text under the reader.
- **A `$0` hero is not the cheaper fix.** `net` is 0 for want of asking, and a confident figure
  next to a live dot is worse than a shimmer. `dataWait` and `goalWait` are deliberately two
  flags: `goalWait` means the sales figure is final and only the goal is in flight, so the
  headline paints. Collapsing them is how the $0 gets shown as a measurement.
- `tests/first_load_state_test.js` — 45 assertions, EXECUTES the shipped source, verified to fail
  against the pre-fix `index.html`.

### Three more faults found by measuring the same load

**"Clear cache" signed you out.** `gc_sales_token` — the session — shares the `gc_sales_` prefix
with the cached sales months, and `clearDutchieCache` / `clearAllCache` swept the prefix raw. The
next request came back `Auth required`, one store's failure called `salesLogout()`, and the login
card appeared over a dashboard that had been working a second earlier. **`evictHistoricalSalesCache`
already excluded the key by name** — it runs on every load, so the app would have logged itself out
constantly otherwise — but the guard never reached the two functions whose whole job is deleting
things. Everything now goes through `isSalesCacheKey_`; a raw `startsWith('gc_sales_')` anywhere is
the bug coming back.

**`backfillDailyHistory` fired 48 requests at once, with a bare `fetch()`.** Measured: 8 months x 6
stores landing in one burst the instant the dashboard became usable, on top of the 15 the boot
already fires — **69 Apps Script calls per page load**. Apps Script caps SIMULTANEOUS EXECUTIONS PER
USER at 30, so the extras were queued or refused into a silent `catch {}`, stealing throughput from
the 60-second poll that keeps the visible numbers fresh. And a bare fetch has **no timeout** — the
same defect `fetchMonthData` was fixed for on v2.560. Now a pool of **4** through `gasFetchJson`:
deliberately well under the cap, not at it, because this work is invisible (it feeds the
day-of-week chart) and should lose every race against the load the reader is waiting on.

**`expbudgets` and `expenses` were paid by every load and read by the Expenses tab only.** The
comment above them said exactly that while they were being fired on boot. Measured: `expbudgets`
was the **slowest call in the boot wave at 8.8s**, against 4.9–10.8s for the six store fetches it
was competing with. Fire-and-forget makes a call invisible, not weightless. Both load on first
entry to that tab now (`ensureExpBudgets`, guarded by **tried, not loading** — a failed fetch
leaves `expBudgets` null and re-renders the tab, so a liveness check alone re-fires forever).
**`otherRevenue` stays on boot**: the Income hero folds ATM and sublet into net sales, so it is
this tab's own data.

**What was NOT the cause, so nobody re-measures it:** the six store fetches themselves are the
floor (4.9–10.8s each, in parallel, wall clock ~11s to the last one) and no client change moves
them; the server-side 90s intraday cache is working; and River was unremarkable in this load.

## The all-weekdays chart's year is KEPT between visits (v2.590, 2026-09-13)

Sky, 2026-09-13: *"performance has degraded. why isn't 'all sunday's' cached?"* It was not. v2.586
cut the backfill to one whole-year request per store and dropped its only localStorage write, so
every visit re-fetched every store's year — and only after the slowest live store answered.

- **Kept per store/year as the day rows exactly as they arrived** (`gc_sales_v2_hist_<store>_<year>_all`),
  never re-summed into a month payload. Year second-to-last so the prior-year eviction retires it.
- **Two ages, deliberately different.** Under **1h** (`SALES_TTL_HIST`) it is trusted and the
  backfill asks for nothing. Under **72h** (`SALES_HIST_PAINT_MAX`) it is painted at boot
  (`hydrateSalesHistory_`) AND re-asked. Older is not painted — days-stale rows feed Reconcile's
  expected totals.
- **Once painted, "the month is in `allDailyData`" no longer means "current".** Months a kept entry
  covers are re-asked regardless of memory; that is the half a simplification would break.
- Measured in the browser: warm reload, all 243 days per store in memory ~2s in, **zero** year
  requests; with the entry aged 2h, painted immediately and all six rewritten 4s later.
  `tests/backfill_request_count_test.js` cases 14-21, each verified by mutation.

**Reconcile's deposit load goes through `gasFetchJson(url, 3, 75000)`** — it was a bare fetch, and
one /exec bounce put Safari's *"The string did not match the expected pattern"* on the card. 75s
because the route crosses to GX Core with its own 60s budget (measured 21s / 35s / >60s the same
night, against 1.5s of Core-side work). The phone had no bug trigger outside Income; `#mob-bug-foot`
now sits under every other tab. `tests/recon_load_resilience_test.js`.

## A store's dot BLINKS while its figure is not current (v2.591, 2026-09-13)

Sky: *"have the bullet next to the store name blink if it's loading so I can tell if what I'm
looking at is loaded/current or not."* A re-poll keeps each row's last figure on screen while it
re-asks, so "being refreshed" and "just refreshed" looked identical. `storeNotCurrent_` is the one
definition: state `loading` or `err`, or in `_todayPending` **while the view includes today** (the
set is not cleared by loads that never reach today, so an August view would blink for a September
miss). Mobile and desktop rows share it.

- **`syncBdStale_` runs from `buildStatusGrid`**, because a load STARTS with that call and no render —
  without it a poll blinks nothing until its first store lands.
- **The blink keeps its phase across rebuilds** (negative `animation-delay` off `performance.now()`):
  `patchEl` replaces the rows on every store landing, which otherwise restarts the animation and
  reads as a stutter. Reduced motion gets a dimmed dot, not no signal.
- Measured on the live backend: a poll set all six blinking at 0s and cleared each as it landed
  (five by 2.9s, Hillsboro at 17.8s). `tests/store_dot_blink_test.js`, verified by mutation.

### …and the HERO says whether the total is whole (v2.600, 2026-09-16)

Sky, 2026-09-16: *"Oh man it's slow again."* Asked which of the four shapes this file documents:
**most stores land, one or two lag, on a phone.** He could not say which stores — and the app is
the reason, not his memory.

**`pill()` writes to `#dsk-live-txt` and nothing else.** So `6/6 stores · today pending: River` —
the one line that says the figure above it is understated — existed on the DESKTOP and **nowhere on
mobile**, which is the device every 60+sec report in this file has come from. The mobile hero's
live dot is `background:var(--green)` in the stylesheet and is never touched by JS, so a total short
a store's today sat under a **confident green light**.

**Nothing was wrong with the numbers, and nothing was slow that v2.592/v2.597 had not already
addressed.** The phase split paints the settled month and marks the store today-pending exactly as
designed; the per-store blink above does run on mobile. What was missing is the COMPANY-level
statement. *Which row is stale* and *is the total whole* are two different questions, and the hero
figure only ever answered the first. The River shape one level up, and the Inventory tile's green 0
again: a per-store failure degrading into a smaller number instead of a message.

- **`_heroLiveHtml_` reads the same two facts as `storeNotCurrent_`** (`_storeStateMap`,
  `_todayPending`) behind the same `viewIncludesToday_()` guard — an August view cannot report a
  September miss. Two definitions of "not current" would drift within a release.
- **Amber names the store while one name fits, counts once it does not.** `err` is the stronger
  statement and outranks today-pending: red with `5/6 stores`, one message rather than two.
- **A load in flight reports NOTHING.** Every store is `loading` on a cold boot and the hero already
  shimmers; an amber "short" light over a shimmer answers a question nobody has asked — the same
  error as the `$0` hero.
- **Built once, used by all three hero branches.** The three `ic-hero-top` blocks were hand-copied,
  so the test asserts the **absence of the copied block**, not the presence of a call.
- `tests/hero_live_state_test.js` — 26 assertions, executes the shipped builder; all seven guards
  mutation-verified, each target asserted present first so no mutation was vacuous.

### …and whether it has finished ADDING THEM UP (2026-09-17)

Sky compared Sales' net sales against Leaderboard's and they disagreed. **Both backends were
right** — Sales showed River $855, Leaderboard's `storetoday` returned $854.81. What he read was
the headline MID-ASSEMBLY: `loadAllStores` paints after every store settles, so until the last one
lands the hero is the sum of however many have arrived. *"They eventually updated correctly after a
few minutes."* The v2.605 concurrency cap widened that window — capping the wave at 8 lands the last
stores later than 19 did — which made a pre-existing silence visible rather than creating it.

The rows already said it (`storeNotCurrent_` blinks their dots) and the hero already said it for a
FAILED store and for a missing TODAY. The one case with no signal was the one in front of him: a
store not added in **yet**.

- **It is not net sales, it is every figure in the hero.** `getPeriodTotals` skips a store it has no
  entry for, so net, gross, transactions and discounts all understate together, AOV is derived from
  two of them and COGS sums the same way. So the statement is made ONCE where the hero is assembled
  (`_heroLiveHtml_`, the same line and the same amber the today-pending case uses) and is not bolted
  onto one number.
- **`storeNotCurrent_` is reused but NOT verbatim, and the difference is the whole design.** That
  predicate is the one definition of *this STORE's figure is not current*, and it is right for the
  dot. *Is this TOTAL whole* is a different question: a re-poll deliberately keeps `liveData` and
  re-asks, so all six stores are `loading` while the total on screen still contains all six.
  Reusing the predicate as-is would brand every 60-second refresh incomplete when nothing is
  missing from it. A store is missing from the TOTAL when it has no `liveData` entry — exactly what
  `getPeriodTotals` skips — so the fact is composed out of what already exists rather than
  redefined. **Cold load and period change report; the poll does not.** That is also the answer to
  "does it cover the boot case as well as the re-poll case": it covers the boot case, which is the
  one Sky hit, and deliberately not the other.
- **A COUNT, `4/6 stores so far`**, in the same vocabulary the red branch already uses for the worse
  case; "so far" is what separates a transient from that branch's verdict. **No time threshold, and
  that is a decision, not an omission**: a threshold needs a repaint timer, because nothing
  re-renders between two stores landing — so its failure mode is staying silent through exactly the
  long stall it was added for. The STATE is the threshold, since it exists only while the sum is
  genuinely short.
- **Counted against `getActiveStores()`**, not all six: a filtered headline sums the stores it
  shows, and `4/6` under a one-store filter describes a number nobody is looking at. *Finding, not
  fixed here: the v2.600 `err` and today-pending branches still count against all six `STORES`, so a
  filtered view can be told about a store it is not showing. Left alone deliberately — it is a
  48-hour-old guard and changing it is not this fix.*
- **Nothing is claimed while the hero SHIMMERS** — gated on `salesPending()`, the flag that decides
  it. The statement qualifies a NUMBER; where there is no number the shimmer is the whole message,
  and an amber "short" light beside it answers a question nobody has asked (the `$0` hero error
  again). **The first version got this wrong and the BROWSER caught it, not a test**: a liveData-only
  guard cannot see `salesPending`'s second clause — a today view whose landed stores are all
  today-pending — and the marker read `1/6 stores so far` over a shimmer at t+2.4s of a cold load.
  §4c of the test is that fixture.
- **The number is never hidden or blanked.** A missing headline is worse than a labeled partial one.
- **Measured in headless Chrome against the live backend, cold cache, 390pt viewport.** Shimmer and
  no claim at 2.4s; `1/6 stores so far` in amber the moment a figure appeared at 3.6s, climbing
  through `5/6` as $1,287 → $3,373; handed off to v2.600's `River pending` at 7.2s; **green with no
  note at 12.1s on $4,263**. At **t+72s the 60-second poll set all twelve dots blinking again and
  the hero stayed green on an unchanged total** — the re-poll case, live. A second run hit a real
  bad-`/exec` load and escalated `3/6 so far` (amber) → `3/6 stores` (red) as three stores timed
  out, which is the precedence rule holding under the failure it was written for. The mobile and
  desktop hero blocks were compared on every sample and were identical every time.
- `tests/hero_partial_total_test.js` — 34 assertions, EXECUTES the shipped `_heroLiveHtml_`,
  `getActiveStores` and `getPeriodTotals`. **Measured against `HEAD:index.html`: 27 pass, 7 fail**,
  and the sections that pass there are named in the file, because a test where everything fails
  proves nothing about the guards it had to leave standing. Eight mutations, counts measured.
  `hero_live_state_test.js`'s fixture gained two bindings (the builder reads two more facts) with
  every assertion unchanged at 26; three of its own mutation-log entries were re-run to prove it
  still bites.

**The durable lesson is about DIAGNOSIS, not the dot.** Three "it's slow" reports in five days
resolved to three different causes, and each cost a round trip to Sky to tell apart. The phone —
the only device any of them came from — could not say which stores were short. **An app that cannot
tell you what is wrong with it turns every report into a guess**, and this file's whole method is
the opposite of guessing.

## Phones don't poll; opening the app reads a server snapshot (v2.609, 2026-09-17)

Sky: *"pull the sales numbers when there's no load, store that into cache, then when i open the sales
app it shows me the latest details, which might be a few minutes old... remove the polling on mobile
and replace it with the option to refresh, either with a pull down haptic or by clicking the top
right status indicator."*

- **Server: `bgRefreshTodayTick` runs every 5 min during store hours (08:00–22:15 PT)** and re-pulls
  any store whose today entry is older than 240s — all due stores in ONE `UrlFetchApp.fetchAll`, one
  attempt, no retry loop. Parallel on purpose: trigger runtime is a daily quota shared by every GX
  script on sky@, and six sequential pulls every 5 minutes could spend hours of it.
  **Install / inspect / switch off:** `?action=bgrefresh&op=install|status|remove|run&secret=…`
  (`run&force=1` ignores store hours). `status` reports trigger count, last run and each store's
  entry age.
- **One cache entry, two thresholds.** `dtoday_v2_<store>_<day>` carries `as_of` (pull start) and is
  kept 20 min. A caller's `maxage` decides what it accepts: default **90s** (poll, Refresh — the old
  contract), up to **600s** for an open. Clamped at 600 server-side (`DTODAY_SNAPSHOT_S_`), and the
  client's `LIVE_SNAPSHOT_MAXAGE_S` must match — `tests/manual_refresh_test.js` compares them.
- **A viewer joining an in-flight pull only accepts an answer NEWER than the one it rejected.**
  Entries now outlive a pull, so "any cache hit" during the wait would hand back the stale figure.
  The marker holds the pull's start time, which is the `as_of` its answer carries.
- **Client: a load is "fresh" only when a person or the desktop poll asked.** `refreshLiveData()` with
  no args (or an Event) is fresh; `{fresh:false}` is an open. Boot and period navigation are opens.
  The flag is read and cleared once at the top of `loadAllStores`.
- **Phones: the 60s tick survives for RECOVERY ONLY** — same predicate and cap as the overnight
  pause (`quietRecoveryNeeded_`, `QUIET_RECOVERY_MAX_`). Without it, "only Center loaded" would sit
  until he pulled. Returning to the app after 2+ minutes re-reads the snapshot (`RESUME_RELOAD_MS_`).
- **Ways to ask:** the hero's status (top right) is a `<button>` → `manualRefresh_()`; pull-to-refresh
  from the top of the page past 70px. Never `preventDefault` — the native rubber-band stays. A
  sideways drag, a start inside a scrolled box, or a page not at the top cancels it.
- **Haptic on iOS is a hack, and best-effort:** Safari has no `navigator.vibrate`, so `haptic_()`
  clicks a hidden `<input type=checkbox switch>` label (iOS 18+). If it stops buzzing after an iOS
  update, the refresh still works — do not "fix" it by gating the refresh on it.
- **The hero clock is when the data was PULLED** (`liveAsOf_`, oldest store), not when it rendered.
  It used to print "now", which would claim a 9-minute-old snapshot was current.
- Tests: `bg_refresh_test.js` (36, executes the shipped trigger then serves its output through the
  real `dutchieTodayFetch_`), `intraday_cache_test.js` (45), `manual_refresh_test.js`,
  `quiet_recovery_test.js` §6b. Mutation-verified: the stale-answer guard, the marker cleanup, the
  maxage condition.

## Today's hop is slow some evenings — never abandon it and pull again (v2.592, 2026-09-13)

Sky, on v2.591: *"it took 60+ seconds to load on mobile."* Measured minutes later with `loadprobe`:
settled halves 19-101ms, live halves **11.7-23.6s in one `dutchie_get` hop** (Portland Rd 50s),
against 2.7-4.2s on 09-04, with GX Core itself idle (~120 calls that hour). The hop is not ours to
shorten. What was ours: the browser gave a live half **15s**, Apps Script ran the abandoned request
to completion anyway, and the retry started a **second** identical pull that was abandoned too —
store falls to the next 60s poll.

- **Live half: `gasFetchJson(url, 2, 28000)`**; settled keeps 15s. 2 x 28s stays inside the 60s
  poll, which `background_refresh_test` pins, because the in-flight guard blocks the recovering poll.
- **The proxy joins a pull already running** (`dtodayAwaitFlight_`, up to 25s, advisory marker with
  a 60s TTL). A marker that vanishes without an answer means that pull failed — pull at once.
  `nocache` skips the wait. `tests/intraday_cache_test.js`.
- **The month paints when its settled half lands** (`onSettled`), today-pending, so the dot blinks
  and a today view shimmers the row. **Only for a store with nothing on screen** — on a re-poll it
  would drop today out of every total for the length of the hop. Never for an old backend that
  ignored `phase`. `tests/phase_split_test.js` 3c.
- **Not done, deliberately:** painting last visit's today figure while the hop runs. It is a
  different number replacing itself, which is the one thing the phone's first load must not do.

Browser, cold, live backend (proxy change not yet deployed): fast stores' today at ~7s; three hit
28s and their retries answered in ~6s; last store 36s — where v2.591 would have fallen to the poll.

## THE STALLS ARE NOT INDEPENDENT — the endpoint goes away, and takes everything in flight (2026-09-17)

**The first clean six-wide `libversion` run, and it breaks the model every number below is built
on.** 240 requests, 40 rounds of six, 2026-09-17 ~15:30 PT, via `tools/exec_stall_probe.py` — the
run this file has been asking for since the instrument was checked in.

```
requests 240 · median 1.7s · p95 2.6s · worst 27.0s · STALLS >=10s  6 = 2.5% · one 404
round 12  slowest 27.0s  !!!!!!   <- STALL      ← and every other round was clean
```

**All six stalls were in ONE round. All six requests of that round.** Under the independent
per-request model — the one behind "a boot fires sixteen, so a load carries a stall ~43% of the
time" — the probability of that is **1.6 × 10⁻¹⁰**. Independence is not a simplification here, it is
refuted. Six stalls spread over six rounds and six stalls landing on one are the same rate and
completely different failures.

**What it actually looks like: the endpoint stops answering for ~27 seconds and everything in
flight dies together.** That is an OUTAGE WINDOW, not a dropped request. The consequences invert
several things this file says:

- **`1-(1-p)^16` is the wrong arithmetic**, and the probe prints it — *"a 16-request load carries a
  stall ~33% of the time"*. If stalls are windows, a load does not roll sixteen dice: it either
  misses the window entirely and is perfectly clean, or it opens inside one and loses **every
  request it has in the air**. That is much better most of the time and much worse occasionally,
  which is exactly the reported experience — *"it's fine"* for days, then *"it took 4 minutes"*.
- **It explains the 40% morning** (the section further down) without needing a raised per-request
  rate at all. A morning of frequent windows reads as a high rate when you average over it, and the
  whole distribution shifting minute to minute — which that section measured and found puzzling —
  is what windows look like through an averaging instrument.
- **It weakens the 12-30 concurrency reading further.** Six-wide, one window took all six. Thirty
  requests spanning a window would lose a chunk together and look exactly like concurrency-dependent
  degradation. Nobody has a run that separates those.
- **Retries are the right lever and the ceiling matters more than it looked.** Against a 27s window,
  a first attempt at 12s fails, and the second's 25s ceiling only clears it if the retry starts late
  enough. Against an independent 2.5% drop, attempt two almost always succeeds. **Do not re-tune on
  this one run** — that is the v2.592 mistake, which this file has now recorded twice.

**This does NOT replace the 3.4%, and comparing them directly is the trap the tool header warns
about.** That baseline was 174 authenticated store-month pulls carrying 2.5-3.5s of our own backend
in every timing; this is `libversion` and nothing else, which is why the median moved 3.1s → 1.7s.
**Same endpoint, different question.** 2.5% of 240 six-wide is the first number that measures the
HOP, and its honest form is *"one ~27s window in 3.5 minutes"*, not a percentage.

**What would settle it: several runs at different hours, and the per-request `(start, duration)`
pairs kept** so a window can be seen rather than inferred from a round. The probe currently sorts
before reporting — the same flaw this file already records about the 09-15 numbers, still unfixed,
and the reason a single `!!!!!!` row is doing all the work above. **One run, one window; the shape
is strong evidence and the rate is not a baseline.**

## …and twenty-one OTHER calls had no ceiling at all (v2.608, 2026-09-17)

The ladder below was built for the twelve store halves and given to nothing else. **Twenty-one of
this app's twenty-three `fetch` call sites were bare** — expenses, expense budgets, other revenue,
revenue detail, the expense breakdown, P&L, inventory, every reconcile write, the whole smart-budget
planner, the leaderboard-goal fallback, and the ten-minute session heartbeat. **A browser `fetch`
has no timeout.** Against a hop that stalls ~3.4% of the time six-wide, a bare one does not fail —
it never returns. The `catch` never runs, the card never fills, the spinner spins until the tab is
closed. The River shape, twenty-one more times.

`tests/aux_hang_bounds_test.js` already had the *reason* exactly right — a hung promise is not a
rejected one, so `finally` never runs and `_paceFracsInFlight` latches for the life of the tab. It
pinned the four calls inside `auxDataPromise` and `loadPaceFracs`. **What it could not do is stop
the twenty-second bare fetch being added**, because it names call sites. The new file pins the
PROPERTY.

- **Reads get `AUX_READ_CAPS_`, which IS `LIVE_PHASE_CAPS_`** — `[12000, 25000]`, the same numbers,
  because it is the same hop and the same endpoint, and a read costs nothing to re-ask. The test
  asserts the two are equal rather than re-typing the numbers, so a re-tune of one cannot silently
  leave the other behind.
- **Writes get `WRITE_CAPS_` = `[25000]` — ONE attempt, and this is the whole design.** An abandoned
  request *keeps running to completion on Apps Script*; that is exactly why attempt two of a store
  half is a cheap cache read rather than a second pull. The same fact makes a retried WRITE a second
  write, because the client cannot tell a timeout from a success. So a write is bounded and then
  REPORTED, never re-sent. `reconPost` is the one that mattered most — every reconcile write funnels
  through it, and a re-sent `set_recon_*` is a second write of a figure somebody is reconciling
  against.
- **Two call sites were already inside `gasGate_`** (`loadPeriodGoals`, `loadOtherRevenue`) and could
  not simply have their `fetch` swapped: **`gasFetchJson` takes a pool lane per ATTEMPT**, so the
  gate would have held one lane while queueing for a second. With eight lanes, the holders are the
  waiters. Both now pass their priority INTO `gasFetchJson` and the gate is gone. `gasGate_` remains
  correct for its one real user — `cogs_dutchie`, which arms its own ceiling inside the lane.
- **The login prewarm is the one deliberate exception.** It stays a raw `fetch` with its own 15s
  abort: taking a lane would put a request nobody waits for in front of the sign-in behind it, and
  `gasFetchJson` parses a body that call throws away. Bounded, but outside the pool, and the test
  knows about it by name.
- **Reconcile's deposit load keeps its own 75s budget** — it crosses to GX Core, which has a 60s
  budget underneath it. Not covered by either constant.

`tests/bounded_fetch_test.js` — **13 assertions, three guards, each verified by mutation:** against
`main` it names all twenty-one bare sites by line; a `gasFetchJson` re-nested inside a `gasGate_`
fails §4 naming the line; `WRITE_CAPS_` given a second element fails §2. §3 EXECUTES the shipped
`gasFetchJson` and counts requests on the wire — one for a one-element ladder, two for a
two-element one, so the no-retry guarantee is a measured count and not a comment.

*Two bugs in the checker itself, both of which made it pass wrongly and are worth keeping.* It first
reported a bare fetch at a `console.warn` whose TEXT contains "Leaderboard fetch (GX Core…" — a
checker that cannot tell code from prose reports the wrong line and would accept a real bare fetch
hidden the same way. The fix after that was worse: whole-file quote-pairing blanked enormous regions
because one apostrophe in HTML prose pairs with a quote thousands of lines away, taking the fetch
count from 4 to 1 and the `gasGate_` count to 0 — **both checks quietly passing themselves into
uselessness.** It is line-local now. And the first run printed its summary before its async section
had finished, reporting "7 passed, 2 failed" above four later PASSes.

*One more correction to a number this file has now had wrong twice.* **Twenty-one sites were bare,
not nineteen.** A first grep said 21, the hub's independent count said 19 of 23, and that number was
taken over the measurement — the shipped checker lists all twenty-one by line against `main`, and
only two of the twenty-three (`gasFetchJson` itself and `cogs_dutchie`) ever had a signal. A peer's
count is evidence, not an override.

## ~4% of /exec requests just don't come back — and the ceiling decided what that cost (v2.597)

Sky, 2026-09-15, on v2.596: *"still taking 60+sec to load on mobile."* Same sentence as v2.592,
different cause — v2.592 fixed the slow HOP and left the stall standing.

**MEASURED that day against this app's live `/exec`, 234 requests in four runs between 16:43 and
16:51 PT — and the number that matters is the six-wide one, because six at a time is the shape a
load fires. 174 of the 234 were fired six-wide: median 3.1s, p95 4.1s, and SIX of them (3.4%) took
11 to 60 seconds while the requests beside them answered in three.** The other 60 were a
concurrency sweep at 12, 18 and 30 wide, where six more stalled. It is the `/exec` hop
intermittently failing to come back — two of the six-wide stalls were Google closing the connection
at its own 60s limit — and at six-wide it hits a request at random. **A boot fires about sixteen,
so a load carries one ~43% of the time**, and a load is only as fast as its slowest request.

*Corrected 2026-09-17 from the raw per-request timings, which only this repo holds.* This paragraph
said **"eight of them (3.4%)"** out of 234 and concluded **"not concurrency"**. Both were wrong the
same way — **the 234 pools four different concurrency widths** — and the wrongness hid because
`8/234 = 3.42%` lands on the same printed "3.4%" as the honest `6/174 = 3.45%`. The headline agreed
while the counts did not, which is why three docs could cite it for two days without anyone
noticing. The eight dropped the 30-wide run's four stalls outright. What the raw timings settle:

- **The stall count is a FLOOR, not a count.** The sweep printed only the four slowest durations per
  width. At 6, 12 and 18 wide the fifth value is already under 5s, so those are exact; at 30 wide
  all four printed are ≥13.3s, so that run is **≥4** and the totals are **≥6 of 60** and **≥12 of
  234**. Nobody can say the true number without re-running.
- **"Not concurrency" was never supported — and neither is the opposite.** 6 of 60 at 12-30 wide
  against 2.1 expected looks like something (Poisson p≈0.02), but that test treats the six-wide rate
  as known when it came out of the same run; conditioning on the 12 stalls the experiment actually
  produced gives **p≈0.06**. One run, one evening, unreplicated. **Do not harden it into "10%", and
  do not average the two into "3-10%"** — that range describes neither condition.
- **The sequential control proves nothing.** 25 clean samples against a 3.4% per-request rate expect
  0.85 stalls, so a clean 25 happens **42% of the time by chance**. It is the sample size, not
  evidence of a concurrency threshold. It stays in the file as a sanity check and nothing more.
- **These 234 were not `libversion`.** Every one was an authenticated `store=…&phase=settled`
  store-month pull, carrying 2.5-3.5s of this app's own backend work inside each timing — so the run
  cannot separate Google's hop from Apps Script executing our pull. At 30 wide, three of the four
  stalls cluster at 13.3-14.4s, which is a different SHAPE from six-wide rather than merely a
  different size. Six-wide is bimodal — 11.4, 21.2, 45.4, 60.2, 60.2, 60.2 — with half of them
  sitting exactly at Google's own 60s cutoff, i.e. requests that never came back at all. A tight
  13-14s cluster with nothing at the cutoff is the shape of our own
  backend queueing, not of the hop dropping a request. **`tools/exec_stall_probe.py` fires
  `libversion` precisely to remove that confound, so its baseline and its instrument are not the
  same experiment** — its header now says so, and a fresh six-wide `libversion` run is what would
  replace the 3.4% properly.

  **And there is a mechanism for that reading, which makes it more than a hedge.** Every GX app runs
  its Apps Script as `sky@`, and Google caps **simultaneous executions at 30 per account** — Crew
  measured a peak of 114 simultaneous on 2026-09-15 from the Executions log. So a 30-wide sweep from
  one machine is firing *at the cap on its own*, before any other app's traffic. That turns "Google
  degrades past 12-wide" into **"we queue behind ourselves past 12-wide"**, which is a different
  problem with a different fix, and a suite-wide one rather than ours. (Hub session, 2026-09-17,
  from Crew's measurement — not re-derived here.)
- **Not a double-count.** Every one of the 234 was a raw `urllib.request.urlopen` from the command
  line — no retry ladder, no `gx-client` tombstones — so no timing here is one logical call counted
  twice, and nothing in the data clusters at gx-client's 20s attempt boundary. (Asked and answered
  by the hub session, 2026-09-17: `gx-client.js` bounds both its paths, 20s per attempt, so a long
  row in a browser network panel is an abandoned request still on the wire, not an unbounded wait.)

**The ledger, written down so it is never reconstructed again.** It took reading a session
transcript to recover this, which is the same failure the probe tool was checked in to end — a
conclusion survived and the measurement did not.

| run (PT) | wide | requests | stalled ≥10s | the stalls |
|---|---|---|---|---|
| 16:43 | 6 | 6 | 2 | 60.2, 60.2 (both connection closed by Google) |
| 16:44 | 12 | 12 | 1 | 37.3 |
| 16:45 | 18 | 18 | 1 | 60.5 |
| 16:46 | 30 | 30 | **≥4** | 37.5, 14.4, 14.4, 13.3 (only the top four were printed) |
| 16:49 | 6 | 48 | 2 | 21.2, 45.4 |
| 16:51 | 6 | 120 | 2 | 11.4, 60.2 |
| **all** | mixed | **234** | **≥12** | six-wide subtotal **6 of 174 = 3.4%** |
| 17:43 | 6 | 120 | 0 | — *(the "0 of 120 an hour later" run; NOT part of the 234)* |

This is the same Google-side flake the repo already documents as "~6% of rapid calls 404". The new
part is that it also presents as a **hang**, which is much more expensive, because a 404 fails
immediately and a hang costs whatever ceiling it is given.

**v2.592's 28s x 2 was the ceiling, and it was right for the wrong failure.** 28s was chosen from a
measured Dutchie hop of 11.7-23.6s, and for a slow hop it is correct. For a stall it is 28 seconds
spent discovering that a request died at second one — twice, before a retry that succeeds in three.
57 seconds. That is the 60.

- **The budget is now a LIST of per-attempt ceilings** (`gasFetchJson(url, null, CAPS)`), which sets
  both how many attempts there are and how long each may take, so the count and the ceilings cannot
  drift apart. Live `[12000, 25000]`; settled `[8000, 12000, 16000]`.
- **12s first, from the EVENING hop, not the median.** The same six stores measured 3.1-7.0s at
  midday and ~10.5s at 18:00 the same day. **What makes the exact number unimportant is that being
  wrong is cheap now:** an abandoned request runs to completion on Apps Script anyway and leaves its
  answer in `dutchieTodayFetch_`'s 90s cache, so attempt two is a ~3s cache read rather than a second
  pull. Three seconds too low costs three seconds; eighteen too high cost the load. **Err short.**
- **25s second, because it must outlast the wait the SERVER is already honoring for it.**
  `dtodayAwaitFlight_` holds a joining request up to `DTODAY_WAIT_MS_` (25s). Caught while building
  this, in the browser: with 14s there, Bend spent fourteen seconds waiting on a pull it then threw
  away and had to ask a third time. **Two numbers describing one wait, in two files and two
  languages** — `tests/phase_split_test.js` reads both and fails if they part company (verified by
  mutation from either side).
- **Settled gets a third attempt where live gets two**, because a settled failure does not merely
  delay a store — `fetchMonthData` does not re-try a timeout, so the store FAILS and drops out of
  the company total. The River shape again: a smaller number, not an error.
- **12+25+backoff ≈ 38s, against 57s.** Still inside one 60s poll, which is the hard constraint:
  `_loadAllStoresInFlight` blocks the very poll that would recover a store.
- Browser, mobile viewport, live backend: cold with the hop at ~10.5s, five of six hit the first
  ceiling and their retries answered in ~3s, landing at ~14s; warm, all six answered in 2.2-4.3s
  with no second attempt at all. `tests/background_refresh_test.js` EXECUTES `gasFetchJson` and
  asserts the delay each abort timer is armed with, in order; every source-read guard is verified by
  mutation (flat cap, 28s x 2, a chain that outruns the poll).

**What this does NOT fix, and is not ours to fix:** the stall itself. Google's hop is going to keep
dropping ~4% of requests, and the only lever this app has is how fast it gives up on one. If loads
still feel long, re-measure the RATE before re-tuning the ceiling — `python3` firing six parallel
requests at `/exec` is the whole instrument, and a `loadprobe` walk cannot see this at all, because
it measures the server's own work and the stall happens outside it.

**That instrument is checked in now — `python3 tools/exec_stall_probe.py` (2026-09-16).** It was a
throwaway both previous times and was gone when the complaint came back, leaving the next session
the last session's CONCLUSION where it needed a measurement. It fires six at a time, reports median
/ p95 / stall rate against the 2026-09-15 baseline, how many requests blew each live ceiling, and
how often a 16-request load carries a stall. `action=libversion` deliberately: public, no secret,
trivial work, so the number is the HOP and not the handler. **Verified in both directions** against
a local server with a deterministic injected rate — every 5th request stalling reported exactly
20.0%, no stalls reported 0.0%; a probe that always found stalls would have passed the first check
alone.

**Ruled OUT by measurement on 2026-09-16, so nobody re-measures it: v2.599's `gxScrub_` is not a
cost anyone can feel.** It IS on the hot path — `getStoreSales_` answers through `jsonOut_` — which
is why it was worth checking rather than assuming. Executing the shipped function over a real
store-month reply costs **0.008–0.063ms**; 0.6ms over a 530KB absurd case and 2ms over a
deliberately credential-dense pathological string.

*One measurement trap worth keeping: a test written `ok(cond, label)` in a file whose `ok` is
`ok(label, cond)` passes unconditionally — the cross-file wait assertion above shipped that way for
one run and reported PASS against a deliberately broken source. Caught only by mutating it. This is
the third instance in this repo of a guard that could not fail; the rule is unchanged and it is the
only thing that catches them.*

## The overnight pause outlasted a FAILED load — five stores shimmered until morning (v2.601, 2026-09-16)

Sky, on an iPhone at 23:36: *"still hasn't loaded on my phone, its been 6 minutes and only Center
has loaded, theres no activity in the network panel."*

**Three correct behaviors composed into a dead dashboard, and no single one of them is wrong.**

1. Five of six stores lost TODAY's half — `[load] <store> today pending: "timed out after 25000ms"`
   for River, Hillsboro, Portland Rd, Commercial and Bend. Center is the only store absent from
   that list, which is precisely the "only Center has loaded" he saw. The settled halves all
   landed, so every store was in `liveData`, `_loadAllStoresInFlight` was `false` and the poll timer
   was alive — from the inside, the load had SUCCEEDED.
2. The landing view is TODAY, so a store with no today figure shimmers. Five shimmering rows.
3. `inQuietHours()` is true from **22:15**, and the 60s poll that recovers exactly this returns on
   that gate. It ticked every minute and did nothing. **Until 08:00.**

**No number was ever wrong and nothing threw.** The screen simply stopped being able to fix itself,
and a shimmer reads as "still working" rather than "abandoned" — the River shape again: a failure
that degrades into something smaller instead of into a message.

- **The pause skips a tick only when there is nothing INCOMPLETE to recover.** It was never wrong
  about closed stores; it was wrong about assuming the data had arrived. `quietRecoveryNeeded_()`.
- **"Incomplete" is `storeNotCurrent_`, never a second definition.** That predicate already decides
  whether a store's dot blinks, so a row blinking *not current yet* while the poll has
  independently concluded all is well is the two-lists bug wearing a new hat. One definition means
  a store that LOOKS unfinished is by construction one the poll will go and finish. Mutation 5 in
  the test is the evidence that the delegation is load-bearing and not stylistic.
- **CAPPED at 10 attempts** (`QUIET_RECOVERY_MAX_`). "Retry while incomplete" alone is ~480 ticks x
  6 stores before dawn if a store is genuinely unreachable. A transient `/exec` flake clears on the
  next attempt or the one after; ten minutes of failing says it is not transient. After the cap the
  pill goes back to saying paused. **The allowance resets the moment a load comes back complete,
  and again on leaving quiet hours**, so a later failure gets a fresh one.
- **Refresh was never gated and still is not.** That is why tapping the live pill fixed it every
  time, and it is the workaround while a tab is stuck on an older build.
- **The three gates ABOVE the quiet check are untouched** — in-flight, hidden tab, historical day.
  The hidden-tab one matters when verifying: the browser pane counts as hidden, so the tick will
  not fire there at all.

**REPRODUCED INDEPENDENTLY while verifying, which is the part worth keeping.** A local load against
the live backend at 00:04 finished with Commercial `err` and River / Portland Rd / Hillsboro
today-pending — four of six incomplete, inside quiet hours, `quietRecoveryNeeded_()` true. On the
old code that is a dashboard dead until 08:00, on my machine, without trying to cause it. One
recovery pass then took Commercial to `ok` and cleared River and Hillsboro, leaving two pending and
the predicate still true — so the next tick continues. Incremental, self-limiting, exactly as
designed.

`tests/quiet_recovery_test.js` — 32 assertions, EXECUTES the shipped tick and the shipped
`quietRecoveryNeeded_` / `storeNotCurrent_`. **Six mutations, counts measured not predicted**;
reverting the gate to the shipped bug fails 10 assertions **while the pause's own section still
passes**, which is the assertion that proves the fix did not simply delete the thing it had to
preserve.

**`tests/quiet_hours_test.js` had to be amended, and the reason generalizes.** One assertion pinned
the gate's exact SPELLING (`if (inQuietHours()) { paintQuietPill(); return;`) rather than the
property it was written to protect — that a quiet tick returns and never calls `clearAutoRefresh`.
That property was fully intact and the assertion failed anyway. It now matches the branch rather
than the line, plus a new one requiring the recovery to stay CONDITIONAL, since an unconditional
fetch would defeat the pause that file exists to defend. Both mutation-verified.

**What this does NOT fix:** the phone's failure RATE. One load that night carried a 12s timeout,
five 25s timeouts, a 20s timeout and two of the documented second-hop 404s — far above the ~4% this
app was tuned for, and still unexplained. This makes a bad load survivable; it does not make it
rarer. Re-measure the rate with `tools/exec_stall_probe.py` before tuning any ceiling.

### The 40% day — what a bad /exec morning looks like, and what does NOT fix it (2026-09-16)

Sky: *"it took 4 minutes for it to load on my phone this morning."* The section above is about a
~4% stall rate. **This is what happens at ten times that**, and the useful part is the list of
things that look like fixes and are not.

**MEASURED, low-volume so it cannot be self-inflicted** — 18 requests (one cold load's worth), then
90 seconds of silence, repeated, against the public `libversion` route so nothing of ours is in the
timing:

| 09:27 | 09:31 | 09:33 | 09:37 | 09:40 | 09:42 | 09:45 | 09:49 |
|---|---|---|---|---|---|---|---|
| 50.0% | 33.3% | 38.9% | 55.6% | 27.8% | 38.9% | 50.0% | **0.0%** |

Median request 2.2s-11.1s against a 2.3s healthy median. **It is not a fat tail — the whole
distribution moves, minute to minute.** A stalling minority against a healthy majority would hold
the median near 2.5s; it plainly does not. core-admin measured the same shape independently
(p50 2.6s at 07:27 -> 10.0s at 09:20, 23.3% then 57.5%).

- **ONE READING PROVES NOTHING TODAY. Sample 8 is 0.0%** — clean, 2.2s median, nine minutes after a
  50% sample. Anyone who probes once and stops will call it recovered and be wrong four minutes
  later. **Deciding "the endpoint is quiet" needs several bursts over several minutes**, which is
  the shape `tools/exec_stall_probe.py` plus a sleep between runs gives you. This is why the GXCore
  332 re-pin was deferred rather than attempted on a good-looking probe (Sky's call).
- **FEWER REQUESTS PER LOAD DOES NOT HELP A BAD DAY, AND THE ARITHMETIC IS COUNTER-INTUITIVE.** At
  ~3% per request a 16-request cold load carries a stall **38.6%** of the time and halving the count
  takes it to **21.6%** — batching is worth doing. At ~40% a 12-request load carries one **99.8%**
  of the time and a 6-request load **95.3%**. Both round to *every load*. So "just make fewer calls"
  is right in the ordinary world and buys nothing in the bad one — and it is the first thing a
  session under pressure to DO something on a bad morning will reach for. Verified by computation,
  not asserted.
- **The lever that works on a bad day is RETRIES — how many stalls get recovered — not request count
  and not ceilings.** Ceilings decide what a stall COSTS; retries decide how many are LOST; neither
  touches how often Google drops one. At ~40% per request a 2-attempt ladder loses ~16% of halves
  and a 3-attempt one ~6%.
- **A third LIVE attempt is therefore a real measured argument, and was deliberately NOT taken.**
  It would cost every ordinary load forever on the evidence of one morning — which is the v2.592
  mistake exactly: a ceiling set from one evening's measurement, correct for the failure in front of
  it and wrong for the one that recurred. **Second bad day first, and decide on a distribution
  rather than a morning.** core-admin now records per-request `(start_offset, duration)` so that
  decision can be measured instead of judged.
- **NOTHING CLIENT-SIDE FIXES THIS.** Worth saying plainly rather than implying a change is pending.

**Two limits on the evidence, recorded because both were nearly over-cited:**

- **The cold-load run that "reproduced" the complaint is a SIMULATION of the ladder in Python, not a
  browser.** It replays the real ceilings and retry behavior against the live endpoint — 54.9s to the
  last request, 8 of 12 halves stalled, Hillsboro and Center lost — but it does not exercise
  `fetchMonthData`'s outer retry, the in-flight guard or the progressive render. So *"Hillsboro
  leaves the company total"* is what the ladder IMPLIES, not something anyone watched happen. It is
  the right implication — a timed-out SETTLED half is not retried, so the store drops out rather than
  arriving late, the River shape again — but implication and observation are different claims.
- **The two most-quoted numbers have no ordering.** The 0/120 clean baseline at 17:45 on 09-15 and
  the 23.3% at 07:27 were both sorted before storage, so neither can place a stall in time, and the
  clean one is **one run on one machine on one network path** — it rules out that instrument at that
  volume reliably producing stalls; it is not a baseline. Ordering is what distinguishes "a bad
  patch" from "builds under sustained load", and it was thrown away by sorting. The 09:37 run has it
  and answers on its own: stalls **flat across the run with the WORST quarter first**, which is the
  opposite of load building up.

**What this bought Sales:** nothing faster, and v2.602 earning its keep. The coverage readout on the
mobile hero reports *"5/6 stores"* instead of a confident total over missing data — the simulation
above is the first demonstration it has something real to report.

## The Inventory tab's sales speed comes through GX Core — and was a green 0 until v2.596

The Critical tile (products under 3 days on hand) fetched velocity straight from a hardcoded
Inventory `/exec` that no other repo referenced — app-to-app, against the suite rule. **Measured
2026-09-14, that deployment answered `{"stores":{},"lastSynced":"2026-08-11…"}`**, and `loadVelocity`
accepted any object with a `stores` key. So the tile counted nothing and showed **0 in green** — "all
clear" — on data that did not exist, for at least a month. Found by a read-only audit filed for
routing; the blank data was found only by calling the address.

- **`?action=velocity`** (auth-gated) → `getVelocity_` → `GXCore.getVelocity('')`, the 6-hourly
  `velocity_summary` Inventory itself reads. Keyed by dutchie_name (what `STORE_TO_VEL` maps to);
  only SELLING products are sent (the tile ignores zero velocity; all ~12k rows is ~1MB). Cached 1h.
- **Empty is an ERROR on both sides, never a result.** The backend refuses to answer `ok` with no
  selling products and does not cache it; the client refuses an empty map (live or cached) and the
  tile reads `—` / *sales speed unavailable*. An empty map is precisely the silent 0.
- **Tried, not loading:** `renderInventory` re-asks at most every 5 minutes after a failure — the
  render a load triggers must not re-trigger it (same rule as `ensureExpBudgets`).
- **One app-to-app address remains, deliberately:** `fetchLeaderboardGoalsDirect`, the documented
  fallback when GX Core's `published_goals` cannot answer, URL from Core config `lbGoals`.
  `tests/velocity_via_core_test.js` (29 assertions, mutation-verified on both halves) fails on any
  THIRD Apps Script address in `index.html`.

## Two load-bearing render rules, both learned the hard way

- **A render fault must never kill a data load.** `loadAllStores()` had `try/finally` with no
  `catch`, and the progressive `render()` sits OUTSIDE the per-store fetch try/catch — so a throw
  while PAINTING rejected the store's promise, rejected the `Promise.all`, escaped the function and
  skipped the final render. The app sat on "Connecting…" forever with nothing logged and no error
  shown. Both are guarded now; `tests/load_resilience_test.js` keeps them that way.
- **Never show a goal you are about to replace.** `getMonthlyGoal` falls back budget-ward while
  `pgDaily` is empty, so the hero painted the budget figure and swapped in the period goal a moment
  later — May 2026 $685,702 becoming $742,625, Portland Rd $65,638 becoming $92,073. The goal now
  shimmers until the authoritative source ANSWERS. The subtlety: `pgLoaded` is added to BEFORE the
  await, so it only ever means *asked* — resolution needs its own set (`pgResolved`), and EVERY exit
  path must reach it, including "GX Core has no periods for this range". Miss one and that view
  shimmers forever, which is worse than the flicker it replaced.

## A filed bug whose email dies is the failure nothing observes (v315 pin, 2026-09-09)

**Since GX Core v310, Core's send is the only send** — this app has no `MailApp` call of its own on
the success path and must not grow one, because two sends is the three-emails bug wearing a fix. But
`gxIngestBug` **swallows its own mail failure on purpose**: a filed report has succeeded, and mail
must never be what stops it. So a bug could reach the board, the email could die, and the app stayed
silent — correctly, by design, with nothing anywhere recording it. The absence of an email is not an
event anyone observes.

v312 added `mailed` / `mail_error` / `mail_skipped` so a spoke can tell the three apart, and reading
them is why this app is pinned to **v315**. `reportBug_` now sends its own notice on that path,
naming the bug id and saying explicitly **not** to re-file it.

- **READ THE POSITIVE FIELDS. NEVER THE ABSENCE OF `mailed`.** `gxIngestBug` returns at its dedupe
  check **above** its send, so a repeat filed inside three minutes carries **no mail field at all** —
  and this app's submit retries transport flakes up to three times (`gasFetchJson(url, 3)`, because a
  bug reporter that dies on a flake is the one thing you cannot report a bug about). `!r.mailed`
  turns one redirect chain into three copies of the very email that exists because nobody was told
  once. Fields are **absent, not empty**, when they do not apply; truthiness is the correct read, the
  same way `deduped` is read. Verified by mutation: that one expression fails 3 assertions.
- **There is deliberately NO notice for a REFUSED report, and this app is the reason.** Leaderboard
  carries one because it answers `ok:true` regardless; here `reportBug_` returns the refusal to the
  browser and the shared form shows it (`gx-bugreport.js` treats a resolved `{ok:false}` as failure),
  so the person who filed it already knows and can re-file. An email about a failure the reporter is
  looking at is noise. **A second notice would need its own `bugMailOnce_` key** — the two say
  opposite things ("re-file this" / "do not re-file this"), and a shared mark lets the first suppress
  the second and leaves the wrong instruction standing as the only word on it.
- **`mail_skipped` is the one that reads as fine and is not.** Nobody configured to receive it plus a
  reporter with no address on file means nothing failed and nobody was mailed. Still a silent report.

  **In practice only `mail_error` can fire today, and that is a CONFIG fact, not a code one.**
  `gxBugWatchEmail_` falls back to a hardcoded default when `cfg.bugWatchEmail` is unset — and it is
  unset — returning `''` only for the literal string `off`. So there is always a recipient and
  `mail_skipped` is currently unreachable. **Do not delete the branch on that basis.** One
  `set_config` writing `off` makes it live overnight, from a change nobody would connect to bug mail,
  and the branch costs a `||`. Read from `gx_core.gs` at HEAD (established by spiff, re-checked by
  Leaderboard and crew); this app runs the v315 snapshot, so treat it as current behavior rather than
  a guarantee about the pin.
- **`bugMailOnce_` fails OPEN.** A cache or lock that is unavailable must never be the reason a bug
  goes unread — better a duplicate email than a silent one. Every failure inside falls through to
  sending. It exists because Core's ingest lock also fails open, so two executions landing at once
  can each get a row and each see a dead send.
- **Whether this send can succeed where Core's failed is not guaranteed**, and the honest answer is
  what it is for. A library call runs under the **calling** project, so `gxIngestBug`'s send already
  spent this script's mail quota — an exhausted quota refuses this one too. What it does cover is a
  bad or missing recipient (all of `mail_skipped`), a transient failure, and a Core-side config
  problem.
- **The notice carries the captured JS errors**, which is the whole reason `context` is forwarded.
  The `defer` bug was filed three times before anyone diagnosed it and its cause was a single boot
  `ReferenceError` sitting in exactly that field.
- **The `script.send_mail` scope was already declared** — this needed no manifest change beyond the
  pin.
- `tests/bug_mail_fallback_test.js` — 44 assertions, executes the shipped `reportBug_` /
  `bugNotify_` / `bugMailOnce_`.

**Not verified end-to-end on the live deployment**, and deliberately not: exercising it means filing
a real bug on the board and sending a real email. What was checked live is that the deployed script
compiles and serves (`libversion` → 315) and that the auth gate still sits above this code.

## Nothing this script returns may carry a credential (v2.599, 2026-09-15)

Reported by SPIFF through core-admin, after SPIFF found the shape in its own router. **Confirmed
reachable HERE before anything was changed**, which is what the note asked for and is the only
reason it was worth shipping:

`gxDutchieGet_` builds `GXCORE_EXEC_ + '?…&secret=' + gxDeploySecret_()` and hands it to
`UrlFetchApp.fetch`. **`muteHttpExceptions: true` suppresses HTTP status errors; it does not
suppress a transport failure**, and there is no `try` around that call. When Apps Script cannot
reach the address it throws `Address unavailable: <the whole URL>`, query string and all — which
escapes to `getStoreSales_`'s catch, becomes `{ error: <that message> }`, and gets painted in the
store's error slot. **Four outbound fetches carry the secret and all four are reachable this way.**
Not an outage, and nothing says it has fired; it is one throw from a credential on a screen staff
can see.

- **TWO LAYERS, AND THE REASON IS THE USEFUL PART.** The obvious fix is a scrub inside `jsonOut_` —
  every reply goes through it, so no new route can forget. **Except nine of this file's replies are
  built with `output.setContent(JSON.stringify(…))` and never touch `jsonOut_` at all.** A
  choke-point-only fix covers two thirds of the paths and reads as complete. So: **`errText_()` at
  all 37 sites** where an exception becomes part of a reply, **and `gxScrub_` inside `jsonOut_` as a
  backstop**. Before adding a "one place to fix it", count the exits.

  **And do not assume this shape is suite-wide — it is ours alone.** Told core-admin I would bet
  another spoke had it; core-admin counted all seven rather than guess, and the bet was wrong.
  Sales has **18 `createTextOutput` and 36 `setContent`**; every other repo has 1-5 and **not a
  single `setContent` between them** (Core's five are fixed-literal POST errors carrying no
  exception text, plus its one `out()` choke point). So a choke-point fix genuinely IS complete
  everywhere else, and this file is the one with 54 doors. The method survives the correction —
  counting is what tells you which case you are in — but "another app probably has this too" was a
  guess where a count was available, which is the same error as the serialization theory the same
  night.
- **`gxScrub_` makes two passes for two different things.** The exact secret, wherever it appears
  and however it got there — no pattern to outsmart. Then any credential-shaped query parameter,
  for values we do NOT hold: a session token in an echoed URL, a key in a message from GX Core.
- **It can never be the reason a response fails.** `gxDeploySecret_` throws when the property is
  unset, and a scrub that threw with it would turn a working app into a blank one. Wrapped, falling
  through to the pattern pass. Leaking is bad; serving nothing is worse.
- **The length guard is load-bearing.** An empty or two-character property would otherwise redact
  half of every payload — `'a cab drove by'` becomes `'a [redacted] drove by'`.
- **`tests/secret_scrub_test.js` (19 assertions) EXECUTES a real handler's catch** — `getVelocity_`,
  reachable at `?action=velocity` — with a real `Address unavailable` exception, then asserts
  separately that **no reply field anywhere in the file is handed a raw `.message`**. That second
  one is written as **the absence of the hazard, never the presence of the fix**: a grep for
  `errText_` goes green the moment one appears anywhere, which is precisely how SPIFF's own version
  passed on a router that still leaked. Six mutations, each failing the right assertion; the
  un-wrapped-call-site mutation prints its line number, and the two layers fail **independently**,
  so you can tell neither is quietly covering for the other.
- **The push gate caught this change's own test** — a random-looking literal assigned to `SECRET` —
  and was right to: it cannot tell a fixture from the real thing and should not have to guess. The
  fixture is assembled from plain words now.

*GX Core has no scrub helper of its own and its `doGet` catch returns `err.message` raw; that is
core-admin's item and is PR-gated as a library cut.*

### The scrub named ONE of the three ways to send a session (fixed 2026-09-15, `2b8f957`)

*Cited by commit, deliberately: this shipped with **no `APP_VERSION` bump** — see the last bullet —
so there is no version number to name it by. `APP_VERSION` is still v2.599 and `app_versions` still
reads `decc9db`. **`core_pins` is what answers "what is this app running"**, written BY the deploy —
its row for `sales` carries **`deployed_sha`** (`2b8f9571b…`, alongside `lib_version` 331 and
`observed_by`), which is the field to read and is not called `sha`. A future session reading
`version_history` and concluding otherwise is reading the wrong table.*

**The fix above shipped leaking, and it was found hours later — by core-admin, after Leaderboard
found the shape in itself.** `gxScrub_`'s pattern pass named `secret|token|key|password|pwd`.
`requireAuth_` accepts **`params.token || params.session || params.auth`**. So a request presenting
its session as `session=` or `auth=` had a **live user token** pass through untouched, into exactly
the error banner the scrub exists to clean.

Reproduced HERE by execution before it was believed — `token` redacted, `session` LEAKS, `auth`
LEAKS, with `secret`/`key`/`password`/`pwd` as passing controls.

- **The literal-value pass cannot cover it.** That memo holds `GX_DEPLOY_SECRET`. What escapes here
  belongs to a **person** and is live until it expires — a different credential whose value this
  app never holds, so there is nothing to match against.
- **Nothing we ship can reach it, which is why it survived.** `index.html` sends `&token=` 27 times
  and never `session=` or `auth=`; the exposure needs a request shaped by hand or by another
  client. **Do not "tidy" the two unused names off the auth line on that basis** — verified live,
  all three genuinely authenticate (`?action=stores` returns the full registry via each), and
  deleting one is the single change the derived guard below **cannot object to**, because the name
  would leave the test's list along with the app's.
- **The defect was never the regex — it was two hand-typed lists in two functions that had to
  agree, with nothing comparing them.** So `tests/secret_scrub_test.js` §7 **DERIVES** the accepted
  names from the `validateSessionToken_(` argument expression in the source and requires each to
  come back redacted. Pin the LINE, not the spelling: a fourth way to present a session joins the
  list on its own. Hand-typing `['token','session','auth']` there rebuilds the exact drift.
- **A derived list is blind DOWNWARD, so there is also a floor.** Additions are automatic;
  deletions are invisible, and a narrowed app would go green. The floor asserts the three are still
  accepted, so a removal fails loudly and a human has to agree to it in the test. **It is not the
  typed list coming back** — it never sources what gets exercised, it only refuses shrinkage.
- **Mutation-verified in three directions, because they say different things:** the regex reverted
  to the shipped list → 5 fail (the real bug); `|| params.auth` deleted → 1 fail, the floor, and
  *nothing else notices*; `|| params.sid` **added** → 2 fail, with `sid=` testing **itself** and no
  edit to the test file. **The third is the only evidence the derivation is real rather than
  decorative.**
- **Known limit, pinned by an assertion rather than papered over:** the pattern pass matches
  `name=value` after a `?` or `&`. A credential sitting **bare** in a message is caught only by the
  literal-value pass. No path was found that embeds one; the assertion stops the next reader
  assuming coverage.
- Backend only — `index.html` untouched, so **no `APP_VERSION` bump**: that constant is a reload
  TRIGGER, not a label (`gcCheckVersion`), and there was nothing for a tab to re-fetch.

**THE THROUGH-LINE, AND IT IS SHARPER THAN "A CHECK CAN FAIL TO FAIL."** Five defects surfaced the
night of 2026-09-15 where a fix covered *most* of the doors: this file's 54 exits against a
choke-point fix, Leaderboard's nine catches, its token-only regex, this one, and the derived list
that would itself have gone green on a narrower app. **Not one was found by re-reading the fix.**
Every one came from **counting the exits, comparing against something outside the fix, or mutating
it.** Re-reading is what produced all five; it is the activity that feels like verification and
is not. *Two of the five were in fixes that had shipped the same day and looked complete —
including the one directly above this section.*

### ONE list now: the names the auth check accepts ARE the names the scrub redacts (v2.600)

The two fixes above were both right and both incomplete, for the same reason, and the third one
stops the reason rather than the symptom. **The accepted parameter names and the redacted ones were
two hand-typed lists in two functions that had to agree, with nothing comparing them.** Core-admin
measured all four of the suite's scrubs on 2026-09-16 and three of them had drifted the same way.
Adding the missing words — which is what v2.599's follow-up did — closes today's gap and leaves the
mechanism that made it.

- **`AUTH_PARAM_NAMES_` is the one list.** `authParamValue_` reads a session off a request through
  it (`requireAuth_` no longer touches `params.token` at all), and `SECRET_PARAM_RE_` is BUILT from
  it via `SECRET_WORD_NAMES_.concat(AUTH_PARAM_NAMES_)`. A fourth way to present a session is
  redacted the moment it is accepted, with no second edit to remember. Verified by mutation: adding
  `sid` to the array made the test exercise `sid=` and pass with **no edit to the test file**.
- **The real remaining leak was the ANCHORING, and it was live.** The shipped pattern required the
  credential word to sit immediately after a `?` or `&`, so an underscore in front of it walked
  straight past. **Measured against this app's live `/exec` before anything was changed**, echoing a
  fixture value back through the `Unknown store:` reply with a read-only dev session:
  `token`/`session`/`auth`/`secret`/`password`/`pwd` redacted; **`connector_secret`, `deploy_secret`,
  `api_key`, `apikey`, `refresh_token`, `x_auth` and `sessionid` came back in full.** That is not
  hypothetical: **GX Core builds a URL with `?connector_secret=`**, and `gxDutchieGet_` re-throws
  Core's error text verbatim. The name now matches anywhere inside the parameter name, so there is
  no third list of prefixes to keep current. The cost is an occasional false redaction (`?keyword=`
  contains `key`) — one word in a message that was already an error, against a credential on screen.
- **Every reply exit scrubs, not every catch.** Re-counted: **54 reply-building exits** — 18
  `ContentService.createTextOutput` and 36 hand-built bodies — against 138 `jsonOut_` call sites
  that all funnel into one of those 18. Each hand-built body now goes through **`setReply_`**, which
  scrubs; `getStoresMeta_`'s two direct `createTextOutput(body)` returns were the other two doors and
  are wrapped. **Cached bodies are scrubbed too** — a scrub that skipped the cache leaks on the
  second request and not the first, which is the worst possible reproduction case. Cost measured at
  **0.2ms on a 981KB payload**, byte-identical out.
- **The test may not take its facts from the thing it is checking.** `tests/secret_scrub_test.js` is
  **64 assertions** now. §7 derives the names from the source; §7's **floor** and all of §8 are
  **hardcoded** and unreachable from the implementation, so a REMOVAL fails loudly instead of
  quietly shrinking the test. That trap is not theoretical — core-admin's first version of this
  passed 23 of 23 with `session` deleted from the source, and Price Cards' passed 62 of 62.
- **Mutation-verified in seven directions**, each failing the right assertion: `session` deleted from
  the list → 5 fail **including the floor**; `sid` added → 66 pass, the new name testing itself; the
  regex typed by hand instead of built → 11 fail; the anchoring reverted to the shipped pattern → 15
  fail, exactly the names measured leaking live; one reply exit of 54 un-wrapped → 1 fail **naming
  the line**; the cached stores payload un-wrapped → 1 fail naming the line; `requireAuth_` reading
  `params.<name>` again → 1 fail.
- **A red line has to be actionable.** The section-6 and section-9 source checks used to strip
  comments by deleting them, which reported a line number ~350 short of the real one in a 6,000-line
  file. Comments are now blanked with their newlines KEPT, so the number printed is the number in
  `dutchie_proxy.gs` — confirmed against both mutations.
- **Five other suites execute `gxScrub_` as a dependency** and now load `AUTH_PARAM_NAMES_` out of
  the source alongside it (`SCRUB_DECLS`). None of them retypes the names; a copy in a test file is
  a third hand-maintained list.
- **This one DID bump `APP_VERSION`** (v2.599 → v2.600) even though `index.html` is otherwise
  untouched, unlike the 2026-09-15 follow-up that shipped as a bare commit. A backend-only ship with
  no number is a release nobody can name afterwards — that note had to cite a sha and explain where
  to read it. The cost is one reload of open tabs.

### …and MAIL was an exit nobody had counted (v2.607, 2026-09-17)

The section above counts **54 reply exits** and wires every one of them to a scrub. It counts **zero
mail exits**, because nobody looked — and this app has one. `bugNotify_`
(`dutchie_proxy.gs`, the unfiled-bug notice) built its body from values that had never met
`gxScrub_` and handed it to `MailApp.sendEmail`. Now scrubbed, subject and body, **at the exit
rather than field by field** — so whatever the next person adds to that block is covered without
their having to know this.

What was actually exposed, since "mail leaks" deserves a real answer rather than a shrug: **`mailWhy`
(`r.mail_error` / `r.mail_skipped` — GX Core's own error string, the same class of text that
`gxDutchieGet_` re-throws verbatim and that the anchoring fix above was written for) and the
reporter's `desc`.** The captured JS errors were already safe — they go through `errText_`, which
scrubs. The page URL arrives cleaner too since gx-theme's bug reporter was fixed the same night, but
that is a second app's fix protecting this one, which is not a property to rely on.

**Two things the next session must NOT conclude from this.**

- **Not "Sales is done because the send scrubs now."** The rule is that **every exit an engine has**
  goes through a scrubbing builder — replies AND mail AND anything stringified into a Script
  Property, a sheet or a cache that something later replays. One more exit is closed; the class is
  not. **A shared TEST is what will hold it** — count the `ContentService` and `MailApp` exits in an
  engine and require each to route through a scrubbing builder. **That is the hub's to write, in
  gx-theme's shared set and wrapped into each spoke's push gate the way
  `tests/cross_app_goals_contract_test.js` already is.** Deliberately NOT written locally here: six
  sessions inventing six spellings of one rule is the thing the shared test exists to stop. As of
  2026-09-17 it is not started and is on Sky's board.
- **Not "a field with no reader is safe."** Crew found a stored error field with no known reader,
  went looking, and found one: a health check folds it into a `reason` that the Monday recap then
  renders into an email. **The rule is about exits, not about which fields look inert.**

**Why the fix is local and one line rather than shared code.** `MailApp` is server-side in each
spoke's own Apps Script project, so **gx-theme cannot host it** — gx-theme is browser-side. The only
shared home is GX Core's library surface, and **a `GXCore.x()` call runs the version the SPOKE
pins**, so a scrub fix there protects nobody until seven spokes re-pin. For something this size that
is a worse property than a wrap at the one send. The suite-wide half is the test, not the code.

Crew is the proof that shared code was never the missing piece: it **had** a correct, tested,
derived scrub and still had **seven mail sends with one scrubbed**. What fixed Crew was routing
every send through one `sendMail_`, the same argument as its single reply builder. Price Cards is
the same story inverted — its scrub is fine and its two queue-digest sends carry no error text at
all, so their lack of a scrub is correct rather than missed. Counted by the hub, 2026-09-17.

**Version bumped for a backend-only change**, per the rule the section above learned the hard way: a
ship with no number is a release nobody can name afterwards.

### The screenshot died one line short of the board (v2.598, 2026-09-15)

Filed by core-admin, measured live: **140 bug reports across all seven apps, not one with a
screenshot** — 24 of them Sales, 14 filed since the feature shipped 2026-08-26. Every piece worked.
The shared form uploads the image to GX Core's `bug_shot` sink itself (a 273KB base64 would not
survive this app's GET) and sets `payload.screenshot_url`; the frontend forwards the whole payload;
`gxIngestBug` reads the field and writes the column. **`reportBug_` then re-packed the payload into
a fresh object literal, field by field, and never named it.**

**Omitting a key from an object literal throws nothing** — which is the entire shape of this bug,
and of the `context` gap before it. A hand-maintained re-pack of a contract that lives somewhere
else will lose a field every time that contract grows one, silently, and the only thing that can
notice is a test naming the field. `tests/bug_context_forward_test.js` now pins both, the screenshot
assertion verified by mutation. The hub carries the cross-repo half
(`tests/bug_screenshot_forwarding_test.js`).

### That commit also shipped two NUL bytes, and the interesting part is what it did NOT break

`bugMailOnce_`'s cache-key delimiter was written to disk as the raw byte instead of an escape —
two NULs at offsets 196535/196563 of `dutchie_proxy.gs`, in `edc075d`, and `clasp push` carried
them to the live project faithfully. **Runtime was never affected**: a NUL inside a JS string
literal is legal, and the escaped form produces a byte-identical string (verified by executing
`bugMailOnce_` and reading its digest input back).

- **Every agent-facing grep went blind, and that cost real time.** The `grep` a Claude Code session
  runs wraps ugrep, which refuses a binary file wherever the NUL sits — so the whole backend was
  invisible to every grep an agent made. A peer session concluded the implementation did not exist
  while it sat right there.
- **The push gate was NOT disabled, contrary to how this was first reported — twice, independently.**
  `gx-preflight.sh` runs under `/bin/sh`, where `grep` is `/usr/bin/grep`, and BSD grep classifies a
  file from its **first block only**. These NULs were at ~196KB. **Measured, by running the real gate
  against the real file with a genuine `debugger;` and a real localhost URL appended: it caught both,
  with line numbers, and printed PUSH BLOCKED.**
- **Position decided what the gate could SAY, not whether it fired.** The same NUL at byte 22 does
  make `/usr/bin/grep` call the file binary; at byte 260000 it does not. *Corrected 2026-09-09, and
  the correction is mine to own: this bullet first claimed two bytes landing 196KB earlier "would
  have silenced every check in the hook".* **That is false, and core-admin measured it before I
  did.** Re-measured here against the real `gx-preflight.sh` with a NUL at byte 1 and a genuine
  `USE_FIXTURES = true` plus `debugger;` in the file: both checks still **fired** and the push was
  still **BLOCKED** — `hits` is non-empty because grep answers `Binary file dutchie_proxy.gs
  matches`, which the comment filter does not strip. A clean file with the same early NUL still
  passed, so there is no false positive either. **What is destroyed is the REPORT**: a filename with
  no line number and no offending text, on a 240KB proxy. That is a blocked push nobody can act on —
  a real defect, and a different one from the silent gate I claimed.
- **Measure a tooling claim with the tool that actually runs.** Both wrong readings came from testing
  with the agent's grep rather than the hook's. That is the same error as reading `appsscript.json`
  to learn what a deployed app is running.
- `tests/binary_source_test.js` asserts no shipped source contains a NUL, and pins the position
  mechanism so the invariant reads as a rule rather than a superstition. The suite-wide fix — `grep
  -a` in `gx-preflight.sh` — is gx-theme's and has been asked for.

### MUTATE A GUARD; YOU CANNOT REVIEW YOUR WAY OUT OF A CHECK THAT CANNOT FAIL

The most durable thing found on 2026-09-09, and it is not about NUL bytes. `tests/binary_source_test.js`
shipped **three** assertions that passed while being **incapable of failing** — and every one was
written while its author was actively thinking about that exact failure mode:

1. `n === -1 || !console.log(...)` — `console.log` returns `undefined`, so the condition was always
   true. It printed the offending byte offset and reported `0 failed` in the same breath.
2. The mechanism check resolved `/usr/bin/grep` through `catch (e) { return false; }`, so on a host
   without that binary the assertion passed for the wrong reason. It skips and says so now.
3. Two of the gate's patterns compiled to JS regexes matching **nothing** (`[[:space:]]` is POSIX and
   is not JS), so the two rules actually at risk were checked by regexes that could never match.

**A check that cannot fail looks exactly like a check that passed.** Reading it does not distinguish
them; only breaking the thing it guards does. So: **verify a guard by mutation, never by a green
run.** Break the source it protects, break its own table, force its dependency absent — and require
the failure to *name what broke*, because a red line nobody can act on is the same defect one level
up (the gate's own `Binary file … matches`, with no line number, on a 240KB proxy).

This is the older `verified to fail against the pre-fix source` rule, sharpened: it is not enough for
the SUITE to fail somewhere. **The specific assertion has to be shown failing for the specific
reason.** Leaderboard reached the same conclusion independently the same evening, with three of its
own in one file. The lesson is a fact about the defect, not about carelessness — being careful is
what all six of these were.


## Sync with the brain — run `/gxbrain` (or say "brain sync")

This app is on the shared brain. **`/gxbrain`** loads the shared rules and reconciles this chat with GX Core
— the sync protocol lives in that one command, not copied here. **"brain sync" / "sync brain"** = the
reconcile-and-report step alone (skips orientation).

Coordination is now the **central brain-notes inbox** in GX Core (this repo's `BRAIN_NOTES.md` was retired and has now been deleted): `/gxbrain` reads notes addressed to `to_app=sales`, resolves done ones (`resolve_note`), and writes
note-backs to any app (`add_note`). The SessionStart hook surfaces the same inbox.

Integration status: app key **`sales`**; deploys clasp (backend) + GitHub Pages (frontend). ✅ shared login
(Phase-2), ✅ auto-record (`deploy_version`), ✅ changelog from `version_history`, ✅ gx-theme, ✅ bug
forwarding (`gxIngestBug` in `reportBug_`) — verified 2026-08-20: real 🐞 reports from this app are on Core's
board with reporter/tab/app_version filled in. Fully integrated; no seam left open.

**Verify the `GXCore` pin by asking the live app, never by reading the repo.** A `GXCore.x()` call runs the
snapshot of the version this app PINS, and a deployment snapshots the manifest — so `appsscript.json` at HEAD
and `gx_core.gs` as it reads today both tell you nothing about what the running app has. Re-pinning is two
steps and the second is the one people skip: set the version, then **deploy**. Then measure:

```
curl -sL -G "<sales /exec>" --data-urlencode action=gxpin --data-urlencode "secret=$(cat .gx_deploy_secret)"
```

`gxpin` returns `GXCore.libVersion()` from the live deployment plus `qb.last_source`, which names the
connector that served the last uncached Expenses load. A `Forbidden` here is a finding, not a route bug:
it means `GX_DEPLOY_SECRET` is unset or stale on this script, and that same property gates
`qbReportViaGXCore_`.

**The legacy local QuickBooks path was REMOVED 2026-08-24** (`qbReportLocal_`, `getQBAccessToken_`,
`exchangeQBCode`, the `qbaccounts` route and the two editor debug fns — ~180 lines). Sales no longer reads
`QB_REFRESH_TOKEN`/`QB_CLIENT_*`/`QB_REALM_ID` at all; the only `QB_` property left is the `QB_LAST_SOURCE`
diagnostic. **GX Core is now the sole QuickBooks token owner by construction, not by convention** — the
invalid_grant desync is no longer a thing that can happen here, so don't re-add a "temporary" local
fallback. `qbProfitAndLoss_` now THROWS when Core is unreachable instead of quietly serving numbers from
somewhere else; a broken Expenses tab is the intended failure, and it is strictly better than the silent
one that hid the misnamed-secret regression for an unknown stretch. `last_source` can now only read
`gxcore@…`; the field stays because it is what made that regression visible, and `null` (nothing has
missed cache yet) is still meaningfully different from a stale timestamp.

**Reconcile counts the Dutchie sales banking and nothing else — by MEMO, not by arithmetic.**
`reconIsSalesDeposit` reads the QuickBooks memo, because the tab answers one question: did this
store bank what it SOLD that week. A `Printer Ink (refund)` line classed to Portland Rd is real
money and not that. Everything it rejects goes to the **not included in a store's week** list with
its amount and memo showing — never dropped, and it survives reconciling the week.

The vocabulary is **measured, not guessed** — `?action=reconprobe&start=…&end=…` reports it. Over
2026-05-25..08-31 the live route gave **103** store-classed deposits: 102 carrying all five of
`Sales 3% Tax` · `Sales 17% Tax` · `Med Sales` · `Rec Sales` · `Non MJ Sales`, one
`Printer Ink (refund)`, one `Report does not match`.

Two things about that rule are load-bearing and easy to "simplify" into a bug:

- **ANY sales line qualifies, not ALL of them.** `Report does not match` is not a deposit — it is a
  SIXTH line on a real Commercial banking, someone's annotation, and it is what Commercial's
  `max_lines_folded: 6` is. An all-lines rule throws a genuine week's banking onto the not-included
  list.
- **A memo naming `sales` or `tax` also counts**, beyond the exact five. Exact-match-only is a bad
  single point of failure: rename a QuickBooks category and EVERY deposit becomes non-sales at once,
  so every week silently reads nothing banked. Both known outliers name neither word. A deposit with
  **no** memo is not counted — no memo is not positive evidence of sales — but it lands on the
  not-included list with its amount visible rather than silently joining a week.

*This replaced an earlier rule that inferred strays by finding a subset of a week's deposits that
tied to the expected figure exactly. Don't go back to it: it only works on a week that TIES, and
most weeks do not — measured on Shawn's 08.17.26 slips, five of six stores carried a variance. It
also had to refuse whenever two subsets both hit the number, and be switched off entirely on an
incomplete week. Classifying a deposit by what it IS needs none of that.*

**`reconData` carries the range it was fetched for.** It used to be a bare global that only reloaded
when null, so changing the period drew the OLD range's deposits against the NEW period's week
windows until someone hit Refresh — a wrong answer, not just friction. `reconDataStale_` compares
the two and the render reloads on a mismatch; visited ranges come back from a 30-minute client cache.
Failures are deliberately never cached, but ARE tagged with their range so an error renders once
instead of re-fetching forever.

### The week where the month turns went missing (fixed v2.574, 2026-09-07)

Sky, 2026-09-07: *"default Reconcile date selection to Current week. currently when i click on WK35
it's not showing deposits that were make on 8/31, which is WK35, but it does show them on WK34."*

**A store-week is not a calendar month, and the tab lost the week where the two cross.** Three
facts compose into it, and each one looks harmless on its own:

1. WK35 runs Mon 2026-08-31 → Sun 2026-09-06, so it **straddles the month**.
2. `periodGoWeek` takes the month from the week's **Thursday** (`getDaysOfISOWeek(...)[3]` = 09-03),
   so clicking WK35 moves the whole tab to **September** — while the deposit being hunted is dated
   in August. Nothing on screen says the month moved.
3. `reconWindows` listed only windows **starting inside** the period. The 08-31 deposit pays for
   River's 08-26 → 09-01 window and Bend's 08-25 → 08-31 window, both of which start in August, so
   neither was listed in September — and September's own windows (09-01, 09-02) had not finished
   running, so they were dropped as pending. **The tab came up empty.**

**No total was ever wrong and no money moved.** The week simply became unreachable from the month
you were standing in when you went looking for it, and an empty Reconcile tab does not read as an
error — it reads as *nothing was banked*. That is the same shape as the River outage: a failure
that degrades into a smaller number instead of a message.

- **The reach-back is the attribution rule read backwards.** `reconWindowForDeposit` steps back one
  day from a deposit's date to find the window it pays for; `reconWindows` now steps back one day
  from the period start to find the earliest window that can be paid inside it. **The two
  expressions are deliberately identical** — change one and the other has to move with it, or a
  week goes missing again.
- **An overlap test is NOT enough, and this is the half that gets missed.** 2026-09-01 is a
  Tuesday, so Bend's week starts exactly on it and its last August window (08-25 → 08-31) does not
  overlap September by even a day. Overlap finds River's straddler and still loses Bend's. What the
  two windows have in common is not their dates but their **money**. The first cut of this fix used
  overlap, and the test caught Bend — not review, and not the browser.
- **The window is listed in BOTH the month it starts in and the month its money lands in.** One
  week of work seen from either side. Reconciled state is keyed on `(store, window start)`, so
  ticking it off in one shows it ticked in the other and it can never be reconciled twice.
- **`reconIsEmptyWindow` replaces the rule that was dropped.** Starts-inside existed because those
  previous-period days "were never loaded", so the card read Incomplete forever — six permanent
  non-answers above the real work. That reason is spent within a year: `backfillDailyHistory` pulls
  every month of the **active year** into `allDailyData`. Where it genuinely cannot — a January
  view reaching into a December that was never fetched — a window with no sales for any of its
  seven days **and** no money either way is dropped instead. Not keyed on "is this the straddler":
  a window that says nothing says nothing wherever it sits.
- **Missing sales but HAVING deposits still renders.** Money banked for a week we cannot price is a
  question for someone, not noise — and it reports incomplete, never a shortfall.

**"Default to the current week" was NOT implemented literally, and should not be.** Deposits for a
week land a day or two after it closes, so a tab scoped to the current calendar week is empty every
Monday and Tuesday — the same complaint one week later. What Sky is asking for in substance is *the
week I am about to reconcile*, which the default view already computes ("latest complete week per
store"); it was the month scoping that broke it at the boundary. With the reach-back it now lands
on the right week on its own, from either month.

`tests/recon_month_boundary_test.js` — 27 assertions, executes the shipped source over the real
calendar of the complaint, **verified to fail 10 against the pre-fix `index.html`** (including the
end-to-end "the 08-31 deposit appears on a September card at all"). Four assertions in
`tests/deposit_reconciliation_test.js` pinned the old starts-inside rule and were inverted.

### The Reconcile headline — "Banked <selected period>" (v2.577)

One figure at the top of the tab: **what was banked in the SELECTED PERIOD**, with Expected and the
variance beside it. Built by `reconBankedInPeriod_`, scoped by `reconSelectedRange()`.

**It tracks the period picker, and the scope is the DEPOSIT'S OWN DATE.** Sky, 2026-09-07: *"yes
track the picker. if i've selected this week (36), i would expect to see —, then if i select the
previous week i would expect to see the 191k."* Verified in the browser on his real numbers:

| picked | shows |
|---|---|
| WK36 (Mon 09-07 – 09-13) | `BANKED SEP 7 – SEP 13` · **—** · *Nothing banked in this period* |
| WK35 (08-31 – 09-06) | `BANKED AUG 31 – SEP 6` · **$191,617.26** · all 6 stores · deposited Aug 31 – Sep 1 · pays for Aug 25 – Sep 1 |
| WK34 (08-24 – 08-30) | **—** — the week the selling happened, and none of it was banked then |

**A dash early in the week is CORRECT, not a gap.** Deposits lag the week they pay for, so a
picker-scoped tile is empty until the banking lands. The weeks still awaiting reconciliation are on
the cards below, which deliberately do **not** follow the picker — narrowing those would hide the
work. Only the headline is period-scoped.

*Two earlier versions, kept because the reasoning is the useful part.* v2.575 shipped it labeled
**"Deposited this week"** showing the latest banked week regardless of the picker. Sky: *"wk 36 is
showing 191,617 as deposited this week, but we're on Monday, no deposits have been made this week
yet."* **The number was right** — $191,617.26 is exactly the six stores' latest banked weeks,
verified per store against the live `reconprobe` (Bend 39,467.76 · Hillsboro 25,240.13 · Center
13,448.01 · Commercial 51,515.05 · Portland Rd 24,159.55 · River 37,786.76), and the money moved on
08-31 and 09-01. The tile claimed it moved in WK36, which had not banked a cent. v2.576 fixed the
label; v2.577 fixed the scope, which is what he actually wanted.

**The lesson generalizes past the wording.** The period bar sits DIRECTLY ABOVE this tile, so a
relative week-word in it will be read as the picked week every time — and a tile that answers a
question the selector does not control has to name its own scope or it inherits the selector's by
default. The durable fix was not better words; it was making the tile and the selector describe the
same window.

Rules, all pinned by `tests/recon_banked_kpi_test.js` (61 assertions, executes the shipped function
and asserts the markup):

- **A deposit belongs to the period ITS OWN DATE falls in** — not the period of the week it pays
  for. Inverting that is exactly the bug the old label had. Hence WK34 showing nothing.
- **The comparison is withheld unless every contributing week is WHOLLY inside the period and fully
  priced.** A week can bank in two deposits (Commercial routinely splits 3 days + 4 days), so a
  period can catch one and miss the other — measured: a September view holds only the 09-01 halves,
  $63,478.68 of the $191,617.26. Comparing part of a week's banking against a whole week's sales
  manufactures a shortfall out of a date boundary, the same error as pacing month-to-date against a
  full-month budget. `partial` suppresses Expected/Variance and the tile says why. All-or-nothing
  deliberately: mixing whole weeks with partial ones is the "two row sets" error again.
- **`outside` names the money for those same weeks banked in a DIFFERENT period**, and it is the
  number that explains a week reading oddly. Sky, 2026-09-07: *"wk 30 is abnormally high and wk 31 is
  low, the two combined look like it could be the right amount."*

  **He was right and nothing was broken.** Measured on the live `reconprobe`: **WK30 $283,835.57 over
  13 deposits** against a ~$186k / 7-deposit norm, **WK31 $97,959.90 over 6**, and the pair
  **$381,795.47** — two ordinary weeks. Every store banked TWICE in WK30: its usual Mon/Tue deposit
  plus an extra one on **Friday 07-31, the last day of July**, because a deposit spanning month end
  is split so the income lands in the right month. WK31's deposit then carried only the August
  remainder. Real money, correctly dated, genuinely lumpy.

  Both halves attribute to the **same store-week** (`2026-07-29..08-04`, verified against the shipped
  `reconWindowForDeposit`), so the CARD reconciles normally — it is only the calendar-week headline
  that splits. `inside + outside` equals the whole week from either side, which is what the tile now
  says rather than leaving the reader to notice the pattern across two weeks and ask.
- **Reconciled weeks still count.** `done` is Sky's progress through the list, not a fact about the
  money; dropping them makes the figure fall toward $0 across a session in which nothing happened.
- **Strays are not banking.** `deps` is already the sales banking; a `Printer Ink (refund)` carrying
  a store's class stays on the not-included list where it is visible.
- **Coverage is reported, never assumed.** `4 of 6 stores` renders in amber — a company figure
  quietly short two stores is the River failure shape.
- **Nothing banked returns NULL, never 0.** The caller renders a dash. A confident zero beside a
  variance measures a question nobody has answered yet.

**Swipe it to step the period — same gesture as the Income hero, and deliberately the SAME CODE.**
Sky, 2026-09-07: *"can we update so i can swipe the top KPI chip to switch the week, same as we do on
the income tab."* A swipe surface is now any element carrying **`data-pswipe="<selector>"`**; the
selector re-finds the node AFTER `periodStep` re-renders, because the element thrown off screen is
never the one that comes back. `#ic-mob-hero` was the first, `.recon-kpi` the second, and there is
exactly one `_pCommit` — a parallel implementation would drift from this one inside a release.

- **Cues live INSIDE the surface** (`.ic-swipe-cue.l` / `.r`), found by query rather than by the old
  global `ic-cue-l` id, so every surface carries its own pair and nothing needs a unique name.
- **`data-pswipe-mobile` restricts a surface to phones.** `#ic-mob-hero` does not need it — that
  element only exists in the mobile render — but the Reconcile tile is one element at both sizes, and
  on a desktop a click-drag across it is someone selecting the dollar figure, not asking to change
  the week. Verified: a 120px drag on a 1280px viewport changes nothing.
- **`.recon-kpi` needs `position:relative`** (anchors the cues) and **`touch-action:pan-y`** (or iOS
  claims the gesture and the swipe never fires). Both mirror `#ic-mob-hero`.
- **A drag starting on a button belongs to that button**, not the stepper.
- It steps whatever grain is selected, because it calls the same `periodStep`. Measured on a phone
  viewport: WK32 $188,358.79 → swipe left → WK33 — → swipe right ×2 → WK31 $97,959.90, and a 20px
  drag (under the 56px commit) correctly does nothing.

**The week total is already month-independent — do not "fix" it again.** Sky, 2026-09-07: *"when i'm
in week mode, i want to see the sum of what was deposited that week, regardless of the month. i
compare the performance by looking at the weekly deposits."* **It already was that sum**, verified
against QuickBooks to the cent (WK30 $283,835.57, WK31 $97,959.90). `reconWantedRange` stays
month-wide only to decide which store-weeks get BUILT, and the one-window reach-back guarantees every
deposit dated in the selected week has a row to land on: attribution is always the window containing
`date − 1`, and the list starts at `windowStart(from − 1)`, so the attributed window can never sort
before the first listed one.

What was wrong was the NOTE, not the number — it said money for these weeks was banked outside the
period, which reads as *your total is short* to someone comparing weekly deposits. It now leads with
**"This is everything banked in this period."** and says it is the GOAL comparison that is withheld.
A correct figure with a note that undermines it is a wrong answer.

### The QuickBooks deposit date is an ACCOUNTING date. The real one is in the memo.

**This is the root cause of the WK30/WK31 swing above.** Sky, 2026-09-07: *"we deposited on 8/4 for
the last days of the month (7/28-31) and back dated the deposit to 7/31 so it hits the P&L correctly,
but it messes up my 'week' view expectations."* `TxnDate` is deliberately, correctly wrong about when
the money moved; the deposit memo is the only record of the real date:

```
BEND 08.04.26 Dep (7/28/26 - 7/31/26)
```

GX Core publishes it as `note` on every `qb_deposits` row (**v305**, requested by Sales, cut
2026-09-07). `reconBankedOn_` in `dutchie_proxy.gs` reads it into **`banked_on`**; `reconBankedDate_`
in `index.html` is `banked_on || date`.

**Only the Reconcile WEEK headline uses it.** The P&L, every month view, and the store-week
ATTRIBUTION on the cards all keep `TxnDate` — that is what it is for. Moving attribution too would
change which week each deposit reconciles against, which is a different question nobody asked.

**Effect, measured:** WK30 $283,836 → **$182,306** and WK31 $97,960 → **$199,490**. The money is
conserved; only the week it lands in moves. On `TxnDate` alone WK31 held *nothing* of it.

#### The parser rules, and the live data that forced each one

**MEASURED over 140 deposits, 2026-05-01..09-07 — every one carried a memo.** Three of these findings
would have cost real money, and none is guessable by reading the format:

- **THE MEMO'S YEAR IS IGNORED; the year comes from `TxnDate`.** Six memos say `.25` in 2026 —
  `BEND 05.12.25`, `HILLSBORO 06.09.25`, `BEND 08.18.25` and their pairs. Obeying the typed year
  moves those six back **364 days**, out of the year entirely: money *gone* from the week rather than
  merely misplaced in it. `TxnDate` is never more than a few days off and cannot be fat-fingered, and
  the memo's year carries no information it does not already have. **This is why the parser waited
  for measurement** — one example string looks like a clean format and hides all six.
- **THE PERIOD IN PARENTHESES IS NEVER PARSED.** Not needed to answer "when did it bank", and it is
  the dirtiest part of the string: one memo reads `(5/6/26 - 0/0/26)`, another `Order Correction
  (refund` with no closing bracket. Anchoring on the date + `Dep` makes both harmless rather than
  special cases.
- **THE SEPARATOR IS OPTIONAL.** `CENTER08.05.26 Dep (…)` — one in 140 has no space. Requiring one
  drops that deposit, and a dropped deposit is the vanishing-row failure this tab exists to prevent.
- **A LAG BOUND IS THE SAFETY NET** (`RECON_BANKED_MAX_LAG_`, 14 days). Observed lags are
  0,+1,+2,+3,+4,+5,+7 and **never negative** — you cannot bank money before you book it. Outside
  0..14 is a typo, not a fact, and falls back to `TxnDate`. That bound is what makes the year rule
  safe *by construction* rather than by correction.
- **`''` means "use TxnDate"**, which is exactly the old behavior, so a memo this cannot read costs
  nothing. Three refund memos in 140 carry no date at all and correctly fall through.

**The banked date is NOT a uniform offset.** At the July month end Bend/Hillsboro/River banked 08-04
and Center/Commercial/Portland Rd banked 08-05, so any "month-end deposits land on the 4th" rule
would be wrong. Only **15 of 140** deposits change calendar week at all; the ordinary +1 day never
crosses a Mon–Sun boundary because the stores bank on Mondays and Tuesdays.

**Do not join on the memo's store name.** It is a THIRD vocabulary — `BEND`, `CENTER`, `HILLSBORO`,
`PORTLAND RD`, `RIVER`, **`SOUTH`** (= Commercial) — neither `store_id` nor the QB class already
mapped verbatim by `RECON_STORE_BY_CLASS_`. The line carries the class already; read the DATE and
ignore the rest, or you have a fourth mapping to drift.

**`?action=reconprobe` reports `deposit_notes`** — every distinct memo per store, paired with the
dates it was booked on, plus `notes_seen`. That is how the above was measured and how the next
format change gets caught. `notes_seen: 0` over a range that HAS deposits means this app is pinned to
a GX Core without `PrivateNote`, so it doubles as the re-pin check — the goalprobe/v223 lesson, where
a pin reporting the right version and still returning the wrong data is a different failure from one
that never took.

`tests/qb_deposits_shape_test.js` (38 assertions) executes `reconBankedOn_` against every live case
above, including all three refund memos and each year typo.

**Corporate money was NEVER in the headline — the NOTE was what said otherwise.** Sky, 2026-09-07:
*"the KPI card should exclude any deposits that have been ignored, so wk31 should be
199490-12662-27"*, then *"or if its easier, only show deposits attributed to store CLASS's, not
Corporate"*.

**It already did.** MEASURED on the live route: WK31 holds 13 deposits totalling $212,152.49, of
which 12 are store-classed sales banking summing to exactly **$199,489.58** — the figure on screen.
The $12,662.91 *South Accident (January) Insurance Reimbursement* is classed **CORPORATE**, so it
belongs to no store and never enters a row; the $26.84 *Q1 Refund* is CORPORATE too and is dated
08-11, which is **WK32, not WK31**. Over 2026-07-01..09-07 those two are the only deposits with no
store class, and there are **no** store-classed deposits whose memo is not sales.

What misled was the line underneath: *"Ignoring 2 deposits not included in a store's week
($12,689.75)"* — 12,662.91 + 26.84 — sitting directly below a large total without saying which side
of it they were on. **The arithmetic never changed; the sentence did.** It now reads "Not in the
total above", and the headline's sub-line ends "store sales banking only", so the question does not
arise from the screen.

Two structural reasons that money cannot reach the headline, both pinned by
`tests/recon_banked_kpi_test.js`: an unattributed deposit is in no store row at all, and a
store-classed deposit whose memo is not sales is set aside by `reconBuildRow` into `strays`, which
the KPI never reads — it sums `deps`.

*The lesson is the one this tab keeps teaching: a correct figure with an ambiguous sentence under it
is indistinguishable, to the reader, from a wrong figure. The same failure as "Deposited this week"
and as "banked in another period", three times in one day on one card.*

**The state colors MUST stay qualified as `.recon-kpi-figs strong.recon-kpi-off`.** The bare class is
(0,1,0) and the `.recon-kpi-figs strong` rule above it is (0,1,1), so a lone class loses and the
variance renders in plain body text — the one figure on the card that has to read as a state. Found
by `getComputedStyle` returning `rgb(230,236,233)` while the screenshot looked fine. Same trap as
`#dsk-subnav`, and the same lesson: **a screenshot does not verify a color.**

**The pacing section renders ALL six stores from the first frame — don't filter it back down.**
`_storeBreakdownRows` deliberately does *not* filter to `liveData[s]`. A store with no data yet is a
row carrying its name, its bar track and shimmer placeholders, so the card is **245px at every
stage** — nothing loaded, half loaded, fully loaded. Filtering meant six height changes per load,
and `loadAllStores` clears `liveData` before refetching, so a re-poll tore the list down and rebuilt
it under the reader. It also made a straggler *invisible*: a store that never answered had no row,
which reads as "no such store" rather than "still waiting".

Sorting is the other half and breaks the same way if touched. **Sort only when every store has
landed**, remember that order in `_bdOrder`, and reuse it while anything is pending — that is what
makes a re-poll refresh numbers in place instead of reshuffling. Sorting by value while values are
still arriving is precisely what makes rows jump.

**Goals: the FROZEN PAY-PERIOD goals are authoritative, in every view.** Until v2.541 only the DAY
view read GX Core's `period_goals`; week, month and YTD read the budget spreadsheet, and
`loadPeriodGoals` was only ever called with `activeDay`, so the frozen goals were never even fetched
elsewhere. The same past period therefore showed two different goals depending on which view you
stood in. Measured over all 18 pay periods of 2026: **budget $4,679,904 vs period goals $5,017,051
across Jan–Jul, +7.2%**, and Portland Rd off by **+39% to +49% every month**. Sky's call
(2026-08-29): the period goals win — they are what the Leaderboard publishes and what staff were
measured on. Precedence in all three accessors is now **frozen goals → `lbGoals` → budget**, where
"budget" since 2026-08-30 means the FROZEN `frozen_goals` property, not the spreadsheet — the sheet
is no longer read at all (see the severance section above).

- **`pgTotal` returns NULL, never a partial sum**, for a window with any uncovered date, and the
  caller falls back to the budget. An understated goal renders identically to a correct one; this is
  the past-year bug one level down. Don't "improve" it into summing what it has.
- **Portland Rd's period goal is a flat $41,500 in every pay period** while all five others move
  every period. **Confirmed intentional by Sky** — its ~40% gap against its budget line is the right
  answer and must not be reconciled away.

  *But the goal this app RENDERED was not always that $41,500, and the reason is worth keeping.*
  Sales sums `dow_targets` per date; it never reads `period_total`. On the Leaderboard a manual
  override rescaled the day-of-week shape by `manualPP / g.ppGoal`, which only lands on the override
  when `2 x sum(dowAvg) == ppGoal` — and that identity breaks whenever the 12-period window is
  missing days (`ppGoal` falls, the per-weekday means do not) or carries an extra one from a
  DST-stretched range. Portland Rd's sales history starts **2025-07-29** (derived here: two
  different windows independently imply it), so the period from 2025-12-22 was short 22 of its 168
  days and this app rendered **$47,735** — 15% over the goal Sky set. The next period rendered
  $43,564; from 2026-01-19 the window cleared the gap. Since 2026-04-27 one extra window day held it
  0.7% light instead.

  Fixed in `greencross-leaderboard` **v1.667** (2026-08-30) by normalizing on the shape's own
  two-week total. Verified at the source: GX Core's `period_goals` row for 2026-08-17 now reads
  `period_total 41500 | 2xdow 41500`. **The two distorted periods were NOT corrected** — a closed
  period is locked, `writeGoalLedger_` refuses it and there is no unlock route, and that is
  deliberate: they are what staff were measured on. Sky's call, 2026-08-30.

  Two things NOT to conclude from that fix. The three `auto` stores also show `2xdow` about 0.5%
  under their `period_total` in the same period — same extra-day effect, but for an auto store there
  is no intended figure, so the shape and `ppGoal` are two equally legitimate readings and nothing
  reads `period_total` anyway. Leave it. And a `goalbackfill` would NOT have repaired the two bad
  periods even unlocked: it reconstructs as-of over the same window, and the gap is real history
  that will never fill in.
- **The current month usually still shows budget/lbGoals**, because the period covering its last day
  or two is often unpublished and a partial window refuses. Deliberate: a goal that silently grew as
  periods landed is worse than one that settles once.
- **The ledger runs 2025-11-10 to 2026-08-30** (measured 2026-08-30). Nothing before or after. A past
  YEAR gets no goal at all — the budget sheet is one year wide and gated to `BUDGET_YEAR` since
  v2.540, because the picker offers curY-2..curY and every 2024/2025 view used to be measured against
  the 2026 plan.

**`period_goals_range` walks periods, and four things about it are load-bearing.** Each was found by
MEASURING the deployed route, not by reading it — every one of them looked fine in the source:

1. **Ask with an EMPTY store.** `getPeriodGoals` re-reads the whole `period_goals` tab on every call,
   so per-store asking meant six full tab reads per period — a cold YTD took **42s**. The store-less
   form returns `picked`, one row per store, in one read.
2. **An empty `picked` is an ANSWER, not a failure.** `{ok:true, picked:[]}` means no period covers
   that date. Falling through to the per-store fallback on it made a miss cost seven calls instead of
   one.
3. **Decide coverage BEFORE `cacheGet_`.** It is two CacheService round-trips per date; a 182-day
   out-of-range walk spent **12–22s** in lookups for dates that cannot have an entry.
4. **Use the exact INTERVALS, never a min/max span.** The tab holds a sentinel row dated
   `2000-01-01`, so a span reported twenty-six years as findable and a 2024 range still took 17.8s.
   `pgLedgerIntervals_` reads only period DATES from the raw rows — never a goal value, never a
   tie-break, because picking a goal out of raw `rows` by hand is the `match[0]`-in-sheet-order bug
   that forced the v220 re-pin. An overlapping orphan costs one lookup, never a wrong goal.

Net: 2024 17.8s→2.5s · 2028 39s→1.5s · March 1.7s · YTD 42s→3.9s. `?action=goalrangeprobe&start=…
&end=…&secret=…` is the secret-gated twin; it reports `periods`, `uncovered_days`, `truncated` and
`ledger_intervals`. **Re-run it after any GXCore re-pin** — like `goalprobe`, it discriminates.

**`?action=attainprobe&start=…&end=…&secret=…` — goal vs ACTUAL, added 2026-08-30.** The frozen
period goal against real net sales, per store, per pay period. Both halves sat behind the login
gate, so "what has attainment been" was a question nobody could answer without adding up screens by
hand. Goal side comes from `getPeriodGoalsRange_` itself — not a second copy of the ledger walk, so
it cannot report a goal the app does not show. Actual side is `GXCore.getSalesDaily`, read ONCE per
store over the union of the kept periods (six calls, not six per period). ~16s for a full year.

Two refusals are the POINT of the route, not gaps in it. They are the same mistake in opposite
directions — comparing a partial to a whole — and both render as a believable percentage:

- **An unsettled period is excluded and NAMED** in `skipped_periods`. The open period holds a few
  days of sales against a full fortnight of goal; counted, the company reads ~20% and someone
  panics. Same reason the smart budget drops the month in progress.
- **A store-period missing any sales day is reported but left out of every total**, carrying
  `days_missing` and `counted: false`. A failed `getSalesDaily` lands in `read_errors` rather than
  reading as a store that sold nothing — a silent 0% is the most alarming wrong answer available
  here. **Read `counted` before believing any single row**; the totals only ever sum rows where it
  is true. `tests/goal_attainment_test.js` (36 assertions) executes the shipped `attainProbe_` in a
  `vm` and asserts the totals equal EXACTLY the sum of counted rows, not "close to".

**The measured baseline (2026-08-30, 17 settled periods 2025-12-22 … 2026-08-16): 95.0%
company-wide** — $5,631,004 goal against $5,349,927 actual. Per store: Hillsboro **104.5%** ·
Commercial 98.2% · Center 96.7% · Bend 96.3% · River **88.8%** · Portland Rd **86.3%**.

So the bar is ~5% above what gets delivered, which is a sane stretch. The spread is not, and it has
a mechanical cause worth knowing before anyone "fixes" a store: the goal is a 12-period TRAILING
MEAN, so it lags. **Hillsboro's goal has been rising** (36,207 → 41,672/period) and its bar sits
below where the store now is; **River's has been falling** (71,830 → 64,458) and its bar sits above,
because an average of better months cannot be caught — and `max(rolling, YoY)` stops it descending
as fast as the store does. Growing stores are flattered, shrinking ones punished. That is the
answer to "the goals feel too high", and it is NOT the stretch multiplier, which is **1.0%**
(measured: published payload / frozen row = 1.0100 on five stores) and **0% on Portland Rd**,
because a manual override zeroes stretch. Stretch also cannot compound — the next goal is computed
from actual SALES, never from the previous goal.

## Every GX Core retry in the backend is now on a 60-second clock

All four /exec retry loops in `dutchie_proxy.gs` — `gxDutchieGet_`, `gxCoreRoute_`,
`qbReportViaGXCore_`, `qbDepositsViaGXCore_` — retried on a stopwatch nobody was holding. Attempt
counts are 5, 3, 5, 5; nothing measured how long the whole loop had already taken. **Apps Script
kills a script at 360s**, so a bouncing endpoint could make the loop outrun the cap, and the caller
then got a *dead request* instead of the clean `unreachable` error the loop exists to produce. A
retry that converts a clean failure into a timeout is worse than no retry. `GXCORE_RETRY_BUDGET_MS`
(60,000) is checked **before sleeping and re-asking**; the full derivation of the number is in the
comment above the constant, and `tests/gxcore_retry_budget_test.js` (55 assertions) executes all
four loops against a scripted clock.

**Do not sync that constant from another app.** Price Cards picked 45,000 the same day for a
three-attempt loop; these make five, and this app's own healthy attempt measured 21.6s once in 49
live samples. The number is derived from this repo's measurements and the 360s cap, not shared.

**This app's `probeMark_` marks are NOT a log — nothing accumulates across executions.**
`_PROBE_MARKS` is `null` unless `loadProbe_` turns it on, and it is set back to `null` at the end of
every store, so the per-attempt durations `gxDutchieGet_` records exist only inside the response of
a `?action=loadprobe` call. There is no history to read back and no "worst ever" to look up. **The
suite's only persisted /exec telemetry is GX Core's**, at `?action=request_stats` (deploy-secret
gated): `timing[]` is GX Core's own execution time and `caller_wait` is a real round trip through
`/exec`, sampled every 10 minutes by `gxProbeSelfScheduled`. Read live 2026-09-12 it said 147
probes, 7.9s average, **628.8s worst**, and — the number that matters — **11 multi-hop (bounced)
probes averaging 46.6s against 136 single-hop averaging 4.8s**. That is where "the bounce is slow"
comes from; measuring this app alone during a good spell says nothing, as 49 clean samples that
afternoon demonstrated.

**Known and deliberately NOT changed: `getCogsDutchie` calls `gxCoreRoute_` once per store, six
times in sequence.** A per-call budget cannot bound that loop — six bad calls exceed the cap no
matter what each one is allowed. It survives today because each store is individually `try`/`catch`ed
and the whole result is cached (10 min / 6 h). Bounding it properly means a loop-wide deadline and a
partial Gross Profit figure, which is a behavior change, not a guard.

## Today's sales are pulled ONCE and shared — the cost scaled with tabs, not people

Every read this app makes comes out of `CacheService`, which lives on the SCRIPT and is therefore
shared by every viewer: settled days (`sdaily_v4_…`), expenses, deposits, goals, budgets. **The
intraday Dutchie pull was the lone exception, and the expensive one** — a live transaction pull with
`includeItems`, one per store, six per load, and the client polls every 60s per open tab. A
back-office monitor plus a phone plus a laptop, all showing the same six stores, was **18 identical
Dutchie pulls a minute**. Cached for 90 seconds in `dutchieTodayFetch_` since v2.569.

**Measured on the live deployment (2026-09-03, River Rd, Sept 1 → now):** a forced-fresh pull
(`&nocache=1`) took **50.1s**; served from the shared entry, **3.0–3.6s**. Identical payload every
time — $11,601.96 net, 58 live orders. That 50 seconds is what each tab was independently paying,
and it is the answer to "why does this feel congested".

- **90s, not 5 minutes, and not 60.** The poll is 60s, so a TTL at or under it leaves nearly every
  poll paying full price — the silent way this change would have accomplished nothing. Much longer
  and the "Live" pill starts lying.
- **Keyed on `store` + `todayPT`, deliberately NOT on the caller's `to`.** That is a live timestamp
  that changes every request; folding it into the key gives a cache that can never hit — correct
  numbers, unchanged congestion, and nothing anywhere saying so. Dropping it is exactly the
  staleness the TTL already licenses: the window is always "Pacific midnight → now", and "now" is
  allowed to be up to 90 seconds ago.
- **`nocache` bypasses, and that escape hatch is what makes the cache safe to add.** Settings →
  "clear cache" means *this data is wrong, go and look again*, which a served copy cannot honor.
  On the client it is a **deadline, not a boolean** (`_serverBypassUntil`): a flag has to be cleared
  by somebody, and the load meant to clear it is exactly the load that can throw or be superseded
  mid-flight, leaving every poll bypassing forever — strictly worse than never having cached. A
  timestamp expires whether or not anything goes right.
- **A corrupt entry falls through to a live pull rather than throwing.** A half-written cache must
  cost a fetch, never the store's whole row — the same rule the render guards follow.
- The compare-period fetch (`_fetchCompareStore`) does **not** bypass. Its ranges are historical, so
  it reaches no live pull, and a compare has no business forcing anyone else's re-fetch.
- `tests/intraday_cache_test.js` (16 assertions) executes the shipped wrapper against a counting,
  expiring cache fake and asserts on the NUMBER of live pulls. Verified to fail against the pre-fix
  source.

**`serve.js` must never reach Apps Script, and here `.claspignore` is the only thing stopping it.**
The shared dev-file sync (2026-09-03, `bd7f5e2`) dropped a Node dev server at the repo root; this
repo's `rootDir` is `"."` and its `.claspignore` is a DENYLIST that names offenders, so `clasp push`
shipped it as `serve.gs`, where `#!/usr/bin/env node` on line 1 is a parse error that **fails the
entire push** — not just that file. Third instance of the same mechanism after `tests/`
(2026-08-22) and `design_handoff_*/` (2026-08-25). Fixed here in `94411ef`.

*Two claims in the first version of this paragraph were wrong, both by over-generalizing from this
repo — corrected 2026-09-03 after core-admin MEASURED the guard against all six repos' real configs
with `serve.js` forced present:*

- *"Every spoke that has run `./gx-sync.sh` carries the same landmine" is **false**. Only **sales
  and inventory** were ever exposed, and both are fixed. `performance`'s `.claspignore` is an
  ALLOWLIST (`**` then `!index.html`, `!goals.gs`, …), so it excludes `serve.js` without naming it;
  `spiff`, `crew` and `pricecards` set `rootDir` to `apps-script`, putting a root file outside push
  scope entirely. **Don't "fix" those three** — core-admin has told the other session the same.
  Two sessions string-compared `rootDir` against `"."` and called spiff armed; the allowlist shape
  is the half that gets missed.*
- *"Nothing excludes JS by extension, so a fourth is already possible" had the mechanism backwards.
  clasp pushes `.js` / `.gs` / `.ts` / `.html` / `.json` and ignores everything else, and
  **`serve.js` is the first root-level `.js` file gx-sync has ever placed** — `deploy.sh`,
  `gx-preflight.sh` and `gxengine.sh` are `.sh`, `serve.py` is `.py`. Months of clean syncs were
  extension, not diligence. The category is a set of ONE today; the next `.js` gx-theme syncs re-arms
  every denylist repo silently.*

The durable fix is in gx-theme (`0a53356`): `gx-sync.sh` now warns at the moment such a file lands
and prints the exact append. It warns rather than fixing because `.claspignore` is per-project truth
— which `rootDir`, which `.gs` are real, which are separate bound projects — and so cannot be synced.

**`getCogsDutchie` is cached at the proxy — leave it that way.** It was the only route the Income tab
touches with no server-side cache, and the most expensive: six `getSalesDaily` reads plus **six live
`dutchieClosingReport` calls, one per store, in sequence**. The Gross Profit card waits on it, which
is why that card was always the last to fill in. Cached by range: 10 min while today is in the
window, 6 hours once the range is settled. The client key `inv_gm2_<today-28>` rotates daily by
design; its TTL used to resolve through `CACHE_TTL['inv']`, *a key that did not exist*, to the 1-hour
default — so a phone re-triggered twelve backend calls hourly.

**A stale tab now says so.** `gcCheckVersion` compares `APP_VERSION` against the newest row in GX
Core `version_history` and offers a cache-busting reload. It never reloads on its own, is suppressed
while signed out and for a version already dismissed or already attempted (Pages can serve a stale
copy for a minute after `deploy.sh` records the release — without that guard the reload loops).
There is no `?v=` cache-buster to check instead: this is a monolith with inline JS, so the HTML *is*
the bundle.

*When GX Core's two-hop flakes it can return a TRUNCATED body, which fails JSON parsing as an
"invalid control character" mid-string. That is the documented ~6% flake, not malformed output —
**retry until it parses**, and don't reach for a lenient parser, which turns a cut-off payload into
one you'll treat as complete.*

**The write guard is LIVE BUT DARK — don't mistake it for enforcing.** All four writes
(`save_expense_mapping` GET+POST, `set_otherrev`, `set_revenue`, `clear_atm_cache`) call `writeGuard_`,
which asks `GXCore.roleForApp(user, 'sales')` and **records what it would have decided without acting on
it**. Mode is the `GX_WRITE_GUARD` script property: `log` (default) · `enforce` · `off`.

Read the decisions, never infer them:

```
curl -sL -G "<sales /exec>" --data-urlencode action=authprobe --data-urlencode "secret=$(cat .gx_deploy_secret)"
```

`write_guard_log` is a capped ring of the last 25 decisions, recording **admits as well as refusals** —
deliberately, because "refuses the bad" and "admits the good" are two different assertions and only the
second one licenses flipping to `enforce`.

**Do not flip to `enforce` until the log shows a real NON-SUPERADMIN user ADMITTED.** Probed on live v170,
`roleForApp` returned a role for exactly one account — `sky`, who is also the account that deploys.
Everyone else came back null, **including Shawn — because he has not been granted access in GX Core yet**
(confirmed by Sky 2026-08-20). That is the true answer, not a lookup miss and not the local-fallback theory
that was current when the guard was built. Shawn is a user of this app, not its owner; Sky owns it.

**ENFORCING since 2026-08-20.** `GX_WRITE_GUARD` = `enforce`, flipped by Sky's explicit instruction after
the admit test below passed. Reads unaffected; unauthenticated and forged-token writes are still refused at
the session gate ABOVE the guard, so a signature failure never reaches the grant lookup. **Roll back in one
command:** the same `guardmode` call with `mode=log`.

**A ROLE IS NOT PERMISSION TO WRITE (fixed v2.593, 2026-09-14).** Until then the guard admitted any
user holding ANY Sales role, so a `viewer` passed `enforce` on every write. Measured live before the fix:
GX Core's read-only dev session (`gx-dev`, role viewer) got past the guard on `set_recon` and was stopped
only by a deliberately invalid date. The guard now also requires `GXCore.roleCanEdit(role)` — never a local
list — refuses a viewer with `code: read_only`, and treats a pin without `roleCanEdit` as a Core error
(fail closed). The tally gained `refused_read_only`. **Re-verify after any deploy with that same probe:**
`dev_session` token → `set_recon&store=Bend&start=not-a-date` must answer `read_only`, not the date error.
`tests/write_guard_test.js` 2b, verified by mutation (7 assertions fail against the old condition).

**Pinned to GXCore — check the live value, do not trust this line** (`?action=libversion`, or `./gxpins.sh --live` from the hub). Measured **v315** on the live `/exec` on 2026-09-09 (from v310, one bump covering v311-v315); it read *v223 (2026-08-25, from v220)* until 2026-08-29, when the app had moved to v241. That is a reading, not a promise — take your own. The history below is still accurate as history. Two re-pins the
same day, and the second one is the one that finished the job — see the store-key entry below. Verified
live after the redeploy: `?action=libversion` → `{"ok":true,"gxcore":223}` six consecutive reads (no
warm-instance lag this time), `gxpin` → `gxcore_version 223` with `qb.last_source` still `gxcore@…`,
`authprobe&user=shawn` → `role editor` / `write_guard_mode enforce`, `pnlprobe` → `qb_source gxcore` with
all three P&L identities balancing, and `goalprobe&date=2026-03-05` → **all six stores** on
`2026-03-02..2026-03-15`: River 70711 · Bend 63205 · Hillsboro 36663 · Portland Rd 41500 · Center 23223 ·
Commercial 89177.

**Superseded — kept for the reasoning.** Pinned to GXCore v220 (2026-08-25, from v213; deployment
`AKfycbzju5He…@175`). The reason was
`getPeriodGoals`: through v218 it returned `match[0]` — the first matching row in SHEET ORDER — and GX
Core held both the stale and the corrected DST pay-period rows, with the stale ones earlier in the sheet.
Every date from 2026-01-05 to 2026-03-15 resolved here to a period that never existed; March carried a
14-day goal total over a 15-day window. Verified live after the redeploy: `?action=libversion` →
`{"ok":true,"gxcore":220}` five consecutive reads, `gxpin` → `gxcore_version 220`,
`authprobe&user=shawn` → `role editor` / `has_roleForApp true` / `write_guard_mode enforce`, and
`goalprobe&date=2026-03-05` → `2026-03-02..2026-03-15`. A `pnlprobe` in the same window returned
`qb_source: gxcore` with all three P&L identities balancing, so the QuickBooks-through-Core path is
healthy on this pin too.

**`action=goalprobe` — secret-gated, added 2026-08-25.** `getPeriodGoalsForDate_` sits behind the login
gate, so proving a re-pin resolves dates to the right pay period used to mean opening a browser and
logging in. Same trick and same reasoning as `pnlprobe`/`reconprobe`: read-only, runs the real path in
the live runtime, returns exactly what the app would render.
`?action=goalprobe&date=YYYY-MM-DD&secret=…`.

**FIXED in GXCore v223 — the story is worth keeping, because the bug was invisible by construction.**
Through v220, `GXCore.getPeriodGoals` matched the store with exact `gxSlug_` equality, but the
`period_goals` tab is keyed by **alias**: the rows are `baseline`, `center`, `century`, `commercial`,
`portland`, `river`. `getPeriodGoalsForDate_` asks with Dutchie names, so only `Center` and `Commercial`
hit — and **only because for those two the canonical id and the alias happen to be the same word.**
`Bend`→`bend` vs row `century`, `Hillsboro`→`hillsboro` vs `baseline`, `Portland Rd`→`portland-rd` vs
`portland`, `River Rd`→`river-rd` vs `river` all returned null, and the `catch(e2)` in that loop makes a
lookup miss indistinguishable from a store with no goals. Four of six stores silently had no period goals
for as long as the tab had been keyed that way. Found here 2026-08-25 while verifying the v220 re-pin,
raised as `note_mt99ji06_9as`, fixed in **v223** — `getPeriodGoals` now resolves BOTH sides through
`gxResolveStore_`, additively (`store` stays as the sheet holds it, canonical `store_id` alongside), and
an unknown store still returns null rather than guessing at a neighbor.

**The lesson, not the incident:** the fix belonged in Core and the workaround belonged nowhere. A
store-alias table in this repo would have made Sales look correct while four stores kept paying for a
Core bug that Leaderboard cannot see either — it reads `getPeriodGoals` with an EMPTY store and never
reaches that comparison. `never hardcode stores` is not only about Command Center edits flowing through.

*One claim in that note was wrong and core-admin corrected it: **`expectedSalesFrac` does NOT share the
assumption.** It delegates to `getHourlyShape` (`gx_dutchie.gs`), which already calls `gxResolveStore_`
and carries a comment naming this exact scenario. `getPacingFracs_` is fine as written, and
`getPeriodGoals` was the lone holdout rather than one instance of a pattern.*

**`goalprobe` is what made this findable, and it is now a discriminating test.** Before the fix it
returned two stores; after, six. Re-run it after any GXCore re-pin — a pin that reports the right version
and still returns two stores is a different failure from one that never took.

**Superseded — kept for the history.** Pinned to GXCore v213 (2026-08-23, from v204; deployment
`AKfycbzju5He…@160`). The reason was the
shared bug reporter: on v204 `gxIngestBug` does **not** self-install the `bug_reports.context` header, so
every 🐞 filed from Sales silently lost its state snapshot while still returning `ok`. Sales was filing
half-reports until this landed. Verified live on the deployed `/exec`: `?action=libversion` →
`{"ok":true,"gxcore":213}`, eight consecutive reads.

**Two cautions were attached to that re-pin. Both are now DISCHARGED — 2026-08-24:**

- **~~The admit check was NOT re-run~~ — RUN 2026-08-24, and it PASSES on the hand-typed path.**
  `authprobe&user=shawn` under v213 returns `role_for_user {"user":"shawn","role":"editor"}`, with
  `has_roleForApp true`, `gxcore_version 213` and `write_guard_mode enforce`. So the nine-version crossing
  did not break `roleForApp`, which was the fear — `writeGuard_` fails CLOSED, so a Core-side break would
  have looked exactly like an outage.
  **CLOSED 2026-08-24 on Sky's word: Shawn has saved under v213 several times, so the token-derived
  path is exercised and this caution is spent.** Rollback is unchanged and one command:
  `guardmode&mode=log`.

  One footnote, deliberately not an open item: `write_guard_log` was showing only three admits, all
  v194-era, with nothing after the v213 re-pin — so it is probably not capturing every write. **Sky's
  call (2026-08-24): don't track this.** The guard enforces and admits correctly in practice, which is
  what matters. Don't cite the log as proof of an admit, don't read its silence as a problem, and don't
  re-open this on your own — if it ever bites, Sky will raise it.
- **~~`gxpin` itself was not read~~ — READ AND CLEAN 2026-08-24.** It returns
  `{"gxcore_version":213,"qb":{"secret_configured":true,"last_source":"gxcore@2026-08-24T23:32:08Z"}}`.
  So `GX_DEPLOY_SECRET` is set on this script and the connector that actually served the last uncached
  Expenses load was **GX Core, not the legacy local QuickBooks token** — the silent-fallback hazard this
  bullet was raised about is not present. That reading, holding across four days and the v153 → v213
  re-pin, is what licensed **deleting** the local path outright on 2026-08-24 (see above). Re-check after
  any deploy that touches script properties; a `Forbidden` here is the finding.

**`gxengine.sh` — FIXED 2026-08-24, safe to use again.** It used to pick the highest `@version` among
non-HEAD deployments, and this script has a stray `AKfycbxDmCB_…@159` that outranked the one every caller
actually uses (`AKfycbzju5He…`, hardcoded as `DEFAULT_PROXY` in `index.html`) — so `--deploy` would push
to HEAD, redeploy the stray, and report success while the live `/exec` kept serving the old snapshot.
core-admin fixed it in gx-theme; `./gx-sync.sh` pulled it here. It now matches deployment ids against the
ones this repo's own source references, and **stops** rather than guessing when it cannot tell
(`GX_DEPLOY_ID=` overrides). Verified by running it: it resolves `AKfycbzju5He…@161`, *"referenced by this
repo's source"*. The by-hand path still works if you want it: `clasp push --force` then
`clasp update-deployment AKfycbzju5He…`.

**`deploy.sh` reads `git show HEAD:index.html`**, not the working tree — same 2026-08-24 sync. It used to
grep the version off disk while pairing it with a sha from `git rev-parse HEAD`, so a mid-edit tree could
record a version and a sha that never coexisted. `GX_VERSION=vX.YYY` records an exact version;
`GX_ALLOW_DIRTY=1` proceeds when HEAD and your tree disagree, which otherwise stops with both printed.

> Both scripts are synced from gx-theme. After **every** `./gx-sync.sh`, `chmod 755` them before
> committing — Dropbox strips the exec bit back to 0600 on its next sweep.

**`ATM_MACHINE_MAP` (`dutchie_proxy.gs`) must NOT be switched to `GXCore.resolveStore()`.** core-admin's
re-pin notes carry a blanket line saying to use `resolveStore()` if you fold store names yourself; it does
not apply here. That map keys **ATM machine labels**, not stores, and `resolveStore` has no machine concept.
**Measured by EXECUTION** (2026-08-22) — the real `gxResolveStore_` run against the live `stores` rows,
not modeled from `?action=stores`. Of the map's **22** labels the swap drops **13 to null**, leaving 9.
**All 9 ATM 2 labels are among the drops; every survivor is ATM 1**, so Bend, Commercial, Hillsboro and
River each lose their second machine entirely. ATM revenue would quietly shrink with no error anywhere —
in a lookup map `null` does not mean "wrong bucket", it means the row **vanishes**.

**There is no merge risk**, contrary to an earlier claim here. The map has 8 collision groups and every
one collapses to an identical `{store, machine}` — `Commercial`/ATM 2 alone has four labels. Collapsing
any group loses nothing; all the damage is in the drops.

*Provenance, since this paragraph previously said otherwise: the earlier "19 labels / 11 to null / merges
`center st`+`center`" figures were **core-admin's**, not Sky's, produced by reading the map through
`grep -A 20` — which truncated it — and retracted the same day. This app caught the error twice: first by
parsing the literal, then by refusing to let core-admin's replacement number harden while it was still
modeled. Modeling undercounts survivors, because `resolveStore` token-folds before matching and strips a
trailing ` rd`/` st` — so `center st` resolves to `center` even though that store publishes only
`["Center"]`.*

**Re-confirmed on 2026-08-22 under GXCore v194.** The app was re-pinned v188 → v194 and redeployed;
Shawn then saved an expense mapping successfully. That matters because `writeGuard_` fails CLOSED — a
Core-side change that broke `roleForApp` would look exactly like an outage, and the six versions crossed
included v191, which changed `gxRead_` to return null-prototype rows that cross the library boundary into
this app. A real non-superadmin admit is the only evidence that actually settles it; the deployer's own
account cannot, because `sky` is superadmin and resolves by a different path.

**The admit test PASSED on 2026-08-20 and is what licensed enforcing.** Shawn was granted, signed in and
saved an expense mapping, and the guard recorded `user shawn / role editor / err null`, with
`tally.first_admit` stamped and zero refusals. That closes the last gap: my earlier probe passed a
hand-typed `"shawn"`, whereas this exercised the REAL path — session token → `auth.user` → `roleForApp` —
proving the token-derived id matches what the grant lookup expects. A mismatch there would have refused him
while the probe kept saying `editor`.

Flip it with `action=guardmode` (secret-gated, below). Enforce mode changes nothing for an admitted user:
the same call already ran in production and returned `editor`; enforce only acts on a null.

**Know the tradeoff before flipping:** enforce fails CLOSED on a Core error as well as on a missing grant,
per core-admin's rule for auth checks. That means a GX Core outage blocks Sales writes — deliberate, since
failing open on an auth check is no check at all, but it is a real availability cost that the read paths
do not pay.

**SUPERSEDED — kept for the reasoning, not the conclusion.** The two paragraphs below argue for staying in
`log`; that was the correct call *until* the admit test passed on 2026-08-20. The guard is **`enforce`**
now. Read them as the rationale for why the admit test was required first, not as current state.

**Why it stays in `log` even though Sales is effectively single-user today.** Sky is currently the only
account that resolves, and he is superadmin, so enforcing right now would be harmless — and would also buy
almost nothing, since the whole point of the check is closing a revocation window and there is presently no
non-superadmin grant to revoke. The risk is all on the other side: flip it now and the FIRST person ever
granted meets a live fail-closed gate on day one, with no evidence it admits anyone but the deployer. Log
mode costs nothing and collects exactly the evidence that removes that risk.

*No longer true since v2.594:* this app HAD a **local-login fallback** (`gc_sales_users`, holding only
`sky`), so "signed in" and "holds a grant" were two different statements here. See the sign-in section below.

**SIGN-IN IS GX CORE ONLY, AND RENEWAL RE-CHECKS THE GRANT (v2.594, 2026-09-14, Sky's call).** Two ways
in skipped the Command Center. (1) `loginUser` retried ANY `GXCore.login` refusal against `gc_sales_users`,
so an old Sales password for `sky` kept working after the Command Center password changed. The fallback
is deleted outright, **including for a Core outage**: this app shows nothing without GX Core, and issued
sessions validate here on the shared secret, so an outage costs new sign-ins only. Don't re-add a
"temporary" one — same reasoning as the QuickBooks local path. (2) The 10-minute `ping` minted a fresh
7-day token from a signature alone, so a removed person stayed signed in while their tab was open.
`pingSession_` now refuses when `roleForApp` answers null (client signs out within ~10 min), and **still
renews on a Core ERROR** — failing that closed signs the office out on every bounce, and writes are failed
closed by `writeGuard_` regardless. *Not closed:* a token copied out of a browser still reads for up to
its 7-day expiry, because read routes check the signature, not the grant. `tests/login_core_only_test.js`
(20 assertions, 12 fail against the pre-fix source). The `gc_sales_users` PROPERTY may still exist on the
script (authprobe `local_users`); nothing reads it for sign-in, and deleting it is safe.

**Flip or roll back the guard by curl — `action=guardmode`, no editor needed.** This exists for ROLLBACK,
not convenience: the guard arms a fail-closed auth gate, so a revert must be seconds away and must not
depend on anyone being at a browser.

```
curl -sL -G "<sales /exec>" --data-urlencode action=guardmode --data-urlencode "secret=$(cat .gx_deploy_secret)" --data-urlencode mode=enforce
```

`mode` is one of `log` · `enforce` · `off`, validated against an array with `indexOf` — deliberately not an
object checked with `MAP[value]`, since this app spent a session removing exactly that idiom. Verified to
refuse `constructor`, `__proto__`, `toString`, an unknown string and an empty one, and to refuse a bad
secret, all without perturbing the current mode.

**What to build next — `/gxwhatsnext`:** run `/gxwhatsnext` in this chat to pull this app's next prioritized work — the Command Center's dependency-ordered build sequence, filtered to this app — so you can build here without switching to the CC. It reads the app key above automatically.

**Close the loop when you're done:** When a dispatched or `/gxwhatsnext`-started task's goals look met — the moment you'd naturally say "that should do it" — proactively tell Sky and **offer to ship/close it out; don't wait to be asked.** Shipping (spoke apps: open/return the PR → `dev_update … status=in_review`; on merge → `dev_ship`; `core-admin` deploys directly → `dev_ship`) auto-completes the Asana to-do and clears it from the Command Center. Find the job via `dev_queue` (filtered to this app) when you need its id for the `curl` — but **refer to it by its `title`, never its id**. `job_mtg9vyxs_ewd9` means nothing to Sky; every job carries the to-do text in the same response the id came from, so say that instead, summarized if it's long ("the employee email column"). Same for `bug_…` and note ids. **Then re-list what's open, numbered `[1] [2] [3]…`, instead of proposing a next task** — re-fetch `action=whats_next` (the board moved while you worked) and let Sky pick by number rather than from memory.


## The HUB is core-admin's — send a note, don't edit (rule from Sky, 2026-09-02 · applied here 2026-09-06)

**Never edit `greencross-command-center` or `greencross-gx-theme` from this chat.** Both belong to
core-admin. It is here because it was broken, not because it was theorized.

On 2026-09-02 a spoke session made a small, correct, tested fix to GX Core and put it on a branch for
Sky to merge, because Core library cuts are PR-gated. **Another Claude session had the same repo open
at the same time.** These repos are Dropbox-synced, so the two sessions shared one working tree and
one HEAD: the branch was switched out from under the first session, its commit landed on `main`
instead, and the other session pushed `main` and shipped it. The change went out as library v284 with
no PR and no review. The code was fine — that is the point. Nothing failed, nothing warned, and the
gate on the highest-stakes repo in the suite simply was not there that time.

Two sessions cannot share a git checkout. Neither can see the other, `git checkout -b` is not atomic
against a second process, and the loser finds out afterwards by reading the log.

**So from Sales: `add_note` to `core-admin` with what you need and why, and stop.** Requests are welcome
and quick, and the hub session holds the repo alone while it works.

**Where the line is, because over-applying this is its own failure:**

- **Reading the hub is fine and often necessary** — `gx_core.gs` is the source of truth for every
  route Sales calls, and guessing a payload shape instead of reading it is how this suite invented a
  `spiff_payouts` tab that never existed. Read freely; run `./gxpins.sh`; diff against it.
- **Calling GX Core's HTTP routes is not editing it.** `deploy.sh`, `gxengine.sh`, `set_config`,
  `bug_update`, `resolve_note`, `add_note` and the rest are the documented interface, secret-gated and
  designed for exactly this. Changing a *setting* through `set_config` is a config change Sales owns;
  changing *code* is not.
- **Do not restyle a shared component from inside Sales either.** A local rule that beats `.gx-btn-green`
  wins here and silently diverges from the other five — that is how the suite ended up with six
  different login screens. The test is *"should all six get this?"*
- **Sales's own engine and repo are still yours.** `clasp push` / `./deploy.sh` here touch only this app.
