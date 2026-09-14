#!/usr/bin/env node
/* THE RECONCILE TAB SURVIVES ONE BOUNCE, SAYS WHAT A FAILURE MEANS, AND A PHONE CAN REPORT IT.
 *
 * Sky, 2026-09-13, from an iPhone: "Error loading reconcile tab, no bug option on this page". The card
 * read "Couldn't load deposits — The string did not match the expected pattern." — Safari's res.json()
 * failing on an HTML body. loadRecon was a bare fetch, so the /exec second-hop bounce that gasFetchJson
 * retries killed the tab outright. And under 768px the only bug trigger lived at the bottom of Income.
 *
 * Executes the shipped loadRecon against a fake gasFetchJson that bounces first, and the shipped
 * reconLoadErrorText_ / syncMobBugFoot_.
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

let finished = false;
process.on('exit', (code) => {
  if (finished || code !== 0) return;
  console.log('\nFAIL: this suite exited without reaching its summary — an await never settled.');
  process.exitCode = 1;
});

let pass = 0, fail = 0;
function ok(label, cond) { if (cond) { pass++; console.log('  PASS ' + label); } else { fail++; console.log('  FAIL ' + label); } }

(async () => {

console.log('\n1. loadRecon goes through the retrying fetch, with a ceiling above the server\'s 60s budget');
{
  const src = grab('loadRecon');
  ok('no bare fetch() left in loadRecon', !/\bawait fetch\(/.test(src));
  const m = /gasFetchJson\(url,\s*(\d+),\s*(\d+)\)/.exec(src);
  ok('calls gasFetchJson(url, attempts, timeout)', !!m);
  ok('more than one attempt', m && Number(m[1]) >= 2);
  ok('timeout above qbDepositsViaGXCore_\'s 60s retry budget', m && Number(m[2]) > 60000);

  // Execute it: gasFetchJson's own contract is that a bounce is retried inside it, so the loader
  // only has to hand over to it. Prove the payload lands and is cached under its range.
  const writes = [];
  const ctx = {
    reconData: null, console,
    reconRangeKey: () => '2026-09-01_2026-09-30',
    readCache: () => null,
    writeCache: (k, v) => writes.push(k),
    getProxyUrl: () => 'https://example.test/exec',
    getToken: () => 'tok',
    encodeURIComponent,
    gasFetchJson: async () => ({ ok: true, deposits: {}, unattributed: [] }),
  };
  vm.createContext(ctx);
  vm.runInContext(grab('loadRecon') + '\nthis.__get = () => reconData;', ctx);
  await ctx.loadRecon(false);
  ok('the answer becomes reconData, tagged with its range', ctx.__get() && ctx.__get()._range === '2026-09-01_2026-09-30');
  ok('and is cached', writes.includes('recon_2026-09-01_2026-09-30'));

  ctx.gasFetchJson = async () => { throw new Error('non-JSON response (1532 bytes)'); };
  await ctx.loadRecon(false);
  ok('a transport failure after retries becomes an error, tagged with the range', ctx.__get().ok === false && ctx.__get()._range);
  ok('and a failure is never cached', writes.length === 1);
}

console.log('\n2. a transport failure is explained in words; the raw message is kept, not led with');
{
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(grab('reconLoadErrorText_'), ctx);
  for (const raw of ['The string did not match the expected pattern.', 'non-JSON response (1532 bytes)',
                     'timed out after 75000ms', 'HTTP 404', 'Load failed', 'qb_deposits unreachable after 5 tries']) {
    ok('explains: ' + raw, /did not make it back/.test(ctx.reconLoadErrorText_(raw)));
  }
  ok('a real server message is left to speak for itself', ctx.reconLoadErrorText_('GX_DEPLOY_SECRET not set on this script') === '');
  const render = grab('renderReconcile');
  ok('the dev-guard hint is localhost-only', /localhost\|127\\.0\\.0\\.1[\s\S]{0,600}GX_DEV_READS/.test(render));
}

console.log('\n3. a phone can file a bug from every tab');
{
  ok('the footer exists in the markup, hidden until decided', /id="mob-bug-foot" hidden[^>]*>\s*<button class="bug-inline" onclick="openBugModal\(\)"/.test(HTML));
  ok('render() syncs it', /function render\(\) \{\s*try \{ syncMobBugFoot_\(\); \} catch/.test(HTML));
  const run = (section, signedIn) => {
    const foot = { hidden: true };
    const ctx = {
      section,
      document: { getElementById: id => id === 'mob-bug-foot' ? foot
        : id === 'bug-fab' ? { classList: { contains: c => c === 'visible' && signedIn } } : null },
    };
    vm.createContext(ctx);
    vm.runInContext(grab('syncMobBugFoot_'), ctx);
    ctx.syncMobBugFoot_();
    return foot.hidden;
  };
  for (const s of ['reconcile', 'expenses', 'inventory', 'pnl', 'revenue']) ok(`shown on ${s} when signed in`, run(s, true) === false);
  ok('not on income, which renders its own', run('income', true) === true);
  ok('not before sign-in', run('reconcile', false) === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
finished = true;
process.exitCode = fail ? 1 : 0;
})();
