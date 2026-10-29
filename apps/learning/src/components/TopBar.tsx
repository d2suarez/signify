import Link from "next/link";
import type { ReactNode } from "react";
import { readMe } from "@/lib/auth";
import { lang, myPrefs } from "@/lib/access";
import { dict } from "@/lib/i18n";
import Supports from "./Supports";

export function Marks() {
  return (
    <span className="marks" aria-hidden="true">
      <span className="shape s-circle" style={{ width: 10, height: 10 }} />
      <span className="shape s-square" style={{ width: 10, height: 10 }} />
      <span className="shape s-tri" style={{ width: 10, height: 10 }} />
      <span className="shape s-arch" style={{ width: 10, height: 10 }} />
    </span>
  );
}

export async function TopBar({ crumbs, right }: { crumbs?: ReactNode; right?: ReactNode }) {
  // Reading supports are on every signed-in page, so a student never has to hunt for them.
  const me = await readMe();
  const supports = me ? <Supports initial={await myPrefs()} d={dict(await lang())} /> : null;
  return (
    <header className="top">
      <div className="top-in">
        <Link href="/" className="brand">
          <Marks />
          <span className="brand-name">Signify Learning</span>
        </Link>
        {crumbs ? <nav className="crumbs" aria-label="Where you are">{crumbs}</nav> : null}
        <span className="spacer" />
        {supports}
        {right}
      </div>
    </header>
  );
}
