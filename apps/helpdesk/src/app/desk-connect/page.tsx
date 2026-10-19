import { requireUser } from "@/lib/auth";
import { BrandMark } from "@/components/brand-mark";
import { CloseWhenDone } from "./close";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connected" };

/**
 * Opened in a small window by the ticket box on Teacher's Desk. Signing in
 * here (through Signify ID, usually without a click) gives the help desk its
 * own cookie, which the box can then use. Then the window closes itself.
 */
export default async function DeskConnectPage() {
  const user = await requireUser("/desk-connect");
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6 text-center">
      <div className="mx-auto"><BrandMark size={16} /></div>
      <h1 className="mt-4 text-2xl font-extrabold">You&apos;re connected</h1>
      <p className="mt-2 text-slate-600">
        {user.name}, the help desk box on your desk is ready. This window will close on its own.
      </p>
      <CloseWhenDone />
    </main>
  );
}
