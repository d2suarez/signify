// Shared between server and client — keep it pure.

export function dateInput(d: Date | null | undefined) {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

/** Dates are kept as midday UTC so a due date never slips a day across time zones. */
export function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function shortDate(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function dueLabel(d: Date | null, done = false) {
  if (!d) return null;
  if (done) return { text: shortDate(d), tone: "text-slate-400" };
  const today = new Date();
  today.setUTCHours(12, 0, 0, 0);
  const days = Math.round((d.getTime() - today.getTime()) / 864e5);
  if (days < 0) return { text: `${-days}d late`, tone: "text-red-700 font-semibold" };
  if (days === 0) return { text: "Today", tone: "text-amber-800 font-semibold" };
  if (days === 1) return { text: "Tomorrow", tone: "text-amber-800" };
  if (days < 7) return { text: d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }), tone: "text-slate-600" };
  return { text: shortDate(d), tone: "text-slate-600" };
}
