import Link from "next/link";
import type { ReactNode } from "react";

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

export function TopBar({ crumbs, right }: { crumbs?: ReactNode; right?: ReactNode }) {
  return (
    <header className="top">
      <div className="top-in">
        <Link href="/" className="brand">
          <Marks />
          <span className="brand-name">Signify Learning</span>
        </Link>
        {crumbs ? <nav className="crumbs" aria-label="Where you are">{crumbs}</nav> : null}
        <span className="spacer" />
        {right}
      </div>
    </header>
  );
}
