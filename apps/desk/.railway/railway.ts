// Teacher's Desk — infrastructure as code.
//
// The whole project is reconciled from this file (`railway config apply`), so
// anything missing here is taken *off* the service. Secrets stay in Railway:
// preserve() means "this variable exists, leave its value alone".
import { defineRailway, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  // desk.json — every teacher's board, their class lists, their behaviour
  // notes. Small, but it is the whole app: it needs a volume, not a container
  // filesystem that goes away on the next deploy.
  const deskVolume = volume("teachers-desk-volume", {
    region: "sfo",
    sizeMB: 1000,
    allowOnlineResize: true,
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
  });

  const desk = service("teachers-desk", {
    replicas: { sfo: 1 },
    domains: ["desk.signify.one"],
    build: { builder: "NIXPACKS" },
    deploy: {
      startCommand: "node server.js",
      // Set here rather than in railway.json, which does not apply it —
      // the same gap the rest of the fleet hit.
      healthcheckPath: "/healthz",
      // Hobby plan: let it sleep when nobody is teaching.
      //
      // Worth knowing: alarms and timers run in the teacher's own browser, so
      // a sleeping service does not stop one going off. It only means the
      // first page load of the morning is slow.
      sleepApplication: true,
      restartPolicyMaxRetries: 5,
    },
    volumeMounts: {
      "/var/data": deskVolume,
    },
    env: {
      CANONICAL_HOST: preserve(),
      DATA_DIR: preserve(),
      NODE_ENV: preserve(),
      BEHAVIOUR_RETENTION_DAYS: preserve(),
      SIGNIFY_ISSUER: preserve(),
      SIGNIFY_CLIENT_ID: preserve(),
      SIGNIFY_CLIENT_SECRET: preserve(),
      SIGNIFY_REDIRECT_URI: preserve(),
      SIGNIFY_COOKIE_SECRET: preserve(),
      // Off-site backups (server/backup.js). Set by hand in Railway; listed
      // here only so an apply never takes them away. BACKUP_DAYS is optional.
      R2_ACCOUNT_ID: preserve(),
      R2_BUCKET: preserve(),
      R2_ACCESS_KEY_ID: preserve(),
      R2_SECRET_ACCESS_KEY: preserve(),
      BACKUP_DAYS: preserve(),
      BACKUP_ENCRYPTION_KEY: preserve(),
    },
  });

  return project("teachers-desk", { resources: [desk, deskVolume] });
});
