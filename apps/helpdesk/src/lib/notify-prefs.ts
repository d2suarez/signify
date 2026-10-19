// Shared between server and client — keep it pure.

export type Channel = "email" | "push" | "sms";
export type ChannelPrefs = Record<Channel, boolean>;
export type NotifyPrefs = Record<string, ChannelPrefs>;

export type EventDef = {
  key: string;
  label: string;
  description: string;
  agentOnly: boolean;
};

export const EVENT_DEFS: EventDef[] = [
  {
    key: "my_updates",
    label: "Updates on my requests",
    description: "When the help desk posts an update or resolves one of your requests",
    agentOnly: false,
  },
  {
    key: "projects",
    label: "Projects",
    description: "When you're added to a project or given a task",
    agentOnly: false,
  },
  {
    key: "new_ticket",
    label: "New requests",
    description: "When anyone submits a new request",
    agentOnly: true,
  },
  {
    key: "assigned",
    label: "Assigned to me",
    description: "When a ticket is assigned to you",
    agentOnly: true,
  },
  {
    key: "reply",
    label: "Requester replies",
    description: "When a requester replies on a ticket (yours, or unassigned)",
    agentOnly: true,
  },
  {
    key: "digest",
    label: "Weekly summary",
    description: "Monday recap: open counts, stale tickets, last week's volume",
    agentOnly: true,
  },
];

export function eventsForRole(role: string): EventDef[] {
  const agent = role === "ADMIN" || role === "TECH";
  return EVENT_DEFS.filter((event) => agent || !event.agentOnly);
}

const DEFAULT_CHANNELS: ChannelPrefs = { email: true, push: true, sms: false };

/** Stored prefs merged over defaults, limited to events this role can receive. */
export function resolvePrefs(user: { role: string; notifyPrefs: string }): NotifyPrefs {
  let stored: Record<string, Partial<ChannelPrefs>> = {};
  try {
    const parsed = JSON.parse(user.notifyPrefs);
    if (parsed && typeof parsed === "object") stored = parsed;
  } catch {
    // fall back to defaults
  }
  const prefs: NotifyPrefs = {};
  for (const event of eventsForRole(user.role)) {
    prefs[event.key] = {
      email: stored[event.key]?.email ?? DEFAULT_CHANNELS.email,
      push: stored[event.key]?.push ?? DEFAULT_CHANNELS.push,
      sms: stored[event.key]?.sms ?? DEFAULT_CHANNELS.sms,
    };
  }
  return prefs;
}
