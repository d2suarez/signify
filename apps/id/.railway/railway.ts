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
    },
  });

  return project("signify-id", {
    resources: [signifyId, Postgres, postgresVolume],
  });
});
