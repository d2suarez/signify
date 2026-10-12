# Blind spots

Written while auditing the whiteboard, atlas and times-tables apps in August
2026 and designing the central service. Grouped by whether Signify ID already
handles it, or whether it is still on you.

---

## Closed by the new design

### 1. Email used as the identity key
Both existing apps store users under their email address. School districts
recycle addresses: `jsmith@` graduates, a new `jsmith@` arrives, and the new
pupil inherits the old one's work. That is a records breach, not a bug.

**Handled.** Google's immutable `sub` is the anchor. An unfamiliar subject
arriving on a taken address is refused and audited; an administrator releases
the address, which archives the old record rather than handing it over.

### 2. `SESSION_SECRET` defaults to a fresh random value at boot
Live in both apps today. Every deploy signs everyone out, and with more than
one replica sessions break unpredictably.

**Handled.** Signing keys live in the database; `COOKIE_SECRET` is a hard
startup requirement in any hosted environment.

### 3. Self-contained tokens cannot be revoked
Blocking a pupil in the whiteboard leaves their session working for up to
twelve hours.

**Handled.** Sessions are rows. Blocking revokes every device in every app at
once; ten-minute access tokens are re-checked against the session on use.

### 4. Roles are global rather than per-school
`store.users[email].role` is one role for the whole world, and "school" is
inferred from the email domain — which breaks on districts with several
domains and on teachers using personal addresses.

**Handled.** Role is a property of a membership. Domains map to tenants
explicitly, and a domain can require Google's `hd` claim.

### 5. Anyone reaching a school domain becomes what that domain grants
Domain-based auto-approval will eventually admit somebody who should not be
there.

**Handled.** Auto-join can never grant an administrative role, `hd` is required
by default, and a domain with no auto-role leaves accounts pending.

### 6. Privilege escalation through custom roles
Nothing stopped a role editor from granting more than the editor holds.

**Handled.** `rbac.canGrant` refuses any permission the actor does not hold at
that scope or wider; administrative roles are super-admin only. Tested.

### 7. No cross-app revocation or deletion
Deleting a person from one app left them in the others.

**Handled.** One erase, one block, one audit trail.

### 8. No record of who authorized any of this
The COPPA school-consent exception assumes a school actually consented.
Nothing recorded that.

**Handled.** `consents` plus a red console alert for any school without one.

### 9. Retention was indefinite
Required by the amended COPPA Rule, and nothing implemented it.

**Handled.** Hourly sweep, per-school override, dormant accounts queued with a
grace period, purges audited as disclosure events.

### 10. One super admin
Lose that Google account and nothing can be administered ever again.

**Handled.** The console refuses to drop below two, and warns at one.

---

## Still open — decisions or work for you

### 11. Directory information on public leaderboards
The Times Tables leaderboard shows pupil names to anyone who loads the page.
Districts commonly let parents opt out of directory disclosures. Needs
class-scoping, a `directory_opt_out` flag, and first-name-plus-initial by
default. **This is the highest-risk item in the fleet.**

### 12. Shared classroom devices
The real failure mode for primary-age pupils. Signify ID shortens idle
timeouts for minors to twenty minutes and disables Google's auto-select, but
three things remain per-app:

- A visible **switch user** control, not buried in a menu.
- Service workers cache the previous pupil's data. Every PWA in the fleet
  (whiteboard, atlas, times tables) must clear its caches on sign-out and
  partition cached responses by user id.
- Consider a kiosk mode that signs out on tab close.

### 13. No step-up authentication for administrators
A super admin can read and change every record in every school, protected by
whatever the Google account is protected by. Require enforced 2SV on those
accounts — and ideally add a re-authentication prompt before bulk erasure.

### 14. The identity service is now a single point of failure
Every app goes down with it. The client library caches JWKS and falls back to
its stale copy, so already-issued tokens keep verifying through a brief
outage. Sign-ins still fail. Decide whether any app needs a read-only
degraded mode.

### 15. Centralisation makes cross-app profiling easy
Exactly what the amended COPPA Rule and state laws are wary of. Per-app claim
filtering is the technical guard; the discipline is not to build a
cross-app analytics view later because it would be easy.

### 16. Backups contain pupil data
Railway Postgres backups are encrypted, but their retention window has to be
set and stated, or "erased within 30 days" is not true. Related: the pending
off-site backup work is now higher-stakes, because it would put pupil records
in a second location that needs its own entry in the data map.

### 17. Two OAuth client secrets are committed
`classroom-whiteboard/MYFOLDER/client_secret_*.json`, in the local git history.
No remote, so exposure is limited — and they are unused today because the apps
use Google's implicit ID-token flow. Under authorization-code flow a client
secret becomes live. **Rotate before switching, and delete the files.**

### 18. Roster rollover at the end of the school year
Pupils advance a year, leave, or arrive. **Half solved:** memberships now carry
a `graduation_year`, which is stable across years and makes the year group
derivable rather than something to rewrite every August, and classes can be
archived rather than deleted. Still unwritten: the job that actually runs the
rollover, and the rule for what happens to leavers.

### 19. Teacher "view as pupil"
Genuinely useful for support and a genuine hazard. If built: read-only, always
audited as a disclosure, and visibly indicated on screen.

### 20. Guardian accounts are modelled but not reachable
`guardian_links` exists with verification fields, and the guardian role can
export their own children's records — but there is no verification UI and no
guardian-facing view. FERPA gives parents these rights whether or not the
software is ready.

### 21. Application logs are a disclosure surface
Signify ID's own logging was audited and now carries no pupil data: the one
path that did — the audit-write failure handler — logs field names rather than
values. The same pass has **not** been done on the whiteboard, atlas or
times-tables apps, and Railway retains their stdout. Worth doing before real
pupils are on any of them.

### 22. Test and demo data
`test/dev-server.js` seeds invented names. Keep it that way — never seed with
a real class list.
