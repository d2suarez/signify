// ===================================================================
// Signify ID — the privacy policy
//
// Single source of truth. The page at /privacy-policy is rendered from here,
// and its "what we collect" section is generated from src/data-inventory.js
// rather than written by hand, so it cannot describe something the database
// does not hold or miss something it does.
//
// ---------------------------------------------------------------
// POSTURE — this is the thing to get right before anything else.
//
// The obligations depend entirely on who runs this and for whom:
//
//   'school-staff'  Run by a member of staff for their own school, for
//                   students aged 13 and over. COPPA is not engaged at all —
//                   it governs personal information collected from children
//                   UNDER 13. No legal entity, postal address or designated
//                   security coordinator is required, because those are
//                   COPPA obligations.
//
//   'vendor'        Offered to schools you do not work at. Now you are an
//                   operator in your own right: a legal entity, a published
//                   address, a named security coordinator and a written
//                   security programme all become necessary, and COPPA
//                   applies the moment a school enrols a pupil under 13.
//
// Changing POSTURE changes what the policy says and what the console
// insists on. Do not switch it to 'vendor' without reading
// docs/COMPLIANCE.md, which lists what comes with it.
// ---------------------------------------------------------------
// ===================================================================

// 2026-09-15: people asking for an account now answer questions about
// themselves, so what is collected changed.
// 2026-09-28: Cloudflare added as a third company, holding encrypted backups
// of every app. The policy's own rule is that a new company means a new
// version and telling the school first.
// 2026-09-29: substitute cover is recorded — who covered which classes, and
// on which days — and what is collected is listed accordingly.
// 2026-10-29: once a school confirms a parent's link to a student, the apps
// that parent signs in to are told which children and classes, so the parent
// can see that child's work.
// 2026-10-30: a school may keep its official record of each name (from its
// own records, entered by hand or uploaded), and every name change is kept.
const VERSION = '2026-10-30';
const EFFECTIVE = '30 October 2026';

const POSTURE = process.env.POLICY_POSTURE || 'school-staff';

// FERPA binds schools that take federal funding, and a private school that
// takes none is not covered by it. Following its standards anyway is a choice
// rather than an obligation — and the policy says exactly that, because
// claiming to "be FERPA compliant" when the law does not apply is a category
// error a district would notice.
const FOLLOWS_FERPA_VOLUNTARILY = process.env.POLICY_FERPA !== '0';

// Accounts are for students of at least this age. Stated in the policy, and
// checked against what each school has actually been configured as — a school
// marked as having younger pupils contradicts this, and the console says so.
const MINIMUM_AGE = Number(process.env.POLICY_MINIMUM_AGE || 13);

const OPERATOR = {
  // Who is responsible. An individual is a perfectly good data controller;
  // no company is required.
  name: process.env.POLICY_OPERATOR_NAME || '[YOUR NAME]',
  role: process.env.POLICY_OPERATOR_ROLE || '[YOUR ROLE]',

  // Deliberately NOT published. The school the apps are used at carries no
  // responsibility for them, so naming it in a policy it did not write would
  // imply one it has not accepted.
  //
  // Optional. Left blank, the policy routes requests through the school,
  // whose administrators genuinely hold the export and erase controls — so a
  // parent still has a real route without a personal address being published.
  contactEmail: process.env.POLICY_CONTACT_EMAIL || '',

  // Only meaningful once you are a vendor. Left blank otherwise, and the
  // policy simply does not mention them.
  legalName: process.env.POLICY_LEGAL_NAME || '',
  address: process.env.POLICY_ADDRESS || '',
  securityCoordinator: process.env.POLICY_SECURITY_COORDINATOR || '',
  jurisdiction: process.env.POLICY_JURISDICTION || '',
};

const isPlaceholder = (v) => /^\[.*\]$/.test(String(v || ''));

// What genuinely has to be filled in for THIS posture. A school-staff
// deployment needs a person to contact and nothing more; demanding a legal
// entity there would be inventing an obligation.
function required() {
  if (POSTURE === 'vendor') {
    return ['legalName', 'address', 'contactEmail', 'securityCoordinator', 'jurisdiction'];
  }
  // A name and what they do. Nothing else is genuinely needed on this footing.
  return ['name', 'role'];
}

function unfilled() {
  return required().filter((k) => !OPERATOR[k] || isPlaceholder(OPERATOR[k]));
}

// ---------- scope ----------

const COVERED = [
  { name: 'Signify ID', what: 'Sign-in, roles and class lists shared by everything below.' },
  { name: 'Classroom Whiteboard', what: 'A shared board teachers and students draw and write on together.' },
  { name: 'Classroom Atlas', what: 'An interactive teaching map, with assignments and coordinates quizzes.' },
  { name: "Teacher's Desk", what: 'Timers, notes, a behaviour tally and a group maker for the classroom.' },
];

// Written by the same author but NOT connected to this sign-in, so this
// policy does not describe them and must not pretend to.
//
// Times Tables Trainer is the one that matters. It is built for third
// graders — well under 13 — so connecting it would put children under 13
// into this system and bring COPPA with them. That is a decision, not a
// migration step, and the note below says so on the page itself.
const NOT_YET_CONNECTED = [
  {
    name: 'Times Tables Trainer',
    what: 'Multiplication practice. Has no sign-in at all — a student types a first name for the class leaderboard and nothing else is kept.',
    note: 'Built for third graders. Connecting it to this sign-in would mean children under 13 having accounts, which changes what law applies.',
  },
  { name: 'Lectern', what: 'A classroom Bible reader. No sign-in.' },
  { name: 'Help desk', what: 'Reporting school IT issues. Has its own separate sign-in.' },
  { name: 'Encounter curriculum', what: 'Curriculum materials. Has its own separate sign-in.' },
];

const NOT_COVERED = [
  { name: 'Oust!', what: 'An online card game. Players type a display name to join; nothing is kept after the game ends and there is no sign-in.' },
  { name: 'Photo Composition Studio', what: 'A photography practice tool that runs entirely in the browser.' },
  { name: 'Red Panda Run', what: 'A browser game that runs entirely on the player\u2019s device.' },
];

module.exports = {
  VERSION, EFFECTIVE, POSTURE, MINIMUM_AGE, OPERATOR,
  FOLLOWS_FERPA_VOLUNTARILY,
  COVERED, NOT_YET_CONNECTED, NOT_COVERED, isPlaceholder, required, unfilled,
};
