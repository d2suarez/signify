import { APP_URL, sendMail } from "./mail";
import { sendPushToUser } from "./push";
import { sendSms } from "./sms";
import { resolvePrefs } from "./notify-prefs";

type NotifiableUser = {
  id: string;
  email: string;
  phone: string | null;
  role: string;
  notifyPrefs: string;
};

export type Notification = {
  title: string;
  body: string;
  /** App-relative URL, e.g. /dashboard/tickets/12 */
  url: string;
};

/** Deliver one event to each user over the channels they've opted into. */
export async function notifyUsers(
  users: NotifiableUser[],
  eventKey: string,
  note: Notification
) {
  const link = `${APP_URL}${note.url}`;
  await Promise.allSettled(
    users.map(async (user) => {
      const channels = resolvePrefs(user)[eventKey];
      if (!channels) return;
      const jobs: Promise<unknown>[] = [];
      if (channels.email) {
        jobs.push(sendMail(user.email, note.title, `${note.body}\n\n${link}`));
      }
      if (channels.push) {
        jobs.push(sendPushToUser(user.id, note.title, note.body, note.url));
      }
      if (channels.sms && user.phone) {
        jobs.push(sendSms(user.phone, `${note.title} — ${note.body} ${link}`));
      }
      await Promise.allSettled(jobs);
    })
  );
}
