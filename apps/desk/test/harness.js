// A test harness small enough to read in one go. No dependencies: the point
// of `npm test` here is that it runs on a fresh clone with nothing installed
// beyond what the server itself needs.

'use strict';

let passed = 0;
const failures = [];
let group = '';

function describe(name, fn) {
  group = name;
  fn();
  group = '';
}

// A test that returns a promise is queued rather than counted on the spot.
// Without this an async `it` was recorded as passing the moment it started —
// the assertions inside it ran after report() had already exited the process,
// so a broken one looked green. Anything that awaits must be waited for.
const pending = [];

function it(name, fn) {
  const label = group ? `${group} — ${name}` : name;
  let result;
  try {
    result = fn();
  } catch (e) {
    failures.push({ label, error: e });
    return;
  }
  if (result && typeof result.then === 'function') {
    pending.push(result.then(() => { passed += 1; }, (e) => { failures.push({ label, error: e }); }));
    return;
  }
  passed += 1;
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'expected the condition to hold');
  passed += 0;
}

function equal(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message || 'not equal'}\n    expected: ${b}\n    actual:   ${a}`);
}

function throws(fn, message) {
  try { fn(); } catch { return; }
  throw new Error(message || 'expected it to throw');
}

async function report() {
  await Promise.all(pending);
  for (const f of failures) {
    console.error(`\n  ✗ ${f.label}\n    ${f.error.message}`);
  }
  const total = passed + failures.length;
  console.log(`\n${failures.length ? '✗' : '✓'} ${passed}/${total} checks passed`);
  process.exit(failures.length ? 1 : 0);
}

module.exports = { describe, it, assert, equal, throws, report };
