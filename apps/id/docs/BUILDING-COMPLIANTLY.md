# Building against the policy

The privacy policy at `/privacy-policy` is not a document that sits beside the
code — it is generated from it. This is how to keep that true.

## The one rule

**If you add a column, you classify it.** `npm test` walks
`information_schema` and fails on any column not described in
`src/data-inventory.js`. There is no way to ship a new field without saying, in
language a parent could read, what it holds and who can see it.

That check runs in both directions: it also fails if the inventory describes a
column that no longer exists, so the policy cannot overstate what is collected.

## Adding a field

1. Write the migration.
2. Add the column to `src/data-inventory.js`:
   ```js
   nickname: {
     personal: true,
     category: 'identity',            // identity | school | technical | credential | operational
     purpose: 'A short name a pupil chooses to be shown to classmates.',
     exposed: 'staff',                // self | staff | admin | apps | nobody
   },
   ```
3. `npm test`. The published policy now lists it automatically.

Write `purpose` for a parent, not a developer. It appears verbatim on the
public page. "FK to users" will fail the test; it is not an explanation.

## Adding an app

Before it touches real pupils:

- [ ] Added to `COVERED` in `src/policy.js`, with a one-line description.
- [ ] Given its own permission namespace, so it receives only its own claims.
      Never widen an existing app's namespace to cover a new one.
- [ ] Enabled per school in **Applications → Schools**. Default is off.
- [ ] Stores `req.user.id` as the owner of anything it saves — **never the
      email address**. Emails get recycled between pupils; ids do not.
- [ ] Has its own export and erase path for the work it stores. Signify ID can
      produce the identity record; only the app can produce its own content.
- [ ] Logs no pupil email addresses to stdout. Railway retains that output.
- [ ] If it is a PWA: clears its caches on sign-out, and partitions cached
      responses by user id. Shared classroom devices are the normal case.

A game or tool that signs nobody in and stores nothing about a school belongs
in `NOT_COVERED` instead. Do not put it behind school sign-in — that adds a
consent surface and an approval conversation for no benefit.

## Changing what is collected

Anything that changes the *shape* of what is collected — a new category of
data, a new third party, a longer retention period — needs the policy version
bumped in `src/policy.js`.

Bumping it matters: every school authorisation is recorded against the version
in force when it was signed, so a school is never treated as having agreed to
something it never saw. Raising the version surfaces the older authorisations
for review.

## The three things that change your legal footing

`src/policy.js` sets `POSTURE`. Today it is `school-staff`: run by staff, for
students 13 and over, which means COPPA is not engaged and no legal entity is
needed. Any of these moves you off that footing, and each is a decision rather
than a code change:

- **A student under 13 gets an account.** The console raises a red alert if a
  school is configured that way while the policy says otherwise.
- **Another school starts using the apps.** That makes this a service.
- **A new third party touches the data.** Today: Google and Railway, nobody else.

## Things that require a decision, not a commit

These change the legal position and must not be done quietly:

- **Adding a third party of any kind** — analytics, error tracking, a CDN, a
  font host, a support widget. Each becomes a subprocessor that a district
  will ask about, and each has to be added to the policy and disclosed. The
  current answer is "Google and Railway, nobody else," and that is a
  meaningful thing to be able to say.
- **Collecting anything from a child directly** — age, birthday, photograph,
  location, anything typed into a free-text field that could hold personal
  information. Today the school supplies everything and the child supplies
  nothing.
- **Joining data across apps** — the per-app claim filtering exists precisely
  to prevent a cross-app picture of a child. A dashboard that combines them
  would be easy to build and is exactly what the amended COPPA Rule and
  several state laws are wary of.
- **Any use of pupil data to train or evaluate a model.**

## What the tests actually guarantee

They check that the *description* matches the *schema*. They cannot check that
an app behaves the way the policy says. Those claims — no advertising, no
profiling, no sale, no cross-app joining — are kept true by review, not by a
test, and that is worth being honest about.
