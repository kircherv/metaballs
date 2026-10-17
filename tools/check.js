// tools/check.js: loads metaballs.js without a browser and checks its public surface. Node, no dependencies.
// The shader itself compiles only in a browser; this catches a broken file, a renamed export or a bad parameter table.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'metaballs.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const M = sandbox.window.Metaballs;
let fails = 0;
function check(ok, what) { console.log((ok ? 'ok   ' : 'FAIL ') + what); if (!ok) fails++; }

check(M && typeof M.create === 'function', 'window.Metaballs.create exists');
check(Array.isArray(M.MODES) && M.MODES.join() === 'final,normals,depth,steps,field', 'five X-ray modes');
for (const [name, p] of Object.entries(M.PARAMS)) {
  const ok = p.type === 'bool' ? typeof p.value === 'boolean'
    : p.min <= p.value && p.value <= p.max && p.step > 0;
  check(ok, 'parameter ' + name + ' has a sane default');
}
check(/#version 300 es/.test(M.FRAGMENT) && /void main\(\)/.test(M.FRAGMENT), 'fragment shader is GLSL ES 3.00');
check(M.create({ getContext: () => null }) === null, 'create() returns null without WebGL 2');
process.exit(fails ? 1 : 0);
