import Link from "next/link";
import { getCurrentUser, isAgent } from "@/lib/auth";
import { getDict } from "@/lib/lang";
import { BrandMark } from "./brand-mark";
import { LangToggle } from "./lang-toggle";
import { NavLink } from "./nav-link";

/**
 * One header for every page. Sticky and frosted, like Teacher's Desk, so the
 * page scrolls under it. The nine-dot app switcher mounts itself into
 * [data-signify-switcher].
 */
export async function AppHeader({ mode = "requester" }: { mode?: "requester" | "agent" }) {
  const user = await getCurrentUser();
  const { lang, t } = await getDict();
  const agent = !!user && isAgent(user);

  return (
    <header
      className="sticky top-0 z-30 print:hidden"
      style={{
        background: "color-mix(in srgb, var(--bg) 86%, transparent)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
      }}
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href={mode === "agent" ? "/dashboard" : "/"} className="flex items-center gap-2.5 text-slate-900 no-underline">
          <BrandMark size={13} />
          <span className="font-display text-lg font-extrabold tracking-tight" style={{ fontStretch: "112%" }}>
            Help Desk
          </span>
        </Link>

        {user && (
          <nav className="order-last -mx-1 flex w-full min-w-0 items-center gap-1 overflow-x-auto px-1 md:order-none md:w-auto md:flex-1">
            {mode === "agent" ? (
              <>
                <NavLink href="/dashboard" exact>Tickets</NavLink>
                <NavLink href="/projects">Projects</NavLink>
                <NavLink href="/dashboard/devices">Devices</NavLink>
                <NavLink href="/dashboard/kb">Articles</NavLink>
                <NavLink href="/dashboard/recurring">Recurring</NavLink>
                {user.role === "ADMIN" && (
                  <>
                    <NavLink href="/dashboard/forms">Forms</NavLink>
                    <NavLink href="/dashboard/users">People</NavLink>
                  </>
                )}
              </>
            ) : (
              <>
                <NavLink href="/" exact>{t.newRequest}</NavLink>
                <NavLink href="/my">{t.myRequests}</NavLink>
                <NavLink href="/projects">{t.projects}</NavLink>
                <NavLink href="/kb">{t.helpCenter}</NavLink>
                {agent && <NavLink href="/dashboard">{t.dashboard}</NavLink>}
              </>
            )}
          </nav>
        )}

        <div className="ml-auto flex flex-none items-center gap-2">
          {mode === "requester" && <LangToggle current={lang} />}
          {user ? (
            <>
              <Link href="/settings" className="btn-ghost hidden sm:inline-flex" title={t.settings}>
                {t.settings}
              </Link>
              <div data-signify-switcher className="flex items-center" />
              <a href="/auth/logout" className="btn-secondary px-3 py-1.5 text-xs">{t.signOut}</a>
            </>
          ) : (
            <a href="/auth/login" className="btn-primary px-3 py-1.5 text-xs">{t.signIn}</a>
          )}
        </div>
      </div>
    </header>
  );
}
