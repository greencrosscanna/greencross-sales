/* Test helpers for GX Core's live data routes (roadmap [5] slice 7). Not a test (no _test suffix).
 *
 * coreRoutesFrom(lib, log) — a stand-in for GX Core's /exec, answering each route the way
 * gx_core.gs's doGet does, from a library-shaped fixture { getStores, getPeriodGoals, getVelocity,
 * getSalesDaily }, so tests written against the old library keep their fixtures. A fixture function
 * that throws stands for a route Core could not answer (the real transport throws after its retries).
 * Returns { gxCoreData_, gxCoreDataAll_ } to put in a vm context. `log` (optional) records each route.
 *
 * memCache() — an in-memory script cache { cacheGet_, cacheSet_, map }. */
'use strict';

function coreRoutesFrom(lib, log) {
  const answer = function (action, b) {
    if (log) log.push(action);
    if (action === 'stores') return { ok: true, stores: lib.getStores() };
    if (action === 'period_goals') return lib.getPeriodGoals(b.store || '', b.date || '');
    if (action === 'velocity_rows') return { ok: true, store: b.store, rows: lib.getVelocity(b.store) };
    if (action === 'sales_rows') return { ok: true, rows: lib.getSalesDaily(b.store, b.from, b.to) };
    throw new Error('test stub: no route ' + action);
  };
  return {
    gxCoreData_: function (action, body) {
      const a = answer(action, body || {});
      if (a && a.ok === false) throw new Error('GX Core ' + action + ': ' + (a.error || 'refused'));
      return a;
    },
    gxCoreDataAll_: function (action, bodies) {
      return bodies.map(function (b) {
        try { const a = answer(action, b); return a && a.ok === false ? { ok: false, error: a.error || 'refused' } : { ok: true, data: a }; }
        catch (e) { return { ok: false, error: e.message }; }
      });
    },
  };
}

function memCache() {
  const m = new Map();
  return { cacheGet_: k => (m.has(k) ? m.get(k) : null), cacheSet_: (k, v) => { m.set(k, String(v)); }, map: m };
}

/* Everything a vm context needs to run the shipped coreData_ against a library-shaped fixture:
 * the two transports, a fresh cache, a silent probeMark_ and errText_. Spread it into the context. */
function routesWorld(lib, log) {
  const c = memCache();
  return Object.assign({ cacheGet_: c.cacheGet_, cacheSet_: c.cacheSet_, probeMark_: () => {},
                         errText_: e => (e && e.message) || String(e) }, coreRoutesFrom(lib, log));
}

module.exports = { coreRoutesFrom, memCache, routesWorld };
