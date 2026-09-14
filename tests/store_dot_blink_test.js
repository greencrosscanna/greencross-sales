#!/usr/bin/env node
/* THE STORE DOT BLINKS WHEN ITS NUMBER IS NOT CURRENT — AND ONLY THEN.
 *
 * Sky, 2026-09-13: "On mobile let's have the bullet next to the store name blink if it's loading so I
 * can tell if what I'm looking at is loaded/current or not." A re-poll keeps each row's last figure on
 * screen while it re-asks, so "being refreshed" and "just refreshed" looked identical.
 *
 * Executes the shipped storeNotCurrent_ / viewIncludesToday_ / syncBdStale_ / _bdSwatchAttrs_.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function grab(name) {
  const re = new RegExp('\\n\\s*(?:async\\s+)?function ' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const m = re.exec(HTML);
  if (!m) throw new Error('could not locate ' + name + ' in index.html — renamed or removed?');
  let i = HTML.indexOf('{', m.index + m[0].indexOf('(')), depth = 0, j = i;
  for (; j < HTML.length; j++) {
    if (HTML[j] === '{') depth++;
    else if (HTML[j] === '}') { depth--; if (!depth) break; }
  }
  return HTML.slice(m.index, j + 1);
}

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { pass++; console.log('  PASS ' + label); } else { fail++; console.log('  FAIL ' + label); } }

const TODAY = '2026-09-13';
function ctxFor({ state = {}, todayPending = [], range = { from: '2026-09-01', to: TODAY } } = {}) {
  const ctx = {
    _storeStateMap: state,
    _todayPending: new Set(todayPending),
    laDay: () => TODAY,
    periodRange: () => ({ from: range.from, to: range.to }),
    toDateStr: d => d,                 // the fake range is already text
    performance: { now: () => 12345 },
    escHtml: s => String(s).replace(/"/g, '&quot;'),
    BD_BLINK_MS: 1200,
  };
  vm.createContext(ctx);
  vm.runInContext(['viewIncludesToday_', 'storeNotCurrent_', '_bdBlinkDelay_', '_bdSwatchAttrs_', 'syncBdStale_']
    .map(grab).join('\n'), ctx);
  return ctx;
}

console.log('\n1. which stores blink');
{
  const c = ctxFor({ state: { Bend: 'loading', Center: 'ok', River: 'err', Hillsboro: 'ok' }, todayPending: ['Hillsboro'] });
  ok('a store whose request is in flight', c.storeNotCurrent_('Bend') === true);
  ok('a store whose last request failed', c.storeNotCurrent_('River') === true);
  ok('a store whose month landed but today did not, in a view that includes today', c.storeNotCurrent_('Hillsboro') === true);
  ok('not a store that landed completely', c.storeNotCurrent_('Center') === false);
  ok('not a store no load has asked about yet', c.storeNotCurrent_('Commercial') === false);
}

console.log('\n2. today-pending only counts when today is on screen');
{
  const aug = ctxFor({ state: { Center: 'ok' }, todayPending: ['Center'], range: { from: '2026-08-01', to: '2026-08-31' } });
  ok('an August view does not blink a store for a September miss', aug.storeNotCurrent_('Center') === false);
  const day = ctxFor({ state: { Center: 'ok' }, todayPending: ['Center'], range: { from: TODAY, to: TODAY } });
  ok('a today view does', day.storeNotCurrent_('Center') === true);
  const ytd = ctxFor({ state: { Center: 'ok' }, todayPending: ['Center'], range: { from: '2026-01-01', to: TODAY } });
  ok('so does YTD, which ends today', ytd.storeNotCurrent_('Center') === true);
}

console.log('\n3. the markup');
{
  const c = ctxFor({ state: { Bend: 'loading', Center: 'ok' } });
  const on = c._bdSwatchAttrs_('Bend', '#22D3EE'), off = c._bdSwatchAttrs_('Center', '#aaa');
  ok('a not-current dot carries bd-stale', /class="swatch bd-stale"/.test(on));
  ok('a current one does not', /class="swatch"/.test(off) && !/bd-stale/.test(off));
  ok('the blink resumes at the shared phase instead of restarting', /animation-delay:-345ms/.test(on));
  ok('both carry the store so they can be toggled in place', /data-bd-store="Bend"/.test(on) && /data-bd-store="Center"/.test(off));
  ok('the color survives', /background:#22D3EE/.test(on));
  for (const fn of ['_incomeBreakdownMobHtml', '_incomeBreakdownDskHtml']) {
    ok(fn + ' builds its dot through _bdSwatchAttrs_', /<div \$\{_bdSwatchAttrs_\(s, col\)\}><\/div>/.test(grab(fn)));
  }
  ok('the CSS blinks it', /\.swatch\.bd-stale\{animation:bdBlink/.test(HTML));
  ok('and reduced motion still shows the state', /prefers-reduced-motion:reduce\)\{\.swatch\.bd-stale\{animation:none;opacity:\.35\}/.test(HTML));
}

console.log('\n4. a load that has not painted anything yet still blinks the dots already on screen');
{
  const mk = (store, cls) => {
    const set = new Set(cls ? [cls] : []);
    return { store, style: {}, getAttribute: () => store,
      classList: { contains: c => set.has(c), toggle: (c, on) => on ? set.add(c) : set.delete(c) }, set };
  };
  const els = [mk('Bend', ''), mk('Center', 'bd-stale')];
  const c = ctxFor({ state: { Bend: 'loading', Center: 'ok' } });
  c.document = { querySelectorAll: () => els };
  c.syncBdStale_();
  ok('Bend starts blinking', els[0].set.has('bd-stale') && els[0].style.animationDelay === '-345ms');
  ok('Center stops', !els[1].set.has('bd-stale') && els[1].style.animationDelay === '');
  ok('buildStatusGrid — called at the START of every load — runs it',
     /function buildStatusGrid\(state\) \{\s*_storeStateMap = state;\s*try \{ syncBdStale_\(\); \} catch/.test(HTML));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
