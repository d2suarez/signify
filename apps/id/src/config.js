// ===================================================================
// Signify ID — configuration
// Everything the service needs to know about its environment, validated once
// at boot so a misconfiguration fails loudly instead of silently degrading
// into an insecure mode.
// ===================================================================

const crypto = require('crypto');

const bool = (v, dflt = false) => (v === undefined ? dflt : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, dflt) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : dflt);
const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const ON_RAILWAY = !!process.env.RAILWAY_ENVIRONMENT;

// The dev bypass lets the app be exercised without a Google project. It is
// refused in any hosted environment — there it would let a stranger claim a
// super admin's identity by typing their address.
const ALLOW_DEV_LOGIN = bool(process.env.ALLOW_DEV_LOGIN) && !ON_RAILWAY;

const config = {
  port: int(process.env.PORT, 3000),
  onRailway: ON_RAILWAY,
  production: ON_RAILWAY || process.env.NODE_ENV === 'production',

  databaseUrl: process.env.DATABASE_URL || '',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  issuer: (process.env.ISSUER || `http://localhost:${int(process.env.PORT, 3000)}`).replace(/\/+$/, ''),
  superAdmins: list(process.env.SUPER_ADMINS),

  // Used to pepper CSRF tokens and the session cookie name. A random value is
  // acceptable for a single local process but not for a deployment: every
  // restart, and every extra replica, would invalidate live sessions.
  cookieSecret: process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex'),
  cookieSecretProvided: !!process.env.COOKIE_SECRET,

  // Two idle windows, chosen at sign-in from the role and then stored on the
  // session. A teacher's should survive a lesson spent away from the screen;
  // a student's should not survive the tablet being handed to the next child.
  sessionIdleMinutes: int(process.env.SESSION_IDLE_MINUTES, 45),
  sessionIdleMinutesStaff: int(process.env.SESSION_IDLE_MINUTES_STAFF, 480),
  sessionAbsoluteHours: int(process.env.SESSION_ABSOLUTE_HOURS, 12),

  retentionDays: int(process.env.RETENTION_DAYS, 400),

  allowDevLogin: ALLOW_DEV_LOGIN,

  // Bumped whenever the privacy notice changes; recorded against every
  // school authorization so you can prove what a signer was shown.
  // Defined in src/policy.js so the published page and the consent record
  // can never disagree about which version was in force.
  policyVersion: process.env.POLICY_VERSION || require('./policy').VERSION,
};

function validate() {
  const fatal = [];
  const warn = [];

  if (!config.databaseUrl) fatal.push('DATABASE_URL is not set.');
  if (!config.googleClientId && !config.allowDevLogin) {
    fatal.push('GOOGLE_CLIENT_ID is not set and dev login is unavailable — nobody could sign in.');
  }
  if (config.production) {
    if (!config.cookieSecretProvided) {
      fatal.push('COOKIE_SECRET must be set in a hosted environment (generate with: openssl rand -hex 32).');
    }
    if (!config.issuer.startsWith('https://')) {
      fatal.push(`ISSUER must be an https URL in a hosted environment (got "${config.issuer}").`);
    }
    if (!config.superAdmins.length) {
      fatal.push('SUPER_ADMINS is empty — the deployment would have no administrator.');
    }
  }
  if (config.superAdmins.length === 1) {
    warn.push('Only one SUPER_ADMINS address is configured. Add a second so a lost account cannot lock you out of every app.');
  }
  if (config.allowDevLogin) {
    warn.push('ALLOW_DEV_LOGIN is on. Any email address can be claimed without proof. Local use only.');
  }

  return { fatal, warn };
}

module.exports = { config, validate, list, bool, int };
