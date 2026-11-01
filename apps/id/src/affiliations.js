// ===================================================================
// Signify ID — what a school belongs to
//
// Some things an app offers depend on a body the school is part of, not on
// the school's own choice: the NAD's (North American Division, Seventh-day
// Adventist) standards in Signify Learning are for NAD schools only. So the
// affiliation is a fact a platform admin records, never something a school
// admin can set for their own school.
//
// Stored as a list of keys in tenants.settings.affiliations and handed to
// apps on every token as `tenant_affiliations`, so an app checks the school
// it is looking at without asking ID again. Unknown keys are dropped.
// ===================================================================

const KNOWN = {
  nad: 'NAD school (North American Division, Seventh-day Adventist)',
};

/** The known affiliation keys in a list (or anything else), in KNOWN's order. */
function clean(value) {
  const want = new Set(Array.isArray(value) ? value.map((v) => String(v).trim().toLowerCase()) : []);
  return Object.keys(KNOWN).filter((k) => want.has(k));
}

/** A school's affiliations from its settings. */
function of(settings) {
  return clean(settings && settings.affiliations);
}

module.exports = { KNOWN, clean, of };
