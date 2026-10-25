import { requireUser } from "@/lib/auth";
import { isEmailEnabled } from "@/lib/mail";
import { smsEnabled } from "@/lib/sms";
import { vapidPublicKey } from "@/lib/push";
import { eventsForRole, resolvePrefs } from "@/lib/notify-prefs";
import { USER_ROLES } from "@/lib/labels";
import { NotificationPrefsForm } from "@/components/notification-prefs-form";
import { PushToggle } from "@/components/push-toggle";
import { SiteHeader } from "@/components/site-header";
import { TestEmail } from "@/components/test-email";

export const dynamic = "force-dynamic";
export const metadata = { title: "Settings" };

const IDENTITY_URL = (process.env.SIGNIFY_ISSUER || "https://id.signify.one").replace(/\/+$/, "");

export default async function SettingsPage() {
  const user = await requireUser();
  const emailEnabled = await isEmailEnabled();

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>

        <section className="card p-5">
          <h2 className="mb-1 text-base font-semibold">Your account</h2>
          <p className="text-sm text-slate-600">
            <span className="font-medium">{user.name}</span> ({user.email}) ·{" "}
            {USER_ROLES[user.role] ?? user.role}
          </p>
          <p className="mt-2 text-sm text-slate-500">
            You sign in with Signify ID. Your name, picture and role come from there;{" "}
            <a href={IDENTITY_URL} className="font-medium text-blue-700 underline">
              open Signify ID
            </a>{" "}
            to see them.
          </p>
        </section>

        <section className="card p-5">
          <h2 className="mb-1 text-base font-semibold">Notifications on this device</h2>
          <p className="mb-4 text-sm text-slate-500">
            Enable once per device you want pop-up notifications on (works great on Chromebooks
            and desktops).
          </p>
          <PushToggle vapidPublicKey={vapidPublicKey} />
        </section>

        <section className="card p-5">
          <h2 className="mb-4 text-base font-semibold">What to notify me about</h2>
          <NotificationPrefsForm
            events={eventsForRole(user.role)}
            prefs={resolvePrefs(user)}
            phone={user.phone ?? ""}
            emailAvailable={emailEnabled}
            smsAvailable={smsEnabled}
          />
        </section>

        {user.role === "ADMIN" && (
          <section className="card p-5">
            <h2 className="mb-1 text-base font-semibold">Backups (admin)</h2>
            <p className="mb-4 text-sm text-slate-500">
              Every day the database and attachments are encrypted and copied off this server,
              and kept for 28 days. You can also download the database right now. That copy is
              not encrypted and holds every request, so keep it somewhere private.
            </p>
            <a href="/api/backup" className="btn-secondary">
              Download backup now
            </a>
          </section>
        )}

        {user.role === "ADMIN" && (
          <section className="card p-5">
            <h2 className="mb-1 text-base font-semibold">Email delivery (admin)</h2>

            <p className="mb-4 text-sm text-slate-500">
              Email is{" "}
              <span className="font-medium">{emailEnabled ? "on (SMTP)" : "not set up"}</span>.
              {!emailEnabled &&
                " Notifications still reach people as app notifications on any device they turn them on for."}
            </p>
            <TestEmail />
          </section>
        )}

      </main>
    </div>
  );
}
