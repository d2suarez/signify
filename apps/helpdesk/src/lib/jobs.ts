import { runDigestIfDue } from "./digest";
import { runRecurringTasks } from "./recurring";

let started = false;

/** Hourly housekeeping: weekly digest, recurring tickets. (Backups: offsite-backup.js.) */
export function startJobs() {
  if (started) return;
  started = true;

  const tick = async () => {
    try {
      await runDigestIfDue();
    } catch (error) {
      console.error("Digest job failed:", error instanceof Error ? error.message : error);
    }
    try {
      await runRecurringTasks();
    } catch (error) {
      console.error("Recurring job failed:", error instanceof Error ? error.message : error);
    }
  };

  setTimeout(tick, 20_000);
  setInterval(tick, 60 * 60 * 1000);
}
