"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** A header link that knows when it is the page you are on. */
export function NavLink({ href, children, exact = false }: { href: string; children: React.ReactNode; exact?: boolean }) {
  const path = usePathname() || "/";
  const on = exact ? path === href : path === href || path.startsWith(href + "/");
  return (
    <Link
      href={href}
      aria-current={on ? "page" : undefined}
      className={`whitespace-nowrap rounded-[var(--radius-sm)] px-2.5 py-1.5 text-sm font-semibold transition ${
        on ? "bg-surface text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900"
      }`}
    >
      {children}
    </Link>
  );
}
