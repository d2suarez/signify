// ===================================================================
// Who teaches a classroom from Signify ID is asked, not remembered.
//
//   node test/teaching.js
//
// The rule these pin down: a teacher seat lasts only while Signify ID keeps
// saying yes. A refusal from ID ends it at once; an outage does not, until
// the last answer is too old to trust.
// ===================================================================

const assert = require('assert');
const idclasses = require('../idclasses');
const teaching = require('../teaching');

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log('  pass  ' + name);
}
const as = (classes) => async () => classes;
const failing = (definitive) => async () => {
  const e = new Error(definitive ? 'Your sign-in has expired.' : 'Could not reach Signify ID.');
  if (definitive) e.definitive = true;
  throw e;
};
const refreshWith = async (produce) => {
  idclasses.myClasses = produce;
  try { await teaching.refresh({}, {}, 'sub@school.edu'); } catch { /* the rule is in what is recorded */ }
};

(async () => {
  console.log('\nWho teaches a Signify ID classroom');

  await check('someone ID lists as teaching a class teaches it', async () => {
    await refreshWith(as([{ idClassId: 'maths', teaching: true }, { idClassId: 'art', teaching: false }]));
    assert.ok(teaching.teaches('sub@school.edu', 'maths'));
  });
  await check('a class they are only a pupil in does not count', async () => {
    assert.ok(!teaching.teaches('sub@school.edu', 'art'));
  });
  await check('addresses are matched without regard to case', async () => {
    assert.ok(teaching.teaches('SUB@School.edu', 'maths'));
  });
  await check('nobody ID has not been asked about teaches anything', async () => {
    assert.ok(!teaching.teaches('stranger@school.edu', 'maths'));
  });

  await check('an outage keeps the last answer for now', async () => {
    await refreshWith(failing(false));
    assert.ok(teaching.teaches('sub@school.edu', 'maths'));
  });
  await check('but not once it is older than can be trusted', async () => {
    teaching._answers.get('sub@school.edu').at = Date.now() - teaching.TRUST_MS - 1000;
    assert.ok(!teaching.teaches('sub@school.edu', 'maths'));
  });

  await check('a fresh answer is used without asking again', async () => {
    await refreshWith(as([{ idClassId: 'maths', teaching: true }]));
    assert.ok(teaching.isFresh('sub@school.edu'));
  });
  await check('and ID taking the class away ends it on the next answer', async () => {
    await refreshWith(as([]));
    assert.ok(!teaching.teaches('sub@school.edu', 'maths'));
  });

  await check('a refusal from ID — sign-in ended — ends it at once, not in twenty minutes', async () => {
    await refreshWith(as([{ idClassId: 'maths', teaching: true }]));
    assert.ok(teaching.teaches('sub@school.edu', 'maths'));
    await refreshWith(failing(true));
    assert.ok(!teaching.teaches('sub@school.edu', 'maths'));
  });

  await check('a page’s parallel requests ask ID once', async () => {
    let calls = 0;
    idclasses.myClasses = async () => { calls += 1; await new Promise((r) => setTimeout(r, 20)); return []; };
    await Promise.all([1, 2, 3, 4, 5].map(() => teaching.refresh({}, {}, 'busy@school.edu')));
    assert.strictEqual(calls, 1);
  });

  console.log(`\n✓ ${passed} checks passed`);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
