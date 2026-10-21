// ===================================================================
// Signify ID — data inventory
//
// Every column in the database, classified. This is the source of truth the
// privacy policy is written from, and it is enforced: a test walks
// information_schema and fails if a column exists that is not listed here.
//
// That is the whole point. A privacy policy drifts from reality the moment
// somebody adds a column and forgets the document. Here, adding a column
// breaks the build until somebody has said what it holds, why, and who sees
// it — which is a decision worth being forced to make deliberately.
//
// Fields:
//   personal  is this information about an identifiable person?
//   category  identity | school | technical | credential | operational
//   purpose   why it exists, in language a parent could read
//   exposed   who can see it: 'self' | 'staff' | 'admin' | 'apps' | 'nobody'
// ===================================================================

const N = (purpose) => ({ personal: false, category: 'operational', purpose, exposed: 'admin' });

const INVENTORY = {
  // ---------- people ----------
  users: {
    id:           { personal: true, category: 'identity', purpose: 'The permanent internal reference for a person. Used instead of their email so a recycled school address never inherits someone else’s records.', exposed: 'apps' },
    email:        { personal: true, category: 'identity', purpose: 'School email address. How a person is matched to a roster and how they sign in.', exposed: 'staff' },
    display_name: { personal: true, category: 'identity', purpose: 'The name shown to a person\u2019s teachers and classmates.', exposed: 'staff' },
    given_name:   { personal: true, category: 'identity', purpose: 'A person\u2019s first name, as Google or the school roster provides it.', exposed: 'staff' },
    family_name:  { personal: true, category: 'identity', purpose: 'A person\u2019s last name, as Google or the school roster provides it.', exposed: 'staff' },
    picture_url:  { personal: true, category: 'identity', purpose: 'Link to the Google profile picture, so an account is recognisable. The image itself is served by Google, not stored here.', exposed: 'staff' },
    status:       { personal: true, category: 'school', purpose: 'Whether a person\u2019s account is active, awaiting approval, suspended or blocked.', exposed: 'admin' },
    is_minor:     { personal: true, category: 'school', purpose: 'A retired setting, kept only so older records still read correctly. Every account is for someone aged 13 or over, so it is no longer used.', exposed: 'apps' },
    minor_source: { personal: true, category: 'school', purpose: 'How that retired setting was originally decided. No longer used.', exposed: 'admin' },
    created_at:   { personal: true, category: 'technical', purpose: 'The date a person\u2019s account was created.', exposed: 'admin' },
    last_seen_at: { personal: true, category: 'technical', purpose: 'The date a person last used their account. This is what triggers deletion of records nobody is using.', exposed: 'admin' },
    deleted_at:   { personal: true, category: 'technical', purpose: 'The date a person\u2019s record was marked for erasure.', exposed: 'admin' },
    purge_after:  { personal: true, category: 'technical', purpose: 'The date a person\u2019s record is permanently destroyed.', exposed: 'admin' },
  },

  identities: {
    id:            N('Internal reference for one sign-in method.'),
    user_id:       { personal: true, category: 'identity', purpose: 'Which person a sign-in method belongs to.', exposed: 'admin' },
    provider:      { personal: true, category: 'identity', purpose: 'Which sign-in service a person uses. Google is the only one today.', exposed: 'admin' },
    subject:       { personal: true, category: 'identity', purpose: 'Google’s own permanent identifier for the account. This, not the email address, is what identifies a person.', exposed: 'nobody' },
    email_at_link: { personal: true, category: 'identity', purpose: 'The email address the account had when it was last used, so a change of address can be traced.', exposed: 'admin' },
    hosted_domain: { personal: true, category: 'school', purpose: 'The Google Workspace domain, used to confirm a genuine school account rather than a personal one wearing the same name.', exposed: 'admin' },
    linked_at:     { personal: true, category: 'technical', purpose: 'The date a person first used a particular sign-in method.', exposed: 'admin' },
    last_login_at: { personal: true, category: 'technical', purpose: 'The date a person last used that sign-in method.', exposed: 'admin' },
  },

  memberships: {
    id:              N('Internal reference for one person’s place in one school.'),
    user_id:         { personal: true, category: 'school', purpose: 'Which person belongs to a school.', exposed: 'staff' },
    tenant_id:       { personal: true, category: 'school', purpose: 'Which school a person belongs to.', exposed: 'staff' },
    role_id:         { personal: true, category: 'school', purpose: 'Which role a person holds at their school, which is what decides what they may do.', exposed: 'staff' },
    status:          { personal: true, category: 'school', purpose: 'Whether a person\u2019s access at their school is active, pending, suspended or blocked.', exposed: 'admin' },
    suspend_until:   { personal: true, category: 'school', purpose: 'The date a temporary suspension of a person\u2019s access lifts by itself.', exposed: 'admin' },
    grade_level:     { personal: true, category: 'school', purpose: 'The year group a student is in this school year.', exposed: 'staff' },
    school_year:     { personal: true, category: 'school', purpose: 'Which school year a person\u2019s place at the school belongs to.', exposed: 'staff' },
    graduation_year: { personal: true, category: 'school', purpose: 'Expected year of leaving. Stable across years, so the year group does not have to be rewritten every August.', exposed: 'staff' },
    added_by:        { personal: true, category: 'technical', purpose: 'Which administrator added a person to a school, so the change can be traced.', exposed: 'admin' },
    created_at:      { personal: true, category: 'technical', purpose: 'The date a person joined a school.', exposed: 'admin' },
    updated_at:      { personal: true, category: 'technical', purpose: 'The date a person\u2019s role or status at a school last changed.', exposed: 'admin' },
  },

  guardian_links: {
    id:           N('Internal reference for one guardian relationship.'),
    guardian_id:  { personal: true, category: 'identity', purpose: 'Which adult is recorded as a student\u2019s parent or guardian.', exposed: 'admin' },
    student_id:   { personal: true, category: 'identity', purpose: 'The child. Establishes the parent’s right to inspect that child’s records.', exposed: 'admin' },
    tenant_id:    { personal: true, category: 'school', purpose: 'Which school a parent-and-student relationship applies at.', exposed: 'admin' },
    relationship: { personal: true, category: 'identity', purpose: 'How that adult is related to the student, as the school records it.', exposed: 'admin' },
    verified_at:  { personal: true, category: 'technical', purpose: 'The date the school confirmed a parent-and-student relationship. Unconfirmed ones grant nothing.', exposed: 'admin' },
    verified_by:  { personal: true, category: 'technical', purpose: 'Which member of staff confirmed that relationship.', exposed: 'admin' },
    created_at:   { personal: true, category: 'technical', purpose: 'The date a parent-and-student relationship was first recorded.', exposed: 'admin' },
  },

  platform_admins: {
    user_id:    { personal: true, category: 'identity', purpose: 'Which people are platform operators, with access across every school.', exposed: 'admin' },
    granted_by: { personal: true, category: 'technical', purpose: 'Which existing operator granted platform access to another.', exposed: 'admin' },
    note:       { personal: true, category: 'operational', purpose: 'A note saying why someone holds platform access.', exposed: 'admin' },
    created_at: { personal: true, category: 'technical', purpose: 'The date platform access was granted.', exposed: 'admin' },
    requests_seen_at: { personal: true, category: 'technical', purpose: 'When a platform operator last opened the list of requests for an account, so the console can say whether new ones have arrived since.', exposed: 'admin' },
  },

  access_requests: {
    id:           N('Internal reference for one request for an account.'),
    user_id:      { personal: true, category: 'identity', purpose: 'Which person asked for an account.', exposed: 'admin' },
    email:        { personal: true, category: 'identity', purpose: 'The email address they signed in with when they asked.', exposed: 'admin' },
    requested_at: { personal: true, category: 'technical', purpose: 'The date a person first asked for an account.', exposed: 'admin' },
    attempts:     { personal: true, category: 'technical', purpose: 'How many times a person has tried to sign in while waiting for a decision.', exposed: 'admin' },
    last_seen_at: { personal: true, category: 'technical', purpose: 'The most recent time a person waiting for an account tried to sign in.', exposed: 'admin' },
    status:       { personal: true, category: 'technical', purpose: 'Whether a request for an account is still open, was approved, or was declined.', exposed: 'admin' },
    decided_at:   { personal: true, category: 'technical', purpose: 'The date a request for an account was decided.', exposed: 'admin' },
    decided_by:   { personal: true, category: 'technical', purpose: 'Which administrator decided a request for an account.', exposed: 'admin' },
    tenant_id:    N('Which school they were admitted to, if they were.'),
    role_id:      N('Which role they were given, if any.'),
    note:         { personal: true, category: 'operational', purpose: 'A note an administrator wrote when deciding a request for an account.', exposed: 'admin' },
    // What someone says about themselves when asking (migration 008). Each
    // purpose renders as a standalone line, so none leans on a pronoun.
    came_from_app:       { personal: true, category: 'technical', purpose: 'Which app a person was trying to open when they asked for an account.', exposed: 'admin' },
    respondent:          { personal: true, category: 'school', purpose: 'Whether a person asking for an account said they work in education, are a student, or are someone else.', exposed: 'admin' },
    interested_apps:     { personal: true, category: 'school', purpose: 'Which Signify.one Apps a person asking for an account said they are interested in.', exposed: 'admin' },
    interested_other:    { personal: true, category: 'school', purpose: 'Anything other than the listed apps that a person asking for an account said they are looking for.', exposed: 'admin' },
    school_name:         { personal: true, category: 'school', purpose: 'The school a person asking for an account said they work at.', exposed: 'admin' },
    not_at_school:       { personal: true, category: 'school', purpose: 'Whether a person asking for an account said they do not work at a school.', exposed: 'admin' },
    job_title:           { personal: true, category: 'school', purpose: 'The job title a person asking for an account gave.', exposed: 'admin' },
    heard_from:          { personal: true, category: 'school', purpose: 'How a person asking for an account said they heard about Signify.one.', exposed: 'admin' },
    heard_from_other:    { personal: true, category: 'school', purpose: 'Where else a person asking for an account said they heard about Signify.one.', exposed: 'admin' },
    subjects:            { personal: true, category: 'school', purpose: 'The subjects a person asking for an account said they teach.', exposed: 'admin' },
    subjects_other:      { personal: true, category: 'school', purpose: 'Subjects outside the listed ones that a person asking for an account said they teach.', exposed: 'admin' },
    grade_levels:        { personal: true, category: 'school', purpose: 'The grade levels a person asking for an account said they teach.', exposed: 'admin' },
    google_accounts:     { personal: true, category: 'school', purpose: 'Whether a person asking for an account said their school uses Google accounts, Microsoft accounts, something else, or is not sure.', exposed: 'admin' },
    usage_scope:         { personal: true, category: 'school', purpose: 'Whether a person asking for an account said the apps would be used in their own classes, by a team, or across a whole school.', exposed: 'admin' },
    student_count:       { personal: true, category: 'school', purpose: 'The rough number of students a person asking for an account said would use the apps, as a range.', exposed: 'admin' },
    start_when:          { personal: true, category: 'school', purpose: 'When a person asking for an account said they would like to start using the apps.', exposed: 'admin' },
    survey_submitted_at: { personal: true, category: 'technical', purpose: 'When a person asking for an account answered the questions about themselves.', exposed: 'admin' },
  },

  // ---------- erasure tombstones (migration 011) ----------
  // So restoring a backup can never bring an erased person back.
  erasure_tombstones: {
    user_id:   { personal: true, category: 'technical', purpose: 'The ID number of an account that has been erased, kept for 30 days so that restoring a backup cannot bring it back. Nothing else about the person is kept.', exposed: 'nobody' },
    erased_at: { personal: true, category: 'technical', purpose: 'When an account was erased, so this record of it can itself be deleted 30 days later.', exposed: 'nobody' },
    sent_at:   N('When the erasure was copied to the backup store.'),
  },

  // ---------- problem reports (migration 010) ----------
  // Sent from "Report a problem" inside any app. Erased with the account that
  // sent them; closed ones are erased 180 days after closing regardless.
  reports: {
    id:         N('Internal reference for one problem report.'),
    ref:        N('A short code for one problem report, so it can be quoted back to the person who sent it.'),
    created_at: { personal: true, category: 'technical', purpose: 'When a person reported a problem.', exposed: 'admin' },
    user_id:    { personal: true, category: 'identity', purpose: 'Which person reported a problem, so it can be followed up and so it is erased along with their account.', exposed: 'admin' },
    tenant_id:  N('Which school a problem report came from, so that school’s administrators can see it.'),
    app_id:     N('Which registered app a problem report was sent from.'),
    app_name:   { personal: true, category: 'technical', purpose: 'The name of the app a person was using when they reported a problem.', exposed: 'admin' },
    kind:       { personal: true, category: 'technical', purpose: 'Whether a person said something was not working, was wrong, or was something else.', exposed: 'admin' },
    message:    { personal: true, category: 'technical', purpose: 'What a person wrote when reporting a problem.', exposed: 'admin' },
    page_url:   { personal: true, category: 'technical', purpose: 'The page a person was on when they reported a problem, without anything after a question mark.', exposed: 'admin' },
    context:    { personal: true, category: 'technical', purpose: 'Technical details sent with a problem report unless the person unticks the box: browser, screen size, language, time zone, recent error messages from the page, and any text they had highlighted.', exposed: 'admin' },
    status:     { personal: true, category: 'technical', purpose: 'Whether a problem report is new, being looked into, fixed, not going to be fixed, or a duplicate.', exposed: 'admin' },
    resolution: { personal: true, category: 'operational', purpose: 'A note an administrator wrote about how a problem report was dealt with.', exposed: 'admin' },
    updated_at: { personal: true, category: 'technical', purpose: 'When a problem report was last changed.', exposed: 'admin' },
    closed_at:  { personal: true, category: 'technical', purpose: 'When a problem report was closed. Closed reports are erased 180 days later.', exposed: 'admin' },
    closed_by:  { personal: true, category: 'technical', purpose: 'Which administrator closed a problem report.', exposed: 'admin' },
  },

  // ---------- substitute cover (migration 011) ----------
  coverages: {
    id:            N('Internal reference for one period of substitute cover.'),
    tenant_id:     N('Which school the cover is at.'),
    substitute_id: { personal: true, category: 'school', purpose: 'Which substitute is covering.', exposed: 'admin' },
    covering_for:  { personal: true, category: 'school', purpose: 'Which teacher a substitute is covering for, when the school said.', exposed: 'admin' },
    starts_on:     { personal: true, category: 'school', purpose: 'The first day a substitute covers.', exposed: 'admin' },
    ends_on:       { personal: true, category: 'school', purpose: 'The last day a substitute covers.', exposed: 'admin' },
    note:          { personal: true, category: 'operational', purpose: 'A note an administrator wrote about a period of substitute cover.', exposed: 'admin' },
    created_by:    { personal: true, category: 'technical', purpose: 'Which administrator arranged a period of substitute cover.', exposed: 'admin' },
    created_at:    { personal: true, category: 'technical', purpose: 'When a period of substitute cover was arranged.', exposed: 'admin' },
    ended_at:      { personal: true, category: 'technical', purpose: 'When a period of substitute cover was ended early or cancelled.', exposed: 'admin' },
    ended_by:      { personal: true, category: 'technical', purpose: 'Which administrator ended a period of substitute cover early.', exposed: 'admin' },
  },
  coverage_classes: {
    coverage_id: N('Which period of cover a class belongs to.'),
    class_id:    { personal: true, category: 'school', purpose: 'Which classes a substitute covers.', exposed: 'admin' },
  },

  // ---------- classes ----------
  classes: {
    id:               N('Internal reference for a class.'),
    tenant_id:        N('Which school the class belongs to.'),
    name:             N('The class name, e.g. 3B Mathematics.'),
    subject:          N('The subject taught.'),
    school_year:      N('Which school year the class runs in.'),
    grade_levels:     N('The year groups the class covers. A class may span several.'),
    google_course_id: N('Link to a Google Classroom course, where one was imported.'),
    join_code:        N('Short code a class can be joined with.'),
    archived:         N('Whether the class is retired but kept for the record.'),
    created_by:       { personal: true, category: 'technical', purpose: 'Which member of staff created a class.', exposed: 'staff' },
    created_at:       N('When the class was created.'),
  },

  class_members: {
    class_id: { personal: true, category: 'school', purpose: 'Which class a person is a member of.', exposed: 'staff' },
    user_id:  { personal: true, category: 'school', purpose: 'Which people are in each class. Together these make up the class register.', exposed: 'staff' },
    role:     { personal: true, category: 'school', purpose: 'Whether a person is a teacher, student, aide or observer in that class.', exposed: 'staff' },
    added_at: { personal: true, category: 'technical', purpose: 'The date a person joined a class.', exposed: 'staff' },
  },

  // ---------- schools and roles ----------
  tenants: {
    id: N('Internal reference for a school.'), slug: N('Short name used in addresses.'),
    name: N('The school’s name.'), status: N('Whether the school’s access is active.'),
    timezone: N('Used to show times correctly.'),
    kind: N('Whether this is a school or the group for people at no school.'),
    year_start_month: N('Which month the school year begins, for rollover.'),
    minors_default: N('Whether pupils here are treated as under 13 by default.'),
    retention_days: N('How long this school keeps inactive records.'),
    settings: N('School preferences, such as the year groups it uses and its list of rooms and places.'),
    created_at: N('When the school was added.'), updated_at: N('When its settings last changed.'),
  },
  tenant_domains: {
    domain: N('An email domain belonging to the school.'),
    tenant_id: N('Which school owns it.'),
    auto_role: N('The role given automatically to a new sign-in on this domain.'),
    require_hd: N('Whether a genuine Google Workspace account is required.'),
    created_at: N('When the domain was added.'),
  },
  roles: {
    id: N('Internal reference for a role.'), tenant_id: N('Which school the role belongs to, if it is a custom one.'),
    key: N('Short identifier.'), label: N('The name shown in the console.'),
    description: N('What the role is for.'), builtin: N('Whether it ships with the product.'),
    is_admin: N('Whether it carries administrative permissions.'),
    sort_order: N('Display order.'), created_at: N('When it was created.'),
    customised: N('Whether a super admin has changed this built-in role, in which case it no longer tracks the platform default.'),
    customised_at: N('When it was changed.'),
    customised_by: { personal: true, category: 'technical', purpose: 'Which operator changed a built-in role, so a school can see who altered what that role may do.', exposed: 'admin' },
  },
  role_permissions: {
    role_id: N('Which role this permission belongs to.'), permission: N('What the role is allowed to do.'), scope: N('How far that permission reaches: their own records, their classes, the school, or everywhere.'),
  },

  // ---------- applications ----------
  apps: {
    id: N('Internal reference for a registered application.'),
    client_id: N('Public identifier the app signs in with.'),
    name: N('The app’s name.'), description: N('What the app is.'),
    client_secret_hash: { personal: false, category: 'credential', purpose: 'A one-way hash of the app’s secret. The secret itself is never stored.', exposed: 'nobody' },
    redirect_uris: N('The exact addresses the app may be returned to.'),
    post_logout_uris: N('Addresses the app may send people to after signing out.'),
    namespace: N('Which permissions the app may ever see.'),
    scopes: N('What the app may ask for.'), status: N('Whether the app is enabled.'),
    access_token_ttl: N('How long its access tokens last.'),
    session_ttl_hours: N('How long a sign-in to it lasts.'),
    launch_url: N('Where the app lives, so the switcher can offer it. An app without one simply does not appear.'),
    short_name: N('The name shown under the app\u2019s tile in the switcher.'),
    tile_initials: N('The one or two letters drawn on the tile.'),
    tile_color: N('Which of the palette colours the tile uses.'),
    sort_order: N('Where the app sits in the switcher grid.'),
    created_at: N('When it was registered.'),
  },
  app_permissions: {
    key: N('The permission an app says it has, such as atlas:grade. Always inside the app’s own namespace.'),
    app_id: N('Which app declared it.'),
    label: N('The wording an administrator sees when putting it into a role.'),
    description: N('A longer explanation of what the permission allows.'),
    is_admin: N('Whether only a super admin may put it into a role.'),
    deprecated: N('Set when an app stops claiming a permission. Kept rather than deleted, because roles may still hold it.'),
    declared_at: N('When the app first declared it.'),
    updated_at: N('When the declaration last changed.'),
  },

  app_tenants: {
    app_id: N('Which registered application this setting is for.'), tenant_id: N('Which school may use it.'),
    enabled: N('Whether it is switched on for that school.'), created_at: N('When that was decided.'),
  },
  user_app_access: {
    user_id:   { personal: true, category: 'school', purpose: 'Which person an app-by-app exception applies to.', exposed: 'admin' },
    app_id:    { personal: true, category: 'school', purpose: 'Which app that person is being allowed or excluded from.', exposed: 'admin' },
    tenant_id: { personal: true, category: 'school', purpose: 'Which school set that app exception.', exposed: 'admin' },
    allowed:   { personal: true, category: 'school', purpose: 'Whether that person may use that app.', exposed: 'admin' },
    set_by:    { personal: true, category: 'technical', purpose: 'Which administrator set an app exception.', exposed: 'admin' },
    created_at:{ personal: true, category: 'technical', purpose: 'The date an app exception was set.', exposed: 'admin' },
  },

  // ---------- sign-in machinery ----------
  sessions: {
    id:              { personal: true, category: 'technical', purpose: 'An internal reference for one person\u2019s sign-in on one device.', exposed: 'admin' },
    user_id:         { personal: true, category: 'technical', purpose: 'Which person a signed-in device belongs to.', exposed: 'admin' },
    token_hash:      { personal: false, category: 'credential', purpose: 'A one-way hash of the sign-in cookie. The cookie value itself is never stored, so a copy of the database does not hand over live sessions.', exposed: 'nobody' },
    created_at:      { personal: true, category: 'technical', purpose: 'The time a person signed in on a device.', exposed: 'admin' },
    last_seen_at:    { personal: true, category: 'technical', purpose: 'The time a signed-in device was last active.', exposed: 'admin' },
    expires_at:      { personal: true, category: 'technical', purpose: 'The time a sign-in ends regardless of activity.', exposed: 'admin' },
    idle_expires_at: { personal: true, category: 'technical', purpose: 'The time a sign-in ends through inactivity. Kept short for students, because classroom devices are shared.', exposed: 'admin' },
    idle_minutes:    { personal: true, category: 'technical', purpose: 'How long a sign-in may be left alone before it ends, decided by the role the person holds.', exposed: 'admin' },
    revoked_at:      { personal: true, category: 'technical', purpose: 'The time a sign-in was ended early, by signing out or by an administrator.', exposed: 'admin' },
    revoked_reason:  { personal: true, category: 'technical', purpose: 'Why a sign-in was ended early: signing out, an administrator ending it, or a security check.', exposed: 'admin' },
    ip:              { personal: true, category: 'technical', purpose: 'The IP address the sign-in came from — the number a network gives a device, not a home address. Kept so an account being used from somewhere it should not be can be spotted.', exposed: 'admin' },
    user_agent:      { personal: true, category: 'technical', purpose: 'The browser and device a person signed in from, kept for the same reason as the IP address.', exposed: 'admin' },
  },
  auth_codes: {
    code_hash: { personal: false, category: 'credential', purpose: 'A one-way hash of a short-lived code used while handing a sign-in to an app. Valid for one minute and once only.', exposed: 'nobody' },
    app_id: N('Which app the code was for.'),
    user_id: { personal: true, category: 'technical', purpose: 'Which person a short-lived sign-in code represents.', exposed: 'nobody' },
    session_id: { personal: true, category: 'technical', purpose: 'Which sign-in a short-lived code came from.', exposed: 'nobody' },
    tenant_id: N('Which school.'), redirect_uri: N('Where the app is returned to.'),
    code_challenge: { personal: false, category: 'credential', purpose: 'Proof that the app finishing the sign-in is the one that started it.', exposed: 'nobody' },
    scope: N('What was asked for.'), nonce: N('One-time value that ties the sign-in to the request.'),
    expires_at: N('When the code stops working.'), used_at: N('When it was used. Re-use ends the session.'),
  },
  refresh_tokens: {
    id: N('Internal reference.'),
    token_hash: { personal: false, category: 'credential', purpose: 'A one-way hash of the token that keeps somebody signed in to an app.', exposed: 'nobody' },
    app_id: N('Which application the token was issued to.'),
    user_id: { personal: true, category: 'technical', purpose: 'Which person a sign-in renewal token belongs to.', exposed: 'nobody' },
    session_id: { personal: true, category: 'technical', purpose: 'Which sign-in a renewal token came from, so ending the sign-in ends the token too.', exposed: 'nobody' },
    expires_at: N('When it stops working.'), created_at: N('When it was issued.'),
    revoked_at: N('When it was ended.'), rotated_to: N('Its replacement. Re-using an old one ends the whole sign-in.'),
  },
  signing_keys: {
    kid: N('The identifier a token carries so an app knows which key signed it.'), alg: N('The signing algorithm used.'),
    public_jwk: N('The public half, published so apps can check a token is genuine.'),
    private_pem: { personal: false, category: 'credential', purpose: 'The private half, used to sign tokens. Never leaves the server and is never included in a backup.', exposed: 'nobody' },
    created_at: N('When the key was made.'), retired_at: N('When it stopped signing new tokens.'),
  },

  // ---------- records and governance ----------
  audit_log: {
    id: N('Internal reference for one logged action.'),
    ts: { personal: true, category: 'technical', purpose: 'The time a recorded action happened.', exposed: 'admin' },
    actor_user_id: { personal: true, category: 'technical', purpose: 'Which account performed the action.', exposed: 'admin' },
    actor_email:   { personal: true, category: 'technical', purpose: 'The email address of whoever performed a recorded action, as it was at the time. Cleared when that person\u2019s record is erased.', exposed: 'admin' },
    tenant_id: N('Which school a recorded action concerned.'),
    app_id: { personal: true, category: 'technical', purpose: 'Which app a person opened or an action concerned.', exposed: 'admin' },
    action: N('What was done.'),
    target_type: N('What kind of thing it was done to.'),
    target_id: { personal: true, category: 'technical', purpose: 'Which record an action was performed on.', exposed: 'admin' },
    detail: { personal: true, category: 'technical', purpose: 'What an action changed. This may name a person or an email address.', exposed: 'admin' },
    ip: { personal: true, category: 'technical', purpose: 'The IP address the action came from.', exposed: 'admin' },
    user_agent: { personal: true, category: 'technical', purpose: 'The browser and device a recorded action came from.', exposed: 'admin' },
    is_disclosure: N('Marks the entries that form the record of disclosures a school must keep.'),
  },
  consents: {
    id: N('Internal reference for one recorded authorization.'),
    tenant_id: N('Which school gave it.'),
    subject_user_id: { personal: true, category: 'identity', purpose: 'Which individual an authorisation concerns, where it is not school-wide.', exposed: 'admin' },
    kind: N('Whether it is a school authorization, a parental consent or a policy acceptance.'),
    policy_version: N('Which version of this policy the signer was shown.'),
    signer_name:  { personal: true, category: 'identity', purpose: 'The name of the adult who gave the authorisation on behalf of the school.', exposed: 'admin' },
    signer_email: { personal: true, category: 'identity', purpose: 'The email address of the adult who gave the authorisation.', exposed: 'admin' },
    signer_title: { personal: true, category: 'identity', purpose: 'The job title of the adult who gave the authorisation.', exposed: 'admin' },
    method: N('How it was given.'),
    document: N('What they were shown at the time, kept verbatim.'),
    signed_at: N('When the authorization was given.'), revoked_at: N('If and when it was withdrawn.'),
    ip: { personal: true, category: 'technical', purpose: 'The IP address an authorisation was recorded from.', exposed: 'admin' },
  },
  backups: {
    id: N('Internal reference for one backup.'), tenant_id: N('Which school it covers.'),
    kind: N('Whether it was downloaded deliberately or taken automatically before a restore.'),
    created_by: { personal: true, category: 'technical', purpose: 'Which administrator took a backup.', exposed: 'admin' },
    created_at: N('When the backup was taken.'), checksum: N('A fingerprint, so a file offered later can be recognised as one this system produced.'),
    row_counts: N('How much it contained.'), note: N('Any note recorded with it.'),
    payload: { personal: true, category: 'identity', purpose: 'A complete copy of one school’s roster. Held only for the automatic snapshot taken before a restore, and only for 30 days. A downloaded backup is never stored here.', exposed: 'admin' },
    expires_at: N('When that snapshot is destroyed.'),
  },
  roster_imports: {
    id: N('Internal reference for one import.'), tenant_id: N('Which school.'),
    created_by: { personal: true, category: 'technical', purpose: 'Which administrator ran the import.', exposed: 'admin' },
    created_at: N('When the import was run.'),
    filename: { personal: true, category: 'technical', purpose: 'The name of the file uploaded, which may identify a class or group.', exposed: 'admin' },
    row_count: N('How many rows it had.'), created_n: N('How many people it added.'),
    updated_n: N('How many it changed.'), skipped_n: N('How many rows it refused.'),
    detail: N('Which columns were ignored and which classes were created.'),
    undo_data: { personal: true, category: 'identity', purpose: 'The prior values of everything the import changed, so it can be reversed. Names and email addresses appear here.', exposed: 'admin' },
    undone_at: N('When it was reversed, if it was.'),
    undone_by: { personal: true, category: 'technical', purpose: 'Which administrator reversed a roster import.', exposed: 'admin' },
  },
  schema_migrations: {
    filename: N('Which database change has been applied.'),
    applied_at: N('When it was applied.'),
  },
};


// ---------- what a reader is actually told ----------
//
// The inventory above is one entry per database column, which is what makes
// the completeness check possible — but as a list for a parent it is 94
// bullets of near-identical timestamps.
//
// So the published policy renders THESE instead: one plain line per thing
// actually collected, each naming the columns it accounts for. The test
// asserts that every personal column appears in exactly one of them, so
// grouping can shorten the list but can never hide anything from it.

const DISCLOSURES = [
  // ---- identity ----
  {
    category: 'identity',
    text: 'Each person\u2019s name: a first name, a last name, and the name shown to their teachers and classmates.',
    covers: ['users.display_name', 'users.given_name', 'users.family_name'],
  },
  {
    category: 'identity',
    text: 'Each person\u2019s school email address. Where an address has changed, the previous one is kept so records are not orphaned.',
    covers: ['users.email', 'identities.email_at_link', 'access_requests.email', 'audit_log.actor_email'],
  },
  {
    category: 'identity',
    text: 'A link to each person\u2019s Google profile picture. The picture itself stays with Google and is not copied here.',
    covers: ['users.picture_url'],
  },
  {
    category: 'identity',
    text: 'Two ID numbers that mean nothing outside Signify.one Apps: one generated here, and the permanent one Google uses for the account. The second is what identifies a person, so that an email address later handed to a new student never reaches the previous student’s work.',
    covers: ['users.id', 'identities.user_id', 'identities.subject', 'identities.provider',
             'platform_admins.user_id', 'access_requests.user_id', 'consents.subject_user_id'],
  },
  {
    category: 'identity',
    text: 'If a parent or guardian has been linked to a student: who they are and how they are related.',
    covers: ['guardian_links.guardian_id', 'guardian_links.student_id', 'guardian_links.relationship'],
  },
  {
    category: 'identity',
    text: 'The name, job title and email address of whoever at the school authorised the use of Signify.one Apps.',
    covers: ['consents.signer_name', 'consents.signer_title', 'consents.signer_email'],
  },
  {
    category: 'identity',
    text: 'Copies of the above, held briefly inside a backup or inside the record of a roster import so that either can be undone.',
    covers: ['backups.payload', 'roster_imports.undo_data'],
  },

  // ---- place in the school ----
  {
    category: 'school',
    text: 'Which school a person belongs to, what their role there is, and whether their account is active, waiting for approval, suspended or blocked.',
    covers: ['users.status', 'memberships.user_id', 'memberships.tenant_id', 'memberships.role_id',
             'memberships.status', 'memberships.suspend_until', 'guardian_links.tenant_id',
             'identities.hosted_domain'],
  },
  {
    category: 'school',
    text: 'A student\u2019s year group, the school year, and the year they are expected to leave.',
    covers: ['memberships.grade_level', 'memberships.school_year', 'memberships.graduation_year'],
  },
  {
    category: 'school',
    text: 'Which classes a person is in, and whether they are a teacher, student, aide or observer in each one.',
    covers: ['class_members.class_id', 'class_members.user_id', 'class_members.role'],
  },
  {
    category: 'school',
    text: 'If a substitute covers classes: who covered, for which teacher, which classes and on which days, who arranged it, and whether it was ended early. On those days the substitute appears to the apps as a teacher of those classes; on any other day they cannot sign in.',
    covers: ['coverages.substitute_id', 'coverages.covering_for', 'coverages.starts_on', 'coverages.ends_on',
             'coverages.created_by', 'coverages.created_at', 'coverages.ended_at', 'coverages.ended_by',
             'coverage_classes.class_id'],
  },
  {
    category: 'school',
    text: 'Whether a school has specifically allowed or blocked one person from one particular app.',
    covers: ['user_app_access.user_id', 'user_app_access.app_id', 'user_app_access.tenant_id', 'user_app_access.allowed'],
  },
  {
    category: 'school',
    text: 'Two retired settings about age, kept only so older records still read correctly. They are no longer used, because every account is for someone aged 13 or over.',
    covers: ['users.is_minor', 'users.minor_source'],
  },

  // ---- records of use ----
  {
    category: 'technical',
    text: 'Dates: when an account was created, when it was last used, when the person joined their school and each of their classes, and when the record is due to be deleted.',
    covers: ['users.created_at', 'users.last_seen_at', 'users.deleted_at', 'users.purge_after',
             'identities.linked_at', 'identities.last_login_at', 'memberships.created_at',
             'memberships.updated_at', 'class_members.added_at', 'guardian_links.created_at',
             'guardian_links.verified_at', 'platform_admins.created_at', 'user_app_access.created_at'],
  },
  {
    category: 'technical',
    text: 'Each sign-in: when it happened, which app was opened, the IP address it came from, and which browser and device was used. This is how an account being used by someone it should not be can be spotted.',
    covers: ['sessions.id', 'sessions.user_id', 'sessions.created_at', 'sessions.last_seen_at',
             'sessions.expires_at', 'sessions.idle_expires_at', 'sessions.idle_minutes',
             'sessions.revoked_at', 'sessions.revoked_reason',
             'sessions.ip', 'sessions.user_agent', 'auth_codes.user_id', 'auth_codes.session_id',
             'refresh_tokens.user_id', 'refresh_tokens.session_id', 'consents.ip', 'audit_log.app_id'],
  },
  {
    category: 'technical',
    text: 'A record of what administrators do: who did it, what they changed, which record it concerned, when, and from where, and when a platform operator last looked at the requests for an account.',
    covers: ['audit_log.ts', 'audit_log.actor_user_id', 'audit_log.target_id', 'audit_log.detail',
             'audit_log.ip', 'audit_log.user_agent', 'memberships.added_by', 'guardian_links.verified_by',
             'platform_admins.granted_by', 'platform_admins.requests_seen_at', 'classes.created_by', 'roles.customised_by',
             'user_app_access.set_by'],
  },
  {
    category: 'technical',
    text: 'Which administrator took a backup or loaded a roster file, and the name of the file they used.',
    covers: ['backups.created_by', 'roster_imports.created_by', 'roster_imports.filename', 'roster_imports.undone_by'],
  },

  // ---- notes ----
  {
    category: 'operational',
    text: 'Short notes an administrator has written: why someone has been given wide access, why a request for an account was decided as it was, or about a period of substitute cover.',
    covers: ['platform_admins.note', 'access_requests.note', 'coverages.note'],
  },

  {
    category: 'technical',
    text: 'If someone reports a problem from inside an app: what they wrote, whether they said something was not working or was wrong, which app and page they were on (without anything after a question mark in the address), and when. Unless they untick the box, also their browser, screen size, language and time zone, any recent error messages from the page, and any text they had highlighted. Then how the report was handled, by which administrator, and when. A report is erased with the account that sent it, and 180 days after it is closed.',
    covers: ['reports.created_at', 'reports.user_id', 'reports.app_name', 'reports.kind',
             'reports.message', 'reports.page_url', 'reports.context', 'reports.status',
             'reports.resolution', 'reports.updated_at', 'reports.closed_at', 'reports.closed_by'],
  },

  {
    category: 'technical',
    text: 'When an account is erased: its ID number and when, for 30 days and nothing else, so that restoring a backup cannot bring the account back.',
    covers: ['erasure_tombstones.user_id', 'erasure_tombstones.erased_at'],
  },

  // ---- asking for an account ----
  // Only ever about someone who does not have an account yet.
  {
    category: 'request',
    text: 'If someone without an account asks for one: when they asked, which app they were trying to open, how many times they have tried since, when they answered the questions about themselves, and how the request was decided.',
    covers: ['access_requests.requested_at', 'access_requests.attempts', 'access_requests.last_seen_at',
             'access_requests.status', 'access_requests.decided_at', 'access_requests.decided_by',
             'access_requests.came_from_app', 'access_requests.survey_submitted_at'],
  },
  {
    category: 'request',
    text: 'The answers someone asking for an account gives about themselves: whether they work in education, are a student or are someone else; which apps they are interested in; the school they work at, or that they do not work at one; their job title; whether that school uses Google accounts; who would use the apps, roughly how many students, and when they would like to start; the subjects and grade levels they teach; and how they heard about Signify.one. A student is asked nothing beyond the first question. The answers are cleared 90 days after the request is decided.',
    covers: ['access_requests.respondent', 'access_requests.interested_apps', 'access_requests.interested_other',
             'access_requests.school_name', 'access_requests.not_at_school', 'access_requests.job_title',
             'access_requests.heard_from', 'access_requests.heard_from_other', 'access_requests.subjects',
             'access_requests.subjects_other', 'access_requests.grade_levels',
             'access_requests.google_accounts', 'access_requests.usage_scope',
             'access_requests.student_count', 'access_requests.start_when'],
  },
];

// Grouped for the page, in the order the categories are introduced.
function disclosuresByCategory() {
  const out = {};
  for (const d of DISCLOSURES) (out[d.category] = out[d.category] || []).push(d);
  return out;
}

// Every column each disclosure claims to account for.
function disclosedColumns() {
  return DISCLOSURES.flatMap((d) => d.covers);
}

// ---------- helpers used by the policy page and the test ----------

function allColumns() {
  const out = [];
  for (const [table, cols] of Object.entries(INVENTORY)) {
    for (const [column, meta] of Object.entries(cols)) out.push({ table, column, ...meta });
  }
  return out;
}

const personalColumns = () => allColumns().filter((c) => c.personal);

// Grouped for the human-readable policy: one row per distinct thing collected,
// rather than one per database column.
function byCategory() {
  const groups = {};
  for (const c of personalColumns()) (groups[c.category] = groups[c.category] || []).push(c);
  return groups;
}

module.exports = {
  INVENTORY, DISCLOSURES,
  allColumns, personalColumns, byCategory,
  disclosuresByCategory, disclosedColumns,
};
