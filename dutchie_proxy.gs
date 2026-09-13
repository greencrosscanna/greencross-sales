// Green Cross — Dutchie API Proxy
// Deploy as Web App: Execute as "Me", Who has access "Anyone"

// ── DUTCHIE CREDENTIALS — NOT HERE, AND NOT IN THIS PROJECT AT ALL ───────────────
// The six POS keys lived here as literals, in a PUBLIC repo, from this file's first commit until
// 2026-08-29. They then moved to this project's own Script Properties — which was better, and still
// one of five copies that all had to be rotated together. Since 2026-08-31 they live ONLY in GX
// Core; this app asks it for data and never holds a credential. There is nothing here to rotate.
/* ─── DUTCHIE, THROUGH GX CORE. THIS APP HOLDS NO CREDENTIAL. ────────────────────────────────────
 *
 * The six POS keys used to live here as literals, then in this project's own
 * DUTCHIE_STORE_KEYS_JSON — one of five copies across the suite. Rotating them meant five paste
 * jobs, and the May leak survived a cleanup pass because a copy nobody remembered was left behind.
 * GX Core holds them alone now, and this app asks it for DATA, never for a key.
 *
 * WHY dutchie_get AND NOT dutchieTransactions: this app windows transactions by
 * fromLastModifiedDateUTC, not by transaction date, deliberately — so an edit to an older sale is
 * picked up. GX Core's named transactions route windows by DATE. Routing through it would have
 * succeeded, returned plausible transactions, and quietly changed WHICH sales this app sees, in the
 * app that reconciles bank deposits. dutchie_get forwards this app's own query verbatim.
 *
 * The deploy secret, not the connector secret: these routes return rows. Only Inventory and
 * Leaderboard hold key access, because only they batch in ways a proxy cannot serve.
 * ------------------------------------------------------------------------------------------------ */
function gxDeploySecret_() {
  const s = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET');
  if (!s) throw new Error('GX_DEPLOY_SECRET is not set on this script — cannot reach GX Core');
  return s;
}

/* ─── HOW LONG A RETRY IS ALLOWED TO GO ON ───────────────────────────────────────────────────────
 *
 * One number for all four GX Core retry loops in this file (gxDutchieGet_, gxCoreRoute_,
 * qbReportViaGXCore_, qbDepositsViaGXCore_). They talk to the same /exec and they fail the same way,
 * so a per-loop number would be four places for the same fact to rot.
 *
 * THE RETRY ITSELF IS RIGHT AND MUST KEEP WORKING. Measured on the live app 2026-09-11 (v2.585):
 * Hillsboro spent 32.3s on an HTTP 404 whose IMMEDIATE retry then succeeded in 2.5s. That recovery
 * is the entire reason these loops exist, and a guard that kills it is worse than no guard — so the
 * budget has to sit well ABOVE 32.3s, not near it.
 *
 * WHAT WAS MISSING IS THE OTHER END: THE BOUNCE IS NOT FAST. The comment that used to sit on the
 * sleep below said "the /exec second hop 404s on ~6% of rapid calls", which describes a quick miss.
 * The rate is about right; the shape is not. The same night, Center and River were dead at 60s. And
 * GX Core's own /exec self-probe (?action=request_stats, read live 2026-09-12) puts a BOUNCED round
 * trip at 46.6s on average across 11 of 147 probes — against 4.8s for the 136 that did not bounce —
 * with a worst single round trip of 628.8s. Apps Script kills a script at 360s. So five sequential
 * attempts against a bouncing endpoint outrun the cap, and when they do the caller gets a DEAD
 * REQUEST instead of the clean "unreachable" error the loop was written to produce. A retry that
 * converts a clean failure into a timeout is worse than no retry.
 *
 * WHY 60s AND NOT ANOTHER NUMBER:
 *   - It is nearly double the 32.3s stall that recovered on the next try, so the fast lane and the
 *     slow-but-working lane both still get every attempt their loop has.
 *   - The check happens BEFORE sleeping and re-asking, so the worst case is the budget plus ONE more
 *     attempt: 60s + the 130s top of the measured bounce band = 190s, leaving 170s of the 360s cap
 *     for the settled half of the same request and the response build.
 *   - NOT 45s, which is what Price Cards picked for its own loop the same day. That loop makes three
 *     attempts; these make five, and a single HEALTHY attempt here measured 21.6s on 2026-09-12
 *     (49 live samples, 3.4s average), so 45s would start clipping working requests on a slow day.
 *     The constant is not a shared suite truth and must not be synced as one.
 *   - NOT 120s or more: the browser bounds a store fetch at 15s x 2, so past ~30s nobody is waiting.
 *     Further attempts buy the reader nothing and only spend the cap.
 *
 * WHAT IT DOES NOT DO: it cannot shorten a call already in flight — attempt 1 alone was measured at
 * 628.8s. It bounds the MULTIPLICATION, which is the part this side controls. */
const GXCORE_RETRY_BUDGET_MS = 60000;

/* The backoff, and the one decision in front of it. Returns '' to go again, or the note to append to
   the calling loop's own error when the budget is spent. Deliberately does NOT throw: each loop owns
   its own message, and a shared throw here would erase which route failed. */
function gxRetryHold_(started, backoffMs) {
  const spent = Date.now() - started;
  if (spent >= GXCORE_RETRY_BUDGET_MS) {
    return ' (stopped after ' + Math.round(spent / 1000) + 's — another attempt on a stalled hop'
         + ' would outrun the 360s execution limit)';
  }
  Utilities.sleep(backoffMs);
  return '';
}

/* One Dutchie read through GX Core. `params` are forwarded verbatim, so each caller keeps its own
   query semantics. Returns the rows array, or the raw object for endpoints that answer with one. */
function gxDutchieGet_(store, path, params) {
  let qs = '?action=dutchie_get'
         + '&store=' + encodeURIComponent(store)
         + '&path=' + encodeURIComponent(path)
         + '&secret=' + encodeURIComponent(gxDeploySecret_());
  Object.keys(params || {}).forEach(k => {
    qs += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  });

  let lastErr = '', stopped = '', tries = 0;
  const started = Date.now();
  for (let i = 0; i < 5; i++) {
    if (i > 0) {
      // Backoff and budget, in that order of appearance but the budget decides first — see
      // GXCORE_RETRY_BUDGET_MS above. The sleep moved up here from the bottom of the loop, where it
      // also paid 400ms after the FINAL attempt, for nothing.
      stopped = gxRetryHold_(started, 400);
      if (stopped) break;
    }
    tries++;
    const _ta = Date.now();
    const resp = UrlFetchApp.fetch(GXCORE_EXEC_ + qs, { muteHttpExceptions: true });
    let data = null;
    try { data = JSON.parse(resp.getContentText()); } catch (e) { lastErr = 'unparseable body'; }
    probeMark_('dutchie_get_attempt', Date.now() - _ta, {
      attempt: i + 1, path: path, http: resp.getResponseCode(),
      bytes: resp.getContentText().length, ok: !!(data && data.ok === true),
    });
    if (data && data.ok === true) return Array.isArray(data.rows) ? data.rows : (data.data != null ? data.data : []);
    // A refusal is final. Retrying a bad secret or a disallowed path buries the message explaining it.
    if (data && data.ok === false) throw new Error('GX Core dutchie_get ' + path + ': ' + (data.error || 'refused'));
    lastErr = lastErr || 'no payload';
  }
  // `tries`, not a hardcoded 5: a budget bail that still claimed five attempts would be a lie in the
  // one message anybody reads when this breaks.
  throw new Error('GX Core dutchie_get ' + path + ' unreachable after ' + tries + ' tries — ' + lastErr + stopped);
}

/* Non-Dutchie GX Core reads that also cannot be library calls.
 *
 * GXCore.expectedSalesFrac() and GXCore.dutchieClosingReport() were called as library functions and
 * could never have worked: both reach gxDutchieAuth_ -> gxDutchieKeys_ -> getScriptProperties(),
 * which scopes to the CALLING project. From here that looks for Dutchie keys this app no longer
 * holds, so every call threw. Both sites swallow the throw, so nothing ever looked wrong:
 * the pacing endpoint quietly returned {} and today's COGS was quietly absent. */
function gxCoreRoute_(action, params) {
  let url = GXCORE_EXEC_ + '?action=' + encodeURIComponent(action)
          + '&secret=' + encodeURIComponent(gxDeploySecret_());
  Object.keys(params || {}).forEach(k => {
    if (params[k] == null || params[k] === '') return;
    url += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
  });
  let lastErr = '', stopped = '', tries = 0;
  const started = Date.now();
  for (let i = 0; i < 3; i++) {
    if (i > 0) { stopped = gxRetryHold_(started, 300); if (stopped) break; }   // see GXCORE_RETRY_BUDGET_MS
    tries++;
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    let data = null;
    try { data = JSON.parse(resp.getContentText()); } catch (e) { lastErr = 'unparseable body'; }
    if (data && data.ok === true) return data;
    if (data && data.ok === false) throw new Error(action + ': ' + (data.error || 'refused'));
    lastErr = lastErr || 'no payload';
  }
  throw new Error('GX Core ' + action + ' unreachable after ' + tries + ' tries — ' + lastErr + stopped);
}

/* The store vocabulary, from the shared registry rather than from the keys of a local credential
   map. That map was doubling as the store list, so a stale label silently became a store this app
   believed in. Cached per execution; a GAS execution is short-lived. */
let _gxStoreRegistry_ = null;
let _gxStoreNames_    = null;
function gxStoreRegistry_() {
  if (_gxStoreRegistry_) return _gxStoreRegistry_;
  let rows = [];
  try {
    rows = GXCore.getStores() || [];
  } catch (e) {
    throw new Error('GX Core store registry unreachable: ' + ((e && e.message) || e));
  }
  if (!rows.length) throw new Error('GX Core returned no stores');
  return (_gxStoreRegistry_ = rows);
}

function gxStoreNames_() {
  if (_gxStoreNames_) return _gxStoreNames_;
  const names = gxStoreRegistry_()
    .map(s => String(s.dutchie_name || '').trim())
    .filter(Boolean);
  if (!names.length) throw new Error('GX Core returned no stores');
  return (_gxStoreNames_ = names);
}

/* Probe helper for the diagnostic routes below. They exist to ask Dutchie what a path returns, and
   they used to do it with a local key. GX Core answers now, so a path outside its allowlist comes
   back as a refusal naming the path — which is exactly the answer a probe wants, rather than a
   silent nothing. Never throws: a probe that dies on the first bad path stops being a probe. */
function gxProbe_(store, path, qs) {
  const params = {};
  String(qs || '').replace(/^\?/, '').split('&').filter(Boolean).forEach(pair => {
    const i = pair.indexOf('=');
    if (i > 0) params[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
  });
  try {
    const out = gxDutchieGet_(store, path, params);
    const body = JSON.stringify(out);
    return { status: 200, preview: body.slice(0, 800), count: Array.isArray(out) ? out.length : null };
  } catch (e) {
    return { status: 'via-gx-core', error: String((e && e.message) || e) };
  }
}

/* Replaces storeKey_ as the validity check, and keeps the property that mattered about it: an
   INHERITED name ('constructor', 'toString') must NOT pass. An array membership test is
   prototype-safe by construction, where a bare `map[store]` truthiness check never was.

   THE EXACT MATCH IS NOT ENOUGH, and River Rd is why. The vocabulary used to be the KEYS of this
   app's own credential map, which were Sales' internal names — including `River`. Moving the keys
   into GX Core replaced that list with the registry's `dutchie_name` values, and five of six stores
   happen to spell the same both ways. River does not: the frontend asks for `River`, the registry
   says `River Rd`, so from 2026-08-31 the one store whose two names differ answered
   "Unknown store: River" on every sales load while the other five were fine.

   The second chance goes through GXCore.resolveStore rather than a local alias table, deliberately:
   an alias table here would make Sales look right while leaving the same mismatch wrong for every
   other reader, and a spelling added in Command Center would never reach us. resolveStore is the
   registry's own folding — `River` and `River Rd` both land on store_id `river-rd`. An inherited
   name still fails: resolveStore is handed a string and answers with a row or nothing, and the
   result is only accepted when it carries a store_id the registry actually lists. */
/* The store_ids the registry lists, read straight off the SAME rows gxStoreNames_ already has.
 *
 * This used to call GXCore.resolveStore once per store to rediscover ids the registry rows were
 * already carrying — six extra library calls, each in its own try that swallowed a failure. That
 * silent swallow is the bug: it drops an id on a transient hiccup, and a dropped id is not a
 * neutral loss, because knownStore_ accepts a resolved name only when its id appears in THIS list.
 * Lose `river-rd` here for one execution and `River` — the only name of the six that has to reach
 * this comparison at all — answers "Unknown store: River" for that request while the other five,
 * which match by string on the first line and never get here, are unaffected.
 *
 * Sky, 2026-09-04: "on the phone River is the one that fails most frequently." That is the shape of
 * it: not a name mismatch (River resolves to river-rd correctly, measured), but the one store whose
 * name is not an exact registry spelling standing behind seven more fallible calls than its five
 * neighbors. Reading the ids off the rows makes it zero. */
let _gxStoreIds_ = null;
function gxStoreIds_() {
  if (_gxStoreIds_) return _gxStoreIds_;
  const ids = gxStoreRegistry_()
    .map(function (r) { return String((r && r.store_id) || '').trim().toLowerCase(); })
    .filter(Boolean);
  return (_gxStoreIds_ = ids);
}

/* storeGate_ — the same decision knownStore_ has always made, plus WHY.
 *
 * The old catch turned every failure of the second chance into `false`, and doGet renders `false`
 * as "Unknown store: River". Those are two different events wearing one message: a name the
 * registry has never heard of, and the registry being briefly unable to answer. The first is a
 * bug in the caller and permanent; the second is a hiccup that the next poll would have survived.
 * Reported as a store that fails "most frequently" — frequency being the tell that it was never a
 * vocabulary problem, because a vocabulary problem fails every single time.
 *
 * A registry outage is RETHROWN, deliberately, so it reaches the client as a transport failure and
 * gets the retry it deserves — which is exactly what already happens to the other five stores,
 * whose gxStoreNames_() throws before this function's try is ever entered. Making River's failure
 * mode match theirs is most of the fix.
 */
function storeGate_(store) {
  const s = String(store);
  if (gxStoreNames_().indexOf(s) !== -1) return { ok: true, exact: true };

  // The second chance goes through GXCore.resolveStore, never a local alias table — see the note
  // above. Memoized in the SCRIPT cache rather than per execution: `River` is the only name that
  // reaches this line, on every request, from every open tab, and the registry's own spelling
  // changes on a human timescale. An hour matches the settled-sales TTL, so a Command Center rename
  // still flows through within the hour.
  const memoKey = 'storeid_v1_' + s;
  let id = '';
  const memo = cacheGet_(memoKey);
  if (memo !== null && memo !== undefined) {
    id = String(memo);
  } else {
    let row;
    try {
      row = GXCore.resolveStore(s);
    } catch (e) {
      // NOT a `false`. Nothing has been learned about this name.
      throw new Error('GX Core store registry unreachable: ' + ((e && e.message) || e));
    }
    id = row && row.store_id ? String(row.store_id).toLowerCase() : '';
    // A null answer IS an answer — the registry does not know this name — so caching it is safe and
    // it is the empty string that gets stored. A throw never reaches here and so is never cached.
    try { cacheSet_(memoKey, id, 3600); } catch (e) {}
  }

  if (!id) return { ok: false, exact: false, reason: 'unknown' };
  // The answer is accepted only when it carries a store_id the registry actually lists, which is
  // what keeps `constructor` / `__proto__` out.
  if (gxStoreIds_().indexOf(id) === -1) return { ok: false, exact: false, reason: 'unknown' };
  return { ok: true, exact: false, store_id: id };
}

function knownStore_(store) {
  return storeGate_(store).ok;
}

/* The JSON translation of the gate, for every caller that answers with a body rather than a throw.
 * Returns null when the store is good, and the response to send when it is not — keeping "the
 * registry could not be reached" a different message from "that is not a store" on the write and
 * inventory routes too, not just on the sales load where it was found. */
function storeGateError_(store) {
  if (!store) return jsonOut_({ ok: false, error: 'Unknown store: ' + store });
  try {
    if (storeGate_(store).ok) return null;
  } catch (e) {
    return jsonOut_({ ok: false, error: (e && e.message) || 'GX Core store registry unreachable' });
  }
  return jsonOut_({ ok: false, error: 'Unknown store: ' + store });
}

/* Same question, for a probe that must not die on it. A probe that throws stops being a probe. */
function knownStoreSafe_(store) {
  try { return knownStore_(store); } catch (e) { return false; }
}

function hasOwn_(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, String(key));
}


const BASE = 'https://api.pos.dutchie.com';

// The legacy "2026 GX2 Dashboard" workbook is DISCONNECTED (2026-08-30, Sky's call). Its id and
// gids are deliberately not constants any more: while they exist, the next session adds "just one
// quick read" and the dependency grows back. Everything it used to supply now lives in this
// script's own properties — frozen_goals, frozen_expbudgets, frozen_qbmapping, otherrev_data,
// rev_atm_* — with expense budgets superseded by the smart budget. This app holds only READER
// access to that file anyway, so nothing here could ever have written it.
// The snapshot taken before the cut: 6 store goal rows, 22 expense categories, 9 QB mapping pairs,
// verified against the sheet (May total $685,700 / Jun $664,946) before anything was removed.
// The calendar year the sheet above holds goals for — it is the "2026 GX2 Dashboard" workbook and
// carries ONE set of 12 monthly columns, with no year dimension. getGoals() ships this alongside the
// numbers so the frontend can refuse to show them for a year they do not describe: the period picker
// offers curY-2..curY, and without this every 2024/2025 view measured real sales against the 2026
// plan. Swap the sheet, swap this. There is no 2025 budget anywhere to fall back to.
const BUDGET_YEAR      = 2026;

// ── Cache helpers ─────────────────────────────────────────────────────────────
const CACHE = CacheService.getScriptCache();

function cacheGet_(key) {
  try {
    // Support chunked storage for large payloads
    const meta = CACHE.get(key + '__meta');
    if (meta) {
      const { chunks } = JSON.parse(meta);
      let out = '';
      for (let i = 0; i < chunks; i++) out += (CACHE.get(key + '__' + i) || '');
      return out || null;
    }
    return CACHE.get(key);
  } catch(e) { return null; }
}

function cacheSet_(key, value, ttl) {
  try {
    const CHUNK = 95000; // GAS cache limit is ~100KB per entry
    if (value.length > CHUNK) {
      const chunks = Math.ceil(value.length / CHUNK);
      const entries = { [key + '__meta']: JSON.stringify({ chunks }) };
      for (let i = 0; i < chunks; i++) {
        entries[key + '__' + i] = value.slice(i * CHUNK, (i + 1) * CHUNK);
      }
      CACHE.putAll(entries, ttl);
    } else {
      CACHE.put(key, value, ttl);
    }
  } catch(e) { /* cache write failure is non-fatal */ }
}

function cacheDelete_(key) {
  try {
    const meta = CACHE.get(key + '__meta');
    if (meta) {
      const { chunks } = JSON.parse(meta);
      const keys = [key + '__meta'];
      for (let i = 0; i < chunks; i++) keys.push(key + '__' + i);
      CACHE.removeAll(keys);
    } else {
      CACHE.remove(key);
    }
  } catch(e) { /* non-fatal */ }
}

// ── JSON response helper ──────────────────────────────────────────────────────
function jsonOut_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── Load timing marks — only collected while a loadprobe execution is running ─
// A store row that shimmers forever and one that errors look the same to the reader, and both
// look the same in the source. The only way to tell "this store is slow" from "the hop to this
// store bounced" is to time the real path in the live runtime, which is what these marks do.
// Off by default: _PROBE_MARKS is null unless loadProbe_ turns it on, so a normal request pays
// nothing and nothing accumulates across executions.
let _PROBE_MARKS = null;
function probeMark_(label, ms, extra) {
  if (!_PROBE_MARKS) return;
  const row = { step: label, ms: Math.round(ms) };
  if (extra) Object.keys(extra).forEach(k => { row[k] = extra[k]; });
  _PROBE_MARKS.push(row);
}

// ── Session auth (mirrors Inventory Phase-1 pattern) ─────────────────────────
// Tokens are signed with GC_SESSION_SECRET (shared across the suite) so a token
// issued by GXCore.login() validates identically in requireAuth_() here.
const GC_SESSION_SECRET_KEY = 'GC_SESSION_SECRET'; // MUST match GXCore + Inventory
const GC_SESSION_TTL_MS     = 7 * 24 * 60 * 60 * 1000; // 7 days
const GC_USERS_KEY          = 'gc_sales_users';    // local fallback user store

function sessionSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty(GC_SESSION_SECRET_KEY);
  if (!secret) {
    // Bootstrap: generate once. For shared-secret operation, Sky must copy the
    // same value from GXCore / Inventory ScriptProperties here after first deploy.
    secret = Utilities.getUuid() + ':' + Utilities.getUuid();
    props.setProperty(GC_SESSION_SECRET_KEY, secret);
  }
  return secret;
}

function hashPass_(pass) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(pass));
  return bytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function signSession_(payload) {
  const sig = Utilities.computeHmacSha256Signature(payload, sessionSecret_());
  return Utilities.base64EncodeWebSafe(sig);
}

function issueSessionToken_(user) {
  const exp = Date.now() + GC_SESSION_TTL_MS;
  const payload = [String(user).toLowerCase().trim(), exp].join(':');
  return payload + ':' + signSession_(payload);
}

function validateSessionToken_(token) {
  if (!token) return { ok: false, error: 'Auth required' };
  const parts = String(token).split(':');
  if (parts.length !== 3) return { ok: false, error: 'Invalid session' };
  const [user, expStr, sig] = parts;
  const exp = Number(expStr || 0);
  if (!user || !exp || Date.now() > exp) return { ok: false, error: 'Session expired' };
  const payload = user + ':' + exp;
  if (sig !== signSession_(payload)) return { ok: false, error: 'Invalid session' };
  return { ok: true, user };
}

// ── Write-auth grant re-check — SHIPPED DARK ON PURPOSE ──────────────────────────
// THE GAP: validateSessionToken_ checks a signature and an expiry, never a GRANT. A token proves who
// you are, not that you still have access, so revoking someone in the shared user list leaves them
// able to write here for the remainder of a SEVEN DAY TTL. Core's roleForApp (public in v170) closes
// that — it is superadmin-aware, filters on status, and invalidates on revoke, so a revocation bites
// in a minute instead of waiting out the token.
//
// WHY IT DOES NOT ENFORCE YET, WHICH IS THE WHOLE POINT OF THIS SHAPE. Probing roleForApp against
// real accounts on live v170 returned a role for exactly ONE of them — the superadmin, who is also
// the person deploying. Every other name came back null, including the owner of this app. Turning
// that into a refusal would have write-locked the owner while working perfectly for whoever shipped
// it, which is precisely the configuration in which nobody notices. Inventory has since made the
// rule explicit and it is adopted here: BEFORE wiring an auth check fail-closed, probe a real
// NON-SUPERADMIN account through it and require ADMITTED. The deployer is the worst test subject
// because they are usually the one account that resolves.
//
// SO THE CHECK RUNS AND RECORDS INSTEAD OF REFUSING. Mode lives in the GX_WRITE_GUARD property:
//   'log'     (default) — decide, record, ALLOW regardless. Cannot cause an outage.
//   'enforce'           — actually refuse. Flip only once the log shows real users being ADMITTED.
//   'off'               — skip entirely.
//
// IT RECORDS ADMITS AS WELL AS REFUSALS, DELIBERATELY. The lesson both this app and inventory landed
// on this week is that "refuses the bad" and "admits the good" are two different assertions, and a
// probe that only ever asserts the first reads green while locking everyone out. A log that captured
// only refusals would repeat that exact error one level down: it could never show the positive path
// working, which is the only evidence that justifies flipping to enforce.
const GX_WRITE_GUARD_KEY = 'GX_WRITE_GUARD';      // 'log' (default) | 'enforce' | 'off'
const GX_WRITE_GUARD_LOG = 'GX_WRITE_GUARD_LOG';  // capped ring — history tables never grow unbounded
const GX_WRITE_GUARD_CAP = 25;
const GX_WRITE_GUARD_TALLY = 'GX_WRITE_GUARD_TALLY';  // monotonic counters — survive the ring rolling

function writeGuard_(user, action) {
  const props = PropertiesService.getScriptProperties();
  const mode  = props.getProperty(GX_WRITE_GUARD_KEY) || 'log';
  if (mode === 'off') return { ok: true, mode: mode };

  let role = null, err = null;
  try {
    role = (typeof GXCore !== 'undefined' && GXCore && typeof GXCore.roleForApp === 'function')
      ? GXCore.roleForApp(String(user || '').toLowerCase().trim(), 'sales')
      : null;
    if (!role && typeof GXCore.roleForApp !== 'function') err = 'roleForApp unavailable at this pin';
  } catch (e) {
    err = e.message;
  }

  recordGuard_(props, { user: user, action: action, role: role || null, err: err || null });

  // Fail CLOSED when enforcing, including on a Core error. We fail open everywhere else so a Core
  // hiccup never blanks a board, but failing open on an AUTH check means no check at all.
  if (mode === 'enforce' && !role) {
    return { ok: false, mode: mode, error: err ? 'Access check unavailable' : 'No access to Sales', code: 'no_access' };
  }
  return { ok: true, mode: mode, role: role || null, would_refuse: !role };
}

function recordGuard_(props, entry) {
  try {
    const ring = JSON.parse(props.getProperty(GX_WRITE_GUARD_LOG) || '[]');
    // Dates in this suite are TEXT, never Date objects.
    entry.ts = Utilities.formatDate(new Date(), 'America/Los_Angeles', "yyyy-MM-dd'T'HH:mm:ss");
    ring.push(entry);
    while (ring.length > GX_WRITE_GUARD_CAP) ring.shift();
    props.setProperty(GX_WRITE_GUARD_LOG, JSON.stringify(ring));

    // COUNTERS ALONGSIDE THE RING, because they answer a question the ring cannot. The ring holds
    // detail for the last 25 decisions and then rolls — and the single most valuable record here is
    // the FIRST admit by a real non-superadmin, since that is the event that licenses flipping to
    // enforce. A batch of saves right after a grant lands would push it off the end. Counters are
    // monotonic, so "has a real user ever been admitted" and "did the gate start refusing everyone"
    // stay answerable as numbers long after the detail has rolled away.
    // Shape borrowed from pricecards via inventory so the suite reads the same way.
    const kind = entry.err ? 'error' : (entry.role ? 'admitted' : 'refused_no_grant');
    const tally = JSON.parse(props.getProperty(GX_WRITE_GUARD_TALLY) || '{}');
    tally[kind] = (tally[kind] || 0) + 1;
    // First admit is stamped once and never overwritten — it is the evidence, not a running value.
    if (kind === 'admitted' && !tally.first_admit) {
      tally.first_admit = { user: entry.user, role: entry.role, ts: entry.ts };
    }
    props.setProperty(GX_WRITE_GUARD_TALLY, JSON.stringify(tally));
  } catch (e) {
    // A diagnostic must never be the reason a write fails.
  }
}

function requireAuth_(params) {
  return validateSessionToken_(params.token || params.session || params.auth || '');
}

// Phase-2 shared sign-on: validate through GXCore (which checks app access grant),
// with a local fallback so a GXCore hiccup never locks anyone out.
function loginUser(params) {
  try {
    if (typeof GXCore !== 'undefined' && GXCore && GXCore.login) {
      const r = GXCore.login(params.user, params.pass, 'sales');
      if (r && r.ok) return r;
      const local = _loginUserLocal_(params);
      if (local && local.ok) return local;
      return r;
    }
  } catch(e) {
    Logger.log('[Sales login/GXCore] ' + e.message);
  }
  return _loginUserLocal_(params);
}

function _loginUserLocal_(params) {
  if (!params.user || !params.pass) return { ok: false, error: 'Missing credentials' };
  const props = PropertiesService.getScriptProperties();
  const users = JSON.parse(props.getProperty(GC_USERS_KEY) || '{}');
  const key   = String(params.user).toLowerCase().trim();
  const hash  = hashPass_(String(params.pass));
  if (hasOwn_(users, key) && users[key] === hash) {
    return { ok: true, user: key, token: issueSessionToken_(key), expiresAt: new Date(Date.now() + GC_SESSION_TTL_MS).toISOString() };
  }
  return { ok: false, error: 'Invalid username or password' };
}

function doGet(e) {
  const params = e.parameter;

  // Serve the dashboard HTML when accessed with no parameters
  if (!params.action && !params.store) {
    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('Green Cross Dashboard')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0, viewport-fit=cover')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // ── Public actions (no token required) ──────────────────
  if (params.action === 'login') return jsonOut_(loginUser(params));

  // Temporary debug — protected by deploy secret
  if (params.action === 'debuglogin') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    try {
      const r = GXCore.login(params.user || '__probe__', params.pass || '__probe__', 'sales');
      return jsonOut_({ gxcore: { ok: r.ok, user: r.user, role: r.role, error: r.error, hasToken: !!r.token } });
    } catch(e) {
      return jsonOut_({ gxcore: null, error: e.message });
    }
  }

  // Which GXCore snapshot is this deployment ACTUALLY running? A GXCore.x() call executes the version this
  // app PINS, and a deployment snapshots the manifest — so the pin in appsscript.json at HEAD tells you
  // nothing about the live app, and reading gx_core.gs tells you less. The only honest answer comes from
  // the live deployment asking the library itself. Ask this URL, not the repo, after every re-pin.
  // Guarded by the deploy secret like debuglogin: a Forbidden here means GX_DEPLOY_SECRET is unset or
  // stale on THIS script, which is its own finding — that same property gates qbReportViaGXCore_.
  /* Are the Dutchie credentials actually configured? Reports LABELS and a COUNT, never a value.
     Exists because the keys moved out of source into Script Properties on 2026-08-29: the property
     is invisible from outside the script, so "did the seed work?" had no answer short of pushing
     the new code and finding out in production. Deploy-secret gated, same as gxpin above. */
  if (params.action === 'storekeys') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    const labels = gxStoreNames_().slice().sort();
    /* &store= answers the question that cost River Rd a day of blank sales: does the name the
       FRONTEND sends pass this app's gate? The labels alone did not answer it — they looked
       complete and correct while `River` was being refused, because the registry spells that one
       store `River Rd`. Ask with the name the caller actually uses. */
    const out = { ok: true, configured: labels.length > 0, count: labels.length, labels: labels };
    if (params.store) {
      out.probe = { store: params.store, known: knownStoreSafe_(params.store), exact: labels.indexOf(String(params.store)) !== -1 };
      try {
        const row = GXCore.resolveStore(String(params.store));
        out.probe.store_id = row && row.store_id ? row.store_id : null;
      } catch (e) { out.probe.store_id = null; }
    }
    return jsonOut_(out);
  }

  if (params.action === 'gxpin') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    try {
      if (typeof GXCore === 'undefined' || !GXCore) return jsonOut_({ ok: false, error: 'GXCore binding missing' });
      // libVersion() landed in Core v153. Its absence is not an error — it dates the pin as older than that.
      const props = PropertiesService.getScriptProperties();
      // Which connector actually served the last uncached Expenses load, and whether the precondition
      // for using Core at all is even in place. qb_last_source is stamped by getExpenses on a cache miss.
      const qb = {
        secret_configured: !!secret,
        last_source: props.getProperty('QB_LAST_SOURCE') || null   // 'gxcore@<iso>' | 'local@<iso>' | null
      };
      if (typeof GXCore.libVersion !== 'function') {
        return jsonOut_({ ok: true, app: 'sales', gxcore_version: null, qb: qb, note: 'pinned Core predates libVersion() (added v153)' });
      }
      return jsonOut_({ ok: true, app: 'sales', gxcore_version: GXCore.libVersion(), qb: qb });
    } catch (e) {
      return jsonOut_({ ok: false, error: e.message });
    }
  }

  // Inventory's snippet, adopted as offered. gxpin answers the same question but is secret-gated;
  // this one is public and needs no session, which is the point — "what version am I running" should
  // cost nothing to ask right after a deploy, or nobody runs it. An old pin IDENTIFIES ITSELF here
  // rather than throwing, so the diagnostic still answers when it is most needed. Leaks one integer,
  // and Core's own action=health already publishes the matching side.
  if (params.action === 'libversion') {
    try {
      if (typeof GXCore === 'undefined' || !GXCore) return jsonOut_({ ok: false, error: 'GXCore not bound' });
      if (typeof GXCore.libVersion !== 'function') return jsonOut_({ ok: false, error: 'pinned GXCore has no libVersion() - pre-v153' });
      return jsonOut_({ ok: true, gxcore: GXCore.libVersion() });
    } catch (e) {
      return jsonOut_({ ok: false, error: e.message });
    }
  }

  // Two facts this app cannot settle by inspection, both secret-gated like gxpin.
  //
  // 1. THE SESSION SECRET FINGERPRINT. Core and every spoke read the SAME property name,
  //    GC_SESSION_SECRET, and each project AUTO-GENERATES a random value when it finds none set — so
  //    matching NAMES prove nothing about matching VALUES. Two projects can hold different secrets
  //    under one name and their tokens will never interoperate. A truncated SHA-256 compares the two
  //    without either side handing over a value. Core publishes 625516f184e4f203.
  //    Read the property DIRECTLY, never through sessionSecret_() — that helper MINTS a secret when
  //    it finds none, so a diagnostic built on it would create the very thing it claims to measure
  //    and then report a confident fingerprint for a brand-new value nobody shares.
  //
  // 2. WHETHER THE GRANT RE-CHECK IS AVAILABLE AND WHAT IT SAYS. roleForApp went public in Core
  //    v170. Pass &user= to see how Core answers for a REAL account before anything fails closed on
  //    it. A fail-closed auth check wired against a wrong assumption is an outage for every user of
  //    the app, not a quiet degradation, so the refusal path gets measured before it is trusted.
  if (params.action === 'authprobe') {
    const props0 = PropertiesService.getScriptProperties();
    const secret = props0.getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    const out = { ok: true, app: 'sales' };
    try {
      const raw = PropertiesService.getScriptProperties().getProperty(GC_SESSION_SECRET_KEY) || '';
      out.session_secret_set = !!raw;
      out.session_fingerprint = raw
        ? Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw)
            .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('').slice(0, 16)
        : null;
    } catch (e) {
      out.session_fingerprint_error = e.message;
    }
    // WHO WOULD A FAIL-CLOSED GRANT CHECK ACTUALLY LOCK OUT? Names only, never hashes. roleForApp
    // answered null for every account name I could guess, which has two very different causes —
    // nobody holds a sales grant in Core, or I was simply guessing the wrong ids — and they call for
    // opposite responses. Listing the ids this app really authenticates tells the two apart instead
    // of leaving a guess in a report.
    try {
      const uraw = PropertiesService.getScriptProperties().getProperty(GC_USERS_KEY) || '{}';
      out.local_users = Object.keys(JSON.parse(uraw));
    } catch (e) {
      out.local_users_error = e.message;
    }
    // WHAT CAN THIS PIN ACTUALLY CALL? Asked because the grant question above is unanswerable from
    // outside Core — no HTTP route enumerates who holds a grant — but we are a BOUND spoke, so
    // anything public on the library is callable from in here. Listing the surface says whether a
    // user/grant listing function exists at our pin instead of guessing route names over HTTP.
    if (params.surface) {
      try {
        out.gxcore_surface = Object.keys(GXCore).sort();
      } catch (e) {
        out.gxcore_surface_error = e.message;
      }
    }
    try {
      out.write_guard_mode = props0.getProperty(GX_WRITE_GUARD_KEY) || 'log';
      out.write_guard_log  = JSON.parse(props0.getProperty(GX_WRITE_GUARD_LOG) || '[]');
      out.write_guard_tally = JSON.parse(props0.getProperty(GX_WRITE_GUARD_TALLY) || '{}');
    } catch (e) {
      out.write_guard_error = e.message;
    }
    try {
      out.gxcore_version  = (typeof GXCore !== 'undefined' && GXCore && typeof GXCore.libVersion === 'function') ? GXCore.libVersion() : null;
      out.has_roleForApp  = !!(typeof GXCore !== 'undefined' && GXCore && typeof GXCore.roleForApp === 'function');
      if (out.has_roleForApp && params.user) {
        const u = String(params.user).toLowerCase().trim();
        out.role_for_user = { user: u, role: GXCore.roleForApp(u, 'sales') };
      }
    } catch (e) {
      out.gxcore_error = e.message;
    }
    return jsonOut_(out);
  }

  // Flip the write guard between log / enforce / off WITHOUT opening the editor. Secret-gated.
  // THE REASON THIS EXISTS IS ROLLBACK, NOT CONVENIENCE. GX_WRITE_GUARD arms a FAIL-CLOSED auth gate;
  // if it ever misbehaves, the fix must be seconds away and must not depend on anyone being at a
  // browser. A revert that requires opening the Apps Script editor is a revert that happens late.
  //
  // The accepted values are an ARRAY checked with indexOf, deliberately not an object checked with
  // MAP[value]. This app spent a session removing exactly that idiom after measuring six inherited
  // names passing a lookup gate; reintroducing it on the route that arms the auth gate would be a
  // poor joke. 'constructor' is not a mode.
  if (params.action === 'guardmode') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    const MODES = ['log', 'enforce', 'off'];
    const want  = String(params.mode || '');
    if (MODES.indexOf(want) === -1) {
      return jsonOut_({ ok: false, error: 'mode must be one of ' + MODES.join(', '), got: want });
    }
    const props = PropertiesService.getScriptProperties();
    const was   = props.getProperty(GX_WRITE_GUARD_KEY) || 'log';
    props.setProperty(GX_WRITE_GUARD_KEY, want);
    return jsonOut_({ ok: true, app: 'sales', was: was, now: want });
  }

  // Heartbeat: renew a still-valid token to extend the session
  // ── pnlprobe — exercise the P&L path in the LIVE Apps Script runtime, without a session ──────
  // The `pnl` action sits behind the session gate, so the only way to run it is to be signed in with
  // a browser — which means the server-side half (qbProfitAndLoss_ by class, flattenPnlRows_, the
  // cache) can sit unexercised while everything around it looks verified. That is exactly the gap
  // this repo already fills with gxpin / authprobe / guardmode: secret-gated, read-only, and asked
  // OF the running deployment rather than inferred from the source.
  //
  // It does not re-implement anything. It calls getPnl and then checks the one property that says
  // the walk was correct: a P&L ties out. Income - COGS = Gross Profit, - Expenses = Net Operating
  // Income, + Net Other Income = Net Income, in EVERY class column. A structural bug in the tree
  // walk cannot leave those identities standing.
  if (params.action === 'pnlprobe') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    try {
      const out  = getPnl({ by: params.by || 'Classes', start: params.start, end: params.end, nocache: '1' });
      const data = JSON.parse(out.getContent());
      if (data.error) return jsonOut_({ ok: false, stage: 'getPnl', error: data.error });

      const at = (label) => (data.rows || []).find(r => r.label === label);
      const val = (label, i) => { const r = at(label); return r ? (r.values[i] || 0) : 0; };
      const checks = [];
      (data.columns || []).forEach((col, i) => {
        const gp  = val('Total Income', i) - val('Total Cost of Goods Sold', i);
        const noi = gp - val('Total Expenses', i);
        const ni  = noi + val('Net Other Income', i);
        checks.push({
          column: col,
          gross_profit:         Math.abs(gp  - val('Gross Profit', i))         < 0.005,
          net_operating_income: Math.abs(noi - val('Net Operating Income', i)) < 0.005,
          net_income:           Math.abs(ni  - val('Net Income', i))           < 0.005,
          reported_net_income:  val('Net Income', i)
        });
      });
      const failed = checks.filter(c => !c.gross_profit || !c.net_operating_income || !c.net_income);
      return jsonOut_({
        ok: failed.length === 0,
        ran_in: 'apps script runtime',
        by: data.by, start: data.start, end: data.end,
        qb_source: data.qb_source, qb_fallback_reason: data.qb_fallback_reason,
        columns: data.columns, rows: (data.rows || []).length,
        kinds: (data.rows || []).reduce((a, r) => { a[r.kind] = (a[r.kind] || 0) + 1; return a; }, {}),
        ties_out: failed.length === 0, failed_columns: failed
      });
    } catch (e) {
      return jsonOut_({ ok: false, stage: 'probe', error: e.message });
    }
  }


  // ── expbreakprobe — does the expanded panel agree with the row above it ──────────────────────
  // The breakdown derives a category's accounts and store split from the by=Classes P&L, while the
  // tab's own total comes from the by=Month P&L. Two reports, one number: the ONLY assertion worth
  // making is that they tie. So this runs both in the live runtime over the same window, walks the
  // month report through the real walkQBRows_, and diffs it against the breakdown category by
  // category. A structural bug in either walk cannot leave those equal.
  //
  // Same trick and same reason as pnlprobe / goalrangeprobe: both halves sit behind the login gate,
  // so without this the only way to check a deploy is to open a browser and expand rows by hand.
  // ?action=expbreakprobe&start=YYYY-MM-DD&end=YYYY-MM-DD&secret=...
  if (params.action === 'expbreakprobe') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    try {
      const start = pnlDate_(params.start), end = pnlDate_(params.end);
      if (!start || !end) return jsonOut_({ ok: false, error: 'start and end are required, as YYYY-MM-DD' });

      const bd = JSON.parse(getExpenseBreakdown({ start, end, nocache: '1' }).getContent());
      if (!bd.ok) return jsonOut_({ ok: false, stage: 'breakdown', error: bd.error });

      // The tab's own attribution, over the same window, through the shipped walk.
      const mReport = qbProfitAndLoss_(start, end, 'Month').report;
      const mCols   = ((mReport.Columns && mReport.Columns.Column) || []).map(c => c.ColTitle || '').filter(Boolean);
      const mRes    = {};
      walkQBRows_((mReport.Rows && mReport.Rows.Row) || [], mCols, mRes, null, new Set(), getExpenseMapConfig_(), 0);
      const monthTotal = (cat) => Object.keys(mRes[cat] || {})
        .filter(c => c !== 'Total')
        .reduce((s, c) => s + (mRes[cat][c] || 0), 0);

      const cats = Object.keys(bd.categories).concat(Object.keys(mRes))
        .filter((v, i, a) => a.indexOf(v) === i).sort();
      const rows = cats.map(cat => {
        const c   = bd.categories[cat] || { total: 0, byClass: {}, accounts: [], residual: 0 };
        const mt  = monthTotal(cat);
        const cls = bd.classes.reduce((s, k) => s + (c.byClass[k] || 0), 0);
        return {
          category: cat,
          by_month: Math.round(mt * 100) / 100,
          breakdown: Math.round(c.total * 100) / 100,
          delta: Math.round((c.total - mt) * 100) / 100,
          classes_sum_ok: Math.abs(cls - c.total) < 0.005,   // the split explains the whole total
          accounts: c.accounts.length,
          residual: Math.round(c.residual * 100) / 100
        };
      });
      const mismatched = rows.filter(r => Math.abs(r.delta) > 0.005 || !r.classes_sum_ok);
      const residuals  = rows.filter(r => r.residual !== 0);
      return jsonOut_({
        ok: mismatched.length === 0,
        ran_in: 'apps script runtime',
        start, end,
        classes: bd.classes,
        categories: rows.length,
        ties_out: mismatched.length === 0,
        mismatched,
        // Nonzero residuals are not a failure — a QB section can carry an amount its children do not
        // explain — but they are the thing to look at before trusting an account list.
        with_residual: residuals,
        totals: {
          by_month:  Math.round(rows.reduce((s, r) => s + r.by_month, 0) * 100) / 100,
          breakdown: Math.round(rows.reduce((s, r) => s + r.breakdown, 0) * 100) / 100
        },
        rows
      });
    } catch (e) {
      return jsonOut_({ ok: false, stage: 'probe', error: e.message });
    }
  }

  // Runs the REAL deposits path in the live Apps Script runtime with no session, the same trick and
  // the same reason as pnlprobe: getDeposits sits behind the login gate, so without this the only
  // way to know whether it works in production is to open a browser and log in — and a check that
  // inconvenient is a check nobody runs after a deploy. Secret-gated, read-only, returns a SHAPE
  // summary rather than the money.
  if (params.action === 'reconprobe') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    try {
      const out  = getDeposits({ start: params.start, end: params.end, nocache: '1' });
      const data = JSON.parse(out.getContent());
      if (data.ok === false) return jsonOut_({ ok: false, stage: 'getDeposits', error: data.error });
      const byStore = data.deposits || {};
      const rows = Object.keys(byStore).map(function (k) {
        const list = byStore[k];
        return {
          store: k, deposits: list.length,
          // The count that was 5x wrong before the lines were collapsed. If a deposit ever comes
          // back as one row per QB line again, this is where it shows.
          max_lines_folded: list.reduce(function (m, r) { return Math.max(m, r.lines || 0); }, 0),
          total: Math.round(list.reduce(function (a, r) { return a + r.amount; }, 0) * 100) / 100,
          first: list.length ? list[0].date : null,
          last:  list.length ? list[list.length - 1].date : null
        };
      }).sort(function (a, b) { return a.store < b.store ? -1 : 1; });
      // The MEMO VOCABULARY, counted over the window. Reconcile only wants the Dutchie sales
      // banking; a "Printer Ink (refund)" line carrying the store's class is not that. Deciding
      // which memos mean sales has to be READ OFF THE REAL DATA rather than guessed, because
      // guessing wrong in the generous direction quietly folds non-sales money into a store's week,
      // and guessing wrong the other way strands real banking on the not-included list. Reports
      // memo strings and how often each occurs — no amounts.
      const memoTally = {};
      Object.keys(byStore).forEach(function (k) {
        byStore[k].forEach(function (r) {
          String(r.memo || '(none)').split(' · ').forEach(function (m) {
            const key = m.trim() || '(none)';
            memoTally[key] = (memoTally[key] || 0) + 1;
          });
        });
      });
      const memos = Object.keys(memoTally)
        .map(function (m) { return { memo: m, seen: memoTally[m] }; })
        .sort(function (a, b) { return b.seen - a.seen; });

      // THE DEPOSIT-LEVEL NOTES, per store, verbatim and undeduplicated across stores.
      //
      // This exists to MEASURE a format before anything parses it. The note carries the real banking
      // date (`BEND 08.04.26 Dep (7/28/26 - 7/31/26)`) while TxnDate carries the accounting one, and
      // keying the Reconcile week view on the real date is the fix for the month-end swing. But two
      // example strings, both from Bend, are not a format: whether every store writes
      // `<STORE> MM.DD.YY Dep (…)`, whether the date is always second, whether it is ever absent —
      // none of that is knowable by reading, and guessing moves real money into the wrong week
      // silently. Same reason the memo vocabulary above is measured rather than assumed.
      //
      // Grouped BY STORE because that is the axis the format could vary on, and the one thing a
      // whole-range tally would hide. `with_note` vs `deposits` is the coverage check: a format that
      // holds for five stores and is missing on the sixth is the River failure shape again.
      //
      // Reports strings only — no amounts. Until this app re-pins to the GX Core version carrying
      // PrivateNote every note is '', which makes this route the check that the re-pin took.
      const noteRows = [];
      let notesSeen = 0;
      Object.keys(byStore).forEach(function (k) {
        const seenIds = {}, distinct = {};
        let n = 0, withNote = 0;
        byStore[k].forEach(function (r) {
          // One deposit can produce several rows (one per class); count the DEPOSIT once.
          if (hasOwn_(seenIds, r.id)) return;
          seenIds[r.id] = 1; n++;
          const note = String(r.note || '');
          if (!note) return;
          withNote++; notesSeen++;
          // Paired with the BOOKED date, because the whole question is how far the memo's date sits
          // from TxnDate. A tally of memo strings alone cannot answer it, and that delta is what
          // decides both the sanity bound on a parser and which deposits actually move week.
          if (!hasOwn_(distinct, note)) distinct[note] = { seen: 0, booked: [], banked: [] };
          distinct[note].seen++;
          if (distinct[note].booked.indexOf(r.date) === -1) distinct[note].booked.push(r.date);
          // What the SHIPPED parser makes of it — not a re-implementation. This is what turns the
          // probe from a format survey into an end-to-end check of the deployed reconBankedOn_.
          const bo = String(r.banked_on || '');
          if (distinct[note].banked.indexOf(bo) === -1) distinct[note].banked.push(bo);
        });
        noteRows.push({
          store: k, deposits: n, with_note: withNote,
          // Every one of them, not a sample: a format is only proved by the cases that break it.
          notes: Object.keys(distinct).map(function (s) {
            return { note: s, seen: distinct[s].seen, booked: distinct[s].booked.sort(),
                     banked_on: distinct[s].banked.sort() };
          }).sort(function (a, b) { return a.note < b.note ? -1 : 1; }),
        });
      });
      noteRows.sort(function (a, b) { return a.store < b.store ? -1 : 1; });
      // The SALES half, sampled in the same breath. The expected figure on every card is
      // Net Sales + TAX, and per-day tax was only added to the daily records for this feature — it
      // used to be summed into the store-month total and dropped from the rows. That change touches
      // the SHARED aggregation path every tab reads, so it is worth proving in production rather
      // than inferring from a green test. Reports the shape, not the money.
      let sales = null;
      if (params.store && knownStoreSafe_(params.store)) {
        // nocache, like every other probe here: the point of a probe is to exercise the real path,
        // and a served copy proves nothing about it.
        const sr = JSON.parse(getStoreSales_(params.store, data.start, data.end, '1').getContent());
        const daily = sr.daily || [];
        const withTax = daily.filter(function (d) { return typeof d.tax === 'number'; });
        sales = {
          store: params.store, days: daily.length,
          days_carrying_tax: withTax.length,
          // If this is false the Reconcile tab silently understates every week by the tax.
          every_day_carries_tax: daily.length > 0 && withTax.length === daily.length,
          // The per-day tax must add up to the store-month total the response already reported.
          daily_tax_sum: Math.round(daily.reduce(function (a, d) { return a + (d.tax || 0); }, 0) * 100) / 100,
          reported_tax: sr.tax,
          daily_net_sum: Math.round(daily.reduce(function (a, d) { return a + (d.netSales || 0); }, 0) * 100) / 100,
          // What a Reconcile card would show as Expected for this window: Net Sales + Tax.
          expected: Math.round(daily.reduce(function (a, d) { return a + (d.netSales || 0) + (d.tax || 0); }, 0) * 100) / 100,
          sample: daily.length ? daily[0] : null
        };
        sales.tax_ties_out = Math.abs(sales.daily_tax_sum - (sr.tax || 0)) < 0.02;
      }

      return jsonOut_({
        ok: true, ran_in: 'apps script runtime', start: data.start, end: data.end,
        stores: rows, sales: sales,
        store_deposits: rows.reduce(function (a, r) { return a + r.deposits; }, 0),
        unattributed: (data.unattributed || []).map(function (u) {
          return { date: u.date, class: u.class, amount: u.amount, memo: u.memo };
        }),
        memos: memos,
        // PER-DEPOSIT detail, behind &detail=1 because it is large and only wanted when a specific
        // figure is being taken apart. Reports the memo VERBATIM and does NOT classify — the
        // sales/stray rule (reconIsSalesDeposit) lives in index.html and must stay in one place. A
        // second copy here would be a rule that can disagree with the tab it is meant to explain,
        // which is the failure this whole tab exists to prevent, one level up.
        detail: String((params && params.detail) || '') === '1' ? (function () {
          const out = [];
          Object.keys(byStore).forEach(function (k) {
            byStore[k].forEach(function (r) {
              out.push({ store: k, id: r.id, date: r.date, banked_on: r.banked_on,
                         amount: r.amount, cls: r.class, memo: r.memo, note: r.note });
            });
          });
          // Unattributed rows carry no store — they are the other half of what a reader means by
          // "ignored", so they belong in the same listing rather than a separate one.
          (data.unattributed || []).forEach(function (u) {
            out.push({ store: null, id: u.id, date: u.date, banked_on: u.banked_on,
                       amount: u.amount, cls: u.class, memo: u.memo, note: u.note });
          });
          return out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
        })() : null,
        // The deposit-level notes, per store — what a memo-date parser has to survive. `notes_seen`
        // 0 across a range that HAS deposits means this app is still pinned to a GX Core without
        // PrivateNote; that is the re-pin check, not a data problem.
        deposit_notes: noteRows, notes_seen: notesSeen,
        week_starts: data.config
      });
    } catch (e) {
      return jsonOut_({ ok: false, stage: 'probe', error: e.message });
    }
  }

  // Runs the REAL period-goal path in the live runtime with no session, the same trick and the same
  // reason as pnlprobe/reconprobe: getPeriodGoalsForDate_ sits behind the login gate, so after a
  // GXCore re-pin the only way to prove the PINNED library resolves a date to the right pay period
  // is to open a browser and log in — and a check that inconvenient is a check nobody runs after a
  // deploy. Secret-gated, read-only, returns exactly what the app would render.
  if (params.action === 'goalprobe') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    return getPeriodGoalsForDate_(params.date);
  }

  // Same trick and same reason as goalprobe, one range wide: the range route sits behind the login
  // gate, so proving a re-pin still rolls periods up correctly would otherwise mean opening a
  // browser. It is also the only way to see uncovered_days/truncated without a session.
  // Secret-gated twin of budget_proposal. Same reasoning as pnlprobe/goalprobe/reconprobe: the real
  // route sits behind the login gate, so without this the only way to check the budget math after a
  // deploy is to open a browser and sign in — and a check that inconvenient is a check nobody runs.
  // Returns the SHAPE and the reasoning (method, confidence, n_months, annual), not a 22×12 grid.
  // Migration + status for severing the legacy budget workbook. Secret-gated, not session-gated:
  // the freeze has to be runnable from a terminal whether or not anyone is signed in.
  // freeze_sheet is gone with the sheet readers it depended on — the snapshot it took is now the
  // source of truth, not a cache of one. freezestatus remains: it reads only properties and is how
  // you confirm what the app is serving.
  if (params.action === 'freezestatus' || params.action === 'admin_apply_proposed') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    return params.action === 'freezestatus' ? freezeStatus_() : adminApplyProposed_(params);
  }

  if (params.action === 'budgetprobe') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    try {
      const out  = getBudgetProposal({ year: params.year, nocache: '1' });
      const data = JSON.parse(out.getContent());
      if (!data.ok) return jsonOut_({ ok: false, stage: 'getBudgetProposal', error: data.error });
      const byMethod = {}, byConf = {};
      (data.proposals || []).forEach(function (p) {
        byMethod[p.method]     = (byMethod[p.method]     || 0) + 1;
        byConf[p.confidence]   = (byConf[p.confidence]   || 0) + 1;
      });
      const annual = (data.proposals || []).reduce(function (a, p) { return a + (p.annual || 0); }, 0);
      return jsonOut_({
        ok: true, ran_in: 'apps script runtime',
        year: data.year, window: data.window, qb_source: data.qb_source,
        months_of_history: data.months_of_history,
        categories: (data.proposals || []).length,
        by_method: byMethod, by_confidence: byConf,
        proposed_annual_total: annual,
        revenue_trend: data.revenue_trend,
        applied: data.applied,
        // The planner's contract, reported so a deploy can be checked without a browser session.
        // open_months is the one that matters: it is what the Apply button promises, and if the
        // server disagrees with it the write silently preserves months the screen said it would set.
        open_months: data.open_months,
        bills_once: data.bills_once,
        prior_year_coverage: (data.proposals || []).filter(function (p) { return !!p.prior_year; }).length,
        rows: (data.proposals || []).map(function (p) {
          return { category: p.category, method: p.method, confidence: p.confidence,
                   n_months: p.n_months, annual: p.annual,
                   prior_year_total: p.prior_year
                     ? Math.round(MONTHS_12_.reduce(function (a, m) { return a + (p.prior_year[m] || 0); }, 0))
                     : null,
                   outliers_excluded: p.basis ? p.basis.outliers_excluded : null };
        })
      });
    } catch (e) {
      return jsonOut_({ ok: false, stage: 'probe', error: e.message });
    }
  }

  if (params.action === 'goalrangeprobe') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    return getPeriodGoalsRange_(params.start, params.end);
  }

  // Frozen period goal vs ACTUAL net sales, per store, per pay period — the measurement that says
  // whether the goals are set at a level the stores reach. Secret-gated and read-only, the same
  // trick and the same reason as pnlprobe / goalrangeprobe: BOTH halves sit behind the login gate,
  // so without this the only way to answer "what has attainment been" is to log in and add up
  // screens by hand, and a check that inconvenient is a check nobody runs.
  // ?action=attainprobe&start=YYYY-MM-DD&end=YYYY-MM-DD&secret=...
  if (params.action === 'attainprobe') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    return attainProbe_(params.start, params.end);
  }

  // What a single store load actually COSTS, in the live runtime, phase by phase.
  // Sky, 2026-09-04: "on the phone River is the one that fails most frequently — is this a name
  // mismatch River vs River-Rd?" The name resolves fine (storekeys says River -> river-rd), so the
  // question this route answers instead is where the seconds go. The client bounds a store fetch at
  // 2 attempts x 15s (fetchMonthData -> gasFetchJson), so any store whose real cost exceeds ~15s
  // fails on the client while the OTHER five, being cheaper, land — which reads as "that store is
  // broken" rather than "that store is slow". A per-store timing is the only thing that tells those
  // apart, and the timing has to come from the live deployment: the cost is in the hop to GX Core
  // and in Dutchie's payload size, neither of which is visible in the source.
  // ?action=loadprobe&store=River%20Rd&from=…&to=…&nocache=1&secret=…
  if (params.action === 'loadprobe') {
    const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
    if (!secret || params.secret !== secret) return jsonOut_({ ok: false, error: 'Forbidden' });
    return jsonOut_(loadProbe_(params));
  }

  if (params.action === 'ping') {
    const pAuth = requireAuth_(params);
    if (!pAuth.ok) return jsonOut_({ ok: false, error: pAuth.error });
    const newExp = Date.now() + GC_SESSION_TTL_MS;
    const payload = pAuth.user + ':' + newExp;
    return jsonOut_({ ok: true, token: payload + ':' + signSession_(payload), expiresAt: new Date(newExp).toISOString() });
  }

  // ── Auth gate — all data actions require a valid session ─
  const auth = requireAuth_(params);
  if (!auth.ok) return jsonOut_({ ok: false, error: auth.error, code: 401 });

  if (params.action === 'stores')      return getStoresMeta_();
  if (params.action === 'goals')       return getGoals();
  if (params.action === 'period_goals') return getPeriodGoalsForDate_(params.date);
  if (params.action === 'period_goals_range') return getPeriodGoalsRange_(params.start, params.end);
  if (params.action === 'pace')        return getPacingFracs_();
  if (params.action === 'save_expense_mapping') { const g = writeGuard_(auth.user, 'save_expense_mapping'); if (!g.ok) return jsonOut_(g); return saveExpenseMapping_(params); }
  if (params.action === 'expenses')    return getExpenses(params);
  if (params.action === 'pnl')         return getPnl(params);
  if (params.action === 'expense_breakdown') return getExpenseBreakdown(params);
  if (params.action === 'qbmapping')   return getQBMappingSheet();
  if (params.action === 'txfields')    return getTxFields(params);
  if (params.action === 'eodtest')     return getEodTest(params);
  if (params.action === 'cogs_dutchie')  return jsonOut_(getCogsDutchie(params));
  if (params.action === 'expbudgets')    return getExpenseBudgets();
  if (params.action === 'otherrev')       return getOtherRevenue();
  if (params.action === 'set_otherrev')   { const g = writeGuard_(auth.user, 'set_otherrev'); if (!g.ok) return jsonOut_(g); return setOtherRevenue(params); }
  if (params.action === 'revenue_detail') return getRevenueDetail(params);
  if (params.action === 'set_revenue')    { const g = writeGuard_(auth.user, 'set_revenue'); if (!g.ok) return jsonOut_(g); return setRevenueLine(params); }
  if (params.action === 'budget_proposal') return getBudgetProposal(params);
  if (params.action === 'apply_budget')    { const g = writeGuard_(auth.user, 'apply_budget'); if (!g.ok) return jsonOut_(g); params._user = auth.user; return applyBudget_(params); }
  if (params.action === 'clear_budget')    { const g = writeGuard_(auth.user, 'clear_budget'); if (!g.ok) return jsonOut_(g); return clearBudget_(params); }
  if (params.action === 'set_bills_once')  { const g = writeGuard_(auth.user, 'set_bills_once'); if (!g.ok) return jsonOut_(g); return setBillsOnce_(params); }
  if (params.action === 'clear_atm_cache') { const g = writeGuard_(auth.user, 'clear_atm_cache'); if (!g.ok) return jsonOut_(g); return clearAtmCache_(params, auth.user); }
  if (params.action === 'inventory')     return getInventory(params);
  if (params.action === 'invprobe')      return probeInventoryEndpoints(params);
  if (params.action === 'invfields')     return getInvFields(params);
  if (params.action === 'itemstest')     return getItemsTest(params);
  if (params.action === 'txdetail')      return getTxDetail(params);
  if (params.action === 'reportbug')     return reportBug_(params, auth.user);
  if (params.action === 'deposits')      return getDeposits(params);
  if (params.action === 'recon_config')  return getReconConfig(params);
  if (params.action === 'set_recon_config') { const g = writeGuard_(auth.user, 'set_recon_config'); if (!g.ok) return jsonOut_(g); return setReconConfig_(params); }
  if (params.action === 'set_recon')        { const g = writeGuard_(auth.user, 'set_recon');        if (!g.ok) return jsonOut_(g); return setRecon_(params, auth.user); }
  if (params.action === 'set_recon_assign') { const g = writeGuard_(auth.user, 'set_recon_assign'); if (!g.ok) return jsonOut_(g); return setReconAssign_(params); }

  const store = params.store;
  const from  = params.from;
  const to    = params.to;

  // "Unknown store" must mean the registry does not know this name — not that it could not be
  // reached. The client retries a store once on a real {error}, so naming the cause is what turns a
  // registry hiccup into a recovered load and a visible message instead of a red square.
  if (!store) return jsonOut_({ error: 'Unknown store: ' + store });
  let gate;
  try {
    gate = storeGate_(store);
  } catch (e) {
    return jsonOut_({ error: (e && e.message) || 'GX Core store registry unreachable' });
  }
  if (!gate.ok) return jsonOut_({ error: 'Unknown store: ' + store });

  return getStoreSales_(store, from, to, params.nocache, params.phase);
}

function doPost(e) {
  const params = e.parameter || {};
  const auth = requireAuth_(params);
  if (!auth.ok) return jsonOut_({ ok: false, error: auth.error, code: 401 });

  let body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch(err) {}

  if (params.action === 'save_expense_mapping') { const g = writeGuard_(auth.user, 'save_expense_mapping:POST'); if (!g.ok) return jsonOut_(g); return saveExpenseMapping_(body); }
  return jsonOut_({ ok: false, error: 'Unknown POST action: ' + params.action });
}

// ── GX Core sales cache + live Dutchie split ──────────────────────────────────
// Settled days (yesterday and earlier) come from GXCore.getSalesDaily — fast,
// no Dutchie quota.  Today (intraday) still uses a live Dutchie transaction pull.

function getStoreSales_(store, from, to, nocache, phase) {
  try {
    /* PHASE SPLITS THE FAST HALF OFF FROM THE FRAGILE ONE.
     *
     * The settled days reach us through GXCore.getSalesDaily — a LIBRARY call, in-process, with no
     * /exec hop anywhere in it. Measured 2026-09-11 it answers from cache in 57ms. Today's figure
     * reaches us through gxDutchieGet_, which is an /exec round trip to GX Core, and that hop
     * intermittently hangs ~32s before returning a 404. Measured the same night, spaced 20s apart so
     * the load was not self-inflicted: three of six stores blew the client's 15s x 2 budget, one on a
     * 32.3s 404 whose immediate retry succeeded in 2.5s, two dead at 60s.
     *
     * Bundled, the 57ms data waits on the 32s data and the browser then throws away BOTH — so a
     * Google-side hiccup on today's number costs the reader the whole month for that store, and the
     * company total silently reads short until the next poll. That is the River Rd failure shape: a
     * per-store failure degrading into a smaller number rather than an error.
     *
     *   phase=settled  yesterday and earlier, no Dutchie call at all, cannot hit the bad hop
     *   phase=live     today only
     *   (absent)       both, exactly as before — loadprobe and pnlprobe still ask this way
     *
     * The default stays BOTH deliberately: every existing caller keeps its current contract, and the
     * split is opt-in from the client. */
    const wantSettled = phase !== 'live';
    const wantLive    = phase !== 'settled';
    const todayPT  = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
    const fromDate = from.slice(0, 10);
    const toDate   = to.slice(0, 10);

    // Settled: [fromDate .. min(toDate, yesterday)]
    const settledTo = toDate < todayPT ? toDate : dayBefore_(todayPT);
    let cacheRows = [];
    if (wantSettled && fromDate <= settledTo) {
      // Version prefix (v3): bumped 2026-08-15 to bust stale entries after GXCore backfill (8/13–8/14 rows
      // were missing; proxy had cached the incomplete result for up to 1h). CacheService has no clear-all.
      const gasCacheKey = 'sdaily_v4_' + store + '_' + fromDate + '_' + settledTo;
      const _t0 = Date.now();
      const hit = cacheGet_(gasCacheKey);
      if (hit) {
        cacheRows = JSON.parse(hit);
        probeMark_('settled_cache_hit', Date.now() - _t0, { days: cacheRows.length });
      } else {
        try {
          const _t1 = Date.now();
          cacheRows = GXCore.getSalesDaily(store, fromDate, settledTo) || [];
          probeMark_('settled_getSalesDaily', Date.now() - _t1, { days: cacheRows.length });
          // 1-hour TTL (was 4h): getSalesDaily is authoritative + cheap, so retroactive returns / re-pull
          // corrections to settled days surface within the hour instead of lingering.
          cacheSet_(gasCacheKey, JSON.stringify(cacheRows), 3600);
        } catch(gxErr) {
          // GXCore hiccup — degrade to live-only (today's data still loads below)
          Logger.log('GXCore.getSalesDaily failed for ' + store + ': ' + gxErr.message);
        }
      }
    }

    // Live: today only (if the requested range includes today)
    const _t2 = Date.now();
    const liveResult = (wantLive && toDate >= todayPT) ? dutchieTodayFetch_(store, todayPT, to, nocache) : null;
    if (liveResult) probeMark_('live_today', Date.now() - _t2, { orders: liveResult.orders });

    let net = 0, gros = 0, disc = 0, cogs = 0, tx = 0, ord = 0;
    const dailyMap = {}, weeklyMap = {};

    for (const r of cacheRows) {
      const rNet  = Number(r.net      || 0);
      const rGros = Number(r.gross    || 0);
      const rDisc = Number(r.discount || 0);
      const rTax  = Number(r.tax      || 0);
      const rCogs = Number(r.cogs     || 0);
      const rOrd  = Number(r.orders   || 0);
      net  += rNet; gros += rGros; disc += rDisc;
      cogs += rCogs; tx   += rTax;  ord  += rOrd;
      if (r.date) {
        dailyMap[r.date] = {
          netSales:   Math.round(rNet  * 100) / 100,
          grossSales: Math.round(rGros * 100) / 100,
          orders:     rOrd,
          discounts:  Math.round(rDisc * 100) / 100,
          cogs:       Math.round(rCogs * 100) / 100,
          // Per-day tax exists only because the Reconcile tab needs it: a bank deposit is
          // Net Sales + Tax for the days it covers, so a day-level total without tax cannot be
          // compared to one. It was summed into the store-month total already and dropped here.
          tax:        Math.round(rTax  * 100) / 100,
        };
        const wk = getISOWeek(new Date(r.date + 'T12:00:00')) - 1;
        weeklyMap['WK' + wk] = (weeklyMap['WK' + wk] || 0) + rNet;
      }
    }

    if (liveResult) {
      net  += liveResult.netSales;  gros += liveResult.grossSales;
      disc += liveResult.discounts; cogs += liveResult.cost;
      tx   += liveResult.tax;       ord  += liveResult.orders;
      for (const d of (liveResult.daily || [])) {
        dailyMap[d.date] = { netSales: d.netSales, grossSales: d.grossSales, orders: d.orders, discounts: d.discounts, cogs: d.cogs || 0, tax: d.tax || 0 };
        const wk = getISOWeek(new Date(d.date + 'T12:00:00')) - 1;
        weeklyMap['WK' + wk] = (weeklyMap['WK' + wk] || 0) + d.netSales;
      }
    }

    const weekly = Object.entries(weeklyMap)
      .sort((a, b) => Number(a[0].slice(2)) - Number(b[0].slice(2)))
      .map(([label, amount]) => ({ label, amount }));

    return jsonOut_({
      store, orders: ord,
      netSales:   Math.round(net  * 100) / 100,
      grossSales: Math.round(gros * 100) / 100,
      discounts:  Math.round(disc * 100) / 100,
      cost:       Math.round(cogs * 100) / 100,
      tax:        Math.round(tx   * 100) / 100,
      profit:     Math.round((net - cogs) * 100) / 100,
      aov:        ord > 0 ? Math.round(net / ord * 100) / 100 : 0,
      margin:     net > 0 ? Math.round((net - cogs) / net * 10000) / 100 : 0,
      weekly,
      topProducts: liveResult ? (liveResult.topProducts || []) : [],
      daily: Object.entries(dailyMap)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, d]) => ({ date, netSales: d.netSales, grossSales: d.grossSales, orders: d.orders, discounts: d.discounts, cogs: d.cogs || 0, tax: d.tax || 0 })),
      cacheRows:  cacheRows.length,
      liveOrders: liveResult ? liveResult.orders : 0,
      /* What this answer actually covers. The client merges a settled half and a live half into one
       * store, and a half that does not say which one it is cannot be merged safely — summing two
       * settled halves would double the month. Always present, including on the unsplit default. */
      phase: wantSettled && wantLive ? 'both' : (wantSettled ? 'settled' : 'live'),
    });
  } catch (err) {
    return jsonOut_({ error: err.message });
  }
}

/* loadProbe_ — time the REAL store fetch, not a copy of it.
 *
 * It calls getStoreSales_ itself and reads the marks that function drops, for the same reason the
 * test suite grab()s named functions out of the shipped file: a probe that re-implements the path
 * measures the probe. The marks are off unless this function turns them on.
 *
 * `store` may be omitted to walk all six in sequence — the comparison is the point, since one slow
 * store only means anything against the five that are not. A single store is the form to use when
 * chasing one; all six can approach the execution limit when nothing is cached.
 */
function loadProbe_(params) {
  const todayPT = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
  const from    = params.from || todayPT.slice(0, 8) + '01';
  const to      = params.to   || new Date().toISOString().slice(0, 19) + 'Z';
  const nocache = params.nocache === '1' || params.nocache === 'true';

  let names;
  if (params.store) {
    names = [params.store];
  } else {
    try { names = gxStoreNames_(); } catch (e) { names = []; }
  }

  const out = [];
  for (const name of names) {
    // knownStore_ is INSIDE the measurement, not before it, because it is the one step that is not
    // the same work for every store. Five names hit the registry list on the first line and cost
    // nothing; `River` — what index.html's STORES actually sends — misses it and pays a
    // GXCore.resolveStore library call on every single request. That asymmetry is invisible unless
    // it is timed per store.
    _PROBE_MARKS = [];
    const tk = Date.now();
    let known = false, gateErr = null;
    try { known = knownStore_(name); } catch (e) { gateErr = (e && e.message) || String(e); }
    probeMark_('known_store', Date.now() - tk, { exact: gxStoreNames_().indexOf(String(name)) !== -1 });
    if (!known) {
      out.push({ store: name, known: false, error: gateErr, marks: _PROBE_MARKS });
      _PROBE_MARKS = null;
      continue;
    }
    let netSales = null, liveOrders = null, cacheRows = null, err = null;
    try {
      const resp = getStoreSales_(name, from, to, nocache);
      const body = JSON.parse(resp.getContent());
      if (body.error) err = body.error;
      netSales   = body.netSales;
      liveOrders = body.liveOrders;
      cacheRows  = body.cacheRows;
    } catch (e) {
      err = e.message;
    }
    const total = Date.now() - tk;   // what the CLIENT waits for, knownStore_ included
    const marks = _PROBE_MARKS;
    _PROBE_MARKS = null;

    // The two numbers that decide whether the client can survive this store: the wall clock, and
    // how it compares to the 15s the browser allows one attempt.
    out.push({
      store: name, total_ms: total,
      over_client_timeout: total > 15000,
      net_sales: netSales, live_orders: liveOrders, settled_days: cacheRows,
      error: err, marks: marks,
    });
  }

  return {
    ok: true, from: from, to: to, today_pt: todayPT, nocache: nocache,
    client_timeout_ms: 15000, client_attempts: 2,
    stores: out,
  };
}

/* Live intraday Dutchie fetch — today only, same logic as the old full handler.
 *
 * SHARED-CACHED FOR 90 SECONDS, and that cache is the difference between one browser and ten.
 * Every other read this app makes already comes out of CacheService, which lives on the SCRIPT and
 * is therefore shared by every viewer: settled days (sdaily_v4_…), expenses, deposits, goals,
 * budgets. This one was the lone uncached call, and it is the expensive one — a live Dutchie
 * transaction pull with includeItems, one per store, six per load.
 *
 * The client polls every 60s (AUTO_REFRESH_MS) per open tab, so the cost scaled with TABS, not with
 * people: a back-office monitor + a phone + a laptop, all showing the same six stores, was 18 live
 * Dutchie pulls a minute for figures that are identical by construction. Now the first asker pays
 * and everyone else reads the answer.
 *
 * 90s, not 5 minutes: the poll interval is 60s, so a TTL below it would leave nearly every poll
 * paying full price, and a much longer one would make the "Live" pill a lie. 90 means a tab sees at
 * worst 90-second-old intraday numbers — inside the resolution the reader already has.
 *
 * KEYED ON store + todayPT ONLY, deliberately NOT on toISO. `to` is a live timestamp that changes
 * every single request; folding it into the key gives a cache that can never hit. Dropping it is
 * exactly the staleness the TTL already licenses — the window is always "Pacific midnight → now",
 * and "now" is allowed to be up to 90 seconds ago.
 *
 * `nocache` bypasses, and that escape hatch is what makes the cache safe to add: Settings →
 * "clear cache" means "this data is wrong, go and look again", which a served copy cannot honor.
 */
function dutchieTodayFetch_(store, todayPT, toISO, nocache) {
  const liveCacheKey = 'dtoday_v1_' + store + '_' + todayPT;
  if (!nocache) {
    const hit = cacheGet_(liveCacheKey);
    // Parse failures fall through to a live pull rather than throwing: a corrupt or half-written
    // cache entry must cost a fetch, never the store's whole row.
    if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  }
  const out = dutchieTodayFetchLive_(store, todayPT, toISO);
  try { cacheSet_(liveCacheKey, JSON.stringify(out), 90); } catch (e) {}
  return out;
}

function dutchieTodayFetchLive_(store, todayPT, toISO) {
  // Wide lastModified window (approx Pacific midnight); filter by transaction date below.
  // WINDOWED BY LAST MODIFIED, NOT BY DATE — an edit to an older sale has to be picked up. This is
  // why the call goes through dutchie_get rather than GX Core's named transactions route, which
  // windows by transaction date: that swap would have quietly changed which sales this app sees.
  const fromUTC = todayPT + 'T07:00:00Z';
  const rows = gxDutchieGet_(store, '/reporting/transactions', {
    fromLastModifiedDateUTC: fromUTC,
    toLastModifiedDateUTC:   toISO,
    includeItems:            'true',
  });

  const sales = rows.filter(r => {
    if (r.isVoid) return false;
    if ((r.transactionType || '').toLowerCase() !== 'retail') return false;
    const txDate = (r.transactionDateLocalTime || r.transactionDate || '').slice(0, 10);
    return txDate === todayPT;
  });

  /* ─── THE REVENUE RULES COME FROM CORE, NOT FROM A COPY HERE ───────────────────────────────────
   *
   * This block used to carry its own net / gross / discount / tax / COGS arithmetic, under a comment
   * saying "LOCKED canonical definitions — mirror GXCore … keep in sync with GXCore". Leaderboard
   * carried a third copy under the same instruction. "Keep in sync" is a hope, not a mechanism, and
   * measured on real Dutchie data 2026-09-07 this copy had already drifted:
   *
   *   RETURNS WERE COUNTED AS SALES. A refund is a separate negative Retail transaction. Core nets it
   *   out of revenue but deliberately excludes it from gross, order count and COGS, because that is
   *   what Dutchie's own Gross Sales and Total Orders report. This loop added it to all three. Over
   *   2026-08-31..09-07: 4 returns at River Rd, 7 at Commercial, and on days with one the gross here
   *   read $6–66 LOW and the order count 1–2 HIGH. Net was never wrong.
   *
   *   TAX USED TRUTHY `||` WHERE CORE USES NULLISH. `tx.tax || tx.taxAmount` reads a legitimate $0 tax
   *   as absent and falls through to the other field. It never fired in 2,573 real transactions, so
   *   it was a latent trap rather than a live error — the kind that waits for a data change.
   *
   * salesFromTxns is a PURE function over an array: no sheet, no Script Properties, no Dutchie
   * credential. That is why the old "kept inline for the intraday hot loop" objection does not apply —
   * this is ONE library call for the whole day, in-process, not one per transaction. The settled path
   * already read GXCore.getSalesDaily; now the intraday path agrees with it by construction instead of
   * by review.
   *
   * WHAT STAYS LOCAL: topProducts. That is a per-item display breakdown, not a revenue rule, and Core
   * has no opinion about it. */
  const totals = GXCore.salesFromTxns(sales);

  const dailyMap   = {};
  const productMap = {};
  const byDay      = {};

  for (const tx of sales) {
    const dateStr = (tx.transactionDateLocalTime || tx.transactionDate || '').slice(0, 10);
    if (dateStr) (byDay[dateStr] = byDay[dateStr] || []).push(tx);

    // Product mix only — deliberately unchanged, and deliberately NOT a money rule.
    const items = tx.items || tx.lineItems || tx.orderItems || [];
    for (const item of items) {
      const qty  = Number(item.quantity != null ? item.quantity : (item.qty != null ? item.qty : 1)) || 1;
      const name = item.productName || item.name || 'Unknown';
      const rev  = Number(item.totalPrice || item.price || item.lineTotal || 0);
      if (!productMap[name]) productMap[name] = { revenue: 0, units: 0 };
      productMap[name].revenue += rev;
      productMap[name].units   += qty;
    }
  }

  // One call per DAY, not per transaction — the same rules, applied to each bucket. Reconcile compares
  // deposits to Net Sales + Tax, so both come from the same place the totals do.
  Object.keys(byDay).forEach(function (d) {
    const t = GXCore.salesFromTxns(byDay[d]);
    dailyMap[d] = { netSales: t.net, grossSales: t.gross, orders: t.orders,
                    discounts: t.discount, cogs: t.cogs, tax: t.tax };
  });

  const topProducts = Object.entries(productMap)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 10)
    .map(([name, d]) => ({ name, revenue: d.revenue, units: d.units }));

  return {
    // Already rounded to cents by salesFromTxns — rounding a rounded number is how two "canonical"
    // figures end up a penny apart.
    netSales:   totals.net,
    grossSales: totals.gross,
    discounts:  totals.discount,
    cost:       totals.cogs,
    tax:        totals.tax,
    // SALE orders, not row count. `sales.length` counted refunds as orders, which is what put this
    // 1-2 above Dutchie's Total Orders on any day with a return.
    orders:     totals.orders,
    topProducts,
    daily: Object.entries(dailyMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, d]) => ({
        date,
        netSales:   Math.round(d.netSales   * 100) / 100,
        grossSales: Math.round(d.grossSales * 100) / 100,
        orders:     d.orders,
        discounts:  Math.round(d.discounts  * 100) / 100,
        cogs:       Math.round((d.cogs || 0) * 100) / 100,
        tax:        Math.round((d.tax  || 0) * 100) / 100,
      })),
  };
}

function dayBefore_(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() - 1);
  return Utilities.formatDate(d, 'America/Los_Angeles', 'yyyy-MM-dd');
}

function getISOWeek(date) {
  var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  var day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  var yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function getStoresMeta_() {
  const HIT = cacheGet_('stores_meta');
  if (HIT) return ContentService.createTextOutput(HIT).setMimeType(ContentService.MimeType.JSON);
  try {
    const rows = GXCore.getStores().map(function(s) {
      return {
        dutchie_name: s.dutchie_name,
        display_name: s.display_name,
        color:        s.color || '',
        sort_order:   Number(s.sort_order) || 0,
      };
    });
    const body = JSON.stringify({ stores: rows });
    cacheSet_('stores_meta', body, 3600); // 1-hour TTL — store list rarely changes
    return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
  } catch(e) {
    // GXCore hiccup — return empty list so frontend keeps its hardcoded fallback colors
    Logger.log('getStoresMeta_ GXCore.getStores failed: ' + e.message);
    return jsonOut_({ stores: [] });
  }
}

function getGoals() {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const cached = cacheGet_('goals');
  if (cached) { output.setContent(cached); return output; }
  // Frozen snapshot only — this app no longer opens the legacy budget workbook. See SHEET FREEZE.
  const goals = frozenGet_(FROZEN_GOALS_PROP);
  if (!goals) {
    output.setContent(JSON.stringify({ error: 'no frozen goals — run action=freeze_sheet is gone; '
      + 'restore the frozen_goals property or rely on GX Core period goals' }));
    return output;
  }
  const content = JSON.stringify({ goals: goals, year: BUDGET_YEAR, source: 'frozen' });
  cacheSet_('goals', content, 3600);
  output.setContent(content);
  return output;
}

// Returns period goals (per-DOW targets) for all stores for a given date.
/* ─── THE STRETCH IS PART OF THE GOAL, AND THIS APP WAS DROPPING IT ──────────────────────────────
 *
 * Found 2026-09-07 from a live disagreement Sky spotted: Leaderboard showed +398.96 ahead of pace
 * while Sales showed +470 over pace, at the same moment, for the same six stores.
 *
 * It was NOT the pacing fraction — both apps compute that identically now, verified against GX Core's
 * own curve to five decimal places. It was the GOAL underneath it. The period_goals ledger stores a
 * `stretch` per row (the growth target on top of the trend). Leaderboard applies it —
 * `goal = trend x (1 + stretch)`, goals.gs — and Sales did not: it returned dow_targets raw and
 * summed them raw. Today that is 1% on five stores, so Sales measured against $21,785 where the kiosk
 * measured against $21,975, and a lower bar reads as further ahead.
 *
 * $53 of the $71 gap was exactly this. The rest is Sales holding its pace fraction for up to five
 * minutes, so the two screens are showing slightly different instants.
 *
 * Sky's call the same day: SALES ADOPTS THE STRETCH. The kiosk is what staff watch all day, and
 * changing what they are chasing mid-period is worse than adjusting a management dashboard.
 *
 * PER-ROW, NEVER A CONSTANT — AND THE REASON IS MANUAL GOALS, NOT ONE ODD STORE.
 *
 * A MANUAL goal carries stretch 0. Leaderboard's resolveEffectiveGoal_ returns `stretch: 0` whenever
 * a manual override is in play, because the number Sky typed into the Settings tab IS the target;
 * multiplying it by a growth factor would quietly override the choice he made.
 *
 * On 2026-09-07 that was Portland Rd — ledger row `source=manual, stretch=0, period_total=41500`,
 * and its unrounded dow targets (2798.417…) are that 41,500 spread across the period by the
 * day-of-week shape. The other five were `source=auto, stretch=0.01`.
 *
 * So this is not a Portland fact, it is a MANUAL fact: any store given a manual goal tomorrow arrives
 * here with stretch 0 too. A hardcoded 1% would inflate every hand-set goal in the suite by 1% and
 * nothing would say so.
 *
 * ROUNDS THE SAME WAY Leaderboard does (Math.round on the stretched daily figure). Two dashboards
 * that agree to within a rounding mode still disagree on screen, and "why is it a dollar out" costs
 * exactly as much attention as "why is it fifty dollars out". */
function pgStretchDaily_(target, stretch) {
  const t = Number(target);
  if (!isFinite(t)) return 0;
  return Math.round(t * (1 + (Number(stretch) || 0)));
}
function pgStretchTargets_(dowTargets, stretch) {
  if (!Array.isArray(dowTargets)) return dowTargets;
  return dowTargets.map(function (t) { return pgStretchDaily_(t, stretch); });
}

// Uses GXCore.getPeriodGoals which resolves any date to its pay period and
// returns the frozen goal. Keyed by Sales canonical store name.
function getPeriodGoalsForDate_(date) {
  if (!date) return jsonOut_({ ok: false, error: 'date required' });
  const STORE_MAP = [
    { dutchie: 'Bend',        sales: 'Bend'        },
    { dutchie: 'Center',      sales: 'Center'      },
    { dutchie: 'Commercial',  sales: 'Commercial'  },
    { dutchie: 'Hillsboro',   sales: 'Hillsboro'   },
    { dutchie: 'Portland Rd', sales: 'Portland Rd' },
    { dutchie: 'River Rd',    sales: 'River'       },
  ];
  try {
    const goals = {};
    for (const s of STORE_MAP) {
      try {
        const pg = GXCore.getPeriodGoals(s.dutchie, date);
        if (pg && pg.dow_targets) {
          goals[s.sales] = {
            period_start: pg.period_start,
            period_end:   pg.period_end,
            // Stretched, so these are the same figures the kiosk shows. `stretch` rides along so a
            // reader can see WHY a target differs from the raw ledger rather than having to guess.
            period_total: pgStretchDaily_(pg.period_total, pg.stretch),
            dow_targets:  pgStretchTargets_(pg.dow_targets, pg.stretch),
            stretch:      pg.stretch,
          };
        }
      } catch(e2) { /* store not in ledger yet — skip */ }
    }
    return jsonOut_({ ok: true, date, goals });
  } catch(e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

// Dutchie name → Sales canonical key. Shared by getPeriodGoalsForDate_ and the range route below so
// the two cannot drift into disagreeing about what a store is called.
const PG_STORE_MAP_ = [
  { dutchie: 'Bend',        sales: 'Bend'        },
  { dutchie: 'Center',      sales: 'Center'      },
  { dutchie: 'Commercial',  sales: 'Commercial'  },
  { dutchie: 'Hillsboro',   sales: 'Hillsboro'   },
  { dutchie: 'Portland Rd', sales: 'Portland Rd' },
  { dutchie: 'River Rd',    sales: 'River'       },
];

const PG_RANGE_MAX_DAYS_ = 400; // a full year plus slack — bounds the walk below

/**
 * Sales store name keyed by GX Core canonical store_id, resolved through the registry.
 *
 * Needed because the store-less getPeriodGoals below returns rows keyed by the period_goals tab's
 * ALIASES — `century`, `baseline`, `portland` — not by anything Sales calls a store. `store_id` is
 * the canonical form Core resolves both sides to, so it is the only safe join key. Resolved live
 * rather than hardcoded as a third store table in this file: a spelling added in Command Center
 * flows through, and an unknown name drops out instead of guessing.
 */
function pgStoreIdMap_() {
  const cached = cacheGet_('pg_storeids');
  if (cached) { try { return JSON.parse(cached); } catch (e) {} }
  const map = {};
  for (const s of PG_STORE_MAP_) {
    try {
      const row = GXCore.resolveStore(s.dutchie);
      if (row && row.store_id) map[String(row.store_id).toLowerCase()] = s.sales;
    } catch (e) { /* unknown to the registry — it simply will not match, which is the safe direction */ }
  }
  if (Object.keys(map).length) cacheSet_('pg_storeids', JSON.stringify(map), 21600);
  return map;
}

/**
 * Every [start, end] the period_goals ledger actually covers, sorted, or null if unknowable.
 *
 * Intervals rather than a min/max span, because a span is wrong in a way that costs real time: the
 * tab holds a sentinel row dated 2000-01-01, so min/max reported the ledger as covering 2000-01-01
 * to 2026-08-30 and every date in between looked findable. Measured on the deployed route, a 2024
 * range still took 17.8s discovering otherwise, while 2028 — genuinely past the max — returned in
 * 1.9s. One orphan row was enough to undo the optimization for twenty-six years of dates.
 *
 * With the real intervals, membership is exact: a date in no interval needs no cache read and no
 * probe, and a date in one names the period to load without guessing at boundaries.
 *
 * Only period_start/period_end are read — never a goal value, never a tie-break. `rows` is the RAW
 * audit view, orphans included, and picking a goal out of it by hand is the match[0]-in-sheet-order
 * bug that forced the v220 re-pin. An overlapping orphan interval only means this asks Core about a
 * date it would otherwise skip; the ANSWER still comes from Core's own tie-break, so an orphan can
 * cost one lookup and never a wrong goal.
 */
function pgLedgerIntervals_() {
  const cached = cacheGet_('pg_intervals');
  if (cached) { try { const v = JSON.parse(cached); return v.length ? v : null; } catch (e) {} }
  try {
    const all  = GXCore.getPeriodGoals('', '');
    const rows = (all && all.rows) || [];
    const seen = Object.create(null);
    const out  = [];
    for (const r of rows) {
      const ps = String(r.period_start || '');
      const pe = String(r.period_end || ps);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ps) || !/^\d{4}-\d{2}-\d{2}$/.test(pe) || pe < ps) continue;
      const k = ps + '|' + pe;
      if (seen[k]) continue;
      seen[k] = 1;
      out.push({ start: ps, end: pe });
    }
    out.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
    if (out.length) {
      cacheSet_('pg_intervals', JSON.stringify(out), 1800); // 30 min: the ledger GROWS
      return out;
    }
  } catch (e) { /* unknown — fall back to probing, which is correct if slow */ }
  cacheSet_('pg_intervals', JSON.stringify([]), 300);
  return null;
}

/** The ledger interval containing `date`, or null. Linear over ~30 entries; not worth a bisect. */
function pgIntervalFor_(intervals, date) {
  if (!intervals) return null;
  for (const iv of intervals) {
    if (iv.start > date) break;      // sorted by start, so nothing later can contain it
    if (date <= iv.end) return iv;
  }
  return null;
}

/**
 * One pay period's goals for every store, as { window, goals }.
 *
 * ONE store-less call, not six per-store ones. getPeriodGoals re-reads the whole period_goals tab on
 * every call, so asking per store meant six full tab reads per period — measured on the deployed
 * route, a cold YTD (18 periods) took 42 seconds. The store-less form returns `picked`: the best row
 * PER STORE for the period, by the same tie-break the single-store branch uses, which is exactly
 * this shape with none of the repetition.
 *
 * The per-store loop is kept as a fallback, not as dead code: it is the path this route shipped on,
 * and if `picked` ever changes shape the range views should get slower rather than silently empty.
 */
function pgLoadPeriod_(date, byStoreId) {
  const out = { window: null, goals: {} };
  try {
    const all    = GXCore.getPeriodGoals('', date);
    const picked = all && all.picked;
    // An ANSWER of "no rows" is not a shape failure. `{ok:true, picked:[]}` is Core stating there is
    // no pay period covering this date, which is the normal reply for anything outside the ledger —
    // and outside it is where the walk spends every one of its MISS_LIMIT probes. Falling through to
    // the per-store loop on an empty array made a miss cost SEVEN calls instead of one, measured at
    // 39s for the 123 uncovered days after 2026-08-30. Only an exception or an unrecognizable shape
    // earns the fallback.
    if (Array.isArray(picked) && !picked.length) return out;
    if (picked && picked.length) {
      for (const r of picked) {
        const sales = byStoreId[String(r.store_id || '').toLowerCase()];
        if (!sales || !r.dow_targets || r.dow_targets.length !== 7) continue;
        // Pin to the FIRST period seen and skip any row describing a different window. Stores should
        // share a pay period, but "should" is not a guarantee, and caching one store's targets under
        // another store's date range is the kind of off-by-a-period nobody would spot in a total.
        if (!out.window) out.window = { start: r.period_start, end: r.period_end };
        if (r.period_start !== out.window.start || r.period_end !== out.window.end) continue;
        /* STRETCHED HERE, AT THE READ — the raw ledger figure never leaves this function.
           attainProbe_ and the client both consume these targets, and applying the stretch at each
           consumer instead would double it the moment a third one appears. `stretch` rides along
           for visibility only; nothing downstream should multiply by it again. */
        out.goals[sales] = { period_total: pgStretchDaily_(r.period_total, r.stretch),
                             dow_targets: pgStretchTargets_(r.dow_targets, r.stretch), stretch: r.stretch };
      }
      if (out.window && Object.keys(out.goals).length) return out;
    }
  } catch (e) { /* fall through to the per-store path */ }

  out.window = null; out.goals = {};
  for (const s of PG_STORE_MAP_) {
    try {
      const pg = GXCore.getPeriodGoals(s.dutchie, date);
      if (pg && pg.dow_targets) {
        out.goals[s.sales] = { period_total: pgStretchDaily_(pg.period_total, pg.stretch),
                               dow_targets: pgStretchTargets_(pg.dow_targets, pg.stretch), stretch: pg.stretch };
        if (!out.window) out.window = { start: pg.period_start, end: pg.period_end };
      }
    } catch (e2) { /* store not in the ledger for this period — skip, same as the day route */ }
  }
  return out;
}

/**
 * Every pay period overlapping [start, end], each with its frozen per-DOW targets.
 *
 * The client needs this because only the DAY view reads frozen period goals; week, month and YTD
 * read the budget spreadsheet, and the two disagree — measured over Jan–Jul 2026, by +7.2%
 * ($337k), and for Portland Rd by ~40% every month. Asking per date would be 365 × 6 GXCore calls
 * for a YTD view, so this returns PERIODS and lets the client expand them to dates itself, exactly
 * as getDailyGoal already does with dow_targets.
 *
 * Walk, don't guess: period boundaries come from GXCore, never from arithmetic on a 14-day cadence.
 * They have moved before — the DST rows that made March 2026 a 15-day window are what forced the
 * v220 re-pin — so a client-side stride would silently mis-bucket exactly the dates that matter.
 *
 * A frozen period never changes, so each one is cached on its own key rather than the range being
 * cached as a whole: overlapping ranges (Aug, then YTD) then share every period they have in common
 * instead of re-fetching from scratch.
 */
function getPeriodGoalsRange_(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end))) {
    return jsonOut_({ ok: false, error: 'start and end required as YYYY-MM-DD' });
  }
  if (end < start) return jsonOut_({ ok: false, error: 'end is before start' });

  const dayMs = 86400000;
  // Noon UTC, not midnight: these are date-only strings and the script timezone is Pacific, so a
  // midnight anchor lands on the previous day and every window shifts by one. Same reason the suite
  // stores dates as TEXT.
  const at    = s => new Date(s + 'T12:00:00Z').getTime();
  // The exact inverse of at(): every t handed to iso() is an at() result plus a whole number of
  // dayMs, so the value is a calendar day encoded as a noon-UTC instant, never a wall-clock one.
  // Reading it back in UTC returns the day it was built from; formatting it in LA would be the
  // conversion that actually risks a shift, since it would no longer pair with the anchor above.
  const iso   = t => new Date(t).toISOString().slice(0, 10);  // @utc-ok inverse of at()'s noon-UTC anchor

  if ((at(end) - at(start)) / dayMs + 1 > PG_RANGE_MAX_DAYS_) {
    return jsonOut_({ ok: false, error: 'range exceeds ' + PG_RANGE_MAX_DAYS_ + ' days' });
  }

  const intervals = pgLedgerIntervals_();
  const byStoreId = pgStoreIdMap_();
  const periods = [];
  let cursor    = at(start);
  const last    = at(end);
  let uncovered = 0;

  // An uncovered date costs six live GXCore calls to establish, and coverage is a contiguous run
  // that begins ~Nov 2025 and extends forward — so a long miss streak means the range starts before
  // the ledger does, not that it is pocked with holes. Without this, asking for 2025 YTD walks 365
  // days at six calls each and times the request out. After a month of nothing, stop probing and
  // report the remainder uncovered; the client shows no goal either way.
  // One pay period. A gap longer than that is not a hole in the ledger, it is the edge of it —
  // measured 2026-08-29, coverage runs contiguously from ~Nov 2025 forward with no interior gaps.
  // 14 rather than 31 halves the worst-case probe cost, which is the whole point of the guard: a
  // fully uncovered year still costs 14 x 6 live calls before it gives up.
  const MISS_LIMIT = 14;
  let misses = 0, everTruncated = false;

  while (cursor <= last) {
    const date = iso(cursor);

    // Not in any ledger interval, decided BEFORE touching the cache. Nothing can be found for such a
    // date and nothing can be cached for it, so both the probe and the lookup are pure cost —
    // cacheGet_ alone is two CacheService round-trips, which is what left a 182-day out-of-range
    // walk at 12-22s even after its probes were skipped. Not `truncated` either: that word means the
    // walk gave up guessing where the ledger ends, and this is the opposite — Core told us, so the
    // miss is exact and spends no probe budget.
    if (intervals && !pgIntervalFor_(intervals, date)) {
      uncovered++;
      cursor += dayMs;
      continue;
    }

    const cached = cacheGet_('pgp_' + date);
    let period   = cached ? JSON.parse(cached) : null;
    if (period && period.none) period = null;

    if (!period && !cached && misses < MISS_LIMIT) {
      const loaded = pgLoadPeriod_(date, byStoreId);
      const goals  = loaded.goals;
      const window = loaded.window;
      if (window) {
        period = { period_start: window.start, period_end: window.end, goals: goals };
        // Cache under EVERY date the period covers, not just the one asked for: the next range that
        // starts mid-period must hit the same entry, or the walk pays for it again.
        const pEnd = at(period.period_end);
        for (let t = at(period.period_start); t <= pEnd; t += dayMs) {
          cacheSet_('pgp_' + iso(t), JSON.stringify(period), 21600); // 6h — the period itself is frozen
        }
      } else {
        // Cache the miss too, on a shorter TTL than a hit: a date before the ledger starts will
        // still be before it in an hour, but a date the producer has yet to publish should not stay
        // negative for six hours after it lands.
        cacheSet_('pgp_' + date, JSON.stringify({ none: true }), 1800);
      }
    }

    if (!period) {
      // No pay period covers this date. GX Core's period_goals do not begin until ~Nov 2025, so this
      // is the normal answer for older dates — report it rather than letting the client mistake a
      // partial sum for a whole one.
      uncovered++;
      if (++misses >= MISS_LIMIT) everTruncated = true;
      cursor += dayMs;
      continue;
    }

    misses = 0;
    periods.push(period);
    cursor = at(period.period_end) + dayMs;
  }

  return jsonOut_({
    ok: true, start: start, end: end, periods: periods,
    uncovered_days: uncovered,
    // What this walk knew about the ledger, echoed so a slow range can be diagnosed from outside
    // rather than reasoned about. null means the lookup failed and every date was probed.
    ledger_intervals: intervals ? intervals.length : null,
    // STICKY: true if the walk ever stopped probing on the miss streak, not merely if it was still
    // in one when the range ended. Read live 2026-08-29 for all of 2025, the non-sticky version
    // reported false after a cached December period reset the counter — so it said "fully probed"
    // about a walk that had skipped ten months. `uncovered_days` is a floor whenever this is true.
    truncated: everTruncated,
  });
}

/**
 * Goal attainment: the frozen period goal against ACTUAL net sales, per store, per pay period.
 *
 * The goal half comes from getPeriodGoalsRange_ — the very route the dashboard reads — rather than a
 * second copy of the ledger walk, so this can never report a goal the app does not show. The actual
 * half is GXCore.getSalesDaily, the settled Dutchie closing-report net, read ONCE per store over the
 * whole span (six calls, not six per period).
 *
 * Two refusals are the point of this route, not shortcomings of it. Both are the same mistake in
 * opposite directions — comparing a partial to a whole — and both render as a plausible number:
 *
 *   - A period that has not SETTLED is excluded, and named in `skipped_periods`. The open period
 *     holds a few days of sales against a full fortnight of goal; counted, it reads as a
 *     catastrophic miss. Same reason the smart budget drops the month in progress.
 *   - A store-period MISSING any day of sales data is reported with its `days_missing`, but left out
 *     of every total. A partial actual understates attainment exactly the way a partial goal
 *     overstates it, which is what pgTotal already refuses to do one level up.
 *
 * `counted: false` is therefore the flag to read before believing any single row, and the totals
 * only ever sum rows where it is true.
 */
function attainProbe_(start, end) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end))) {
    return jsonOut_({ ok: false, error: 'start and end required as YYYY-MM-DD' });
  }
  if (end < start) return jsonOut_({ ok: false, error: 'end is before start' });

  const dayMs = 86400000;
  // Noon UTC and getUTCDay(), matching getPeriodGoalsRange_ and the frontend's own expansion of
  // dow_targets exactly. A midnight anchor lands on the previous day under the Pacific script
  // timezone and would pick the wrong weekday target for every date.
  const at  = s => new Date(s + 'T12:00:00Z').getTime();
  const iso = t => new Date(t).toISOString().slice(0, 10);  // @utc-ok inverse of at()'s noon-UTC anchor

  if ((at(end) - at(start)) / dayMs + 1 > PG_RANGE_MAX_DAYS_) {
    return jsonOut_({ ok: false, error: 'range exceeds ' + PG_RANGE_MAX_DAYS_ + ' days' });
  }

  let pg;
  try { pg = JSON.parse(getPeriodGoalsRange_(start, end).getContent()); }
  catch (e) { return jsonOut_({ ok: false, stage: 'period_goals_range', error: e.message }); }
  if (!pg.ok) return jsonOut_({ ok: false, stage: 'period_goals_range', error: pg.error });

  const todayPT        = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
  const settledThrough = dayBefore_(todayPT);

  const all     = pg.periods || [];
  const kept    = all.filter(p => p.period_end <= settledThrough);
  const skipped = all.filter(p => p.period_end > settledThrough).map(p => ({
    period_start: p.period_start, period_end: p.period_end,
    reason: 'not settled — ends after ' + settledThrough
  }));

  if (!kept.length) {
    return jsonOut_({
      ok: true, start: start, end: end, settled_through: settledThrough,
      periods: [], skipped_periods: skipped, summary: null, read_errors: [],
      uncovered_days: pg.uncovered_days, truncated: pg.truncated,
      note: 'no settled pay period in this range'
    });
  }

  // The kept periods can start before `start` and end after `end` — a pay period is not a calendar
  // month. Read the union, or the edge periods come back short on days and get dropped as missing.
  let spanFrom = kept[0].period_start, spanTo = kept[0].period_end;
  kept.forEach(function (p) {
    if (p.period_start < spanFrom) spanFrom = p.period_start;
    if (p.period_end   > spanTo)   spanTo   = p.period_end;
  });

  const netByStore = {}, readErrors = [];
  for (const s of PG_STORE_MAP_) {
    netByStore[s.sales] = {};
    try {
      const rows = GXCore.getSalesDaily(s.dutchie, spanFrom, spanTo) || [];
      for (const r of rows) {
        if (!r.date) continue;
        netByStore[s.sales][String(r.date).slice(0, 10)] = Number(r.net || 0);
      }
    } catch (e) {
      // Named, never silent: a store whose read failed has an EMPTY day map, so every one of its
      // periods reports days_missing and drops out of the totals on its own. Without this list that
      // is indistinguishable from a store that simply had no sales.
      readErrors.push({ store: s.sales, error: e.message });
    }
  }

  const agg = {};
  const periods = kept.map(function (p) {
    const stores = {};
    let pGoal = 0, pActual = 0;
    const pEnd = at(p.period_end);

    for (const s of PG_STORE_MAP_) {
      const g    = (p.goals || {})[s.sales];
      const days = netByStore[s.sales] || {};
      const hasGoal = !!(g && g.dow_targets && g.dow_targets.length === 7);
      let goal = 0, actual = 0, missing = 0;

      for (let t = at(p.period_start); t <= pEnd; t += dayMs) {
        // Already stretched by pgLoadPeriod_ — do NOT apply g.stretch again here.
        if (hasGoal) goal += Number(g.dow_targets[new Date(t).getUTCDay()] || 0);
        const v = days[iso(t)];
        if (v == null) missing++; else actual += v;
      }

      const counted = hasGoal && missing === 0 && goal > 0;
      stores[s.sales] = {
        goal: Math.round(goal), actual: Math.round(actual),
        pct: counted ? Math.round(actual / goal * 1000) / 10 : null,
        days_missing: missing, has_goal: hasGoal, counted: counted
      };
      if (counted) {
        pGoal += goal; pActual += actual;
        const a = agg[s.sales] || (agg[s.sales] = { goal: 0, actual: 0, periods: 0 });
        a.goal += goal; a.actual += actual; a.periods++;
      }
    }

    return {
      period_start: p.period_start, period_end: p.period_end,
      days: Math.round((pEnd - at(p.period_start)) / dayMs) + 1,
      stores: stores,
      total: { goal: Math.round(pGoal), actual: Math.round(pActual),
               pct: pGoal > 0 ? Math.round(pActual / pGoal * 1000) / 10 : null }
    };
  });

  const byStore = {};
  let tGoal = 0, tActual = 0;
  Object.keys(agg).forEach(function (k) {
    const a = agg[k];
    byStore[k] = { goal: Math.round(a.goal), actual: Math.round(a.actual),
                   pct: Math.round(a.actual / a.goal * 1000) / 10, periods: a.periods };
    tGoal += a.goal; tActual += a.actual;
  });

  return jsonOut_({
    ok: true, start: start, end: end, settled_through: settledThrough,
    periods: periods, skipped_periods: skipped, read_errors: readErrors,
    summary: {
      periods_in_range: periods.length,
      by_store: byStore,
      total: { goal: Math.round(tGoal), actual: Math.round(tActual),
               pct: tGoal > 0 ? Math.round(tActual / tGoal * 1000) / 10 : null }
    },
    uncovered_days: pg.uncovered_days, truncated: pg.truncated
  });
}

/* ─── THE CURVE IS THE SHARED TRUTH; THE FRACTION IS A CLOCK APPLIED TO IT ───────────────────────
 *
 * GX Core telemetry over the 24h to 2026-09-07: `expected_frac` was 59.7% of ALL calls reaching Core
 * and 55% of its total execution time — the largest single load on the shared brain. Batching six
 * trips into one (below, kept for the history) was right and was not enough.
 *
 * The number is derivable here. Core's expectedSalesFrac (gx_dutchie.gs:949) is ten lines of
 * arithmetic over the store's hourly SHAPE — same-day-of-week revenue weights, stable for the whole
 * day. So this app now fetches the SHAPE once a day and does the arithmetic itself, instead of asking
 * for the derived number on every refresh. One source of truth is preserved exactly: the shape is the
 * truth, and it still comes from Core.
 *
 * Leaderboard made the same move the same day; it already had a mirror and simply stopped asking.
 * Sales had neither, so the mirror and the arithmetic are added here — deliberately as a port of
 * Core's, not a reinvention, and the test asserts them equal against a verbatim copy of Core's.
 *
 * THESE MUST MATCH GX Core's GX_HOURLY_OPEN / GX_HOURLY_CLOSE. The shape is built over that window,
 * so summing it over a different one silently returns a fraction of a different day. Core is 8..22
 * (open inclusive, close exclusive) and so is Leaderboard's STORE_OPEN_HOUR / STORE_CLOSE_HOUR. */
const PACE_OPEN_HOUR  = 8;
const PACE_CLOSE_HOUR = 22;
const GC_PACE_SHAPES_KEY = 'GC_PACE_SHAPES';   // { 'store-id:YYYY-MM-DD': { hour: weight } }

/* Core's expectedSalesFrac, ported. Completed hours in full plus the fraction of the current one.
 * Returns null rather than a number when the curve cannot answer, so the caller decides what a
 * missing curve means — this app's contract is to SKIP the store, never to send a zero, because a
 * zero on a pace row reads as "sold nothing" rather than "unknown". */
function paceFracFromShape_(shape, nowHour, nowMinute) {
  if (!shape) return null;
  var ef = 0;
  for (var h = PACE_OPEN_HOUR; h < PACE_CLOSE_HOUR; h++) {
    if (h < nowHour)        ef += (Number(shape[h]) || 0);
    else if (h === nowHour) ef += (Number(shape[h]) || 0) * (nowMinute / 60);
  }
  return ef > 0 ? ef : null;
}

/* All curves for today, mirrored from Core and cached in Script Properties.
 *
 * ONE batched call, and only for stores still missing — on a warm day this costs nothing at all, so
 * the mirror is not a fixed daily tax. The failure is memoized for the execution too: gxCoreRoute_
 * retries with sleeps, and without this a Core outage would cost every render a full retry cycle,
 * which is the same lesson Leaderboard's primeHourlyDist_ records.
 *
 * Old dates are dropped on write rather than accumulating — Script Properties is a small store and a
 * year of curves for six stores would eventually fill it. */
var _PACE_SHAPES_MEMO = null;

function paceShapesToday_(storeIds) {
  const today = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
  if (_PACE_SHAPES_MEMO && _PACE_SHAPES_MEMO.date === today) return _PACE_SHAPES_MEMO.shapes;

  const props = PropertiesService.getScriptProperties();
  let cache = {};
  try { cache = JSON.parse(props.getProperty(GC_PACE_SHAPES_KEY) || '{}'); } catch (e) { cache = {}; }

  const missing = storeIds.filter(function (id) { return !cache[id + ':' + today]; });
  if (missing.length) {
    try {
      const r = gxCoreRoute_('hourly_shape', { stores: missing.join(',') });
      const shapes = (r && r.shapes) || null;
      if (shapes) {
        let wrote = false;
        missing.forEach(function (id) {
          const shape = shapes[id];
          if (shape && Object.keys(shape).length) { cache[id + ':' + today] = shape; wrote = true; }
        });
        if (wrote) {
          // Keep today only. A stale curve is worse than no curve: it would paint yesterday's
          // weighting with today's confidence, and nothing downstream could tell.
          const pruned = {};
          Object.keys(cache).forEach(function (k) { if (k.slice(-10) === today) pruned[k] = cache[k]; });
          try { props.setProperty(GC_PACE_SHAPES_KEY, JSON.stringify(pruned)); } catch (e) {}
          cache = pruned;
        }
      }
    } catch (e) {
      // Remembered as-is: the memo below stops a per-render retry storm against a Core that is down.
      Logger.log('paceShapesToday_: GX Core hourly_shape failed, pace falls back — ' + e);
    }
  }

  const out = {};
  storeIds.forEach(function (id) { out[id] = cache[id + ':' + today] || null; });
  _PACE_SHAPES_MEMO = { date: today, shapes: out };
  return out;
}

function getPacingFracs_() {
  const now    = new Date();
  const hour   = now.getHours();
  const minute = now.getMinutes();
  /* ONE GX Core call, not six.
   *
   * This looped over the stores and made a separate /exec round trip for each. GX Core's request
   * telemetry measured what that cost on 2026-09-03: expected_frac was 46% of ALL traffic reaching
   * GX Core, the single largest caller of anything, and this loop plus Leaderboard's was most of it.
   *
   * The round trips are what matter, not the work: GX Core's /exec has intermittent bad spells, and
   * every trip is an independent roll against them. Six rolls to paint one pacing row is six chances
   * to lose. Leaderboard was the app stuck on a 75-day-old cache that morning for exactly this
   * reason, while spiff, which makes one call, loaded fine.
   *
   * KEYED BY store_id NOW, not by the Dutchie name. The batched route resolves any alias and returns
   * canonical ids, which is what lets this app and Leaderboard read the same payload — Sales used to
   * ask with Dutchie names ('River Rd') and Leaderboard with store_ids, and before GX Core v293 the
   * map came back keyed by whatever the caller typed. `sales` stays the label this app renders. */
  const STORE_MAP = [
    { core: 'bend',        sales: 'Bend'        },
    { core: 'center',      sales: 'Center'      },
    { core: 'commercial',  sales: 'Commercial'  },
    { core: 'hillsboro',   sales: 'Hillsboro'   },
    { core: 'portland-rd', sales: 'Portland Rd' },
    { core: 'river-rd',    sales: 'River'       },
  ];
  /* NO ROUND TRIP FOR THE FRACTION — see paceShapesToday_ above. The curves come from Core once a
     day; the arithmetic is local and runs on every call for free. */
  const fracs = {};
  const shapes = paceShapesToday_(STORE_MAP.map(function (s) { return s.core; }));
  // Same per-store tolerance as before: a store with no curve is SKIPPED, not zeroed, so the caller
  // keeps its own fallback rather than being told the day expects nothing.
  STORE_MAP.forEach(function (s) {
    const frac = paceFracFromShape_(shapes[s.core], hour, minute);
    if (typeof frac === 'number' && isFinite(frac) && frac >= 0) fracs[s.sales] = frac;
  });
  return jsonOut_({ ok: true, fracs, hour, minute });
}



// ── QuickBooks Expenses ───────────────────────────────────────────────────────

// Section summaries: when matched, add the total and DON'T recurse into children
// Keys are the section name after stripping "Total " or "Total for "
const QB_SUMMARY_MAP_ = {
  'COST OF GOODS SOLD':             'COGS',
  'COGS - SUPPLIES & MATERIALS':    'COGS - Supplies & Materials',
  'PAYROLL EXPENSES':               'Payroll Expenses',
  'PURCHASED MATERIALS FOR RESALE': 'COGS',
  'INSURANCE EXPENSE':              'Insurance Expense',
  'PROFESSIONAL FEES':              'Professional Fees',
  'TAXES PAID':                     'Taxes',
  'SOFTWARE':                       'Software',
};

// Individual leaf rows: always captured directly by account name
// REPAIRS & MAINTENANCE is intentionally NOT in QB_SUMMARY_MAP_ so we recurse
// into its sub-items and split GENERAL (Management) from the rest
const QB_DETAIL_MAP_ = {
  'ADVERTISING & PROMOTION':   'Advertising & Promotion',
  'BANK SERVICE CHARGE':       'Bank Service Charge',
  'BUILDING':                  'Repairs & Maintenance',
  'EQUIPMENT':                 'Repairs & Maintenance',
  'GARBAGE':                   'Utilities / Garbage',
  'GENERAL':                   'Management',
  'INTEREST EXPENSE':          'Interest Expense',
  'INTERNET & PHONE':          'Internet & Phone',
  'LICENSES':                  'Licenses',
  'MEALS & ENTERTAINMENT':     'Meals & Entertainment',
  'MISCELLANEOUS EXPENSE':     'Miscellaneous',
  'OFFICE SUPPLIES':           'Office Supplies',
  'PEST CONTROL':              'Repairs & Maintenance',
  'POSTAGE':                   'Office Supplies',
  'RENT EXPENSE':              'Rent Expense',
  'SCALES':                    'Repairs & Maintenance',
  'SECURITY SYSTEMS':          'Security Monitoring',
  'SOFTWARE':                  'Software',
  'START UP EXPENSES':         'Startup Expense',
  'TELEPHONE EXPENSE':         'Internet & Phone',
  'TRAVEL':                    'Travel',
  'UNCATEGORIZED EXPENSE':     'Miscellaneous',
  'UTILITIES':                 'Utilities / Garbage',
};

// Loads custom QB→dashboard mappings and ignored accounts from ScriptProperties.
function getExpenseMapConfig_() {
  const props = PropertiesService.getScriptProperties();
  let custom = {}, ignored = [];
  try { custom  = JSON.parse(props.getProperty('expense_map')     || '{}'); } catch(e) {}
  try { ignored = JSON.parse(props.getProperty('expense_ignored') || '[]'); } catch(e) {}
  return { custom, ignored: new Set(ignored) };
}

// Saves QB→dashboard mappings submitted from the in-app mapping tool.
// mappings JSON: { QB_RAW_UPPER: dashCat | '__ignore__' | '' }
// '' = revert to hardcoded (remove custom), '__ignore__' = suppress from expenses + unmapped
function saveExpenseMapping_(params) {
  let mappings;
  const raw = params.mappings;
  try {
    mappings = (raw && typeof raw === 'object') ? raw : JSON.parse(raw || '{}');
  } catch(e) {
    return jsonOut_({ ok: false, error: 'Invalid mappings JSON' });
  }
  const props = PropertiesService.getScriptProperties();
  let custom = {}, ignored = [];
  try { custom  = JSON.parse(props.getProperty('expense_map')     || '{}'); } catch(e) {}
  try { ignored = JSON.parse(props.getProperty('expense_ignored') || '[]'); } catch(e) {}
  const ignoredSet = new Set(ignored);
  for (const [qb, cat] of Object.entries(mappings)) {
    if (cat === '__ignore__') { ignoredSet.add(qb); delete custom[qb]; }
    else if (!cat)            { delete custom[qb];  ignoredSet.delete(qb); }
    else                      { custom[qb] = cat;   ignoredSet.delete(qb); }
  }
  props.setProperty('expense_map',     JSON.stringify(custom));
  props.setProperty('expense_ignored', JSON.stringify([...ignoredSet]));
  cacheDelete_('expenses_' + new Date().getFullYear() + '_v5');
  return jsonOut_({ ok: true });
}

// accounts is an ordered array; seenRaws is a Set for dedup across the tree.
// depth drives indentation in the mapping UI and increments on each recursive level.
// Pushing the parent entry BEFORE recursing ensures it appears above its children.
function walkQBRows_(rows, cols, result, accounts, seenRaws, mapConfig, depth) {
  depth = depth || 0;
  const custom  = mapConfig?.custom  || {};
  const ignored = mapConfig?.ignored || new Set();
  for (const row of (rows || [])) {
    let summaryMatched = false;

    // Section row — push parent first, then recurse into children
    if (row.Summary) {
      const summaryLabel = (row.Summary.ColData?.[0]?.value || '').replace(/^Total\s+(for\s+)?/i, '').trim();
      const raw  = summaryLabel.toUpperCase();
      const disp = (row.Header?.ColData?.[0]?.value || summaryLabel);
      const cat  = custom[raw] || QB_SUMMARY_MAP_[raw];
      if (cat && !ignored.has(raw)) {
        summaryMatched = true;
        if (result) {
          if (!result[cat]) result[cat] = {};
          cols.forEach((col, i) => {
            const v = parseFloat((row.Summary.ColData?.[i + 1]?.value || '').replace(/,/g, '')) || 0;
            if (col) result[cat][col] = (result[cat][col] || 0) + v;
          });
        }
      }
      // Always record section in accounts so the full QB tree appears in the mapping UI
      if (accounts && raw && !seenRaws.has(raw)) {
        seenRaws.add(raw);
        accounts.push({ qb_raw: raw, display: disp, depth, mapped_to: cat || null, ignored: ignored.has(raw), hardcoded: !!QB_SUMMARY_MAP_[raw] && !custom[raw], isSection: true });
      }
    }

    // Recurse into children — depth+1, null result when parent summary already aggregated
    if (row.Rows?.Row) {
      walkQBRows_(row.Rows.Row, cols, summaryMatched ? null : result, accounts, seenRaws, mapConfig, depth + 1);
    }

    // Leaf data row (no Summary)
    if (row.ColData && !row.Summary) {
      const raw  = (row.ColData[0]?.value || '').trim().toUpperCase();
      const disp = (row.ColData[0]?.value || '').trim();
      if (!raw) continue;
      const cat       = custom[raw] || QB_DETAIL_MAP_[raw];
      const isIgnored = ignored.has(raw);
      if (cat && !isIgnored) {
        if (result) {
          if (!result[cat]) result[cat] = {};
          cols.forEach((col, i) => {
            const v = parseFloat((row.ColData[i + 1]?.value || '').replace(/,/g, '')) || 0;
            if (col) result[cat][col] = (result[cat][col] || 0) + v;
          });
        }
        if (accounts && !seenRaws.has(raw)) {
          seenRaws.add(raw);
          accounts.push({ qb_raw: raw, display: disp, depth, mapped_to: cat, ignored: false, hardcoded: !!QB_DETAIL_MAP_[raw] && !custom[raw], isSection: false });
        }
      } else if (accounts) {
        const hasVal = cols.some((_, i) => Math.abs(parseFloat((row.ColData[i + 1]?.value || '').replace(/,/g, '')) || 0) > 0.01);
        if (hasVal && !seenRaws.has(raw)) {
          seenRaws.add(raw);
          accounts.push({ qb_raw: raw, display: disp, depth, mapped_to: null, ignored: isIgnored, hardcoded: false, isSection: false });
        }
      }
    }
  }
}

// QB Profit & Loss raw report. GX Core's connector is now the ONLY path — Core is the sole owner of the
// QuickBooks token. The local-token fallback was retired 2026-08-24 after gxpin showed last_source
// gxcore@ across four days and a v153 -> v213 re-pin, i.e. the fallback had gone unused.
//
// It fails LOUD on purpose. The fallback existed to keep Expenses alive through the cutover, and the cost
// was that it could not report the cutover had not happened: a misnamed GX_DEPLOY_SECRET kept the tab
// rendering off the legacy token for an unknown stretch while this file read as if it were centralized.
// An error here is a worse afternoon than a silently wrong number is; a silently wrong number is a worse
// quarter. Keep the throw.
//
// Returns { report, source, fallback_reason } — the shape getExpenses and qb_source depend on. `source` is
// constant today and stays anyway: it is what made the regression visible, and a second connector would
// need it back.
function qbProfitAndLoss_(start, end, by) {
  by = by || 'Month';
  const r = qbReportViaGXCore_(start, end, by);
  // qbReportViaGXCore_ returns null for exactly one reason: no secret configured on this script.
  if (!r) throw new Error('GX_DEPLOY_SECRET is not set on this script — cannot reach the GX Core QuickBooks connector.');
  return { report: r, source: 'gxcore', fallback_reason: '' };
}

// Fetch the P&L through GX Core's centralized, health-instrumented QB connector (secret-gated qb_pnl route).
// Retries the intermittent Drive-HTML two-hop 404. Returns the raw QB report, or throws.
function qbReportViaGXCore_(start, end, by) {
  const GXCORE_EXEC = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';
  const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
  if (!secret) return null;   // no secret configured → caller throws; there is no local path any more
  const url = GXCORE_EXEC + '?action=qb_pnl&secret=' + encodeURIComponent(secret)
    + '&start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end)
    + '&by=' + encodeURIComponent(by || 'Month');
  let stopped = '', tries = 0;
  const started = Date.now();
  for (let i = 0; i < 5; i++) {
    // Transient Drive-HTML miss → retry, but not past the budget — see GXCORE_RETRY_BUDGET_MS.
    if (i > 0) { stopped = gxRetryHold_(started, 500); if (stopped) break; }
    tries++;
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    let data = null; try { data = JSON.parse(resp.getContentText()); } catch (e) {}
    if (data && data.ok === true && data.report) return data.report;
    if (data && data.ok === false) throw new Error(data.error || 'qb_pnl error');   // connected but errored → surface it; nothing to fall back TO
  }
  throw new Error('qb_pnl unreachable after ' + tries + ' tries' + stopped);
}


// ── Weekly deposit reconciliation ─────────────────────────────────────────────────────────────
//
// Shawn banks each store's week as one or more deposits; Sky checks that the deposit equals that
// store's Net Sales + Tax for the days it covers. Three things make this NOT a calendar-week sum:
//
//   1. The week does not start on Monday, and it differs BY STORE — some run Tue→Mon, some Wed→Tue,
//      because that is when the deposits happen. The boundary is CONFIGURED (see RECON_CFG_PROP),
//      not hardcoded, so a store whose deposit day moves is a settings change, not a deploy.
//   2. One week can have SEVERAL deposits — Commercial is routinely split 3 days + 4 days.
//   3. A deposit that spans month end gets split in two so the income lands in the right month.
//
// So the unit is a WEEK WINDOW per store, holding N deposits, and it balances when the deposits sum
// to the sales sum. Never assume one deposit per week.

const GXCORE_EXEC_ = 'https://script.google.com/macros/s/AKfycbx9mjeCBbDpxNYaqBv2hyZaO1hpbGG6PZM9AebFdwl0UwkdtRCGSWrH-8ohEtdF1K_6/exec';

// Reads real bank deposits out of QuickBooks THROUGH GX Core. Sales holds no QB token — the local
// path was deleted 2026-08-24 and must not come back — so this fails CLOSED exactly like
// qbReportViaGXCore_ does: a broken Reconcile tab is the intended failure, and it is strictly better
// than a tab that quietly shows sales with no deposits and reads as "nothing has been banked".
function qbDepositsViaGXCore_(start, end) {
  const secret = PropertiesService.getScriptProperties().getProperty('GX_DEPLOY_SECRET') || '';
  if (!secret) throw new Error('GX_DEPLOY_SECRET not set on this script — cannot reach GX Core');
  const url = GXCORE_EXEC_ + '?action=qb_deposits&secret=' + encodeURIComponent(secret)
    + '&start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end);
  let stopped = '', tries = 0;
  const started = Date.now();
  for (let i = 0; i < 5; i++) {
    // Transient Drive-HTML miss → retry, same as the P&L bridge, and budgeted the same way.
    if (i > 0) { stopped = gxRetryHold_(started, 500); if (stopped) break; }
    tries++;
    const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    let data = null; try { data = JSON.parse(resp.getContentText()); } catch (e) {}
    if (data && data.ok === true && Array.isArray(data.deposits)) return data.deposits;
    if (data && data.ok === false) throw new Error(data.error || 'qb_deposits error');
  }
  throw new Error('qb_deposits unreachable after ' + tries + ' tries' + stopped);
}

// Dates are TEXT end to end. Accepts only YYYY-MM-DD, else ''. Same rule and same reason as
// pnlDate_: parsing to a Date and reformatting is where a timezone mismatch shifts a day.
function reconDate_(v) {
  const t = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '';
}

// Adds n days to a YYYY-MM-DD string WITHOUT going through the script timezone. Date.UTC keeps the
// arithmetic in UTC and the result is sliced straight back to text, so no local offset can touch it.
function reconAddDays_(dateStr, n) {
  const p = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);  // @utc-ok Date.UTC round-trip — built in UTC two lines up
}

// Day of week for a YYYY-MM-DD, 0=Sun..6=Sat, in UTC for the same reason as above.
function reconDow_(dateStr) {
  const p = dateStr.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}

const RECON_CFG_PROP_   = 'RECON_CONFIG_V1';
const RECON_STATE_PROP_ = 'RECON_STATE_V1';

// Week-start weekday per store, 0=Sun..6=Sat. MEASURED, not assumed: read off Shawn's own deposit
// slips ("08.17.26 Deposits.xlsx", one tab per store, each stating its DEPOSIT DATE and the SALES
// DATE range that deposit covers). Bend and Hillsboro bank Tue→Mon on the Tuesday; the four Salem
// stores bank Wed→Tue on the Wednesday. Sky confirmed the pattern is the same every week.
//
// Still overridable per store from the tab — a deposit day that moves should be a dropdown, not a
// deploy — but the shipped defaults are now the real ones rather than a placeholder.
const RECON_WEEK_START_BY_STORE_ = {
  'Bend':        2,   // CENTURY   — Tue→Mon, deposited Tue
  'Hillsboro':   2,   // HILLSBORO — Tue→Mon, deposited Tue
  'Center':      3,   // CENTER    — Wed→Tue, deposited Wed
  'Commercial':  3,   // COMMERCIAL, the "South" tab — Wed→Tue, routinely split Wed-Sat + Sun-Tue
  'Portland Rd': 3,   // PORTLAND  — Wed→Tue, deposited Wed
  'River':       3,   // RIVER     — Wed→Tue, deposited Wed
};
const RECON_DEFAULT_WEEK_START_ = 3;   // a store not named above; Salem's pattern is the majority

function getReconConfig_() {
  let cfg = {};
  try { cfg = JSON.parse(PropertiesService.getScriptProperties().getProperty(RECON_CFG_PROP_) || '{}'); }
  catch (e) { cfg = {}; }
  const out = {};
  for (const name of gxStoreNames_()) {
    const v = Number(cfg[name]);
    if (Number.isInteger(v) && v >= 0 && v <= 6) { out[name] = v; continue; }
    out[name] = hasOwn_(RECON_WEEK_START_BY_STORE_, name)
      ? RECON_WEEK_START_BY_STORE_[name] : RECON_DEFAULT_WEEK_START_;
  }
  return out;
}

function getReconState_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(RECON_STATE_PROP_) || '{}'); }
  catch (e) { return {}; }
}

// GET action=recon_config — the per-store week-start map, always complete for all six stores.
function getReconConfig(params) {
  return jsonOut_({ ok: true, config: getReconConfig_(), default_week_start: RECON_DEFAULT_WEEK_START_ });
}

// Write one store's week-start weekday. Validated against the canonical store list and an integer
// 0..6 — never used as an object key lookup on unvalidated input.
function setReconConfig_(params) {
  const store = String(params.store || '');
  const dow   = Number(params.week_start);
  // knownStore_ carries forward storeKey_'s guard: an INHERITED name ('constructor', 'toString')
  // must NOT pass. Array membership is prototype-safe where a bare map lookup never was.
  const gateErr = storeGateError_(store);
  if (gateErr) return gateErr;
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) return jsonOut_({ ok: false, error: 'week_start must be an integer 0..6' });
  try {
    const cfg = getReconConfig_();
    cfg[store] = dow;
    PropertiesService.getScriptProperties().setProperty(RECON_CFG_PROP_, JSON.stringify(cfg));
    return jsonOut_({ ok: true, config: cfg });
  } catch (e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

// Mark one store-week reconciled, or un-mark it. The key is store + window-start, which is stable
// even when the store's week-start setting changes later — a week already reconciled keeps the
// window it was reconciled under, recorded ON the record rather than re-derived from current config.
function setRecon_(params, user) {
  const store = String(params.store || '');
  const start = reconDate_(params.start);
  const end   = reconDate_(params.end);
  const on    = String(params.reconciled) !== 'false';
  const gateErr = storeGateError_(store);
  if (gateErr) return gateErr;
  if (!start || !end) return jsonOut_({ ok: false, error: 'start and end must be YYYY-MM-DD' });
  if (end < start)    return jsonOut_({ ok: false, error: 'end is before start' });
  try {
    const state = getReconState_();
    const key   = store + '|' + start;
    if (on) {
      state[key] = {
        store: store, start: start, end: end,
        expected: Math.round(Number(params.expected || 0) * 100) / 100,
        deposited: Math.round(Number(params.deposited || 0) * 100) / 100,
        by: String(user || ''), at: new Date().toISOString(),
      };
    } else {
      delete state[key];
    }
    PropertiesService.getScriptProperties().setProperty(RECON_STATE_PROP_, JSON.stringify(state));
    return jsonOut_({ ok: true, state: state });
  } catch (e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

const RECON_ASSIGN_PROP_ = 'RECON_ASSIGN_V1';

function getReconAssign_() {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(RECON_ASSIGN_PROP_) || '{}'); }
  catch (e) { return {}; }
}

// Pin one deposit to a specific week window, overriding the default date rule.
//
// The default rule (see reconWindowForDeposit in index.html) says a deposit belongs to the most
// recent week that had already ENDED when it was made. That is right for an ordinary week and wrong
// for the two cases Sky called out: a deposit split across month end has its second half dated in
// the next month, and a week banked late drifts into the following window. Rather than guess harder,
// the guess is overridable and the override is what gets stored.
//
// An empty window clears the override and returns the deposit to the default rule.
function setReconAssign_(params) {
  const id     = String(params.deposit_id || '');
  const window = params.window ? reconDate_(params.window) : '';
  if (!id) return jsonOut_({ ok: false, error: 'deposit_id is required' });
  if (params.window && !window) return jsonOut_({ ok: false, error: 'window must be YYYY-MM-DD' });
  try {
    const a = getReconAssign_();
    if (window) a[id] = window; else delete a[id];
    PropertiesService.getScriptProperties().setProperty(RECON_ASSIGN_PROP_, JSON.stringify(a));
    return jsonOut_({ ok: true, assign: a });
  } catch (e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

// GET action=deposits — real QB deposits for a range, plus the reconciled-week history and the
// week-start config, so the tab can paint in one round trip.
//
// Deposits are attributed to a store by QB CLASS, using the SAME explicit map the P&L already uses.
// The class string is compared verbatim: no folding, no trailing-token stripping. A deposit whose
// class matches no store is NOT silently dropped — it comes back under `unattributed`, because in a
// lookup a miss is not a wrong bucket, it is a row that vanishes, and money that vanishes from a
// reconciliation screen is the exact failure this tab exists to prevent.
const RECON_STORE_BY_CLASS_ = {
  'CENTURY DR':    'Bend',
  'CENTER ST':     'Center',
  'COMMERCIAL ST': 'Commercial',
  'BASELINE ST':   'Hillsboro',
  'PORTLAND RD':   'Portland Rd',
  'RIVER RD':      'River',
};

// WHEN THE MONEY ACTUALLY REACHED THE BANK, read out of the deposit's own memo.
//
// QuickBooks' TxnDate is an ACCOUNTING date. Month-end deposits are back-dated so the income lands
// in the right month — Sky, 2026-09-07: "we deposited on 8/4 for the last days of the month
// (7/28-31) and back dated the deposit to 7/31 so it hits the P&L correctly, but it messes up my
// 'week' view expectations." The memo is the only record of the real date:
//
//     BEND 08.04.26 Dep (7/28/26 - 7/31/26)
//
// MEASURED over 140 live deposits, 2026-05-01..09-07, every one of which carried a memo. Four
// findings shaped this, and three of them would have cost real money:
//
//  1. THE MEMO'S YEAR IS UNRELIABLE, SO IT IS IGNORED. Six memos say `.25` in 2026 —
//     `BEND 05.12.25`, `HILLSBORO 06.09.25`, `BEND 08.18.25` and their pairs. Trusting the typed
//     year moves those six deposits back 364 days, i.e. out of the year entirely: money silently
//     gone from the week rather than merely misplaced in it. The year is taken from TxnDate instead,
//     which is never more than a few days off and cannot be fat-fingered. Nothing is lost by it —
//     the memo's year carries no information TxnDate does not already have.
//  2. THE PERIOD IN PARENTHESES IS NEVER PARSED. It is not needed to answer "when did it bank", and
//     it is the dirtiest part of the string: one memo reads `(5/6/26 - 0/0/26)` and another
//     `Order Correction (refund` with no closing bracket. Anchoring on the date + "Dep" makes both
//     harmless instead of a special case.
//  3. THE SEPARATOR IS OPTIONAL. `CENTER08.05.26 Dep (…)` — one memo in 140 has no space before the
//     date. A pattern requiring one drops that deposit, and a dropped deposit is the vanishing-row
//     failure this tab exists to prevent.
//  4. A LAG BOUND IS THE SAFETY NET, not a nicety. Observed lags are 0,+1,+2,+3,+4,+5,+7 days and
//     NEVER negative — you cannot bank money before you book it. So a parse landing outside 0..14
//     days is a typo, not a fact, and falls back to TxnDate. That bound is what makes finding 1
//     safe by construction rather than by correction.
//
// Returns '' when there is nothing trustworthy to say — the three refund memos in the sample carry
// no date at all. '' means "use TxnDate", which is exactly today's behavior, so a memo this cannot
// read costs nothing.
const RECON_BANKED_MAX_LAG_ = 14;
function reconBankedOn_(note, booked) {
  const m = /(?:^|\D)(\d{1,2})\.(\d{1,2})\.(\d{2,4})\s*Dep\b/i.exec(String(note || ''));
  const b = reconDate_(booked);
  if (!m || !b) return '';
  const mm = Number(m[1]), dd = Number(m[2]);
  const bookedYear = Number(b.slice(0, 4));
  let best = '', bestLag = -1;
  // The booking year, then the next one — a December booking banked in January is the only roll
  // that can legitimately occur inside the lag bound.
  for (let i = 0; i < 2; i++) {
    const yr = bookedYear + i;
    const d = new Date(Date.UTC(yr, mm - 1, dd));
    // Round-trip check: Date.UTC happily rolls 2/30 into March and 0/0 into the previous year, and
    // both appear in real memos. A date that does not come back as itself was never a date.
    if (d.getUTCFullYear() !== yr || d.getUTCMonth() !== mm - 1 || d.getUTCDate() !== dd) continue;
    const cand = d.toISOString().slice(0, 10);  // @utc-ok built with Date.UTC one line up
    const lag = Math.round((d.getTime() - new Date(b + 'T00:00:00Z').getTime()) / 86400000);
    if (lag < 0 || lag > RECON_BANKED_MAX_LAG_) continue;
    if (bestLag < 0 || lag < bestLag) { best = cand; bestLag = lag; }
  }
  return best;
}

function getDeposits(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const start = reconDate_(params && params.start);
    const end   = reconDate_(params && params.end);
    if (!start || !end) throw new Error('start and end are required, as YYYY-MM-DD');
    if (end < start)    throw new Error('end is before start');

    const cacheKey = 'deposits_' + start + '_' + end + '_v1';
    if (!params?.nocache) {
      const cached = cacheGet_(cacheKey);
      if (cached) { output.setContent(cached); return output; }
    }

    const raw   = qbDepositsViaGXCore_(start, end);
    const byStore = {};
    const unattributed = [];
    for (const dep of raw) {
      const date = reconDate_(dep && dep.date);
      if (!date) continue;
      const lines = Array.isArray(dep.lines) && dep.lines.length
        ? dep.lines
        : [{ class: '', amount: Number(dep.total || 0), memo: '' }];
      // COLLAPSE THE LINES BY CLASS FIRST. A real store deposit arrives as FIVE lines all carrying
      // the same class — "Sales 3% Tax", "Sales 17% Tax", "Med Sales", "Rec Sales", "Non MJ Sales" —
      // because that is how the revenue is broken out in QuickBooks. Measured on the live route over
      // 2026-08-01..08-25: 20 of 22 deposits are 5 lines, and NOT ONE spans more than one class.
      //
      // Pushing a record per LINE turned one trip to the bank into five rows under that store. The
      // week TOTAL still reconciled, because amounts sum either way — but the card listed five
      // deposits and any count was 5x out, and "Commercial banked ten times this week" reads as
      // broken faster than a wrong total would.
      //
      // Grouped by class rather than assumed one-per-deposit: a deposit CAN carry several stores.
      // That did not occur in the sample, so it is handled but not treated as the common case.
      const byClass = {};
      const order   = [];
      for (const ln of lines) {
        const cls = String(ln.class || '');
        if (!hasOwn_(byClass, cls)) { byClass[cls] = { amount: 0, memos: [] }; order.push(cls); }
        byClass[cls].amount += Number(ln.amount || 0);
        const memo = String(ln.memo || '').trim();
        if (memo) byClass[cls].memos.push(memo);
      }
      for (const cls of order) {
        const g = byClass[cls];
        // Own property only — an inherited key like 'constructor' must not resolve to a store.
        const store  = hasOwn_(RECON_STORE_BY_CLASS_, cls) ? RECON_STORE_BY_CLASS_[cls] : null;
        const rec = {
          id: String(dep.id || ''), date: date,
          amount: Math.round(g.amount * 100) / 100,
          class: cls, account: String(dep.account || ''),
          // The per-line memos are the tax/med/rec breakdown. Kept, not folded away — GX Core
          // deliberately did not collapse them upstream, and they are the obvious next thing to
          // want on this tab.
          memo: g.memos.join(' · '), lines: g.memos.length,
          // THE DEPOSIT'S OWN MEMO (QuickBooks PrivateNote), passed through UNPARSED and unused.
          //
          // It is the only place the REAL banking date exists. Month-end deposits are back-dated so
          // they land in the right month for the P&L — Sky, 2026-09-07: "we deposited on 8/4 for the
          // last days of the month (7/28-31) and back dated the deposit to 7/31 so it hits the P&L
          // correctly, but it messes up my 'week' view expectations." So `date` above is an
          // ACCOUNTING date and is deliberately, correctly wrong about when the money moved:
          //
          //     BEND 08.04.26 Dep (7/28/26 - 7/31/26)
          //
          // Added to GX Core at Sales' request (core-admin, hub e180e2a) and NOTHING READS IT YET.
          // Parsing it is deliberately not done: two example strings, both from Bend, are not a
          // format, and a date parser that guesses wrong moves real money into the wrong week
          // silently. `?action=reconprobe` reports the distinct notes per store so the format can be
          // MEASURED across all six first — same discipline as the deposit-memo vocabulary above.
          //
          // Empty STRING when a deposit has no memo, never undefined (Core's contract), so a reader
          // must not branch on absence. Empty for EVERY deposit until this app re-pins to the
          // version carrying it — which makes reconprobe the check that the re-pin took.
          note: String(dep.note || ''),
          // The real banking date read out of that memo, or '' when it cannot be read. See
          // reconBankedOn_. `date` above is untouched and stays authoritative for the P&L and every
          // month view; only the Reconcile WEEK headline reads this one.
          banked_on: reconBankedOn_(dep.note, date),
        };
        if (store) { (byStore[store] = byStore[store] || []).push(rec); }
        else       { unattributed.push(rec); }
      }
    }
    for (const k of Object.keys(byStore)) byStore[k].sort((a, b) => a.date.localeCompare(b.date));

    const content = JSON.stringify({
      ok: true, start: start, end: end,
      deposits: byStore, unattributed: unattributed,
      config: getReconConfig_(), state: getReconState_(), assign: getReconAssign_(),
    });
    cacheSet_(cacheKey, content, 900);   // 15 min — deposits land during the day
    output.setContent(content);
  } catch (err) {
    output.setContent(JSON.stringify({ ok: false, error: err.message }));
  }
  return output;
}


function getExpenses(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const cacheKey = 'expenses_' + new Date().getFullYear() + '_v6';   // v6: response now carries qb_source
  if (!params?.debug && !params?.nocache) {
    const cached = cacheGet_(cacheKey);
    if (cached) { output.setContent(cached); return output; }
  }
  try {
    const today   = new Date();
    const yr      = today.getFullYear();
    const start   = yr + '-01-01';
    const end     = yr + '-' + String(today.getMonth() + 1).padStart(2, '0')
                        + '-' + String(today.getDate()).padStart(2, '0');

    // GX Core's connector is the single token owner and the only path; a failure here throws rather than
    // quietly serving numbers from somewhere else.
    const qb     = qbProfitAndLoss_(start, end);
    const report = qb.report;
    const raw    = JSON.stringify(report);
    // Park the answer where an unauthenticated caller can read it. Every QB path here is behind the
    // login gate, so without this the only way to learn which connector served the tab is to open
    // devtools while logged in — and a fact that inconvenient to check is a fact nobody checks.
    // Cache-miss only, so this writes at most twice an hour.
    try {
      PropertiesService.getScriptProperties()
        .setProperty('QB_LAST_SOURCE', qb.source + '@' + new Date().toISOString());
    } catch (e) { /* diagnostics must never break the tab */ }
    if (report.Fault) throw new Error(JSON.stringify(report.Fault));

    // Column titles e.g. ["Jan 2026", "Feb 2026", ...]
    const cols = (report.Columns?.Column || []).map(c => c.ColTitle || '').filter(Boolean);

    const mapConfig   = getExpenseMapConfig_();
    const allAccounts = []; // ordered, tree-structured
    const seenRaws    = new Set();
    const expenses    = {};
    walkQBRows_(report.Rows?.Row || [], cols, expenses, allAccounts, seenRaws, mapConfig, 0);

    // debug=true returns raw report for mapping verification
    if (params && params.debug === 'true') {
      output.setContent(raw);
      return output;
    }

    const unmappedCount = allAccounts.filter(a => !a.mapped_to && !a.ignored).length;

    const content = JSON.stringify({ expenses, columns: cols, allAccounts, unmappedCount,
                                     qb_source: qb.source, qb_fallback_reason: qb.fallback_reason });
    cacheSet_(cacheKey, content, 1800); // 30 min
    output.setContent(content);
  } catch (err) {
    output.setContent(JSON.stringify({ error: err.message }));
  }
  return output;
}

// ── Expense breakdown — what is BEHIND a category ──────────────────────────────────────────────
//
// The Expenses tab renders a category's total. This answers the two questions a reader asks next:
// which QuickBooks accounts make it up, and which stores spent it. Both come from ONE QuickBooks
// report — the P&L summarized by Classes over the selected window — so a breakdown can never
// disagree with the total it sits under.
//
// It reuses walkQBRows_'s EXACT map semantics rather than a second attribution rule: a matched
// section summary IS the category's total, and its children are not re-added. Two attribution rules
// would be two sets of numbers, and the one on the expanded panel is the one nobody reconciles.
// The children are still LISTED — "which accounts" is the whole question — they are simply listed
// under the summary's category without being summed into it. Whatever that leaves unexplained comes
// back as `residual` instead of being quietly absorbed into the last row.
//
// CORPORATE is a class here like any other. It is not a store and no store pill selects it, but in
// August 2026 it carried $297,833 of COGS and all $73,200 of Management — a per-store panel that
// dropped it would hide most of the money on the screen. This app does not let money vanish off a
// screen; see the reconciliation tab's unattributed list for the same rule.
//
// Verified against the by=Month figures the tab already shows: 17 categories, $566,667 for
// 2026-08-01..08-30, zero delta. expbreakprobe re-runs that comparison in the live runtime.
function qbBreakdownWalk_(rows, cols, out, mapConfig, depth, listUnder) {
  depth = depth || 0;
  const custom  = (mapConfig && mapConfig.custom)  || {};
  const ignored = (mapConfig && mapConfig.ignored) || new Set();

  const vals = (colData) => cols.map((_, i) =>
    parseFloat(((colData && colData[i + 1] && colData[i + 1].value) || '').replace(/,/g, '')) || 0);

  const bucketFor = (cat) => {
    if (!out[cat]) out[cat] = { byClass: {}, accounts: [] };
    return out[cat];
  };
  const addTo = (b, v) => cols.forEach((c, i) => { b.byClass[c] = (b.byClass[c] || 0) + v[i]; });
  // QB can repeat a display name across sections; merge rather than push a duplicate row.
  const pushAcct = (cat, disp, v) => {
    const b  = bucketFor(cat);
    const ex = b.accounts.find(a => a.display === disp);
    if (ex) { cols.forEach((c, i) => { ex.byClass[c] = (ex.byClass[c] || 0) + v[i]; }); return; }
    const byClass = {};
    cols.forEach((c, i) => { byClass[c] = v[i]; });
    b.accounts.push({ display: disp, byClass });
  };

  for (const row of (rows || [])) {
    let matchedCat = null;

    if (row.Summary) {
      const lbl = ((row.Summary.ColData && row.Summary.ColData[0] && row.Summary.ColData[0].value) || '')
                    .replace(/^Total\s+(for\s+)?/i, '').trim();
      const raw = lbl.toUpperCase();
      const cat = custom[raw] || QB_SUMMARY_MAP_[raw];
      if (cat && !ignored.has(raw)) {
        matchedCat = cat;
        // Only when an outer section is not already carrying this money. walkQBRows_ expresses the
        // same rule as `if (result)`; without it a mapped section INSIDE a mapped section is counted
        // twice. It does not fire on the current mapping — nothing nests today — but the mapping UI
        // lets Sky map any section, so it is one custom override away from doubling a category.
        if (!listUnder) addTo(bucketFor(cat), vals(row.Summary.ColData));
      }
    }

    if (row.Rows && row.Rows.Row) {
      // listUnder FIRST: the outermost matched section owns the money, so a nested match must not
      // steal the listing away from it.
      qbBreakdownWalk_(row.Rows.Row, cols, out, mapConfig, depth + 1, listUnder || matchedCat);
    }

    if (row.ColData && !row.Summary) {
      const raw  = ((row.ColData[0] && row.ColData[0].value) || '').trim().toUpperCase();
      const disp = ((row.ColData[0] && row.ColData[0].value) || '').trim();
      if (!raw) continue;
      const v = vals(row.ColData);
      // Inside a section whose summary already carried the whole total: list, never re-sum.
      if (listUnder) { pushAcct(listUnder, disp, v); continue; }
      const cat = custom[raw] || QB_DETAIL_MAP_[raw];
      if (cat && !ignored.has(raw)) { addTo(bucketFor(cat), v); pushAcct(cat, disp, v); }
    }
  }
}

/** action=expense_breakdown&start=YYYY-MM-DD&end=YYYY-MM-DD — per-category accounts and class split. */
function getExpenseBreakdown(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const start = pnlDate_(params && params.start);
    const end   = pnlDate_(params && params.end);
    if (!start || !end) throw new Error('start and end are required, as YYYY-MM-DD');

    const cacheKey = 'expbreak_' + start + '_' + end + '_v1';
    if (!(params && params.nocache)) {
      const cached = cacheGet_(cacheKey);
      if (cached) { output.setContent(cached); return output; }
    }

    const qb     = qbProfitAndLoss_(start, end, 'Classes');
    const report = qb.report;
    if (report.Fault) throw new Error(JSON.stringify(report.Fault));

    // Column 0 is the account-name column and carries no title; the last money column is TOTAL.
    const cols     = ((report.Columns && report.Columns.Column) || []).map(c => c.ColTitle || '').slice(1);
    const totalKey = cols.find(c => String(c).toUpperCase() === 'TOTAL') || null;
    const classes  = cols.filter(c => c && c !== totalKey);

    const out = {};
    qbBreakdownWalk_((report.Rows && report.Rows.Row) || [], cols, out, getExpenseMapConfig_(), 0, null);

    const sumClasses = (byClass) => classes.reduce((s, c) => s + (byClass[c] || 0), 0);
    const categories = {};
    Object.keys(out).forEach(cat => {
      const b   = out[cat];
      const tot = totalKey ? (b.byClass[totalKey] || 0) : sumClasses(b.byClass);
      const accounts = b.accounts
        .map(a => ({
          display: a.display,
          amount:  totalKey ? (a.byClass[totalKey] || 0) : sumClasses(a.byClass),
          byClass: classes.reduce((o, c) => {
            if (Math.abs(a.byClass[c] || 0) > 0.005) o[c] = a.byClass[c];
            return o;
          }, {})
        }))
        .filter(a => Math.abs(a.amount) > 0.005)
        .sort((x, y) => Math.abs(y.amount) - Math.abs(x.amount));
      const listed = accounts.reduce((s, a) => s + a.amount, 0);
      categories[cat] = {
        total:   tot,
        byClass: classes.reduce((o, c) => { o[c] = b.byClass[c] || 0; return o; }, {}),
        accounts,
        // Nonzero means the listed accounts do not explain the section total. Reported, never hidden.
        residual: Math.abs(tot - listed) < 0.005 ? 0 : tot - listed
      };
    });

    const content = JSON.stringify({ ok: true, start, end, classes, categories, qb_source: qb.source });
    cacheSet_(cacheKey, content, 1800); // 30 min, same as the expenses payload it sits beside
    output.setContent(content);
  } catch (err) {
    output.setContent(JSON.stringify({ ok: false, error: err.message }));
  }
  return output;
}

// ── Profit & Loss — the QB report rendered as QB renders it ────────────────────────────────────
// Deliberately NOT built on getExpenses. That path exists to force QB's chart of accounts through
// this app's OWN category map (QB_SUMMARY_MAP_ / QB_DETAIL_MAP_ + the user's custom overrides) and
// to DROP whatever it cannot map — which is the right behavior for a budget tab and the wrong
// behavior for a financial statement. A P&L that silently omits an unmapped account is not a P&L.
// So this walks the QB tree structurally instead: every row survives, in QB's own order, with QB's
// own subtotals, which is also what makes the output line up with the PDF Sky reads in QuickBooks.
//
// `by` is validated against an ARRAY with indexOf, not an object looked up by key — this app spent a
// session removing that idiom, because `MAP[value]` answers for 'constructor' and '__proto__' too.
const PNL_SUMMARIZE_BY_ = ['Classes', 'Month', 'Total'];

function getPnl(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const by = String((params && params.by) || 'Classes');
    if (PNL_SUMMARIZE_BY_.indexOf(by) === -1) {
      output.setContent(JSON.stringify({ error: 'bad by (want one of: ' + PNL_SUMMARIZE_BY_.join(', ') + ')' }));
      return output;
    }

    const today = new Date();
    const yr    = today.getFullYear();
    const start = pnlDate_(params && params.start) || (yr + '-01-01');
    const end   = pnlDate_(params && params.end)   || (yr + '-' + String(today.getMonth() + 1).padStart(2, '0')
                                                          + '-' + String(today.getDate()).padStart(2, '0'));

    const cacheKey = 'pnl_' + by + '_' + start + '_' + end + '_v1';
    if (!params?.nocache) {
      const cached = cacheGet_(cacheKey);
      if (cached) { output.setContent(cached); return output; }
    }

    const qb     = qbProfitAndLoss_(start, end, by);
    const report = qb.report;
    if (report.Fault) throw new Error(JSON.stringify(report.Fault));

    // Column 0 is the account-name column and carries no title; the rest are the money columns.
    const allCols = (report.Columns?.Column || []).map(c => c.ColTitle || '');
    const columns = allCols.slice(1);

    const rows = [];
    flattenPnlRows_(report.Rows?.Row || [], columns.length, rows, 0);

    const content = JSON.stringify({
      columns, rows,
      start, end,
      basis:    report.Header?.ReportBasis || '',
      currency: report.Header?.Currency || 'USD',
      by,
      qb_source: qb.source, qb_fallback_reason: qb.fallback_reason
    });
    cacheSet_(cacheKey, content, 1800); // 30 min, same as Expenses
    output.setContent(content);
  } catch (err) {
    output.setContent(JSON.stringify({ error: err.message }));
  }
  return output;
}

// Accepts only YYYY-MM-DD and returns it unchanged, else ''. Dates go into a URL that reaches QB, and
// this app's convention is that dates are TEXT end to end — never parsed into a Date and re-formatted,
// which is where a sheet/script timezone mismatch shifts them a day.
function pnlDate_(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

// Walk QB's nested report into a FLAT, ordered list — the render order is decided here, once, on the
// server, so the client never has to re-derive the shape of a financial statement.
//
// Each row is { label, depth, kind, group, values[] }:
//   kind 'header'  — a section's opening line ("Income", "TAXES PAID"); no numbers of its own
//   kind 'detail'  — an account line
//   kind 'total'   — a section's own subtotal ("Total Income")
//   kind 'grand'   — QB's computed lines (Gross Profit, Net Operating Income, Net Income)
// `group` carries QB's semantic tag (Income / COGS / GrossProfit / Expenses / NetIncome / …) so the
// client can rule off the statement lines without string-matching English labels.
function flattenPnlRows_(rows, colCount, out, depth) {
  const vals = (colData) => {
    const v = [];
    for (let i = 0; i < colCount; i++) {
      const raw = (colData?.[i + 1]?.value || '').replace(/,/g, '');
      const n   = parseFloat(raw);
      v.push(isNaN(n) ? null : n);   // null ≠ 0: QB prints blank for "no activity", and the PDF does too
    }
    return v;
  };

  for (const row of (rows || [])) {
    const group = row.group || '';

    // A section: optional header line, its children, then its own total line.
    if (row.Rows?.Row || row.Header || row.Summary) {
      const headLabel = (row.Header?.ColData?.[0]?.value || '').trim();
      if (headLabel) {
        out.push({ label: headLabel, depth, kind: 'header', group, values: vals(row.Header.ColData) });
      }

      if (row.Rows?.Row) {
        flattenPnlRows_(row.Rows.Row, colCount, out, headLabel ? depth + 1 : depth);
      }

      const sumLabel = (row.Summary?.ColData?.[0]?.value || '').trim();
      if (sumLabel) {
        // QB's standalone computed lines (Gross Profit, Net Income) arrive as a Summary with no
        // header and no children — they are the statement's rules, not a section's subtotal.
        const isGrand = !headLabel && !row.Rows?.Row;
        out.push({
          label: sumLabel,
          depth: isGrand ? 0 : depth,
          kind:  isGrand ? 'grand' : 'total',
          group, values: vals(row.Summary.ColData)
        });
      }
      continue;
    }

    // A leaf account line.
    if (row.ColData) {
      const label = (row.ColData[0]?.value || '').trim();
      if (!label) continue;
      out.push({ label, depth, kind: 'detail', group, values: vals(row.ColData) });
    }
  }
}

// Probes common Dutchie EOD/daily-summary endpoint patterns to find inventory cost
function getEodTest(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const store  = params.store || 'River';
    const date   = params.date || '2026-04-20'; // use yesterday by default
    const today2 = new Date();
    const from   = new Date(today2.getFullYear(), today2.getMonth(), 1).toISOString().replace('.000','');
    const to     = today2.toISOString().replace('.000','');

    // Probe endpoints that might expose product-level sold qty or cost
    const paths = [
      // Dedicated sales / product-performance endpoints
      ['/reporting/sales', '?fromDate=' + date + '&toDate=' + date],
      ['/reporting/sales', '?startDate=' + date + '&endDate=' + date],
      ['/reporting/product-performance', '?fromDate=' + date + '&toDate=' + date],
      ['/reporting/product-performance', ''],
      ['/reporting/daily-summary', '?date=' + date],
      ['/reporting/daily-summary', ''],
      ['/reporting/sales-summary', '?date=' + date],
      // Inventory adjustments — could show outbound movements
      ['/reporting/inventory-adjustments', '?fromLastModifiedDateUTC=' + encodeURIComponent(from)],
      ['/reporting/adjustments', '?fromDate=' + date],
    ];
    const results = {};
    for (const [path, qs] of paths) {
      results[path + (qs ? ' ' + qs.slice(0,30) : '')] = gxProbe_(store, path, qs);
    }
    output.setContent(JSON.stringify(results));
  } catch(e) {
    output.setContent(JSON.stringify({ error: e.message }));
  }
  return output;
}

// Returns top-level fields + first item fields from one transaction — for debugging cost field names
function getTxFields(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  try {
    const store  = params.store || 'River';
    const today  = new Date();
    const from   = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().replace('.000','');
    const to     = today.toISOString().replace('.000','');
    const rows = gxDutchieGet_(store, '/reporting/transactions', {
      fromLastModifiedDateUTC: from,
      toLastModifiedDateUTC:   to,
      includeItems:            'true',
      includeItemDetails:      'true',
    });
    const tx   = rows.find(r => !r.isVoid && (r.transactionType||'').toLowerCase() === 'retail') || rows[0];
    if (!tx) { output.setContent(JSON.stringify({ error: 'no transactions found' })); return output; }
    const items = tx.items || tx.lineItems || tx.orderItems || [];
    output.setContent(JSON.stringify({
      txKeys:   Object.keys(tx),
      txSample: Object.fromEntries(Object.entries(tx).filter(([k,v]) => typeof v !== 'object')),
      itemKeys: items[0] ? Object.keys(items[0]) : [],
      itemSample: items[0] ? Object.fromEntries(Object.entries(items[0]).filter(([k,v]) => typeof v !== 'object')) : {},
    }));
  } catch(e) {
    output.setContent(JSON.stringify({ error: e.message }));
  }
  return output;
}

// Returns Col A → Col B from the P&L mapping sheet so we can verify/build the map
function getQBMappingSheet() {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const pairs = frozenGet_(FROZEN_QBMAP_PROP);
  output.setContent(JSON.stringify(pairs ? { pairs: pairs, source: 'frozen' }
                                         : { error: 'no frozen QuickBooks mapping stored' }));
  return output;
}

function testProxy() {
  const e = { parameter: {
    store: 'River',
    from:  '2026-04-01T07:00:00Z',
    to:    '2026-04-21T07:00:00Z',
  }};
  const result = doGet(e);
  Logger.log(result.getContent());
}

// Returns first 10 rows of a sheet by GID to inspect structure

/* ─── HOW LONG THE SIX-STORE COGS SWEEP IS ALLOWED TO GO ON ──────────────────────────────────────
 *
 * GXCORE_RETRY_BUDGET_MS bounds ONE call. It cannot bound this loop, and it was never meant to:
 * six bounded calls in sequence still outrun the 360s script cap, because six times a legal number
 * is not a legal number. This is the other half of the same guard, and it is deliberately a
 * SEPARATE constant with its own derivation — a loop deadline and a per-call retry budget are
 * different questions and reusing one number for both is how the next loop inherits a number that
 * was never measured for it.
 *
 * THE LOOP IS CHECKED BEFORE EACH STORE, NEVER MID-STORE. Nothing here can shorten a round trip
 * already in flight, so the honest worst case is the deadline PLUS one whole store:
 *
 *   deadline 150s
 * + the worst a single store can cost: gxCoreRoute_ is allowed to start a second attempt at 59.9s
 *   (just inside GXCORE_RETRY_BUDGET_MS) and that attempt can run the 130s top of the bounce band
 *   measured 2026-09-11/12 = ~190s
 * = 340s, inside the 360s cap with ~20s left for the settled half already gathered and the
 *   response build. The response is a few hundred small rows; 20s is generous for it.
 *
 * WHY 150s AND NOT SOMETHING SMALLER:
 *   - A slow-but-WORKING day must still return all six stores. A single healthy round trip to GX
 *     Core measured 3.4s on average and 21.6s at worst over 49 live samples on 2026-09-12. Six of
 *     the worst of those back to back is ~130s. A deadline at or under that starts dropping stores
 *     on a day when nothing is actually broken — which is the same mistake as clipping the retry,
 *     just one level up, and it is the mistake that produces a permanently-partial money figure.
 *   - NOT 60s. That is GXCORE_RETRY_BUDGET_MS, and copying it here would look tidy and drop two or
 *     three stores every merely-slow afternoon.
 *   - NOT 45s. That is the number Price Cards picked for a three-attempt loop of its own. It is not
 *     a suite constant and must not be synced as one.
 *   - NOT 300s. That leaves no room for the store in flight when the deadline passes, so the script
 *     dies at the cap and the caller gets a dead request — precisely the failure this prevents.
 *
 * WHAT HAPPENS WHEN IT FIRES is the point: the stores already gathered are RETURNED, the ones not
 * asked are NAMED, and the answer is NOT cached. See the cache decision at the bottom of the loop. */
const COGS_LOOP_DEADLINE_MS = 150000;

// Returns daily COGS from GXCore (Dutchie-sourced, settled days only).
// Response: { data: [{ date, store, cogs }], partial, stores_answered, stores_missing, missing_reason }
function getCogsDutchie(params) {
  // dutchie_name → Sales internal store name (only River differs)
  const STORES = [
    { dutchie: 'Bend',        sales: 'Bend'        },
    { dutchie: 'Center',      sales: 'Center'      },
    { dutchie: 'Commercial',  sales: 'Commercial'  },
    { dutchie: 'Hillsboro',   sales: 'Hillsboro'   },
    { dutchie: 'Portland Rd', sales: 'Portland Rd' },
    { dutchie: 'River Rd',    sales: 'River'       },
  ];
  const todayPT      = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
  const from         = (params.from || '').slice(0, 10);
  const rawTo        = (params.to   || '').slice(0, 10);
  const includesToday = !rawTo || rawTo >= todayPT;
  const settledTo    = includesToday ? dayBefore_(todayPT) : rawTo;

  // This route was the only uncached one on the Income tab, and it is the most expensive: six
  // getSalesDaily reads PLUS six live dutchieClosingReport calls, one per store, in sequence. The
  // Gross Profit card is what waits on it, which is why that card is the last thing to fill in on a
  // phone. Everything about the settled half is immutable — yesterday's COGS does not change — and
  // even today's only moves as sales happen.
  /* `_v2`, not `_v1`: entries written by the version before this one carry no `partial` field, and
     `undefined` reads as "complete" to the guard below. Bumping the key orphans them rather than
     trusting a payload that predates the claim. Old keys are simply never read again. */
  const cacheKey = 'cogsd_' + from + '_' + (rawTo || 'now') + '_v2';
  if (!params.nocache) {
    const hit = cacheGet_(cacheKey);
    if (hit) {
      try {
        const prev = JSON.parse(hit);
        /* A PARTIAL MUST NOT SATISFY A CACHE READ EITHER. Nothing below writes one, so this can
           only fire against an entry some other version or some other hand put there — and the
           whole point of the rule is that a partial money figure must never be served under a
           freshness claim. Belt and braces on purpose: the write guard and the read guard fail in
           different directions, and this is the one the reader sees. */
        if (prev && !prev.partial) return prev;
      } catch (e) {}
    }
  }

  const results      = [];
  const answered     = [];
  const missing      = [];
  const missingWhy   = {};
  const loopStarted  = Date.now();
  for (const { dutchie, sales } of STORES) {
    /* THE DEADLINE IS THE LOOP'S, NOT THE CALL'S — see COGS_LOOP_DEADLINE_MS. Checked here, before
       committing to another store, because that is the only moment this side controls. Everything
       already gathered is kept and returned; the stores below are named, not silently dropped. */
    if (Date.now() - loopStarted >= COGS_LOOP_DEADLINE_MS) {
      missing.push(sales);
      missingWhy[sales] = 'not asked — the sweep hit its ' + Math.round(COGS_LOOP_DEADLINE_MS / 1000)
                        + 's deadline after ' + Math.round((Date.now() - loopStarted) / 1000) + 's';
      continue;
    }
    let storeOk = true;
    try {
      // Settled days via sales_daily cache (sourced from Dutchie Closing Report, nightly)
      const rows = GXCore.getSalesDaily(dutchie, from, settledTo) || [];
      for (const r of rows) {
        if (!r.date) continue;
        results.push({ date: String(r.date).slice(0, 10), store: sales, cogs: Number(r.cogs || 0) });
      }
      // Today: call Closing Report directly — returns live intra-day COGS (a valid partial, not an error)
      if (includesToday) {
        try {
          // Through the route: this reads Dutchie, so it needs GX Core's own context.
          const crr = gxCoreRoute_('dutchie_closing_report', { store: dutchie, date: todayPT });
          const cr = crr && (crr.data || (crr.rows && crr.rows[0]));
          results.push({ date: todayPT, store: sales, cogs: Math.round(Number(cr && cr.cost || 0) * 100) / 100 });
        } catch(e) {
          /* A MISSING DAY OF COGS IS NOT A SMALLER ANSWER, IT IS A WRONG ONE — and it is wrong in
             the flattering direction: less cost subtracted means Gross Profit reads HIGH. So a
             store whose settled month arrived but whose today did not still counts as missing.
             Same judgment the frontend already makes for sales with "today pending". */
          storeOk = false;
          missingWhy[sales] = "today's closing report: " + e.message;
          Logger.log('getCogsDutchie: today CR failed for ' + dutchie + ': ' + e.message);
        }
      }
    } catch(e) {
      storeOk = false;
      missingWhy[sales] = 'settled days: ' + e.message;
      Logger.log('getCogsDutchie: getSalesDaily failed for ' + dutchie + ': ' + e.message);
    }
    (storeOk ? answered : missing).push(sales);
  }

  /* The caller must be able to tell a complete answer from a partial one WITHOUT inferring it from
     the shape of the data — "six stores' worth of rows" is not a thing a reader can count, and a
     store that sold nothing today is indistinguishable from a store that never answered. */
  const partial = missing.length > 0;
  const out = { data: results, partial: partial, stores_answered: answered,
                stores_missing: missing, missing_reason: missingWhy };

  /* A PARTIAL ANSWER IS RETURNED BUT NEVER PERSISTED, and those are two separate decisions.
     Returning it is right — the caller asked, some stores answered, and `stores_missing` says which
     did not, so nothing here is passed off as whole. PERSISTING it is not, because this cache
     OUTLIVES the blip that caused it: 10 minutes while today is live, SIX HOURS once the window is
     settled. Freezing a Gross Profit that is short one store's COGS — and therefore reads HIGH —
     under a freshness claim is how a two-minute Google routing hiccup becomes a wrong number on a
     screen that gates a bank-deposit reconciliation for the rest of the day.
     Not caching is also what makes it self-heal: the very next load re-asks every store, including
     the ones that were never reached, rather than being handed back its own bad afternoon. */
  if (!partial) {
    // 10 minutes while today is in range, 6 hours once the whole window is settled. A range that ends
    // in the past cannot change at all, so the only reason not to cache it forever is the sheet being
    // corrected behind us.
    try { cacheSet_(cacheKey, JSON.stringify(out), includesToday ? 600 : 21600); } catch (e) {}
  }
  return out;
}

// Returns monthly expense budgets from the Annual Budget sheet
// Response: { budgets: { "COGS": { Jan: 311749, Feb: 282160, ... }, ... } }
function getExpenseBudgets() {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const cached = cacheGet_('expbudgets');
  if (cached) { output.setContent(cached); return output; }
  // Frozen snapshot as the base, the applied smart budget overlaid per category on top. The legacy
  // workbook is no longer read at all — the overlay IS the budget for any category Sky has applied,
  // and the frozen figure covers the rest.
  const budgets = frozenGet_(FROZEN_EXPBUD_PROP) || {};
  const overlaid = [];
  const ov = sbGetOverlay_();
  if (ov && ov.year === BUDGET_YEAR && ov.categories) {
    Object.keys(ov.categories).forEach(function (cat) {
      budgets[cat] = ov.categories[cat];
      overlaid.push(cat);
    });
  }
  const content = JSON.stringify({ budgets: budgets, overlaid: overlaid, source: 'frozen+overlay',
                                   // The Expenses tab needs these to decide whether to PACE a
                                   // category; shipping them here keeps that decision one fetch.
                                   bills_once: sbBillsOnce_(),
                                   overlay_applied_at: ov ? ov.applied_at : null,
                                   overlay_applied_by: ov ? ov.applied_by : null });
  cacheSet_('expbudgets', content, 3600);
  output.setContent(content);
  return output;
}

// Test transactions with fromDate/toDate params instead of lastModifiedDate
function getTxDetail(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const store  = params.store || 'River';

  // Dutchie's fromDate/toDate are CALENDAR days, so yesterday has to be yesterday in Pacific —
  // toISOString() is UTC whatever the project timezone is, and from 17:00 PDT it returns tomorrow,
  // which made this probe read the wrong day for seven hours out of every one. Same idiom as
  // getCogsDutchie/getStoreSales_.
  const todayPT = Utilities.formatDate(new Date(), 'America/Los_Angeles', 'yyyy-MM-dd');
  const yd      = dayBefore_(todayPT);
  // Try fromDate/toDate instead of lastModified
  // fromDate/toDate here, NOT the lastModified window — this route exists to compare the two.
  const rows  = gxDutchieGet_(store, '/reporting/transactions',
    { fromDate: yd, toDate: yd, includeItems: 'true' });
  const retail = rows.filter(r => !r.isVoid && (r.transactionType||'').toLowerCase() === 'retail');
  const first  = retail.find(r => (r.items||r.lineItems||r.orderItems||[]).length > 0) || retail[0];
  const fi     = first ? (first.items || first.lineItems || first.orderItems || []) : [];
  output.setContent(JSON.stringify({
    status: code,
    total: rows.length,
    withItems: retail.filter(r => (r.items||r.lineItems||r.orderItems||[]).length > 0).length,
    firstItemLen: fi.length,
    firstItem: fi[0] || null,
  }));
  return output;
}

// Probes candidate inventory endpoints to find which one the Dutchie API supports.
function probeInventoryEndpoints(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const store  = params.store || 'River';
  const paths  = [
    '/inventory/product',
    '/inventory',
    '/product',
    '/products',
    '/inventory/active',
    '/api/inventory/product',
    '/v1/inventory/product',
    '/reporting/product-performance',
    '/reporting/inventory',
    '/inventory/transfer',
  ];
  const results = {};
  for (const path of paths) {
    try {
      results[path] = gxProbe_(store, path, '');
    } catch(e) {
      results[path] = { status: 'error', preview: e.message };
    }
  }
  output.setContent(JSON.stringify(results, null, 2));
  return output;
}

// Tests item-level access — fetches one transaction and tries its detail endpoint
function getItemsTest(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const store  = params.store || 'River';
  const today  = new Date();
  const from   = new Date(today - 2 * 86400000).toISOString().replace('.000', '');
  const to     = today.toISOString().replace('.000', '');

  // Fetch with includeLineItems param variant
  const rows1 = gxDutchieGet_(store, '/reporting/transactions', {
    fromLastModifiedDateUTC: from,
    toLastModifiedDateUTC:   to,
    includeLineItems:        'true',
  });
  const retail1 = rows1.filter(r => !r.isVoid && (r.transactionType||'').toLowerCase() === 'retail');
  const withItems1 = retail1.filter(r => (r.items||r.lineItems||r.orderItems||[]).length > 0);

  output.setContent(JSON.stringify({
    includeLineItems_variant: { retail: retail1.length, withItems: withItems1.length },
    firstTxId: retail1[0]?.transactionId || null,
  }));
  return output;
}

// Returns keys + first 3 items from /reporting/inventory for field discovery
function getInvFields(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const store  = params.store || 'River';
  const items = gxDutchieGet_(store, '/reporting/inventory', {});
  const sample = items.slice(0, 3);
  output.setContent(JSON.stringify({
    totalItems: items.length,
    keys: sample[0] ? Object.keys(sample[0]) : [],
    samples: sample,
  }));
  return output;
}

// Returns current inventory with stock levels and value per store.
// Response: { store, products: [{ name, category, vendor, qty, value, sku }] }
// qty=0 means OOS (recently active package with no remaining stock)
function getInventory(params) {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);

  const store = params.store;
  const invGateErr = storeGateError_(store);
  if (invGateErr) return invGateErr;

  const cacheKey = 'inv_' + store;
  const cached = cacheGet_(cacheKey);
  if (cached) { output.setContent(cached); return output; }

  try {
    // gxDutchieGet_ throws on a non-200 or a refusal, and the catch below turns that into the same
    // shaped error payload this route always returned.
    const invItems = gxDutchieGet_(store, '/reporting/inventory', {});

    // Aggregate all packages by productName (including qty=0 for OOS detection).
    // Keep OOS entries modified within 1 year so recently-sold-out products count.
    // Only drop truly ancient zero-qty entries (ghost products never re-ordered).
    const cutoff = new Date(Date.now() - 365 * 86400000).toISOString();
    const productMap = {};
    for (const item of invItems) {
      const lastMod = item.lastModifiedDateUtc || '';
      const qty     = Number(item.quantityAvailable || 0);
      if (qty <= 0 && lastMod < cutoff) continue;
      const name = item.productName || 'Unknown';
      if (!productMap[name]) {
        productMap[name] = {
          name,
          category: item.masterCategory || item.category || 'Other',
          vendor:   item.brandName || item.vendor || '',
          qty:      0,
          value:    0,
          sku:      item.sku || '',
          lastMod:  lastMod,
        };
      }
      productMap[name].qty   += qty;
      productMap[name].value += qty * Number(item.unitCost || 0);
      if (lastMod > productMap[name].lastMod) productMap[name].lastMod = lastMod;
    }

    const result = Object.values(productMap).map(p => ({
      name:     p.name,
      category: p.category,
      vendor:   p.vendor,
      qty:      Math.round(p.qty   * 10)  / 10,
      value:    Math.round(p.value * 100) / 100,
      sku:      p.sku,
    }));

    const content = JSON.stringify({ store, products: result });
    cacheSet_(cacheKey, content, 300); // 5 min
    output.setContent(content);
  } catch (err) {
    output.setContent(JSON.stringify({ error: err.message, store }));
  }
  return output;
}


const OTHERREV_PROP    = 'otherrev_data';
const MONTHS_12_       = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Header cell text → MONTHS_12_ 3-letter abbreviation (handles full and abbreviated names)
const MONTH_ABBR_ = {
  jan:'Jan', january:'Jan', feb:'Feb', february:'Feb', mar:'Mar', march:'Mar',
  apr:'Apr', april:'Apr', may:'May', jun:'Jun', june:'Jun', jul:'Jul', july:'Jul',
  aug:'Aug', august:'Aug', sep:'Sep', sept:'Sep', september:'Sep',
  oct:'Oct', october:'Oct', nov:'Nov', november:'Nov', dec:'Dec', december:'Dec',
};

function getOtherRevData_() {
  const props = PropertiesService.getScriptProperties();
  const raw   = props.getProperty(OTHERREV_PROP);
  if (raw) return JSON.parse(raw);
  // The one-time GX2-workbook bootstrap that used to live here is gone with the rest of the sheet
  // reads. It was already spent: otherrev_data has been populated since long before the cut, and
  // it was verified present (freezestatus.otherrev_stored) before the sheet was disconnected.
  // An empty record is the honest answer now — the Revenue tab writes real numbers back.
  const blank = function () { const o = {}; MONTHS_12_.forEach(function (m) { o[m] = 0; }); return o; };
  const data = { atm: blank(), sublet: blank() };
  props.setProperty(OTHERREV_PROP, JSON.stringify(data));
  return data;
}

function getOtherRevenue() {
  const output = ContentService.createTextOutput();
  output.setMimeType(ContentService.MimeType.JSON);
  const cached = cacheGet_('otherrev');
  if (cached) { output.setContent(cached); return output; }
  try {
    const data    = getOtherRevData_();
    const content = JSON.stringify(data);
    cacheSet_('otherrev', content, 3600);
    output.setContent(content);
  } catch(e) {
    output.setContent(JSON.stringify({ error: e.message }));
  }
  return output;
}

function setOtherRevenue(params) {
  const type  = params.type;
  const month = params.month;
  const value = Number(params.value);
  if (!['atm','sublet'].includes(type))       return jsonOut_({ ok: false, error: 'invalid type' });
  if (!MONTHS_12_.includes(month))            return jsonOut_({ ok: false, error: 'invalid month' });
  if (isNaN(value) || value < 0)             return jsonOut_({ ok: false, error: 'invalid value' });
  try {
    const data     = getOtherRevData_();
    data[type][month] = Math.round(value * 100) / 100;
    PropertiesService.getScriptProperties().setProperty(OTHERREV_PROP, JSON.stringify(data));
    cacheDelete_('otherrev');
    return jsonOut_({ ok: true, data });
  } catch(e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

// ── Revenue detail: ATM + Sublet per machine/category, per store ──────────────

// Canonical store names (must match STORE_KEYS and the frontend STORES array)
const DEFAULT_ATM_MACHINES = {
  'Bend':        ['ATM 1', 'ATM 2'],
  'Center':      ['ATM 1'],
  'Commercial':  ['ATM 1', 'ATM 2'],
  'Hillsboro':   ['ATM 1', 'ATM 2'],
  'Portland Rd': ['ATM 1'],
  'River':       ['ATM 1', 'ATM 2']
};

// Maps GX2 ATM sheet row labels → {store, machine} using canonical store names
const ATM_MACHINE_MAP = {
  'bend':                  { store: 'Bend',        machine: 'ATM 1' },
  'bend 2':                { store: 'Bend',        machine: 'ATM 2' },
  'bend atm':              { store: 'Bend',        machine: 'ATM 1' },
  'bend atm 2':            { store: 'Bend',        machine: 'ATM 2' },
  'center st':             { store: 'Center',      machine: 'ATM 1' },
  'center':                { store: 'Center',      machine: 'ATM 1' },
  'commercial':            { store: 'Commercial',  machine: 'ATM 1' },
  'commercial large-2':    { store: 'Commercial',  machine: 'ATM 2' },
  'commercial large 2':    { store: 'Commercial',  machine: 'ATM 2' },
  'commercial 2':          { store: 'Commercial',  machine: 'ATM 2' },
  'hillsboro':             { store: 'Hillsboro',   machine: 'ATM 1' },
  'hillsboro 2':           { store: 'Hillsboro',   machine: 'ATM 2' },
  'baseline':              { store: 'Hillsboro',   machine: 'ATM 1' },
  'commercial lg':         { store: 'Commercial',  machine: 'ATM 2' },
  'hilsborro':             { store: 'Hillsboro',   machine: 'ATM 1' },
  'portland lg':           { store: 'Portland Rd', machine: 'ATM 1' },
  'portland':              { store: 'Portland Rd', machine: 'ATM 1' },
  'portland rd':           { store: 'Portland Rd', machine: 'ATM 1' },
  'river lg':              { store: 'River',       machine: 'ATM 1' },
  'river sm':              { store: 'River',       machine: 'ATM 2' },
  'river rd sm':           { store: 'River',       machine: 'ATM 2' },
  'river':                 { store: 'River',       machine: 'ATM 1' },
};

function getRevConfig_() {
  const props = PropertiesService.getScriptProperties();
  const raw   = props.getProperty('rev_config');
  const cfg   = raw ? JSON.parse(raw) : {};
  let dirty = false;
  if (!cfg.machines)    { cfg.machines    = DEFAULT_ATM_MACHINES; dirty = true; }
  if (!cfg.sublet_cats) { cfg.sublet_cats = {}; dirty = true; }
  if (!cfg.atm_rate)    { cfg.atm_rate    = 1.75; dirty = true; }
  // Migrate legacy 'Portland' key → 'Portland Rd' (canonical store name)
  if (cfg.machines['Portland'] && !cfg.machines['Portland Rd']) {
    cfg.machines['Portland Rd'] = cfg.machines['Portland'];
    delete cfg.machines['Portland'];
    dirty = true;
  }
  if (dirty) props.setProperty('rev_config', JSON.stringify(cfg));
  return cfg;
}

function getRevYearData_(type, year) {
  const raw = PropertiesService.getScriptProperties().getProperty('rev_' + type + '_' + year);
  return raw ? JSON.parse(raw) : {};
}

// One-time bootstrap: reads per-machine rows from the ATM sheet and stores txn counts.
// Revenue = txns × rate is computed at display time (rate lives in rev_config.atm_rate).
// Sum-row detection uses INDENTATION: sheet machine rows have leading whitespace;
// store total rows (uppercase, no indent) are skipped when a store has any indented siblings.

function getRevenueDetail(params) {
  const year = params.year || String(new Date().getFullYear());
  try {
    const cfg    = getRevConfig_();
    let   atm    = getRevYearData_('atm', year);
    const sub    = getRevYearData_('sub', year);

    // The first-access bootstrap from the GX2 workbook is gone with the rest of the sheet reads.
    // It was already spent: rev_atm_2025, rev_atm_2026 and rev_config were all verified present
    // (freezestatus.rev_props) before the sheet was disconnected, so nothing was still relying on
    // it. A year with no stored data now returns empty rather than silently reaching for a
    // spreadsheet this app can no longer open.

    return jsonOut_({ ok: true, year, cfg, atm, sub });
  } catch(e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

// Sky-only: delete stored ATM bootstrap so next revenue_detail re-reads from sheet.
function clearAtmCache_(params, user) {
  const u = (user || '').toLowerCase();
  const isSky = u === 'sky@greencrosscanna.com' || u === 'sky' || u.startsWith('sky@');
  if (!isSky) return jsonOut_({ ok: false, error: 'Forbidden' });
  const year = params.year || String(new Date().getFullYear());
  PropertiesService.getScriptProperties().deleteProperty('rev_atm_' + year);
  cacheDelete_('otherrev');
  return jsonOut_({ ok: true, cleared: 'rev_atm_' + year });
}

function setRevenueLine(params) {
  const { year, month, type, store, item } = params;
  const value = Math.round(Number(params.value) * 100) / 100;
  if (!['atm','sub'].includes(type)) return jsonOut_({ ok: false, error: 'invalid type' });
  if (!MONTHS_12_.includes(month))   return jsonOut_({ ok: false, error: 'invalid month' });
  if (isNaN(value) || value < 0)    return jsonOut_({ ok: false, error: 'invalid value' });
  if (!year || !store || !item)      return jsonOut_({ ok: false, error: 'missing params' });
  try {
    const data = getRevYearData_(type, year);
    if (!data[month])        data[month]       = {};
    if (!data[month][store]) data[month][store] = {};
    data[month][store][item] = value;
    PropertiesService.getScriptProperties().setProperty('rev_' + type + '_' + year, JSON.stringify(data));
    cacheDelete_('otherrev');
    return jsonOut_({ ok: true });
  } catch(e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

function reportBug_(params, reporter) {
  try {
    const priority = params.priority || 'medium';
    const desc     = params.desc     || '';
    if (!desc) return jsonOut_({ ok: false, error: 'desc required' });
    // GX Core requires a title; the Sales form collects only a description, so derive one from its first
    // line. Without this, the pinned GXCore library rejected the report ("title required") and the old code
    // ignored that result — returning ok:true, so the report was silently lost while the user saw success.
    const title = (params.title && String(params.title).trim()) || desc.split('\n')[0].slice(0, 80).trim();

    /* FORWARD `context`, AND READ `tab` OUT OF IT.
     *
     * gx-bugreport.js sends ONE state field — `context`, a JSON snapshot carrying the browser, screen
     * size, online flag, a Pacific timestamp, RECENT JS ERRORS, and this app's own {tab: section}. It
     * sends no top-level `tab`, `appTab` or `appStore` at all; the payload is exactly
     * {action, title, desc, priority, reporter, appVer, context}. So the three fields this call used to
     * read were reading a payload that has not contained them since the inline form was deleted (the
     * migration recorded at index.html:917), and `context` — the only one actually being sent — was
     * never forwarded at all.
     *
     * MEASURED 2026-09-09 over all 19 bugs Sales has ever filed: `tab` was populated on the four filed
     * 2026-08-14..17 and on NONE of the fourteen since 2026-08-25, and `context` on zero of nineteen.
     * The break is the form migration, not a Core pin — this repo re-pinned to v213 specifically so
     * gxIngestBug would self-install the bug_reports.context header, and that header has been storing
     * an empty string ever since because nothing was ever handed to it. The v213 note verified
     * reporter/tab/app_version, three fields that were fine, and context was not among them.
     *
     * WHAT IT COST, concretely. Three of those fourteen read "App stalls on connecting", "the page
     * still hangs on loading" and "loading" — the v2.559 `defer` bug, filed three times across
     * v2.557..v2.559 before anyone diagnosed it. The cause was a single ReferenceError thrown during
     * boot: one console error, no UI, an app that looked merely slow. `recentErrors` is in the
     * snapshot. All three reports would have arrived carrying the exact error.
     *
     * THE PARSE CANNOT SINK THE REPORT. tab is a nicety; the report is the point. A malformed context
     * costs the tab column and nothing else, and the raw string still goes up either way — Core stores
     * whatever it is given, and an unparseable snapshot is still evidence. Same rule the render guards
     * follow: a decoration must never take the payload with it.
     *
     * appTab / appStore stay as fallbacks. They are dead against today's shared form, but they cost a
     * `||` and they are what a future top-level field would arrive as. */
    const ctx = String(params.context || '');
    /* ONE parse, reused. `tab` is what the ingest call needs; the unannounced-bug notice below wants
       the route and the captured JS errors out of the same snapshot. Parsing it twice would be two
       places for the guard to go missing, and the guard is the whole point: a malformed context costs
       the tab column and a few lines of an email, never the report. */
    let ctxObj = {};
    try { ctxObj = JSON.parse(ctx) || {}; } catch (e) { ctxObj = {}; }
    const ctxTab = String(ctxObj.tab || '');

    const r = GXCore.gxIngestBug('sales', reporter, {
      title, priority, desc,
      appVer:   params.appVer   || '',
      appStore: params.appStore || '',
      tab:      ctxTab || params.appTab || '',
      appTab:   params.appTab   || '',
      context:  ctx
    });
    if (!r || !r.ok) return jsonOut_({ ok: false, error: (r && r.error) || 'bug report was not saved' });

    /* THE ROW IS DOWN AND NOBODY WAS TOLD — the one failure nothing anywhere observes.
     *
     * Since GX Core v310 Core's send is the only send: this app has no MailApp call of its own on the
     * success path and does not want one, because two sends is the three-emails bug wearing a fix.
     * But Core SWALLOWS its own mail failure on purpose — a filed report has succeeded, and mail must
     * never be what stops it — so a bug can reach the board, the email can die, and the app stays
     * silent. Correctly silent, by design, and nothing records it: the absence of an email is not an
     * event anyone observes. v312 added `mailed` / `mail_error` / `mail_skipped` so a spoke can tell
     * the three apart, and reading them is why this app is pinned to v315.
     *
     * READ THE POSITIVE FIELDS, NEVER THE ABSENCE OF `mailed`. gxIngestBug returns at its dedupe check
     * ABOVE the send, so a repeat filed within three minutes carries NO mail field at all — and this
     * app's submit retries transport flakes up to three times. Treating "no `mailed`" as a failure
     * would turn one redirect chain into three of these emails, which is the bug this notice exists
     * to prevent, re-created through the fix for it. Fields are ABSENT, not empty, when they do not
     * apply; truthiness is the correct read, the same way `deduped` is read.
     *
     * THERE IS NO SECOND NOTICE FOR A REFUSED REPORT, deliberately. Leaderboard needs one because it
     * answers ok:true regardless; this app returns the refusal to the browser and the shared form
     * shows it, so the person who filed it already knows it did not save and can re-file. An email
     * about a failure the reporter is looking at is noise. The case handled here is the opposite one:
     * the reporter is correctly told it WORKED, and the notification is what went missing.
     *
     * `mail_skipped` is the one that reads as fine and is not — nobody configured to receive it plus a
     * reporter with no address on file means nothing failed and nobody was mailed. Still silent.
     *
     * WHETHER THIS SEND CAN SUCCEED WHERE CORE'S FAILED is not guaranteed, and the honest answer is
     * what it is for. A library call runs under the CALLING project, so gxIngestBug's send already
     * spent THIS script's mail quota — an exhausted quota refuses this one too. What it does cover is
     * everything else: a bad or missing recipient (all of `mail_skipped`), a transient failure, a
     * Core-side config problem. */
    const mailWhy = r.mail_error || r.mail_skipped;
    if (mailWhy && bugMailOnce_(reporter, title, desc)) {
      bugNotify_({
        subject: '🔕 UNANNOUNCED Sales bug [' + priority + ']: ' + title,
        lead: [
          'THIS REPORT IS ON THE BUG BOARD — do NOT re-file it — but GX Core could not email',
          'anyone about it, so this notice is standing in. The reporter got no receipt either.',
          '',
          'Bug id  : ' + String(r.id || '(none returned)'),
          'Mail ' + (r.mail_error ? 'failed  : ' : 'skipped : ') + mailWhy,
        ],
        reporter: reporter,
        priority: priority,
        store:    params.appStore || '',
        version:  params.appVer   || '',
        tab:      ctxTab,
        url:      String(ctxObj.url || ''),
        errors:   Array.isArray(ctxObj.errors) ? ctxObj.errors : [],
        desc:     desc,
      });
    }

    return jsonOut_({ ok: true });
  } catch(e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

/* The body of the unannounced-bug notice. Kept out of reportBug_ so the handler reads as what it is
   — file the report, then check whether anyone was told — and so the send is wrapped in one place.
   NON-FATAL BY CONSTRUCTION: the report is already on the board by the time this runs, so a throw in
   here must never become the reporter's error. Mail is the enhancement; the row is the thing. */
function bugNotify_(o) {
  try {
    const lines = o.lead.concat([
      '',
      'Reporter : ' + (o.reporter || '(not signed in)'),
      'Priority : ' + (o.priority || 'medium'),
      'Store    : ' + (o.store   || ''),
      'Screen   : ' + (o.tab     || ''),
      'Version  : ' + (o.version || ''),
      'Route    : ' + (o.url     || ''),
      'Time     : ' + Utilities.formatDate(new Date(), 'America/Los_Angeles', 'M/d/yy h:mm a'),
    ]);
    /* The captured JS errors, which are the reason `context` is forwarded at all — the `defer` bug was
       filed three times before anyone diagnosed it, and its cause was a single boot ReferenceError
       sitting in exactly this field. An email that omits them is the email that cost those three
       reports. Absent when the page threw nothing, rather than a header standing over an empty list. */
    if (o.errors.length) {
      lines.push('', 'JS errors captured before submit (' + o.errors.length + '):');
      o.errors.forEach(function (e) { lines.push('  - ' + String(e).slice(0, 200)); });
    }
    lines.push('', o.desc || '(no details provided)');
    MailApp.sendEmail({ to: 'sky@greencrosscanna.com', subject: o.subject, body: lines.join('\n') });
  } catch (mailErr) { /* non-fatal, on purpose — see above */ }
}

/* True the FIRST time a given report asks for the unannounced notice, false for a repeat inside three
 * minutes. The window matches GX Core's own bug dedupe so the email and the board agree on what "the
 * same report" means; a fourth minute is a person filing again because nothing happened, which should
 * mail.
 *
 * THIS APP NEEDS THE MARK MORE THAN MOST. Its submit runs through `gasFetchJson(url, 3)`, because a
 * bug reporter that dies on a transport flake is the one thing in the app you cannot report a bug
 * about. Core's dedupe means those retries produce ONE row and carry no mail field, so they cannot
 * reach this notice — but Core's ingest lock fails open by design, so two executions landing at once
 * can each get a row and each see a dead send. Without the mark that is two copies of the email that
 * exists precisely because nobody was told once.
 *
 * ONE NAMESPACE, because there is one notice: the refusal path returns its error to the browser and
 * the shared form shows it. If a second notice is ever added it MUST get its own key — Leaderboard
 * carries two whose instructions contradict each other ("re-file this" / "do not re-file this"), and
 * a shared mark there would let the first suppress the second and leave the wrong one standing.
 *
 * FAILS OPEN on purpose: a cache or a lock that is unavailable must never be the reason a bug goes
 * unread. Better a duplicate email than a silent one. Every failure inside falls through to sending. */
function bugMailOnce_(reporter, title, desc) {
  let lock = null;
  try {
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
      String(reporter || '') + '\u0000' + String(title || '') + '\u0000' + String(desc || ''),
      Utilities.Charset.UTF_8);
    const key = 'bugmail:unannounced:' + Utilities.base64EncodeWebSafe(digest);
    lock = LockService.getScriptLock();
    try { lock.waitLock(5000); } catch (e) { lock = null; }   // busy -> fall through and send
    const cache = CacheService.getScriptCache();
    if (cache.get(key)) return false;
    cache.put(key, '1', 180);   // seconds; 3 min, the same window as gxIngestBug's dedupe
    return true;
  } catch (e) {
    return true;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e) {} }
  }
}


// ══════════════════════════════════════════════════════════════════════════════════════════════
//  SMART BUDGET — proposes a 12-month expense budget from actual QuickBooks history
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// Replaces the two things Sky named as the problem: "dividing an expense by 12" (which asserts a
// flat month and is wrong for anything seasonal) and "guessing $500 for a line item" (which asserts
// a number nothing supports). The engine answers the first with a measured seasonal index and the
// second by REFUSING — a category with no history gets no proposal and says so, rather than a round
// number that reads as analyzed. An unsupported budget is worse than a visibly missing one: the
// missing one gets filled in by a human who knows, the invented one gets trusted.
//
// WHERE IT APPLIES, and why not the sheet. BUDGET_SHEET_ID is the legacy "2026 GX2 Dashboard".
// Its Drive permissions are `anyone → reader` with the file owned by a different account, so this
// script CANNOT write it — a setValues() there throws — and the suite conventions say never to
// touch that sheet anyway. So an applied budget is stored here, in ScriptProperties, exactly like
// otherrev_data and expense_map, and getExpenseBudgets() overlays it per-category on top of the
// sheet's own numbers. The sheet stays the untouched baseline, which is what makes revert total:
// clearing the overlay restores it with nothing to undo.
//
// Everything below is deterministic and MEDIAN-based, never mean. One anomalous month — a legal
// bill, an annual insurance premium paid in a lump — moves a mean enough to set the next twelve
// months wrong. The median ignores it, and `outliers` reports what was set aside so the exclusion
// is visible rather than silent.

const SMART_BUDGET_PROP = 'smart_budget';

// Categories whose spend tracks SALES VOLUME rather than the calendar. Budgeting these from their
// own history would hold them flat against a sales plan that isn't — if the plan is to grow 10%,
// a COGS budget built from last year's COGS is wrong by construction. These are modeled as a
// median ratio to revenue and re-projected onto projected revenue instead. Sky's call, 2026-08-30.
const SB_VOLUME_LINKED = ['COGS', 'COGS - Supplies & Materials', 'Payroll Expenses'];

// Minimum COMPLETE months of history each method needs. Below SB_MIN_ANY there is no proposal at all.
// 18, not 12. At twelve months there is exactly ONE observation per calendar month, and a single
// observation cannot distinguish "December is always high" from "December was high once" — both
// readings fit the data equally. Claiming a seasonal shape there is claiming to know something the
// history does not contain, so below 18 the months are held flat and the row says so.
const SB_MIN_SEASONAL = 18;
const SB_MIN_TREND    = 6;
const SB_MIN_RATIO    = 3;
const SB_MIN_ANY      = 1;

// Trend damping. A 6-vs-6-month growth ratio extrapolated twelve months forward compounds whatever
// noise is in it, so half of it is taken and the result is clamped. A budget that doubles off one
// good half-year is not a budget anyone can hold a manager to.
const SB_TREND_DAMP = 0.5;
const SB_TREND_MIN  = 0.80;
const SB_TREND_MAX  = 1.25;

// Outlier detection. SB_LIMIT_FLOOR keeps the band from collapsing on a near-constant series (see
// sbOutlierLimit_); SB_LOCAL_W is how many months either side form the local level a point is
// checked against. Both were chosen by running the real 24-month QuickBooks series through the
// candidates, not by taste — W=3 with a 15% floor flags exactly the three true Rent anomalies
// (a partial month, a double payment, a skipped month) and nothing else.
const SB_LIMIT_FLOOR = 0.15;
const SB_LOCAL_W     = 3;

// A category is SPARSE when at least this share of its months had no spend at all. Sparse
// categories get a run-rate budget instead of a typical-month one — see sbSparseProposal_.
const SB_SPARSE_ZERO_SHARE = 0.5;
// Inside a sparse category, a single month bigger than this share of the WHOLE window's spend is a
// one-off event, not a rate. Miscellaneous is 94% one $26,915 month; Meals' biggest is 24%.
const SB_SPARSE_EVENT_SHARE = 0.5;

/** Median of a numeric array. Empty → 0. */
function sbMedian_(arr) {
  const a = (arr || []).filter(function (v) { return typeof v === 'number' && isFinite(v); })
                       .slice().sort(function (x, y) { return x - y; });
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Median absolute deviation — the robust spread that pairs with a median. */
function sbMad_(arr, med) {
  const m = (med == null) ? sbMedian_(arr) : med;
  return sbMedian_((arr || []).map(function (v) { return Math.abs(v - m); }));
}

/**
 * The robust distance beyond which a value is an outlier: 3×MAD from the median.
 *
 * The MAD-ZERO FALLBACK is the whole reason this is its own function. MAD is zero whenever MORE
 * THAN HALF the values are identical — which is not the rare case, it is every fixed cost: rent,
 * insurance, a flat software subscription. Those are exactly the categories where a single 8×
 * month is most obviously an anomaly, and a bare `if (!mad) keep everything` switched the check
 * OFF precisely there. Caught by tests/smart_budget_test.js on a rent series of 23×50k and one
 * 400k month, where nothing was flagged at all.
 *
 * So when MAD is zero, fall back to the MEAN absolute deviation from the median. On that series it
 * gives 14,583 and a limit of 43,750, which catches the 400k and keeps every 50k. When both are
 * zero the series is genuinely flat and nothing is an outlier — which is the case the old guard
 * was actually written for.
 */
function sbOutlierLimit_(vals) {
  const med = sbMedian_(vals);
  const devs = (vals || []).map(function (v) { return Math.abs(v - med); });
  let scale = sbMedian_(devs);
  if (!scale && devs.length) {
    scale = devs.reduce(function (a, b) { return a + b; }, 0) / devs.length;
  }
  // RELATIVE FLOOR. 3×MAD alone collapses on a series whose recent months are near-identical: the
  // real Rent Expense window gave a limit of $1,755 across values spanning $0 to $73,762, so a
  // perfectly ordinary $2,400 month read as an outlier. Measured against the live series, anything
  // from 10–25% behaves the same; 15% sits in the middle of that plateau.
  const floor = Math.abs(med) * SB_LIMIT_FLOOR;
  const base  = scale ? 3 * scale : 0;
  const lim   = Math.max(base, floor);
  return { med: med, lim: lim || Infinity };
}

/** Split into the values to use and the ones to set aside. Never returns an empty `kept`. */
function sbSplitOutliers_(vals) {
  const o = sbOutlierLimit_(vals);
  const kept = [], outliers = [];
  (vals || []).forEach(function (v) { (Math.abs(v - o.med) > o.lim ? outliers : kept).push(v); });
  return { kept: kept.length ? kept : (vals || []).slice(), outliers: outliers };
}

/**
 * Winsorize a series: a genuinely anomalous month keeps its slot but takes the median's VALUE.
 *
 * The hard part is that "far from the median" does NOT mean "anomalous". A category with a real
 * summer peak — advertising at 10k for nine months and 30k for three — has six months sitting far
 * from its own median, and a plain outlier filter flattens every one of them. That is not a
 * cosmetic loss: it deletes the exact seasonality this whole feature exists to find, and it does it
 * silently, handing back a confident flat budget for a category that is anything but.
 *
 * What separates the two cases is RECURRENCE. A seasonal peak repeats in the same calendar month
 * across years; a one-off does not. So a point is winsorized only when it is far from the overall
 * median AND far from the same calendar month in OTHER years. July 2025 advertising is far from the
 * overall median but sits right on July 2024, so it survives. March 2025 rent is far from both, so
 * it does not. When a month has no peer year the peer test is skipped — but seasonality is not
 * claimed at that little history either (see SB_MIN_SEASONAL), so a survivor can only move the
 * level, which is a mean over cleaned values and barely notices one month.
 *
 * Replacing rather than dropping keeps the month count honest: drop March 2025 and March has one
 * observation instead of two, so its index is built from a single month.
 */
function sbCleanSeries_(series) {
  const all = (series || []).map(function (p) { return p.v; });
  const o   = sbOutlierLimit_(all);

  // Same-calendar-month values from OTHER years, per index — the recurrence test.
  const peerMed = (series || []).map(function (p, i) {
    const peers = (series || []).filter(function (q, j) { return j !== i && q.mo === p.mo; })
                                .map(function (q) { return q.v; });
    return peers.length ? sbMedian_(peers) : null;
  });

  // The LOCAL level: the median of the two months either side, excluding this one. A level SHIFT is
  // persistent — a new lease, a rent increase, a store opening — so its months agree with their
  // immediate neighbors. A true anomaly does not. Without this test the rule cannot tell "rent went
  // up in 2025" from "one weird month", and on the real Rent series it called 10 of 23 months
  // outliers when only three were: Aug 2024 (partial), Dec 2024 (double payment), Apr 2025 (zero).
  // The other seven were simply the old, lower rent.
  // The neighbors BEFORE and AFTER are looked at separately, and agreeing with EITHER side is
  // enough to be kept. A centered window cannot survive a step change: at the first month of a new
  // lease, half the window is the old level and half the new, so the median lands between them and
  // the month reads as an outlier against its own regime. One-sided, the new month agrees with what
  // FOLLOWS it and is kept — which is the whole point, because a recent step up is exactly what a
  // budget has to capture and the easiest thing to erase.
  const side = function (i, dir) {
    const near = [];
    for (let k = 1; k <= SB_LOCAL_W; k++) { const q = series[i + dir * k]; if (q) near.push(q.v); }
    return near.length ? sbMedian_(near) : null;
  };

  let replaced = 0;
  const out = (series || []).map(function (p, i) {
    const before = side(i, -1), after = side(i, 1);
    const farFromAll  = Math.abs(p.v - o.med) > o.lim;
    const farFromPeer = peerMed[i] === null ? true : Math.abs(p.v - peerMed[i]) > o.lim;
    const fitsBefore  = before !== null && Math.abs(p.v - before) <= o.lim;
    const fitsAfter   = after  !== null && Math.abs(p.v - after)  <= o.lim;
    if (farFromAll && farFromPeer && !fitsBefore && !fitsAfter) {
      replaced++;
      // Filled with the level around it, not the window median: an anomaly inside a shifted stretch
      // should be replaced by what that stretch was doing, not by an average of two regimes.
      const fill = after !== null ? after : (before !== null ? before : o.med);
      return { mo: p.mo, yr: p.yr, v: fill };
    }
    return p;
  });
  return { series: out, replaced: replaced };
}

/** Arithmetic mean. Empty → 0. */
function sbMean_(arr) {
  const a = (arr || []).filter(function (v) { return typeof v === 'number' && isFinite(v); });
  return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0;
}

/** 'Aug 2026' → { mo: 7 (0-indexed), yr: 2026 }, or null if it isn't a month column. */
function sbParseCol_(label) {
  const m = /^([A-Za-z]{3})\s+(\d{4})$/.exec(String(label || '').trim());
  if (!m) return null;
  const mo = MONTHS_12_.indexOf(m[1]);
  return mo < 0 ? null : { mo: mo, yr: Number(m[2]) };
}

/**
 * Damped, clamped growth factor from the last 6 complete months against the 6 before them.
 * Medians on both sides so a single spike cannot manufacture a trend.
 */
function sbTrendFactor_(series) {
  if (series.length < SB_MIN_TREND * 2) return 1;
  const vals  = series.map(function (p) { return p.v; });
  const recent = vals.slice(-SB_MIN_TREND);
  const prior  = vals.slice(-SB_MIN_TREND * 2, -SB_MIN_TREND);
  const rm = sbMedian_(recent), pm = sbMedian_(prior);
  if (!pm) return 1;
  const raw = rm / pm;
  if (!isFinite(raw) || raw <= 0) return 1;
  const damped = 1 + (raw - 1) * SB_TREND_DAMP;
  return Math.max(SB_TREND_MIN, Math.min(SB_TREND_MAX, damped));
}

/**
 * Seasonal index per calendar month, normalized to average 1 so applying it redistributes the year
 * without resizing it. Months with no observation get exactly 1 rather than 0 — "no data for March"
 * must not become "budget nothing in March".
 *
 * MEANS, not medians, and only because the series reaching here has already been cleaned. A budget
 * has to TOTAL correctly: for a category that is 10k nine months a year and 30k for three, the
 * median month is 10k and twelve of those under-budgets the year by 20%. The median's job was to
 * find the distortion; once it is gone the mean is the right estimator.
 */
function sbSeasonalIndex_(series) {
  const overall = sbMean_(series.map(function (p) { return p.v; }));
  const idx = new Array(12).fill(1);
  if (!overall) return idx;
  for (let mo = 0; mo < 12; mo++) {
    const forMo = series.filter(function (p) { return p.mo === mo; }).map(function (p) { return p.v; });
    if (forMo.length) idx[mo] = sbMean_(forMo) / overall;
  }
  const avg = idx.reduce(function (a, b) { return a + b; }, 0) / 12;
  return avg ? idx.map(function (v) { return v / avg; }) : idx;
}

/** Zero-filled Jan..Dec object. */
function sbBlankYear_() {
  const o = {};
  MONTHS_12_.forEach(function (m) { o[m] = 0; });
  return o;
}

/**
 * Project a series forward over the 12 months of `year` using level × seasonality × trend.
 * `level` is the median of the kept (non-outlier) values, so it is the typical month, not the
 * average month — those differ most exactly where it matters, on lumpy categories.
 */
function sbProjectSeries_(series, year) {
  // Clean FIRST, then derive all three of level, seasonality and trend from the cleaned series.
  // A spike left in any one of them leaks into the budget by a different route: the level directly,
  // the seasonal index by inventing a peak month and depressing the rest, the trend by landing in
  // one half of the 6-vs-6 comparison.
  const cleaned = sbCleanSeries_(series);
  const cs      = cleaned.series;
  // LEVEL comes from the trailing 12 months, SEASONALITY from the whole window. They want different
  // spans and averaging them together is what makes a level shift disappear: rent that rose from
  // ~40k to ~44k has a 24-month mean of ~42k, so a budget built on it is under by 4% every month
  // for a cost that is known exactly. Twelve months is also a whole cycle, so the mean is not itself
  // seasonally skewed. Seasonality needs the longer window for the opposite reason — it takes
  // repeated observations of the same calendar month to establish a shape at all.
  const recent  = cs.slice(-Math.min(12, cs.length));
  const level   = sbMean_(recent.map(function (p) { return p.v; }));
  const trend   = sbTrendFactor_(cs);
  const seas    = cs.length >= SB_MIN_SEASONAL ? sbSeasonalIndex_(cs) : new Array(12).fill(1);
  const out     = sbBlankYear_();
  MONTHS_12_.forEach(function (m, i) { out[m] = Math.round(level * seas[i] * trend); });
  return { monthly: out, level: level, trend: trend, seasonal: seas, outliers: cleaned.replaced };
}

/**
 * Budget for a SPARSE category — one with no spend in half its months or more.
 *
 * These have no "typical month", and the main engine gets them badly wrong: with the median at
 * zero, every month that DID have spend reads as an outlier, cleaning replaces it with the
 * surrounding zeros, and the category is budgeted at $0. Meals & Entertainment came out of the live
 * data at exactly that — $0 a year against $7,014 of real spend, with 11 of 12 months "excluded".
 * A confident zero is the worst possible answer here: it reads as a decision.
 *
 * What such a category actually has is an annual RATE, so that is what it gets — total spend spread
 * evenly, no seasonal claim. The only thing removed is a single month large enough to be an event
 * rather than a rate: Miscellaneous is 94% one $26,915 line, which must not become a recurring
 * budget, while Meals' largest month is 24% of its total and is simply a busy month.
 *
 * Deliberately NOT the MAD machinery. On small skewed values it produces a limit of a few hundred
 * dollars and throws away half the real spend — the same collapse this function exists to avoid.
 */
function sbSparseProposal_(cat, series, windowMonths) {
  const vals  = series.map(function (p) { return p.v; });
  const total = vals.reduce(function (a, b) { return a + b; }, 0);
  const events = [];
  let used = total;
  if (total > 0) {
    vals.forEach(function (v) {
      if (v > 0 && v / total > SB_SPARSE_EVENT_SHARE) { events.push(v); used -= v; }
    });
  }
  const perMonth = windowMonths > 0 ? Math.max(0, used / windowMonths) : 0;
  const monthly  = sbBlankYear_();
  MONTHS_12_.forEach(function (m) { monthly[m] = Math.round(perMonth); });
  const annual = MONTHS_12_.reduce(function (a, m) { return a + monthly[m]; }, 0);
  const spent  = series.filter(function (p) { return p.v > 0; }).length;
  return {
    category: cat, method: 'run_rate', confidence: 'low', n_months: spent,
    monthly: monthly, annual: annual,
    basis: { total_in_window: Math.round(total), one_off_excluded: events.length,
             one_off_amount: events.length ? Math.round(events[0]) : 0,
             outliers_excluded: events.length },
    note: 'Irregular — only ' + spent + ' of ' + windowMonths + ' months had any spend, so there is '
        + 'no typical month. Budgeted at the run rate'
        + (events.length ? ', after setting aside a one-off of $'
             + Math.round(events[0]).toLocaleString() + ' that was most of the window\'s total' : '')
        + '. Flat by design, not by analysis.'
  };
}

/**
 * Pull mapped expense categories AND total income, by month, over an arbitrary range.
 * Deliberately reuses walkQBRows_ and the user's own mapping config so a proposal is expressed in
 * exactly the categories the Expenses tab shows — a budget in different buckets than the actuals
 * it will be compared against is not a budget.
 */
function sbFetchHistory_(start, end) {
  const qb     = qbProfitAndLoss_(start, end, 'Month');
  const report = qb.report;
  if (report.Fault) throw new Error(JSON.stringify(report.Fault));

  const cols = (report.Columns && report.Columns.Column ? report.Columns.Column : [])
    .map(function (c) { return c.ColTitle || ''; }).filter(Boolean);

  const expenses = {};
  walkQBRows_(report.Rows && report.Rows.Row ? report.Rows.Row : [], cols, expenses, [], new Set(),
              getExpenseMapConfig_(), 0);

  // Total Income, straight off the flattened P&L — the same basis as the expense rows above, which
  // is what makes a spend/revenue ratio meaningful. Mixing in Dutchie net sales here would divide
  // two numbers that don't share a definition of revenue.
  const flat = [];
  flattenPnlRows_(report.Rows && report.Rows.Row ? report.Rows.Row : [], cols.length, flat, 0);
  const incomeRow = flat.find(function (r) { return r.label === 'Total Income'; });
  const income = {};
  cols.forEach(function (c, i) { income[c] = incomeRow ? (incomeRow.values[i] || 0) : 0; });

  return { columns: cols, expenses: expenses, income: income, qb_source: qb.source };
}

/**
 * Build the proposal. `year` is the budget year; `throughMonth` is the last COMPLETE month of
 * history (exclusive of the month in progress).
 *
 * Excluding the current month is load-bearing and easy to miss: on the 30th of a month, that
 * month's column holds ~29 days of spend. Left in the series it drags the level and the trend
 * down every single time the proposal is generated, and the closer to the 1st you run it the
 * worse the answer — a failure that looks like a plausible number and never errors.
 */
function sbBuildProposal_(year, history) {
  const series = {};   // cat → [{mo, yr, v}]
  const incomeSeries = [];

  history.columns.forEach(function (col) {
    const p = sbParseCol_(col);
    if (!p) return;                                  // 'Total' and anything unparsed
    incomeSeries.push({ mo: p.mo, yr: p.yr, v: Number(history.income[col]) || 0 });
  });

  const cats = Object.keys(history.expenses);
  cats.forEach(function (cat) {
    series[cat] = [];
    history.columns.forEach(function (col) {
      const p = sbParseCol_(col);
      if (!p) return;
      series[cat].push({ mo: p.mo, yr: p.yr, v: Number(history.expenses[cat][col]) || 0 });
    });
  });

  // Revenue projected by the same engine, so the volume-linked ratio has something to land on.
  const incomeProj = sbProjectSeries_(incomeSeries, year);

  // Last year's actuals per month, keyed by month name. The planner shows them beside every figure
  // it proposes, because "is this number sane" is answered by what the category actually spent, not
  // by the method label. The data is already in `series` — this is a reshape, not a second fetch.
  const priorYear = {};
  cats.forEach(function (cat) {
    const row = sbBlankYear_();
    let any = false;
    (series[cat] || []).forEach(function (p) {
      if (p.yr !== year - 1) return;
      row[MONTHS_12_[p.mo]] = Math.round(p.v * 100) / 100;
      any = true;
    });
    priorYear[cat] = any ? row : null;   // null, not a row of zeros: "no history" is not "spent nothing"
  });

  const proposals = cats.map(function (cat) {
    const s        = series[cat] || [];
    const nonZero  = s.filter(function (p) { return p.v > 0; });
    const n        = nonZero.length;
    const isVolume = SB_VOLUME_LINKED.indexOf(cat) !== -1;

    // No history at all → no proposal. This is the "$500 guess" rule, and it is a refusal on
    // purpose: the caller keeps whatever the sheet already holds and is told why.
    if (n < SB_MIN_ANY) {
      return { category: cat, method: 'none', confidence: 'none', n_months: 0,
               monthly: null, annual: null,
               note: 'No spend in the history window — nothing to derive a budget from. Left as-is.' };
    }

    // Sparse categories are decided BEFORE the volume/seasonal paths — both of those assume a
    // meaningful central value, which a mostly-zero series does not have.
    const windowMonths = s.length;
    const zeroShare    = windowMonths ? (windowMonths - n) / windowMonths : 1;
    if (zeroShare >= SB_SPARSE_ZERO_SHARE) return sbSparseProposal_(cat, s, windowMonths);

    if (isVolume && n >= SB_MIN_RATIO) {
      // Ratio per month, then the MEDIAN ratio — not total spend over total revenue, which is a
      // revenue-weighted average and lets the biggest month set the rate for all twelve.
      const ratios = [];
      s.forEach(function (p, i) {
        const inc = incomeSeries[i] ? incomeSeries[i].v : 0;
        if (inc > 0 && p.v > 0) ratios.push(p.v / inc);
      });
      // Mean of the KEPT ratios, for the same reason the level is a mean: the split has already
      // removed the distortion, and a budget that under-totals is not a budget.
      const rs    = sbSplitOutliers_(ratios);
      const ratio = sbMean_(rs.kept);
      const monthly = sbBlankYear_();
      MONTHS_12_.forEach(function (m) { monthly[m] = Math.round(ratio * (incomeProj.monthly[m] || 0)); });
      const annual = MONTHS_12_.reduce(function (a, m) { return a + monthly[m]; }, 0);
      return {
        category: cat, method: 'pct_of_revenue',
        confidence: n >= SB_MIN_SEASONAL ? 'high' : 'medium', n_months: n,
        monthly: monthly, annual: annual,
        basis: { ratio: ratio, ratio_pct: Math.round(ratio * 1000) / 10,
                 projected_revenue: incomeProj.monthly, outliers_excluded: rs.outliers.length },
        note: 'Median ' + (Math.round(ratio * 1000) / 10) + '% of revenue, applied to projected revenue.'
      };
    }

    const proj   = sbProjectSeries_(s, year);
    const annual = MONTHS_12_.reduce(function (a, m) { return a + proj.monthly[m]; }, 0);

    let method, confidence, note;
    if (n >= SB_MIN_SEASONAL) {
      method = 'seasonal_trend'; confidence = 'high';
      note = 'Typical month $' + Math.round(proj.level).toLocaleString() +
             ', shaped by ' + n + ' months of seasonality' +
             (proj.trend !== 1 ? ' and a ' + (proj.trend > 1 ? '+' : '−') +
              Math.abs(Math.round((proj.trend - 1) * 100)) + '% trend' : '') + '.';
    } else if (n >= SB_MIN_TREND) {
      method = 'trend_only'; confidence = 'medium';
      note = n + ' months of history — enough for a level and a trend, not enough to claim a ' +
             'seasonal shape, so the months are held flat.';
    } else {
      method = 'level_only'; confidence = 'low';
      note = 'Only ' + n + ' month' + (n === 1 ? '' : 's') + ' of history. Flat at the median; ' +
             'treat as a placeholder, not an analysis.';
    }

    return {
      category: cat, method: method, confidence: confidence, n_months: n,
      monthly: proj.monthly, annual: annual,
      basis: { level: proj.level, trend: proj.trend,
               seasonal: n >= SB_MIN_SEASONAL ? proj.seasonal : null,
               outliers_excluded: proj.outliers },
      note: note
    };
  });

  // Attached in ONE place rather than in each branch: the sparse path returns from
  // sbSparseProposal_, so a per-branch assignment silently skips it — and a missing prior year
  // renders as an empty column, which reads as "spent nothing last year".
  proposals.forEach(function (p) { p.prior_year = priorYear[p.category] || null; });

  proposals.sort(function (a, b) { return (b.annual || 0) - (a.annual || 0); });
  return { year: year, proposals: proposals, projected_revenue: incomeProj.monthly,
           revenue_trend: incomeProj.trend };
}

/** The applied overlay, or null. Shape: { year, categories:{cat:{Jan..Dec}}, applied_at, applied_by }. */
function sbGetOverlay_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(SMART_BUDGET_PROP);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

/**
 * The 24-month window ending with the last COMPLETE month. Dates are built with
 * Utilities.formatDate in Los Angeles, never toISOString — from 17:00 PT onward the UTC date is
 * already tomorrow, which here would silently pull an extra month on some evenings and not others.
 */
function sbHistoryWindow_() {
  const tz    = 'America/Los_Angeles';
  const today = new Date();
  const y     = Number(Utilities.formatDate(today, tz, 'yyyy'));
  const m     = Number(Utilities.formatDate(today, tz, 'MM'));   // 1–12
  // Last complete month = the month before the current one.
  const endD  = new Date(y, m - 1, 0);                  // day 0 of this month = last day of previous
  const startD= new Date(y, m - 1 - 24, 1);             // 24 complete months back
  const fmt   = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  return { start: fmt(startD), end: fmt(endD) };
}

/** action=budget_proposal — compute (never store) a proposal. Cached 1h; the inputs move monthly. */
function getBudgetProposal(params) {
  try {
    const year = Number((params && params.year) || BUDGET_YEAR) || BUDGET_YEAR;
    const win  = sbHistoryWindow_();
    const key  = 'sbprop_' + year + '_' + win.start + '_' + win.end + '_v1';
    if (!params || !params.nocache) {
      const cached = cacheGet_(key);
      if (cached) return jsonOut_(JSON.parse(cached));
    }
    const history = sbFetchHistory_(win.start, win.end);
    const built   = sbBuildProposal_(year, history);
    const overlay = sbGetOverlay_();
    const out = {
      ok: true, year: year, window: win,
      qb_source: history.qb_source,
      months_of_history: history.columns.filter(function (c) { return sbParseCol_(c); }).length,
      proposals: built.proposals,
      projected_revenue: built.projected_revenue,
      revenue_trend: built.revenue_trend,
      applied: overlay && overlay.year === year ? Object.keys(overlay.categories || {}) : [],
      // The planner cannot work these out for itself without re-deriving the server's own date
      // rules, and a client that disagreed would render an Apply button promising something the
      // write would refuse.
      open_months: sbOpenMonths_(year),
      bills_once:  sbBillsOnce_(),
      current:     frozenGet_(FROZEN_EXPBUD_PROP) || {},
      overlay:     overlay && overlay.year === year ? (overlay.categories || {}) : {}
    };
    cacheSet_(key, JSON.stringify(out), 3600);
    return jsonOut_(out);
  } catch (e) {
    return jsonOut_({ ok: false, error: e.message });
  }
}

// ── Which months a budget may still be written to ─────────────────────────────────────────────
//
// A quarterly re-cut must not rewrite January. Every variance the Expenses tab has already shown
// for a closed month was measured against the budget that stood at the time; changing it now makes
// that history retroactively wrong, and silently — the tab would simply start drawing a different
// line with no indication anything moved.
//
// The month IN PROGRESS counts as closed too. A partial month cannot be budgeted, which is the same
// reason the proposal engine excludes it from history (sbHistoryWindow_).
//
// Computed HERE, never taken from the client. The client sends numbers for the months it thinks are
// open; the server decides which of them it is willing to write. A client that is wrong about the
// date must not be able to rewrite a closed month.
function sbOpenMonths_(year) {
  const tz  = 'America/Los_Angeles';
  const now = new Date();
  const cy  = Number(Utilities.formatDate(now, tz, 'yyyy'));
  const cm  = Number(Utilities.formatDate(now, tz, 'MM'));   // 1-12
  if (year > cy) return MONTHS_12_.slice();                  // a future year is entirely open
  if (year < cy) return [];                                  // a past year is entirely closed
  return MONTHS_12_.slice(cm);                               // months AFTER the one in progress
}

/** Categories flagged as landing at the start of a period rather than accruing daily. */
const BILLS_ONCE_PROP = 'bills_once';
function sbBillsOnce_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(BILLS_ONCE_PROP);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(function (v) { return typeof v === 'string' && v; }) : [];
  } catch (e) { return []; }
}

/**
 * action=set_bills_once - which categories bill at a point in the period instead of accruing.
 *
 * This has to live on the SERVER rather than in the planner's own state, because the consumer is the
 * EXPENSES tab: Rent, Insurance, Licenses and Management are billed once, so pacing them against a
 * day-30 fraction flags them as "over" by construction every single month. A flag kept only in the
 * planner would leave that wrong on the screen people actually read.
 *
 * Takes the WHOLE list, not a delta - the planner always knows the full set, and a merge would make
 * un-flagging impossible without a second verb.
 */
function setBillsOnce_(params) {
  let list;
  try {
    const raw = params.categories;
    list = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
  } catch (e) { return jsonOut_({ ok: false, error: 'Invalid categories JSON' }); }
  if (!Array.isArray(list)) return jsonOut_({ ok: false, error: 'categories must be an array' });
  const clean = [];
  list.forEach(function (v) {
    const n = String(v || '').trim();
    if (n && clean.indexOf(n) === -1) clean.push(n);
  });
  PropertiesService.getScriptProperties().setProperty(BILLS_ONCE_PROP, JSON.stringify(clean));
  cacheDelete_('expbudgets');
  return jsonOut_({ ok: true, bills_once: clean });
}

/**
 * action=apply_budget — store accepted categories as the overlay. Write-guarded like every other
 * write here. Merges rather than replaces, so applying one category at a time is safe and a second
 * apply cannot silently drop the first.
 */
function applyBudget_(params) {
  let incoming;
  try {
    const raw = params.categories;
    incoming = (raw && typeof raw === 'object') ? raw : JSON.parse(raw || '{}');
  } catch (e) { return jsonOut_({ ok: false, error: 'Invalid categories JSON' }); }
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return jsonOut_({ ok: false, error: 'categories must be an object' });
  }

  const year = Number(params.year || BUDGET_YEAR) || BUDGET_YEAR;
  const prev = sbGetOverlay_();
  // A year change replaces rather than merges — carrying last year's overlaid months into a new
  // budget year would be indistinguishable from having applied them deliberately.
  const cats = (prev && prev.year === year && prev.categories) ? prev.categories : {};

  // Only months the server considers open may be written; the rest KEEP whatever they already
  // budgeted. The overlay row stays a full twelve months on purpose — getExpenseBudgets replaces the
  // whole category row with it, so a partial row would blank every month it omitted. This is the
  // read-merge-write rule the GX Core writes follow, for the same reason.
  const open = sbOpenMonths_(year);
  if (!open.length) {
    return jsonOut_({ ok: false, error: 'every month of ' + year + ' is closed — nothing can be written' });
  }
  const frozen = frozenGet_(FROZEN_EXPBUD_PROP) || {};

  const applied = [], skipped_months = MONTHS_12_.filter(function (m) { return open.indexOf(m) === -1; });
  for (const name of Object.keys(incoming)) {
    const row = incoming[name];
    if (!row || typeof row !== 'object') continue;
    const held = cats[name] || frozen[name] || {};
    const clean = {};
    let wroteAny = false;
    MONTHS_12_.forEach(function (m) {
      if (open.indexOf(m) === -1) {
        // Closed: preserve. Not the proposal's figure for that month — what the month already had.
        const h = Number(held[m]);
        clean[m] = isFinite(h) && h >= 0 ? Math.round(h * 100) / 100 : 0;
        return;
      }
      const v = Number(row[m]);
      clean[m] = (isFinite(v) && v >= 0) ? Math.round(v * 100) / 100 : 0;
      wroteAny = true;
    });
    // A category proposed at $0 for every open month IS a real answer — it is how a stale figure
    // gets retired — so unlike before, an all-zero row is applied rather than skipped. What is
    // skipped is a row that supplied no open month at all.
    if (!wroteAny) continue;
    cats[name] = clean;
    applied.push(name);
  }
  if (!applied.length) return jsonOut_({ ok: false, error: 'nothing to apply' });

  const rec = {
    year: year, categories: cats,
    applied_at: Utilities.formatDate(new Date(), 'America/Los_Angeles', "yyyy-MM-dd'T'HH:mm:ssXXX"),
    applied_by: String(params._user || '') || 'unknown',
    source: 'smart_budget'
  };
  PropertiesService.getScriptProperties().setProperty(SMART_BUDGET_PROP, JSON.stringify(rec));
  cacheDelete_('expbudgets');
  return jsonOut_({ ok: true, applied: applied, total_overlaid: Object.keys(cats).length, year: year,
                    open_months: open, preserved_months: skipped_months });
}

/**
 * action=clear_budget — drop the whole overlay, or one category. The sheet was never written, so
 * this is a complete revert with nothing to reconstruct.
 */
function clearBudget_(params) {
  const props = PropertiesService.getScriptProperties();
  const cur   = sbGetOverlay_();
  if (!cur) return jsonOut_({ ok: true, cleared: 'nothing', remaining: 0 });

  const one = String((params && params.category) || '').trim();
  if (one) {
    if (!cur.categories || !(one in cur.categories)) {
      return jsonOut_({ ok: false, error: 'not overlaid: ' + one });
    }
    delete cur.categories[one];
    props.setProperty(SMART_BUDGET_PROP, JSON.stringify(cur));
    cacheDelete_('expbudgets');
    return jsonOut_({ ok: true, cleared: one, remaining: Object.keys(cur.categories).length });
  }
  props.deleteProperty(SMART_BUDGET_PROP);
  cacheDelete_('expbudgets');
  return jsonOut_({ ok: true, cleared: 'all', remaining: 0 });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  SHEET FREEZE — the last read of the legacy "2026 GX2 Dashboard" workbook
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// Sky's call (2026-08-30): sever this app from that spreadsheet entirely. It is the legacy workbook
// the suite conventions already say never to touch, this script only holds READER access to it
// (`anyone → reader`, owned by another account), and everything it still supplies now has a better
// home — expense budgets in the smart budget, store goals in GX Core's frozen pay periods.
//
// Cutting a live dependency in one step is how a dashboard goes blank, so this is deliberately two
// steps. FIRST freeze: copy what the sheet currently says into this script's own properties, and
// have every reader prefer that copy. At that point the app is already independent — the sheet is
// only a fallback for anything the freeze missed. THEN, once the smart budget is applied, delete
// the sheet code outright. Between the two the app is fully functional with the sheet disconnected,
// which is what makes the deletion boring instead of risky.
//
// One finding worth stating plainly, because it changes what "freeze the earlier goals" can mean:
// THE BUDGET SHEET HOLDS ONE YEAR ONLY. getGoals() tags its response with BUDGET_YEAR (2026) and
// the frontend returns 0 for any other year, so there are no pre-2026 budget goals to preserve —
// views before 2026 already show no goal and will look identical after the cut. What the freeze
// actually preserves is the 2026 fallback, which is what serves any window the pay-period ledger
// does not cover (August's last day, and September onward until those periods are published).

const FROZEN_GOALS_PROP    = 'frozen_goals';
const FROZEN_EXPBUD_PROP   = 'frozen_expbudgets';
const FROZEN_QBMAP_PROP    = 'frozen_qbmapping';
const FROZEN_AT_PROP       = 'frozen_at';

/** Read a frozen snapshot, or null. Never throws — a corrupt snapshot must fall back, not break. */
function frozenGet_(prop) {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(prop);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return (v && typeof v === 'object') ? v : null;
  } catch (e) { return null; }
}

/** The store-goal rows, straight off the sheet. Same parse getGoals() has always used. */

/** The EXPENSES BUDGET section, straight off the sheet. Same parse getExpenseBudgets() has used. */

/** The QuickBooks account → dashboard category pairs. */

/**
 * action=freeze_sheet — snapshot everything the workbook still supplies into this script.
 *
 * Secret-gated rather than session-gated: this is a one-time migration step that has to be
 * runnable from a terminal, and it must work whether or not anyone is signed in. Idempotent —
 * re-running simply re-reads the sheet, which is exactly what you want if the sheet is corrected
 * before the cut. `dry=1` reports what WOULD be captured without writing, so the parse can be
 * checked against the live sheet before anything is committed to properties.
 */

/** action=freezestatus — what is frozen, how much, and when. Read-only. */
function freezeStatus_() {
  const g = frozenGet_(FROZEN_GOALS_PROP), e = frozenGet_(FROZEN_EXPBUD_PROP), q = frozenGet_(FROZEN_QBMAP_PROP);
  const overlay = sbGetOverlay_();
  const props = PropertiesService.getScriptProperties();
  return jsonOut_({
    ok: true,
    frozen_at: props.getProperty(FROZEN_AT_PROP) || null,
    goals:      g ? Object.keys(g).length : 0,
    expbudgets: e ? Object.keys(e).length : 0,
    qbmapping:  q ? q.length : 0,
    otherrev_stored: !!props.getProperty(OTHERREV_PROP),
    smart_budget_applied: overlay && overlay.categories ? Object.keys(overlay.categories).length : 0,
    // The frozen store goals in full. This is the LAST read of a workbook we are about to
    // disconnect, so the values have to be checkable, not just counted — the sheet has more than
    // one row per store label and the parse takes the last match, which is precisely the kind of
    // thing that freezes a wrong number permanently and silently.
    goals_frozen: g || null,
    // ATM per-machine data also comes from that workbook (ATM_SHEET_CONFIG_['2026'].sid IS
    // BUDGET_SHEET_ID). If these rev_* properties are not already populated, bootstrapAtmFromSheet_
    // is still load-bearing and cutting the sheet would silently blank ATM revenue.
    rev_props: props.getKeys().filter(function (k) { return k.indexOf('rev_') === 0; }).sort(),
    // The cut is only safe once every category the Expenses tab can show has a source that is not
    // the sheet — either an applied smart budget or a frozen figure.
    ready_to_cut: !!(g && e && q && props.getProperty(OTHERREV_PROP))
  });
}

/**
 * action=admin_apply_proposed — apply the engine's OWN proposal for named categories.
 *
 * The normal apply_budget sits behind the session gate and the write guard, which is right for a
 * person clicking Apply. This exists for the scripted case (a migration, finishing a partial
 * rollout from a terminal) where there is no browser and no session to have.
 *
 * Deliberately NARROWER than the route it complements: it takes category NAMES only and fills them
 * from a freshly computed proposal. There is no way to pass amounts, so it cannot be used to write
 * a figure the engine did not produce — which is the property that makes a secret-gated write into
 * financial config defensible at all. Same secret that already gates guardmode, which can disable
 * the write guard outright, so this grants strictly less than what the secret already carries.
 *
 * Refuses a category with no proposal (confidence 'none'), because "apply" must never mean "invent".
 */
function adminApplyProposed_(params) {
  const names = String((params && params.categories) || '')
    .split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  if (!names.length) return jsonOut_({ ok: false, error: 'categories= is required (comma-separated)' });

  const year = Number(params.year || BUDGET_YEAR) || BUDGET_YEAR;
  let built;
  try {
    const win = sbHistoryWindow_();
    built = sbBuildProposal_(year, sbFetchHistory_(win.start, win.end));
  } catch (e) {
    return jsonOut_({ ok: false, stage: 'proposal', error: e.message });
  }

  const byCat = {};
  built.proposals.forEach(function (p) { byCat[p.category] = p; });

  const payload = {}, applied = [], refused = {};
  names.forEach(function (n) {
    const p = byCat[n];
    if (!p)            { refused[n] = 'no such category in the current proposal'; return; }
    if (!p.monthly)    { refused[n] = 'no proposal for this category (' + p.confidence + ') — nothing to apply'; return; }
    payload[n] = p.monthly;
    applied.push({ category: n, method: p.method, confidence: p.confidence, annual: p.annual });
  });
  if (!applied.length) return jsonOut_({ ok: false, error: 'nothing applicable', refused: refused });

  const res = applyBudget_({ categories: payload, year: year, _user: 'admin:secret' });
  const body = JSON.parse(res.getContent());
  return jsonOut_({ ok: !!body.ok, applied: applied, refused: refused,
                    total_overlaid: body.total_overlaid, year: year, error: body.error || null });
}
