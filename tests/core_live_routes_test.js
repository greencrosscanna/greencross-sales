#!/usr/bin/env node
/* ─── GX Core's live data routes — the transport, the caches, and no library binding ─────────────
 *
 *   RUN:  node tests/core_live_routes_test.js     (from the repo root; no deps, no network)
 *
 * Roadmap [5] slice 7: Sales reads GX Core's data over /exec instead of the pinned GXCore library, so
 * a Core fix never needs a Sales re-pin. A library call was in-process and essentially never failed;
 * an /exec hop is slow and bounces ~6% of the time. The properties under test are what keeps that
 * from becoming a smaller number or a refused store:
 *
 *   gxCoreData_      the secret rides in the POST body, never the URL; a bounce (unparseable body) is
 *                    retried; a JSON `null` is an ANSWER; a refusal ({ok:false}) throws, never empties
 *   gxCoreDataAll_   parallel; re-asks ONLY the reads that bounced; reports each read on its own
 *   coreStoresLive_  cached; on a Core failure uses the last good registry, never an empty one
 *   corePeriodGoalsLive_  cached per (store, date), "no goal" (null) included; a failure never cached
 *   appsscript.json  binds no library at all
 *
 * EXECUTES the shipped functions. Each check names the fixture that would make it FAIL.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const GS = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');
const { memCache } = require('./_core_routes_stub');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
function grab(name) {
  const m = new RegExp('\\nfunction ' + name + '\\s*\\(').exec(GS);
  if (!m) throw new Error('could not locate ' + name);
  let i = GS.indexOf('{', m.index + 1), d = 0, j = i;
  for (; j < GS.length; j++) { if (GS[j] === '{') d++; else if (GS[j] === '}' && --d === 0) break; }
  return GS.slice(m.index + 1, j + 1);
}
const grabConst = n => new RegExp('\\nconst ' + n + '\\s*=\\s*[^;]+;').exec(GS)[0];

/* `answers` is a list of what /exec returns on successive requests: a string body, or an Error to throw. */
function transport(answers) {
  const w = { reqs: [], sleeps: 0, answers: answers.slice() };
  const next = () => { const a = w.answers.length > 1 ? w.answers.shift() : w.answers[0]; if (a instanceof Error) throw a; return a; };
  const resp = body => ({ getContentText: () => body, getResponseCode: () => (body.charAt(0) === '<' ? 404 : 200) });
  const ctx = {
    JSON, Object, Date, String, Math, Error,
    GXCORE_EXEC_: 'https://script.google.com/macros/s/CORE/exec',
    GXCORE_RETRY_BUDGET_MS: 60000,
    gxDeploySecret_: () => 'test-secret',
    errText_: e => (e && e.message) || String(e),
    Utilities: { sleep: () => { w.sleeps++; } },
    UrlFetchApp: {
      fetch: (url, o) => { w.reqs.push({ url, o }); return resp(next()); },
      fetchAll: reqs => reqs.map(r => { w.reqs.push({ url: r.url, o: r }); try { return resp(next()); } catch (e) { return resp('<html>'); } }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext([grab('gxRetryHold_'), grab('gxCoreData_'), grab('gxCoreDataAll_')].join('\n'), ctx);
  w.ctx = ctx;
  return w;
}

console.log('\n1. gxCoreData_ — one read through GX Core\'s /exec');
{
  const w = transport(['{"ok":true,"stores":[1]}']);
  const r = w.ctx.gxCoreData_('period_goals', { store: 'Bend', date: '2026-11-25' });
  const req = w.reqs[0];
  const body = JSON.parse(req.o.payload);
  ok(r.stores[0] === 1 && w.reqs.length === 1, 'an answer comes back on the first try');
  // Fails if the secret were appended to the URL the way gxCoreRoute_ does.
  ok(req.o.method === 'post' && req.url === w.ctx.GXCORE_EXEC_ && !/secret/.test(req.url) && body.secret === 'test-secret',
     'POST to Core\'s /exec, secret in the body, never in the URL');
  ok(body.action === 'period_goals' && body.store === 'Bend' && body.date === '2026-11-25', 'the action and its parameters ride in the body');
  const pub = transport(['{"ok":true,"stores":[]}']);
  pub.ctx.gxCoreData_('stores', {}, { public: true });
  ok(!('secret' in JSON.parse(pub.reqs[0].o.payload)), 'a public route (stores) is not sent the secret at all');

  // Fails if a bare `null` (getPeriodGoals' "no goal") were treated as a bounce and retried/thrown.
  const n = transport(['null']);
  ok(n.ctx.gxCoreData_('period_goals', { store: 'Bend', date: '2024-01-01' }) === null && n.reqs.length === 1, 'JSON null is an answer, asked once');
  const bare = transport(['{"period_start":"2026-11-24","dow_targets":[1,2,3,4,5,6,7]}']);
  ok(bare.ctx.gxCoreData_('period_goals', { store: 'Bend' }).dow_targets.length === 7, 'an answer without an `ok` field (the bare goal row) is accepted');

  // The /exec bounce: an HTML 404 page, then a real answer.
  const b = transport(['<html>404</html>', '{"ok":true,"rows":[]}']);
  ok(Array.isArray(b.ctx.gxCoreData_('sales_rows', {}).rows) && b.reqs.length === 2 && b.sleeps === 1, 'a bounce is retried once, after a pause, then answers');
  const dead = transport([new Error('Address unavailable')]);
  let msg = ''; try { dead.ctx.gxCoreData_('sales_rows', {}); } catch (e) { msg = e.message; }
  ok(/unreachable after 3 tries/.test(msg) && dead.reqs.length === 3, 'three dead tries throw, naming the count');

  // Fails if a refusal were returned (a caller reading `.rows` of it would see nothing — a smaller number).
  const ref = transport(['{"ok":false,"error":"Forbidden"}']);
  msg = ''; try { ref.ctx.gxCoreData_('sales_rows', {}); } catch (e) { msg = e.message; }
  ok(/sales_rows: Forbidden/.test(msg) && ref.reqs.length === 1, 'a refusal throws at once — not retried, never an empty answer');
}

console.log('\n2. gxCoreDataAll_ — several reads in parallel, each retried on its own');
{
  // fetchAll answers in order: round 1 → [good, bounce, refusal]; round 2 → [good] for the bounced one.
  const w = transport(['{"ok":true,"rows":[1]}', '<html>', '{"ok":false,"error":"store required"}', '{"ok":true,"rows":[2]}']);
  const r = w.ctx.gxCoreDataAll_('velocity_rows', [{ store: 'bend' }, { store: 'river-rd' }, { store: 'nope' }]);
  ok(r[0].ok && r[0].data.rows[0] === 1, 'the first read answers');
  // Fails if a bounced read were dropped instead of re-asked (River would read as selling nothing).
  ok(r[1].ok && r[1].data.rows[0] === 2 && w.reqs.length === 4, 'the bounced read — and ONLY it — is asked again');
  ok(!r[2].ok && r[2].refused && /store required/.test(r[2].error), 'a refusal is reported for its own read, not retried');
  ok(w.reqs.every(q => !/secret/.test(q.url) && JSON.parse(q.o.payload).secret === 'test-secret'), 'every request carries the secret in the body only');
}

/* coreStoresLive_ and corePeriodGoalsLive_ with a scripted gxCoreData_. */
function cached(core) {
  const c = memCache();
  const w = { calls: 0, marks: [], cache: c.map };
  const ctx = {
    JSON, cacheGet_: c.cacheGet_, cacheSet_: c.cacheSet_,
    gxCoreData_: (a, b, o) => { w.calls++; return core(a, b, o, w.calls); },
    probeMark_: (l, ms, x) => w.marks.push({ l, x }), errText_: e => (e && e.message) || String(e),
  };
  vm.createContext(ctx);
  vm.runInContext([grabConst('CORE_STORES_FRESH_'), grabConst('CORE_STORES_LAST_'), grabConst('CORE_PG_TTL_S_'),
                   grab('coreStoresLive_'), grab('corePeriodGoalsLive_')].join('\n'), ctx);
  w.ctx = ctx;
  return w;
}
const REG = [{ store_id: 'bend', dutchie_name: 'Bend' }, { store_id: 'river-rd', dutchie_name: 'River Rd' }];

console.log('\n3. the store registry — read on nearly every request, so it must not cost a hop each time');
{
  const w = cached(() => ({ ok: true, stores: REG }));
  w.ctx.coreStoresLive_(); w.ctx.coreStoresLive_(); w.ctx.coreStoresLive_();
  ok(w.calls === 1, 'three reads, ONE hop (the rest from the 10-minute cache)');

  // Core down, but it answered earlier: the last good registry, with a mark saying so.
  const d = cached((a, b, o, n) => { if (n === 1) return { ok: true, stores: REG }; throw new Error('unreachable after 3 tries'); });
  d.ctx.coreStoresLive_();
  d.cache.delete('corestores_v1');                        // the fresh copy expires…
  const r = d.ctx.coreStoresLive_();                      // …and Core is down
  // Fails if a Core outage turned into "GX Core store registry unreachable" on every store gate.
  ok(r.length === 2 && r[1].store_id === 'river-rd' && d.marks.some(m => m.l === 'core_stores_last_good'),
     'Core unreachable: the LAST GOOD registry answers, and a probe mark says it did');

  // Never answered, and down: THROWS. Fails if this returned [] — "no stores" would refuse every load.
  const never = cached(() => { throw new Error('unreachable after 3 tries'); });
  let threw = ''; try { never.ctx.coreStoresLive_(); } catch (e) { threw = e.message; }
  ok(/unreachable/.test(threw), 'no copy at all and Core down: throws, never an empty registry');

  // A malformed answer is not cached and is not a registry.
  const odd = cached(() => ({ ok: true, stores: [{ store_id: 'bend' }] }));
  threw = ''; try { odd.ctx.coreStoresLive_(); } catch (e) { threw = e.message; }
  ok(/no usable rows/.test(threw) && !odd.cache.has('corestores_v1'), 'a row with no dutchie_name: refused, nothing cached');
}

console.log('\n4. period goals — cached 10 minutes per (store, date), and only ANSWERS are cached');
{
  const goal = { period_start: '2026-11-24', dow_targets: [1, 2, 3, 4, 5, 6, 7] };
  const w = cached((a, b) => (b.date === '2024-01-01' ? null : goal));
  w.ctx.corePeriodGoalsLive_('Bend', '2026-11-25'); w.ctx.corePeriodGoalsLive_('Bend', '2026-11-25');
  ok(w.calls === 1, 'the same question twice: one hop');
  w.ctx.corePeriodGoalsLive_('Bend', '2024-01-01');
  ok(w.ctx.corePeriodGoalsLive_('Bend', '2024-01-01') === null && w.calls === 2, '"no goal" (null) is an answer and is cached too');
  w.ctx.corePeriodGoalsLive_('River Rd', '2026-11-25');
  ok(w.calls === 3, 'a different store is a different question');

  // Fails if a failure were cached: the goal would stay missing for ten minutes after Core recovered.
  const f = cached((a, b, o, n) => { if (n === 1) throw new Error('hop timed out'); return goal; });
  try { f.ctx.corePeriodGoalsLive_('Bend', '2026-11-25'); } catch (e) {}
  ok(f.ctx.corePeriodGoalsLive_('Bend', '2026-11-25').dow_targets.length === 7 && f.calls === 2, 'a failure is not cached — the next ask goes to Core');

  const shape = cached(() => ({ ok: true, rows: [] }));    // store-less shape missing `picked`
  let threw = ''; try { shape.ctx.corePeriodGoalsLive_('', '2026-11-25'); } catch (e) { threw = e.message; }
  ok(/unrecognized answer for all stores/.test(threw) && shape.cache.size === 0, 'an unrecognizable all-stores answer throws (the per-store fallback then runs), not cached');
  const all = cached(() => ({ ok: true, rows: [], picked: [] }));
  all.ctx.corePeriodGoalsLive_('', ''); all.ctx.corePeriodGoalsLive_('', '');
  ok(all.calls === 2, 'the whole-ledger read (no date) is not cached here — pgLedgerIntervals_ caches what it derives');
}

console.log('\n5. nothing binds the library');
{
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'appsscript.json'), 'utf8'));
  const libs = (m.dependencies && m.dependencies.libraries) || [];
  // Fails if the GXCore binding is restored (a re-pin would then be needed again for any fix).
  ok(libs.length === 0, 'appsscript.json binds no Apps Script library');
  // The scope list is what decides whether a deploy needs Sky to re-authorize in the editor. Unbinding
  // must not change it — and `spreadsheets` is still listed (see CLAUDE.md, Budgets and Expenses).
  ok(JSON.stringify(m.oauthScopes) === JSON.stringify([
    'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.scriptapp', 'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/script.send_mail']), 'the OAuth scopes are exactly what they were — no re-authorization');
  const strip = t => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const gs = fs.readdirSync(path.join(__dirname, '..')).filter(f => f.endsWith('.gs'));
  // Strings blanked first, then trailing // comments (a `// MUST match GXCore` note is prose).
  const code = f => strip(fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).replace(/'[^'\n]*'/g, "''").replace(/\/\/.*$/gm, '');
  const users = gs.filter(f => /\bGXCore\b/.test(code(f)));
  ok(users.length === 0, 'no pushed .gs file names GXCore in code (' + (users.join(', ') || 'none') + ')');
}

console.log('\n──────────────────────────────');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
