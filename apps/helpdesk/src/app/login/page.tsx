import { redirect } from "next/navigation";
import { getCurrentUser, isAgent, wrongSchool } from "@/lib/auth";
import { getDict } from "@/lib/lang";
import { BrandMark } from "@/components/brand-mark";
import { LangToggle } from "@/components/lang-toggle";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

/**
 * There is no password here any more: signing in is Signify ID's job. This
 * page is only what a signed-out visitor, or someone from another school,
 * lands on.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ return?: string }>;
}) {
  const user = await getCurrentUser();
  const sp = await searchParams;
  if (user) redirect(sp.return?.startsWith("/") && !sp.return.startsWith("//") ? sp.return : isAgent(user) ? "/dashboard" : "/");
  const { lang, t } = await getDict();
  const other = await wrongSchool();
  const back = sp.return && sp.return.startsWith("/") && !sp.return.startsWith("//") ? sp.return : "/";

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <div className="card p-8">
        <BrandMark size={18} />
        <h1 className="mt-5 text-3xl font-extrabold tracking-tight" style={{ fontStretch: "112%" }}>
          Help Desk
        </h1>
        <p className="mt-2 text-slate-600">{t.loginSubtitle}</p>
        {other && (
          <p className="mt-5 rounded-[var(--radius-md)] bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {t.wrongSchool}
          </p>
        )}
        <a href={other ? "/auth/logout" : `/auth/login?return=${encodeURIComponent(back)}`} className="btn-primary mt-6 w-full py-3 text-base">
          {other ? t.signOut : t.signInBtn}
        </a>
        <p className="mt-4 text-sm text-slate-500">{t.accountsNote}</p>
      </div>
      <div className="mt-4 flex justify-center">
        <LangToggle current={lang} />
      </div>
    </div>
  );
}
