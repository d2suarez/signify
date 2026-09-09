# Legal posture

Written for the Signify apps as they stand in August 2026. This is an
engineering document, **not legal advice**.

---

## 0. Which footing you are on

This is the question everything else hangs off, and it is set in
`src/policy.js` as `POSTURE`.

### `school-staff` — where you are today

Built and run by a member of staff, for their own school, for students **13
and over**.

**COPPA does not apply.** It governs personal information collected from
children *under 13*. With no under-13 users, it is simply not engaged — there
is nothing to comply with, and nothing to disclose about it. That means **no
legal entity, no published postal address, and no designated security
coordinator**, because all three are COPPA obligations.

**FERPA probably does not apply either.** It binds schools that receive
federal funding; most private K-12 schools do not. That is the school's
determination rather than yours — worth asking, but not a blocker.

What you still owe, as a matter of decency rather than statute, and what the
software already does:

- Say plainly what is collected and why — the published policy, generated
  from the schema.
- Let anyone see, correct or delete what is held about them — one click each.
- Collect the least you can, and nothing directly from a student.
- Keep it secure, and say so honestly.
- Delete it when it stops being needed.

### `vendor` — if you sell to other schools

The moment these apps are offered to a school you do not work at, you become
an operator in your own right. Then everything in the sections below applies:
a legal entity, a published address, a named security coordinator, a written
security programme, DPAs, and COPPA in full as soon as any school enrols a
student under 13.

Switch `POSTURE` to `vendor` and the console starts insisting on all of it.

### What moves you from one to the other

Any of these, and the footing changes:

- A student **under 13** given an account.
- Another **school** using the apps.
- Any **new third party** touching the data.

The console watches the first of those: a school configured as having under-13
pupils while the policy states 13+ raises a red alert, because that
contradiction is exactly what decides whether children's privacy law applies.

---

## 1. If and when you become a vendor

*Everything from here assumes the `vendor` footing. None of it is required
while you are running these apps as school staff for students 13 and over.*

### COPPA — children under 13

Signify ID collects personal information from children under 13, so COPPA
applies. The basis being relied on is the **school-consent exception**: a
school may consent on parents' behalf, but only where all of the following
hold. Each row names what enforces it.

| Condition | How it is met |
|---|---|
| Use is strictly educational | Purpose limitation is written into the tenant authorization record and the privacy notice. No advertising, profiling or sale exists anywhere in the codebase. |
| The school, not the vendor, authorizes | `consents` table, `kind = 'school_authorization'`, recorded on the Compliance page with signer name, role, email, method and date. The console raises a red alert for any active school without one. |
| The school is given full notice of what is collected | The authorization record embeds the exact data categories at the moment of signing, alongside the policy version. `/privacy` is the plain-language version. |
| The school can review and delete | **People → Record** exports everything held about one person. **Manage → Erase record** soft-deletes with a 30-day grace period, then purges. |
| Data is not retained indefinitely | `RETENTION_DAYS` (default 400) per platform, overridable per school. The hourly sweep queues dormant accounts and purges expired ones. |

### The 2025 COPPA amendments — compliance date has passed

The amended Rule's compliance date was **21 April 2026**. Three obligations
land squarely on this project:

1. **A written, publicly posted retention policy** stating that data is not
   kept indefinitely and what the limit is. `/privacy` states the limit and the
   console shows the effective figure per school. **Still needed:** the
   policy as a published document at a stable URL.
2. **A written information security programme** with a designated coordinator,
   annual risk assessments, and due diligence on service providers. **Not yet
   written.** See the checklist in §5.
3. **Separate verifiable consent for third-party disclosure.** Not applicable
   today — nothing is disclosed to third parties beyond the infrastructure
   providers in §3 — and it must stay that way, or this changes.

### Google accounts and under-13 pupils

Google's own terms require an under-13 pupil to hold a Workspace for Education
or Family Link account, not a personal one. Signify ID enforces this
structurally: a domain may require the Google Workspace `hd` claim
(`require_hd`, on by default), and a personal account merely *looking* like a
school address is refused. Personal `@gmail.com` addresses can only reach the
system if a school domain is deliberately configured without `hd` required.

**Keep `require_hd` on for any domain pupils sign in with.**

### FERPA — education records

Signify ID acts as a **school official with a legitimate educational interest**
under 34 CFR 99.31(a)(1)(i)(B). That requires the school to retain direct
control, the vendor to use records only for the authorized purpose, and no
redisclosure without authorization.

| Right | Where it lives |
|---|---|
| Inspect and review (§99.10) | **People → Record** produces the complete record as JSON, in one call. |
| Request amendment (§99.20) | **People → Manage** edits role, year group and status; every change is audited. |
| Record of disclosures (§99.32) | `audit_log.is_disclosure`. Set on record exports, roster reads by staff, erasures and purges, and on every token issued for a minor. Never trimmed. |
| Directory information | See §4 — this is the live gap. |

---

## 2. What is collected

Everything, exhaustively. This table is the data map; keep it in step with
`migrations/`.

| Data | Why | Source |
|---|---|---|
| Name, given/family name | Showing who is who | Google |
| School email address | Identifier for roster matching | Google |
| Profile picture URL | Recognising an account | Google |
| Google `sub` | The stable identity anchor | Google |
| Google `hd` | Confirming a genuine school account | Google |
| Internal uuid | Primary key everywhere | Generated |
| Role, school, year group, class membership | Deciding what someone may do | School |
| Minor flag | Session length and handling | School assertion |
| Account created / last seen | Retention | Derived |
| Sign-in time, IP, browser, app opened | Security and the disclosure record | Request |
| Administrative actions | Audit | Derived |

**Not collected:** home address, phone number, date of birth, government
identifiers, precise location, biometrics, behavioural or advertising data.

---

## 3. Third parties

Every one of these is a subprocessor and belongs in a district DPA.

| Party | Role | Sees |
|---|---|---|
| Google LLC | Identity provider | Sign-in events; already the school's own provider |
| Railway | Hosting and Postgres | All data at rest, encrypted backups |

**No analytics, no error-tracking service, no CDN.** Adding one is a
disclosure decision, not a technical one. If an error tracker is ever added,
student emails must be scrubbed before they reach it.

---

## 4. The live gap: directory information

The Times Tables leaderboard currently publishes pupil names to anyone who
loads the page. Under FERPA that is a disclosure of directory information, and
districts commonly let parents opt out of directory disclosures entirely.

**Required before that app goes near a real class:**

- Scope every leaderboard to a class, never globally or publicly.
- Add a per-pupil `directory_opt_out` flag, honoured everywhere a name is shown
  to anyone but the pupil and their teacher.
- Default to first name plus last initial.

---

## 5. Outstanding obligations

Things the software cannot do for you.

- [ ] **Designate a security coordinator** by name. Required by the amended
      COPPA Rule.
- [ ] **Write the information security programme** — risk assessment, controls,
      annual review, vendor due diligence.
- [ ] **Publish the retention policy** at a stable public URL.
- [ ] **Write the DPA / school-official addendum** the school signs, naming the
      subprocessors in §3.
- [ ] **Confirm the school's annual FERPA notification** lists these apps as
      school officials.
- [ ] **Check state law.** If any pupil is in New York, Illinois or California,
      NY Ed Law 2-d (Parents' Bill of Rights, specific security plan), IL SOPPA
      (contracts, 30-day breach notice) or CA SOPIPA add requirements beyond
      the federal floor.
- [ ] **Write the incident response plan.** FERPA has no notification mandate;
      state law and most DPAs do.
- [ ] **Set the backup retention window** on Railway Postgres and state it, so
      "deleted within 30 days including backups" is true rather than aspirational.
- [ ] **Require two-step verification** on every super admin's Google account.

---

## 6. Answering a parent

> *"What do you hold about my child, and can you delete it?"*

1. **People**, search the pupil, **Record**. Enter the reason; the download is
   logged as a disclosure automatically.
2. That covers identity, roles, classes, guardians, sessions and the full
   activity history. Work produced inside each app is exported from that app.
3. To erase: **Manage → Erase record**. Recoverable for 30 days, then purged,
   and gone from backups within 30 days after that.
