/* The SHIPPED coreData_ helper and everything it needs, as source text, for tests that load single
 * functions into a vm context. Since roadmap [5] slice 5 every GX Core data read goes through
 * coreData_ (dutchie_proxy.gs), so a test that grabs a caller must grab the helper too — read from
 * the real file, never retyped. With no SALES_DATA_SOURCE property the helper takes the old library
 * path, which is what those tests exercise. Not a test itself (no _test suffix). */
'use strict';
const fs = require('fs');
const path = require('path');
const GS = fs.readFileSync(path.join(__dirname, '..', 'dutchie_proxy.gs'), 'utf8');

function grabFn(name) {
  const m = new RegExp('\\nfunction ' + name + '\\s*\\(').exec(GS);
  if (!m) throw new Error('could not locate ' + name + ' in dutchie_proxy.gs');
  let i = GS.indexOf('{', m.index + 1), d = 0;
  for (let j = i; j < GS.length; j++) { if (GS[j] === '{') d++; else if (GS[j] === '}' && --d === 0) return GS.slice(m.index, j + 1); }
  throw new Error('unbalanced ' + name);
}
function grabConst(name) {
  const m = new RegExp('\\nconst ' + name + '\\s*=\\s*[^;]+;').exec(GS);
  if (!m) throw new Error('no const ' + name);
  return m[0];
}

module.exports = [
  grabConst('GX_API_'), grabConst('SALES_DATA_SOURCE_PROP_'), grabConst('CORE_API_MAX_AGE_S_'),
  grabFn('salesDataSource_'), grabFn('coreData_'), grabFn('coreDataLib_'), grabFn('gxApiGet_'), grabFn('coreDataApi_'),
].join('\n');
