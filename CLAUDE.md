# Sales / Cashflow (app key `sales`) — GX app

A Green Cross suite app; **GX Core** (Command Center) is the shared brain. Owner: **Sky** — Shawn is
a USER of this app, not its owner. Frontend `index.html` (monolith, inline JS, GitHub Pages); backend
`dutchie_proxy.gs` (Dutchie + QuickBooks proxy, clasp); read cache in `worker/` (Cloudflare). Fully
integrated with GX Core (login, `deploy_version`, changelog, gx-theme, bug forwarding).

**This file is rules only.** The incidents, measurements and reasoning behind every rule were moved
verbatim to `docs/claude-md-history.md` on 2026-10-09. Each `Hist:` line names, in quotes, words from a
heading to search for there. **Read that section before changing the code a rule guards.** If the two files disagree, this one wins.

## Stack & local loop

- **No build step — the file on disk IS the app.** `python3 serve.py` → <http://localhost:3000>, against
  the **live** backend; `gx-dev.js` blocks writes until armed (writes hit a fail-closed auth guard).
- Version is the **`APP_VERSION` constant** in `index.html` (no `?v=`). It is a reload TRIGGER
  (`gcCheckVersion`), not only a label. **Bump it on backend-only ships too** — a ship with no number is a
  release nobody can name. `core_pins.deployed_sha` (not `version_history`) answers "what is running".
- Ship: commit → push (Pages) → `./deploy.sh` (records to `app_versions`; reads `git show
  HEAD:index.html`, not the tree; `GX_VERSION=vX.YYY` forces a version, `GX_ALLOW_DIRTY=1` proceeds when
  they disagree). Backend: `./gxengine.sh --deploy` — it stops rather than guess a deployment
  (`GX_DEPLOY_ID=` overrides). The live deployment is `AKfycbzju5He…` (`DEFAULT_PROXY` in `index.html`);
  by hand: `clasp push --force` then `clasp update-deployment AKfycbzju5He…`.
- After **every** `./gx-sync.sh`, `chmod 755` the synced scripts before committing — Dropbox strips the
  exec bit. Shared files (`deploy.sh`, `serve.py`, `gx-preflight.sh`, `.claude/gx-brain-notes.sh`) come
  from gx-theme; edit them **there**. This CLAUDE.md is **not** synced.
- Tests: `tests/*_test.js`, run by the **pre-push hook** (`gx-preflight.sh`; a failure blocks the push)
  and by `.claude/gx-posttool-tests.sh` after every edit to the two source files. Run them:
  `ls tests/*_test.js | xargs -n1 node`. They read the real source, never a copy. `cross_app_contract`
  and `store_palette_drift` are hub wrappers that **SKIP — not fail** — without a sibling
  `greencross-command-center`: read it, don't assume green means covered.
- `orphan_css_classes`: every class used is defined and every class defined is used. `dev_guard_actions`:
  every `action=` the app fetches must be declared in `GX_DEV_READS`.
- **`serve.js` must never reach Apps Script.** `rootDir` is `"."` and `.claspignore` is a DENYLIST, so a
  root `.js` that gx-sync drops must be named there or it fails the **entire** `clasp push`. Only sales
  and inventory are exposed — **don't "fix"** performance, spiff, crew or pricecards.

Hist: "Stack & local loop" · "serve.js must never reach" · "gxengine.sh and deploy.sh"

## Verifying — rules this repo paid for

- **Verify a guard by mutation, never by a green run.** The specific assertion has to be shown failing
  for the specific reason, and the failure must name what broke (a red line has to be actionable). **A
  check that cannot fail looks exactly like a check that passed.**
- Assert **the absence of the hazard, never the presence of the fix.** A test may not take its facts from
  the thing it is checking: derive lists from the source AND keep a hardcoded floor so a removal fails.
  Pin the property, not the spelling of a line. Watch `ok(cond, label)` vs `ok(label, cond)` per file.
- **Before adding a "one place to fix it", count the exits.** Re-reading a fix is not verification —
  count, compare against something outside the fix, or mutate.
- **Measure a tooling claim with the tool that actually runs** (the hook's `/usr/bin/grep`, not the
  agent's). No shipped source may contain a NUL byte (`binary_source_test`).
- **A screenshot does not verify a color** — use `getComputedStyle`. `requestAnimationFrame` does not run
  in a hidden tab and the browser pane counts as hidden: animated values read 0 and the poll tick never
  fires there. Measure synchronous counts.
- Decide on a distribution, not a run. A peer's count is evidence, not an override. Implication and
  observation are different claims — say which one you have.
- **The failure shape to watch for everywhere ("the River shape"): a per-store failure degrades into a
  smaller number, not an error.** Coverage is reported, never assumed; show `—`/null, never a confident 0.
  A correct figure with an ambiguous sentence under it reads as a wrong figure.

Hist: "MUTATE A GUARD" · "two NUL bytes"

## Stores come from GX Core

- **Never hardcode stores.** `knownStore_`'s **second chance goes through `GXCore.resolveStore`, never a
  local alias table**, accepted only when it carries a `store_id` the registry lists (so
  `constructor` / `__proto__` still fail). River proves it: the frontend sends `River`, the registry's
  `dutchie_name` is `River Rd`, its `display_name` is `River`.
- Ids come off `GXCore.getStores()` rows (`gxStoreRegistry_`, memoized per execution); the resolve is
  memoized 1h in the script cache. **A registry failure THROWS; it never returns `false`** ("not a store"
  and "the registry did not answer" are different). **A throw is never cached. A null answer is.**
  `storeGateError_` / `knownStoreSafe_` carry the distinction to write routes and probes.
- **Backend: `salesStores_()` is the only list** (`SALES_STORES_FALLBACK_` only when the registry cannot
  answer). Don't add another copy.
- **Frontend: `addOrUpdateStore_` ADDS unknown stores**, matched on `store_id` (`?action=stores`, cache
  key `stores_meta_v2`). Hardcoded `STORES` is the offline fallback; keep `name` then `display` first on
  each row — the hub's contract test parses that shape.
- **`sales` (the internal key) is never renamed** — reconciliation state, caches and deposit rules are
  written under it. `SALES_KEY_BY_DUTCHIE_` / `GX_DUTCHIE_TO_SALES` hold the one legacy exception
  (`River Rd` → `River`).
- A new store is **not automatic** for its QuickBooks class (`RECON_STORE_BY_CLASS_`), ATM machines
  (`ATM_MACHINE_MAP`) or deposit week start (default Wednesday). **Removing** a deactivated store is
  deliberately NOT done — it would erase its history from every past total.
- **`ATM_MACHINE_MAP` must NOT be switched to `GXCore.resolveStore()`.** core-admin's re-pin notes carry
  a blanket line saying to use `resolveStore()` if you fold store names yourself; it does not apply
  here. The map keys ATM machine labels, not stores; the swap drops 13 of 22 labels to null and ATM revenue quietly shrinks with no error.
- Probes: `?action=storekeys&store=…&secret=…` (`known` / `exact` / `store_id` — ask with the name the
  caller actually sends) · `?action=loadprobe&store=…&from=…&to=…&nocache=1&secret=…` (per-phase timings;
  omit `store` to compare all six; it cannot see an `/exec` stall).

Tests: `store_vocabulary_test`, `store_list_test`.
Hist: "store VOCABULARY" · "store LIST" · "FREQUENCY" · "ATM_MACHINE_MAP"

## Budgets and Expenses

- **The budget sheet is GONE: `dutchie_proxy.gs` contains ZERO `SpreadsheetApp` calls** — never add "just
  one quick read" (`sheet_severance_test` asserts the absence). The legacy "2026 GX2 Dashboard" workbook
  is not read. Served from ScriptProperties: `frozen_goals` · `frozen_expbudgets` · `frozen_qbmapping` ·
  `otherrev_data` · `rev_atm_*`; `?action=freezestatus&secret=…` reports all of it.
- **The `spreadsheets` OAuth scope STAYS, deliberately — do not "tidy" it away.** GXCore runs under this
  project's authorization; dropping it severs `getPeriodGoals` and `roleForApp`, and the fail-closed
  write guard would then refuse every write.
- Check properties before removing a "one-time" bootstrap; one-time does not mean spent. Budget goals are
  2026 only (`BUDGET_YEAR`); the frontend returns 0 / no goal for any other year.
- **Smart budget** — `?action=budget_proposal`, from **24 complete months** of QuickBooks actuals (month
  in progress excluded). Apply writes the `smart_budget` overlay that `getExpenseBudgets()` merges
  per-category over `frozen_expbudgets`; `clear_budget` reverts. **COGS / Payroll are % of projected
  revenue.** **A category with no history gets NO proposal.** Sparse categories get a run rate, not a
  typical month (a confident zero is the worst answer). Cleaning is recurrence-aware and one-sided
  (`SB_LOCAL_W` 3, `SB_LIMIT_FLOOR` 15%, chosen on the real series). Level from the trailing 12,
  seasonality from the full 24, both means over the CLEANED series.
- `admin_apply_proposed` takes category NAMES only and fills them from a fresh proposal — there must be
  no parameter through which a number could reach the budget; that is the entire reason secret-gating a
  financial write is defensible. `?action=budgetprobe&secret=…` — re-run after any GXCore re-pin.
- **The planner never writes a closed month** (`applyBudget_` → `sbOpenMonths_`). The month IN PROGRESS
  is closed. The window is decided SERVER-side and the client's months are filtered against it — a stale
  tab left open into a new month must not reach a closed month by sending it. **The
  overlay row stays a full twelve months** (`getExpenseBudgets` replaces the whole row). **A $0 proposal
  is APPLIED, not skipped.** An annual typed below the closed-month floor flags `at floor`.
  `budget_proposal` returns `open_months`, `bills_once`, `current`, `overlay`, `prior_year` so the
  planner never re-derives the server's date rules.
- **`bills_once` is a SERVER-side flag** riding on `expbudgets` (its consumer is the Expenses tab).
  `#dsk-subnav` is hidden on the planner from ONE place (`syncSubnavVisibility`), and the rule needs
  `#dsk-subnav.dsk-subnav-off`.
- **Expenses compares against EXPECTED-TO-DATE, and every bar puts the full-period budget at 80% of its
  track** — hero and rows share the geometry; change one and change the other. One pace fraction, read
  once from `getPacingPct()`. **A category with no budget renders `—`, never 0**, counts in neither
  tally and sorts last. **`fmtSigned`, not `fmtK`**, for anything signed. Desktop and phone are two
  renderings picked by **`matchMedia`** (two `#expChart` canvases break Chart.js); the phone keeps the
  old `.kpi-grid`/`.srow` layout deliberately. Row click expands; exclusion lives in the panel.
- `?action=expense_breakdown&start=…&end=…` — ONE report, the P&L by **`Classes`** (not `Class`).
  **`qbBreakdownWalk_` copies `walkQBRows_`'s map semantics exactly**: a matched section summary IS the
  category's total and its children are listed but **never re-summed**. **`residual` is reported, never
  absorbed.** **CORPORATE is a class like any other and must keep its row**; bars scale to the largest
  STORE. The payload is tagged with its range. `?action=expbreakprobe&start=…&end=…&secret=…` must show
  zero delta — re-run after any GXCore re-pin.
- `expbudgets` / `expenses` load on first entry to the Expenses tab (`ensureExpBudgets`, guarded by
  **tried, not loading**). `otherRevenue` stays on boot.

Tests: `expense_breakdown_test`, `budget_apply_window_test`.
Hist: "budget sheet is GONE" · "Smart budget" · "EXPECTED-TO-DATE" · "budget planner"

## Boot, load and render

- **Never put `defer` (or `async`) on a shared script this app's inline code calls.**
  `maintenance_wiring_test` pins the fix — don't "restore" the defer.
- **The boot block starts the data load FIRST and wraps every decoration in its own try/catch.**
  `avatarEdit` tests for `GXClient` before building one.
- **A render fault must never kill a data load** (`loadAllStores` catch + guarded progressive render;
  `load_resilience_test`).
- **Never show a goal you are about to replace.** The goal shimmers until the source ANSWERS: `pgLoaded`
  only means *asked*, `pgResolved` means answered, and EVERY exit path must reach `pgResolved`.
- **The landing view is TODAY from the first frame**: `selectDefaultPeriod_()` runs in the top-level
  init, before `buildTimeNav()` and `loadAllStores()`. Only the current month — a deep link keeps its
  period. **Do not seed `activeDay`/`activeWeek` on their `let` lines.** The end-of-load block keeps only
  `loadPeriodGoals(activeDay)` and `loadPaceFracs()`.
- "No data loaded yet" is gated on **`salesPending()`**; a load in flight shimmers. **A `$0` hero is not
  the cheaper fix.** `dataWait` and `goalWait` are deliberately two flags.
- **The 60s poll must not remount the page.** `_incomeMounted = false` lives in `clearLiveData()` (used by
  `clearAllCache`, `clearDutchieCache`, `hardReset`; never by the poll). `_invalidateDerivedCaches` must
  still reset `liveDateMaps` and the day-of-week weights. `_bdHoldOrder` holds row order for the whole
  load and is released in `finally`. The end-of-load `scrollTo` fires only if the page moved on its own
  AND the reader did not move it, keyed on **input events (`touchmove`/`wheel`/`keydown`), never on `scroll`**.
- **The pacing section renders ALL six stores from the first frame — don't filter
  `_storeBreakdownRows` to `liveData[s]`.** **Sort only when every store has landed**; reuse `_bdOrder`
  while anything is pending.
- Cache keys go through **`isSalesCacheKey_`; a raw `startsWith('gc_sales_')` anywhere is the bug coming
  back** (it deletes `gc_sales_token`, the session — "clear cache" signs you out).
- **No bare `fetch()`** — a browser fetch has no timeout, and a hung promise never reaches `catch` or
  `finally`. Reads get `AUX_READ_CAPS_` (which IS `LIVE_PHASE_CAPS_`). **Writes get `WRITE_CAPS_` =
  `[25000]` — ONE attempt: a write is bounded and then REPORTED, never re-sent** (an abandoned request
  still runs to completion on Apps Script; `reconPost` matters most). **Never nest `gasFetchJson` inside
  `gasGate_`** — it takes a pool lane per attempt; pass the priority INTO `gasFetchJson`. Named
  exceptions: the login prewarm (raw `fetch`, own 15s abort), `cogs_dutchie` (own ceiling inside
  `gasGate_`), Reconcile's deposit load `gasFetchJson(url, 3, 75000)` (crosses to Core's 60s budget).
- `backfillDailyHistory` runs a pool of **4** through `gasFetchJson` — Apps Script caps simultaneous
  executions at 30 per account, shared by every GX app on `sky@`.
- Year history cache `gc_sales_v2_hist_<store>_<year>_all`: day rows exactly as they arrived, never
  re-summed. Trusted under 1h (`SALES_TTL_HIST`); painted AND re-asked under 72h
  (`SALES_HIST_PAINT_MAX`); older is not painted (it feeds Reconcile's expected totals). Months a kept
  entry covers are re-asked regardless of memory.
- `gcCheckVersion` offers a reload when `version_history` is newer; it never reloads on its own and is
  suppressed while signed out and for a version already dismissed or attempted.
- A TRUNCATED GX Core body ("invalid control character") is the ~6% two-hop flake: **retry until it
  parses**, and don't reach for a lenient parser.
- The phone's bug trigger `#mob-bug-foot` sits under every tab but Income.

Tests: `boot_sequence`, `poll_quiet`, `landing_period`, `first_load_state`, `backfill_request_count`,
`bounded_fetch`, `aux_hang_bounds`.
Hist: "defer" · "60-second poll" · "landing view is TODAY" · "No data available" · "Three more faults"
· "all-weekdays chart" · "Two load-bearing render rules" · "twenty-one OTHER calls" · "pacing section"
· "A stale tab"

## Is this figure current, and is the total whole

- **`storeNotCurrent_` is the one definition** of "this store's figure is not current" (state `loading`
  or `err`, or in `_todayPending` while the view includes today). The dot blink, the quiet-hours recovery
  and the hero all read it — never a second definition. `syncBdStale_` runs from `buildStatusGrid`; the
  blink keeps its phase across rebuilds; reduced motion gets a dimmed dot.
- Hero status — `_heroLiveHtml_`, **built once for all three hero branches**, behind
  `viewIncludesToday_()`: amber names the store while one name fits and counts once it does not; `err`
  outranks today-pending (red, `5/6 stores`). **A load in flight reports NOTHING** (gated on
  `salesPending()`).
- **"Is the TOTAL whole" is a different question — `storeNotCurrent_` is reused but NOT verbatim.** A
  store is missing from the total when it has no `liveData` entry → amber `4/6 stores so far`, counted
  against `getActiveStores()`. **Cold load and period change report; the poll does not.** No time
  threshold, deliberately. **The number is never hidden or blanked.**
- Known and left alone: the `err` / today-pending branches still count against all six `STORES` under a
  filter. The hero clock is when the data was PULLED (`liveAsOf_`, oldest store).

Tests: `store_dot_blink`, `hero_live_state`, `hero_partial_total`. Hist: "dot BLINKS" · "HERO says" ·
"ADDING THEM UP"

## Today's figures — shared pull, server snapshot, Cloudflare shortcut

- Dutchie's line-item parameter is **`IncludeDetail`**; `includeItems` is silently ignored and COGS reads
  $0. `dtodayQuery_` is the one place the question is asked. Line items carry no product name — unnamed
  items are skipped, not bucketed "Unknown". The debug probes `getTxFields`/`getTxDetail` are left alone.
- **Today's sales are pulled ONCE and shared** (`dutchieTodayFetch_`, script cache). Keyed on `store` +
  `todayPT`, **deliberately NOT on the caller's `to`**. Entry `dtoday_v3_<store>_<day>` carries `as_of`
  and is kept 20 min; a caller's `maxage` decides what it accepts — default **90s** (must stay above the
  60s poll), up to **600s** for an open, clamped by `DTODAY_SNAPSHOT_S_`, which must equal the client's
  `LIVE_SNAPSHOT_MAXAGE_S` (tested). `nocache` bypasses; on the client it is a **deadline, not a
  boolean** (`_serverBypassUntil`). A corrupt entry falls through to a live pull rather than throwing.
  The compare-period fetch does **not** bypass.
- **Never abandon today's pull and pull again.** The proxy joins a pull already running
  (`dtodayAwaitFlight_`, up to `DTODAY_WAIT_MS_` 25s); a joiner only accepts an answer NEWER than the one
  it rejected; a marker that vanishes without an answer means pull at once.
- Ceilings are a LIST per attempt (`gasFetchJson(url, null, CAPS)`): live `[12000, 25000]`, settled
  `[8000, 12000, 16000]`. **Err short** on the first; **the 25s second must outlast `DTODAY_WAIT_MS_`**
  (`phase_split_test` reads both); the whole chain must stay inside one 60s poll, because
  `_loadAllStoresInFlight` blocks the poll that would recover a store. Settled gets a third attempt
  because a settled timeout drops the store out of the company total.
- The month paints when its settled half lands (`onSettled`) — **only for a store with nothing on
  screen**, never for an old backend that ignored `phase`. **Not done, deliberately:** painting last
  visit's today figure while the hop runs.
- `bgRefreshTodayTick` (every 5 min, 08:00–22:15 PT) re-pulls stale stores in ONE
  `UrlFetchApp.fetchAll`, one attempt, no retry loop (trigger runtime is a daily quota shared across
  `sky@`), then builds the snapshot (`bundleRefresh_` → `bundleBuild_`, each in its own try).
  `?action=bgrefresh&op=install|status|remove|run|bundle&secret=…` (`run&force=1` ignores store hours).
- Snapshot `sbundle_v1`: stored with `saveChunkedCache_`, **not `cacheSet_`**. Every part is built by the
  function its own route calls; `bundleLiveHalf_` reads the cache entry and NEVER pulls. Per part
  `as_of`; **a failed part keeps its last good copy with its ORIGINAL age** (`stale`, `error`), never
  blanked by a sibling and never re-stamped; day-scoped parts are not
  carried across midnight; **an empty settled month is a failure here**. **`?action=bundle` reads, never
  builds** (missing → `bundle_missing` plus a throttled `bundleKickRun`).
- **Client: an OPEN reads the snapshot; a Refresh never does.** `refreshLiveData()` with no args (or an
  Event) is fresh; `{fresh:false}` is an open; boot and period navigation are opens. A today figure
  older than `LIVE_SNAPSHOT_MAXAGE_S` is dropped per store and that store asks for today itself. A missing
  snapshot costs one extra call, never a figure. Disk paint (`paintSavedBundle_`) reads "saved
  copy, N min ago"; a snapshot with ANY `ok:false` part is used but never written to disk. What's New
  waits for the first load.
- **Phones don't poll.** The 60s tick survives for RECOVERY ONLY; returning after 2+ min re-reads
  (`RESUME_RELOAD_MS_`). Manual refresh: hero status button → `manualRefresh_()`, or pull past 70px —
  **never `preventDefault`**. The iOS haptic (`haptic_()`) is a best-effort hack; do not gate the refresh
  on it.
- **Quiet hours (from 22:15): the pause skips a tick only when there is nothing INCOMPLETE to recover**
  (`quietRecoveryNeeded_()`, which is `storeNotCurrent_`). CAPPED at 10 attempts
  (`QUIET_RECOVERY_MAX_`), reset on a complete load and on leaving quiet hours. Refresh was never gated
  and still is not.
  The three gates above the quiet check (in-flight, hidden tab, historical day) stay. A quiet tick
  returns and never calls `clearAutoRefresh`; the recovery must stay CONDITIONAL.
- **The Cloudflare Worker (`worker/src/index.js`) IS A SHORTCUT, NOT A DEPENDENCY.** `fetchCachedBundle_`
  returns null on anything but a clean answer and `fetchOpenBundle_` falls through to `/exec`. **It holds
  no `GC_SESSION_SECRET`** (a read-only viewer token) and serves **reads only** — every write still POSTs
  to Apps Script, where `writeGuard_` and the audit log live. **A stale copy is never painted**
  (`BUNDLE_MAX_AGE_S`, 1h). KV **writes** are the scarce resource (1,000/day): an unchanged snapshot or
  cron outcome is not written, and `fetched_at` does not move on a no-op. `/health` reports what the last
  cron actually DID.
- Worker auth verdicts — three numbers, each load-bearing: `AUTH_TTL_S` 24h · `AUTH_REFRESH_AFTER_S` 12h
  · `AUTH_MAX_LIFETIME_MS` 6d (without the cap an EXPIRED token reads from the cache forever). Legacy
  `'ok'` verdicts are honored. The re-stamp is the only KV WRITE on the request path, which is why it is
  twelve hours and not every open. **A verification TIMEOUT is never cached as a refusal.** The TTL is
  asserted as a LOWER BOUND, never an equality — the number may be tuned, the property may not. Accepted cost (Sky's call, 2026-10-05): a revoked person can read the cached
  snapshot for up to a day. **Timing the warm path proves nothing about the cold one.**

Tests: `intraday_cache`, `bg_refresh`, `manual_refresh`, `opening_bundle`, `phase_split`,
`background_refresh`, `quiet_recovery`, `quiet_hours`, `worker_bundle_cache`.
Hist: "IncludeDetail" · "pulled ONCE" · "Today's hop" · "Phones don't poll" · "ONE read of a snapshot"
· "CLOUDFLARE" · "shortcut was unreachable" · "overnight pause"

## `/exec` stalls — Google's hop, not ours

- `/exec` intermittently fails to return, in **windows** that last minutes — the stalls are NOT
  independent per-request drops. ~3.4% six-wide is one evening's baseline, not a constant. **NOTHING
  CLIENT-SIDE FIXES THIS.** Ceilings decide what a stall COSTS; retries decide how many are LOST; fewer
  requests per load does not help a bad day.
- **Do not re-tune a ceiling or an attempt count on one run or one morning** (the v2.592 mistake).
  Re-measure the RATE first: `python3 tools/exec_stall_probe.py` (six-wide `libversion`, logs in
  `tools/stall-log/`), several bursts over several minutes — **ONE READING PROVES NOTHING**.
- Compare probe runs with each other, never with the 3.4% store-pull baseline; do not pool rates across
  concurrency widths (12-30 wide: **do not harden it into "10%", and do not average the two into
  "3-10%"**); 60s is not a safe upper bound for anything without its own ceiling.
- A third LIVE attempt was deliberately NOT taken — second bad day first.
- **The stall ledger** (the table code comments cite as "CLAUDE.md, the v2.597 section") now lives in
  the history file under the heading "~4% of /exec requests … (v2.597)".

Hist: "STALLS ARE NOT INDEPENDENT" · "Two more runs" · "~4% of /exec" (the v2.597 ledger) · "40% day"

## Backend ↔ GX Core

- **All GX Core traffic from the page goes through `GXClient`.** Cross-app data goes through GX Core,
  never app-to-app: the one direct address left, deliberately, is `fetchLeaderboardGoalsDirect` (fallback,
  URL from Core config `lbGoals`); `velocity_via_core_test` fails on any THIRD Apps Script address in
  `index.html`.
- `?action=velocity` → `getVelocity_` → `GXCore.getVelocity('')` (keyed by dutchie_name, selling products
  only, cached 1h). **Empty is an ERROR on both sides, never a result** — never cached; the tile reads
  `—`. Tried, not loading: `renderInventory` re-asks at most every 5 minutes after a failure — the
  render a load triggers must not re-trigger it.
- The four retry loops (`gxDutchieGet_`, `gxCoreRoute_`, `qbReportViaGXCore_`, `qbDepositsViaGXCore_`)
  check `GXCORE_RETRY_BUDGET_MS` (60,000) **before sleeping and re-asking** — Apps Script kills a script
  at 360s. **Do not sync that constant from another app.**
- `probeMark_` marks are NOT a log. The only persisted `/exec` telemetry is GX Core's
  `?action=request_stats` (deploy-secret gated).
- **`getCogsDutchie` is cached at the proxy — leave it that way** (10 min with today in range, 6h
  settled). Its six sequential `gxCoreRoute_` calls are known and deliberately NOT changed.
- **QuickBooks: GX Core is the sole token owner by construction. Don't re-add a "temporary" local
  fallback.** `qbProfitAndLoss_` THROWS when Core is unreachable — a broken Expenses tab is the intended
  failure. The only `QB_` property left is the `QB_LAST_SOURCE` diagnostic.

Tests: `gxcore_retry_budget`, `velocity_via_core`.
Hist: "60-second clock" · "Inventory tab's sales speed" · "getCogsDutchie" · "legacy local QuickBooks"

## Bug reports and credentials

- **Core's send is the only send** — no `MailApp` call on the success path, and it must not grow one.
  `reportBug_` sends its own notice only when Core reports the mail died. **READ THE POSITIVE FIELDS
  (`mail_error` / `mail_skipped`). NEVER THE ABSENCE OF `mailed`** — a deduped repeat carries no mail
  field at all and submit retries up to three times. Fields are absent, not empty, when they do not
  apply; truthiness is the correct read. There is deliberately NO notice for a REFUSED
  report; a second notice would need its own `bugMailOnce_` key. **`bugMailOnce_` fails OPEN.** Do not
  delete the `mail_skipped` branch as unreachable.
- `reportBug_` re-packs the payload field by field: a new field (`context`, `screenshot_url`) must be
  named or it is silently dropped (`bug_context_forward_test`).
- **Nothing this script returns may carry a credential.** TWO LAYERS: `errText_()` at every site where
  an exception becomes part of a reply, AND `gxScrub_` at every exit — `jsonOut_`, `setReply_` for
  hand-built bodies, cached bodies, and mail (`bugNotify_` scrubs subject and body at the exit). **The
  rule is every exit an engine has**: replies AND mail AND anything stringified into a Script Property,
  a sheet or a cache that something later replays — not "a field with no reader is safe". Do not assume
  this file's many-exits shape is suite-wide — it is ours alone.
- **`AUTH_PARAM_NAMES_` is the one list.** `authParamValue_` reads a session through it and
  `SECRET_PARAM_RE_` is BUILT from it — never hand-type either, in source or in a test (`SCRUB_DECLS`).
  `token`, `session` and `auth` all authenticate: **do not "tidy" the two unused names off the auth line.**
  The pattern matches the word anywhere inside a parameter name (an occasional false redaction is the
  accepted cost).
- `gxScrub_` can never be the reason a response fails (wrapped); its length guard is load-bearing. The
  push gate blocks secret-looking test fixtures — assemble them from plain words. The shared
  exit-counting test is the hub's to write — deliberately NOT written locally.

Tests: `bug_mail_fallback`, `secret_scrub`. Hist: "filed bug whose email dies" · "carry a credential" ·
"ONE of the three ways" · "ONE list now" · "MAIL was an exit" · "screenshot died"

## GX Core: brain and pin

- **`/gxbrain`** (or "brain sync") loads the shared rules and reconciles this chat with GX Core; the
  notes inbox is `to_app=sales` (`resolve_note`, `add_note`), surfaced by the SessionStart hook.
- **Verify the `GXCore` pin by asking the live app, never by reading the repo.** Re-pinning is two steps
  and the second gets skipped: set the version, then **deploy**. Then measure (`?action=libversion`, or):

```
curl -sL -G "<sales /exec>" --data-urlencode action=gxpin --data-urlencode "secret=$(cat .gx_deploy_secret)"
```

  `gxpin` returns `GXCore.libVersion()` plus `qb.last_source` (`gxcore@…`; `null` = nothing has missed
  cache yet). **A `Forbidden` here is a finding, not a route bug**: `GX_DEPLOY_SECRET` is unset or stale
  on this script, and that same property gates `qbReportViaGXCore_`. Re-check after any deploy that
  touches script properties. Pinned to GXCore — check the live value, do not trust any written number
  (`?action=libversion`, or `./gxpins.sh --live` from the hub); v315 on 2026-09-09 is a reading, not a
  promise.
- **Re-run the discriminating probes after any GXCore re-pin** (all `&secret=…`):
  `goalprobe&date=YYYY-MM-DD` (must return all SIX stores) · `goalrangeprobe&start=…&end=…` ·
  `budgetprobe` · `expbreakprobe` · `pnlprobe` · `reconprobe` (`notes_seen: 0` over a range that HAS
  deposits = a Core without `PrivateNote`) · `authprobe&user=shawn`. A pin that reports the right version
  and still returns the wrong data is a different failure from one that never took.
- A Core bug is fixed in Core; the workaround belongs nowhere. `expectedSalesFrac` does NOT share the
  store-alias assumption — `getPacingFracs_` is fine as written.

Hist: "Sync with the brain" · "Verify the GXCore pin" · "GXCore pin history"

## Reconcile

- **Reconcile counts the Dutchie sales banking and nothing else — by MEMO, not by arithmetic**
  (`reconIsSalesDeposit`). **ANY sales line qualifies, not ALL of them.** **A memo naming `sales` or `tax`
  also counts**; a deposit with no memo is not counted. Everything it rejects goes to the *not
  included in a store's week* list with its amount and memo showing — never dropped, and it survives
  reconciling the week. Don't go back to subset-matching against the expected
  figure. The vocabulary is measured: `?action=reconprobe&start=…&end=…`.
- **`reconData` carries the range it was fetched for** (`reconDataStale_`). Failures are never cached but
  ARE tagged with their range.
- Windows: `reconWindows` steps back one day from the period start — **deliberately identical to
  `reconWindowForDeposit`'s step-back; change one and the other has to move with it. An overlap test is
  NOT enough.** A window is listed in BOTH the month it starts in and the month its money lands in;
  state is keyed on `(store, window start)`. `reconIsEmptyWindow` drops only a window with no sales AND
  no money; **missing sales but HAVING deposits still renders** (incomplete, never a shortfall).
  **"Default to the current week" was NOT implemented literally, and should not be.**
- Headline (`reconBankedInPeriod_`, `reconSelectedRange()`) tracks the picker; the cards below
  deliberately do not. **A deposit belongs to the period ITS OWN DATE falls in.** A dash early in the
  week is CORRECT. **The comparison is withheld (`partial`) unless every contributing week is WHOLLY
  inside the period and fully priced** — all-or-nothing. `outside` names money for those weeks banked in
  a different period. Reconciled weeks still count. Strays are not banking. Coverage (`4 of 6 stores`)
  is reported. **Nothing banked returns NULL, never 0.** A tile has to name its own scope.
- **The week total is already month-independent — do not "fix" it again.**
  `reconWantedRange` stays month-wide only to decide which store-weeks get BUILT. Corporate money was
  NEVER in the headline: an unattributed deposit is in no store row, and `reconBuildRow` sets a
  store-classed non-sales deposit aside into `strays`, which the KPI never reads — it sums `deps`.
- **The QuickBooks deposit date (`TxnDate`) is an ACCOUNTING date; the real one is in the memo** (`note`
  from Core v305 → `reconBankedOn_` → `banked_on`; `reconBankedDate_` is `banked_on || date`). **Only the
  Reconcile WEEK headline uses it** — the P&L, every month view and store-week ATTRIBUTION keep `TxnDate`.
- Memo parser: **THE MEMO'S YEAR IS IGNORED** (year from `TxnDate`) · **THE PERIOD IN PARENTHESES IS
  NEVER PARSED** · **THE SEPARATOR IS OPTIONAL** · lag bound `RECON_BANKED_MAX_LAG_` (0..14 days, else
  `TxnDate`) · `''` means "use TxnDate". The banked date is NOT a uniform offset. **Do not join on the
  memo's store name** (`SOUTH` = Commercial — a third vocabulary).
- Swipe: any element with **`data-pswipe="<selector>"`** (the selector re-finds the node AFTER
  `periodStep` re-renders); exactly one `_pCommit` — no parallel
  implementation. `data-pswipe-mobile` restricts a surface to phones; `.recon-kpi` needs
  `position:relative` and `touch-action:pan-y`. A drag starting on a button belongs to that button.
- **The state colors MUST stay qualified as `.recon-kpi-figs strong.recon-kpi-off`.**

Tests: `deposit_reconciliation`, `recon_month_boundary`, `recon_banked_kpi`, `qb_deposits_shape`,
`recon_load_resilience`.
Hist: "Reconcile counts" · "month turns" · "Reconcile headline" · "ACCOUNTING date" · "parser rules"

## Goals

- **The FROZEN PAY-PERIOD goals are authoritative, in every view** (Sky's call, 2026-08-29). Precedence in
  all three accessors: **frozen goals → `lbGoals` → budget** (`frozen_goals`, never the sheet).
- **`pgTotal` returns NULL, never a partial sum**, for a window with any uncovered date, and the caller falls
  back to the budget — don't "improve" it into summing what it has. The current month usually still shows budget/lbGoals: deliberate. The
  ledger starts 2025-11-10; a past YEAR gets no goal at all.
- **Portland Rd's period goal is a flat $41,500 in every pay period — confirmed intentional by Sky; its
  ~40% gap against its budget line must not be reconciled away.** A closed period is locked (`writeGoalLedger_`
  refuses it and there is no unlock route), so the two distorted periods were deliberately NOT corrected
  — and a `goalbackfill` would NOT have repaired them even unlocked. Sales sums `dow_targets`; it never reads
  `period_total`. The ~0.5% `2xdow` gap on auto stores: leave it.
- `period_goals_range`, four load-bearing things: (1) **ask with an EMPTY store**; (2) **an empty
  `picked` is an ANSWER, not a failure**; (3) **decide coverage BEFORE `cacheGet_`**; (4) **use the
  exact INTERVALS, never a min/max span** (`pgLedgerIntervals_` reads period DATES only; the tab holds a
  `2000-01-01` sentinel row) and never pick a goal out of raw rows by hand.
- `?action=attainprobe&start=…&end=…&secret=…` — goal vs actual. An unsettled period is excluded and
  NAMED (`skipped_periods`); a store-period missing any sales day is left out of every total
  (`counted: false`; failures in `read_errors`). **Read `counted` before believing any single row.**
  Goals are a 12-period TRAILING MEAN, so they lag (stretch is 1.0%, 0 on a manual override) — know that
  before anyone "fixes" a store.

Tests: `goal_attainment`, `pacing_agreement`. Hist: "FROZEN PAY-PERIOD"

## The write guard — treat it as production auth

- Four writes (`save_expense_mapping` GET+POST, `set_otherrev`, `set_revenue`, `clear_atm_cache`) call
  `writeGuard_`, which asks `GXCore.roleForApp(user, 'sales')`. Mode is the `GX_WRITE_GUARD` script
  property: `log` · `enforce` · `off`. **ENFORCING since 2026-08-20**, flipped by Sky's explicit
  instruction after a real non-superadmin admit test passed.
- **A ROLE IS NOT PERMISSION TO WRITE.** The guard also requires `GXCore.roleCanEdit(role)` — never a
  local list — refuses a viewer with `code: read_only`, and treats a pin without `roleCanEdit` as a Core
  error (fail closed).
- **Enforce fails CLOSED on a Core error as well as on a missing grant.** A GX Core outage blocks Sales
  writes; reads are unaffected. A Core-side break looks exactly like an outage. Unauthenticated and
  forged-token writes are refused at the session gate ABOVE the guard.
- The mode changes only on Sky's explicit instruction *(sentence added 2026-10-09; original in history
  § "The write guard")*. After a rollback to `log`: **do not flip to `enforce` until the log shows a real
  NON-SUPERADMIN user ADMITTED** *(reworded 2026-10-09; original in history § "The write guard")*.
  `action=guardmode` exists for
  ROLLBACK, not convenience — a revert must be seconds away and must not depend on anyone being at a
  browser. **Roll back in one command** (the same call with `mode=log`):

```
curl -sL -G "<sales /exec>" --data-urlencode action=guardmode --data-urlencode "secret=$(cat .gx_deploy_secret)" --data-urlencode mode=enforce
```

  `mode` is validated against an array with `indexOf` — **deliberately not an object checked with
  `MAP[value]`**. It must refuse `constructor`, `__proto__`, `toString`, an unknown string, an empty one
  and a bad secret, all without perturbing the current mode. Keep it that way.
- **Read the decisions, never infer them** — `write_guard_log` is a capped ring of the last 25, admits
  as well as refusals:

```
curl -sL -G "<sales /exec>" --data-urlencode action=authprobe --data-urlencode "secret=$(cat .gx_deploy_secret)"
```

  Sky's call (2026-08-24): the log may not capture every write — don't cite it as proof of an admit,
  don't read its silence as a problem, and don't re-open this on your own.
- Only a real NON-SUPERADMIN admit settles the guard after a Core change; `sky` is superadmin and
  resolves by a different path. **Re-verify after any deploy:** `dev_session` token →
  `set_recon&store=Bend&start=not-a-date` must answer `read_only`, not the date error.
- **SIGN-IN IS GX CORE ONLY, AND RENEWAL RE-CHECKS THE GRANT** (v2.594, Sky's call). No local-login
  fallback, **including for a Core outage** — don't re-add a "temporary" one. `pingSession_` refuses when
  `roleForApp` answers null and **still renews on a Core ERROR**. *Not closed:* a copied token reads until
  its 7-day expiry. The `gc_sales_users` property is unread; deleting it is safe.

Tests: `write_guard`, `login_core_only`. Hist: "The write guard" · "admit tests"

## Working with the hub

- **Never edit `greencross-command-center` or `greencross-gx-theme` from this chat.** `add_note` to
  `core-admin` with what you need and why, and stop. Two sessions cannot share a git checkout, and
  these repos are Dropbox-synced.
- Reading the hub is fine and often necessary (`gx_core.gs` is the source of truth for every route Sales
  calls). Calling GX Core's HTTP routes (`set_config`, `bug_update`, `resolve_note`, `add_note`…) is not
  editing it. Sales's own engine and repo are still yours.
- **Do not restyle a shared component from inside Sales either.** The test is *"should all six get
  this?"*
- **`/gxwhatsnext`** pulls this app's next prioritized work from the Command Center.
- **Close the loop when you're done:** when a dispatched or `/gxwhatsnext`-started task's goals look met,
  proactively tell Sky and **offer to ship/close it out; don't wait to be asked.** Shipping (open/return
  the PR → `dev_update … status=in_review`; on merge → `dev_ship`) auto-completes the Asana to-do. Find
  the job via `dev_queue`, but **refer to it by its `title`, never its id** — same for `bug_…` and note
  ids. **Then re-list what's open, numbered `[1] [2] [3]…`, instead of proposing a next task** —
  re-fetch `action=whats_next` and let Sky pick by number.

Hist: "HUB is core-admin's" · "What to build next"
