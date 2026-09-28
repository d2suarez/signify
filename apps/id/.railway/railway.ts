// Signify ID — infrastructure as code.
//
// Imported from the live project, so this file describes the whole thing:
// `railway config apply` reconciles the entire project, and anything missing
// here would be taken away from it.
//
// Secrets stay in Railway. preserve() means "this variable exists, leave its
// value alone", so COOKIE_SECRET and the rest are never written to the repo.
import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  // Every person, role, class, consent record and audit row lives here.
  const Postgres = postgres("Postgres", { region: "sfo" });

  const postgresVolume = volume("postgres-volume", {
    region: "sfo",
    sizeMB: 5000,
    allowOnlineResize: true,
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
  });

  const signifyId = service("signify-id", {
    replicas: { sfo: 1 },
    domains: ["id.signify.one"],
    healthcheck: "/healthz",
    healthcheckTimeout: 30,
    // Deliberately NOT sleeping, unlike the other apps on this plan. Every
    // sign-in in the fleet goes through here, so a cold start would stall all
    // of them — and the hourly retention sweep cannot run while asleep, which
    // is a COPPA obligation rather than housekeeping.
    sleepApplication: false,
    env: {
      COOKIE_SECRET: preserve(),
      DATABASE_URL: preserve(),
      GOOGLE_CLIENT_ID: preserve(),
      ISSUER: preserve(),
      NODE_ENV: preserve(),
      RETENTION_DAYS: preserve(),
      SUPER_ADMINS: preserve(),
      // The operator named on the published privacy policy. Missing from this
      // file until 2026-09-28, when `railway config plan` showed an apply
      // would have deleted both.
      POLICY_OPERATOR_NAME: preserve(),
      POLICY_OPERATOR_ROLE: preserve(),
      // Off-site database backups (src/dbbackup.js). Set by hand in Railway;
      // listed here only so an apply never takes them away.
      R2_ACCOUNT_ID: preserve(),
      R2_BUCKET: preserve(),
      R2_ACCESS_KEY_ID: preserve(),
      R2_SECRET_ACCESS_KEY: preserve(),
      BACKUP_ENCRYPTION_KEY: preserve(),
    },
  });

  return project("signify-id", {
    resources: [signifyId, Postgres, postgresVolume],
  });
});
