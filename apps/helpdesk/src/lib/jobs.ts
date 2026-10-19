import { runDailyBackup } from "./backup";
import { runDigestIfDue } from "./digest";
import { runRecurringTasks } from "./recurring";

let started = false;

/** Hourly housekeeping: daily backup, weekly digest, recurring tickets. */
export function startJobs() {
  if (started) return;
  started = true;

  const tick = async () => {
    try {
      await runDailyBackup();
    } catch (error) {
      console.error("Backup job failed:", error instanceof Error ? error.message : error);
    }
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
