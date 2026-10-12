// ===================================================================
// Who teaches a classroom that came from Signify ID
//
// For a classroom made from a Signify ID class, Signify ID is the only
// authority on who teaches it, and it is asked rather than remembered.
//
// The classroom used to record its teachers itself: an owner (whoever opened
// it first) and co-teachers, added and never removed. So anyone taken off a
// class in ID — a teacher reassigned, or a substitute whose cover had ended —
// kept its boards, its pupils' boards and its messages indefinitely.
//
// Each person's answer comes from their own call to ID, with their own token,
// and is reused for a minute. An HTTP request refreshes it before anything is
// decided; a live classroom connection is checked against it every minute, and
// the page asks again every two minutes so a connection held open for a whole
// lesson stays current. An answer ID has not confirmed for TRUST_MS counts as
// no answer at all: a teacher seat lasts only while ID keeps saying yes.
// ===================================================================

const idclasses = require('./idclasses');

// An answer this recent is used without asking again.
const FRESH_MS = 60 * 1000;
// The oldest confirmation a teacher seat may rest on. The page refreshes every
// two minutes, so this only ever bites a connection nobody is keeping current,
// or one held through a long Signify ID outage.
const TRUST_MS = 20 * 60 * 1000;

const answers = new Map();   // email -> { ids: Set<idClassId>, at }
const inFlight = new Map();  // email -> Promise, so a page's parallel requests ask once

const key = (email) => String(email || '').trim().toLowerCase();

// Keeps what ID said this person teaches. Only a successful answer is
// recorded, so a failed call leaves the last one to age out on its own.
function record(email, classes) {
  const ids = new Set((classes || []).filter((c) => c.teaching).map((c) => String(c.idClassId)));
  answers.set(key(email), { ids, at: Date.now() });
}

function isFresh(email) {
  const a = answers.get(key(email));
  return !!a && Date.now() - a.at < FRESH_MS;
}

function ask(email, produce) {
  const k = key(email);
  if (inFlight.has(k)) return inFlight.get(k);
  const p = (async () => {
    try {
      const classes = await produce();
      record(k, classes);
      return classes;
    } catch (e) {
      // A refusal is an answer: they teach nothing now. Only an outage keeps
      // the last answer, which then ages out on its own.
      if (e && e.definitive) record(k, []);
      throw e;
    } finally {
      inFlight.delete(k);
    }
  })();
  inFlight.set(k, p);
  return p;
}

const refresh = (req, res, email) => ask(email, () => idclasses.myClasses(req, res));
const refreshWithToken = (token, email) => ask(email, () => idclasses.myClassesWithToken(token));

// Does ID currently list this person as teaching that class?
function teaches(email, idClassId, maxAgeMs = TRUST_MS) {
  const a = answers.get(key(email));
  return !!a && !!idClassId && Date.now() - a.at <= maxAgeMs && a.ids.has(String(idClassId));
}

module.exports = { FRESH_MS, TRUST_MS, record, isFresh, refresh, refreshWithToken, teaches, _answers: answers };
