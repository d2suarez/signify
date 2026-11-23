"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState } from "react";
import type { DrawerCourse, DrawerData } from "@/app/api/my-courses/route";
import { LiveJoin } from "./LiveJoin";

export type DrawerWords = Record<
  "cdButton" | "cdTitle" | "cdHint" | "cdFilter" | "cdNoMatch" | "cdLoading" | "cdFailed" | "cdHere" | "cdGoHome" | "close" | "tryAgain"
  | "teaching" | "learning" | "clubsTitle" | "yourChildren" | "seeAllWork" | "liveNow" | "joinLive" | "liveNowJoin" | "covering" | "clubSponsors" | "clubLabel"
  | "noCourses" | "childrenFailed",
  string
>;

/** Shown once the list is longer than this. */
const FILTER_FROM = 7;

/**
 * "Courses" in the top bar: a drawer over the page, from the left, with every
 * class, club and child the home page lists. Asked for when it opens (and
 * once more on each open, so live markers are current). A modal <dialog>, so
 * focus stays inside, Esc closes it and focus goes back to the button.
 */
export default function CourseDrawer({ w }: { w: DrawerWords }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [data, setData] = useState<DrawerData | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  const path = usePathname() || "/";
  const busy = useRef(false);

  const load = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const res = await fetch("/api/my-courses", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      busy.current = false;
    }
  };

  const open = () => {
    setQ("");
    dialog.current?.showModal();
    void load();
  };
  const close = () => dialog.current?.close();

  const here = (href: string) => {
    const m = href.match(/^\/(courses|family)\/([^/]+)/);
    return !!m && (path === `/${m[1]}/${m[2]}` || path.startsWith(`/${m[1]}/${m[2]}/`));
  };

  const all = data ? data.teaching.length + data.learning.length + data.clubs.length + data.children.length : 0;
  const needle = q.trim().toLowerCase();
  const match = (s: string) => !needle || s.toLowerCase().includes(needle);
  const pick = (list: DrawerCourse[]) => list.filter((c) => match(`${c.name} ${c.sub}`));
  const teaching = data ? pick(data.teaching) : [];
  const learning = data ? pick(data.learning) : [];
  const clubs = data ? pick(data.clubs) : [];
  const children = data ? data.children.filter((k) => match(k.name)) : [];
  const shown = teaching.length + learning.length + clubs.length + children.length;

  const Row = ({ href, name, sub, shape, pills, after }: { href: string; name: string; sub?: string; shape: string; pills?: React.ReactNode; after?: React.ReactNode }) => {
    const cur = here(href);
    return (
      <li className="class-row">
        <Link href={href} className="class-link drawer-link" aria-current={cur ? "page" : undefined} onClick={close}>
          <span className={`shape ${shape}`} aria-hidden="true" />
          <span className="grow" style={{ minWidth: 0 }}>
            <span className="class-name">{name}</span>
            {sub && <span className="muted class-sub">{sub}</span>}
            {cur && <span className="drawer-here">{w.cdHere}</span>}
          </span>
          {pills}
        </Link>
        {after}
      </li>
    );
  };
  const courseRow = (c: DrawerCourse) => (
    <Row key={c.id} href={c.href} name={c.name}
      sub={c.club ? (c.role === "teacher" ? w.clubSponsors : w.clubLabel) : c.sub}
      shape={c.club ? "s-arch" : c.role === "teacher" ? "s-square" : "s-arch"}
      pills={c.covering ? <span className="pill">{w.covering}</span> : undefined}
      after={c.liveHref ? <LiveJoin href={c.liveHref} label={`${w.joinLive}: ${c.name}`} text={w.liveNowJoin} onClick={close} /> : undefined} />
  );
  const Group = ({ id, title, children: kids }: { id: string; title: string; children: React.ReactNode }) => (
    <section aria-labelledby={id} className="drawer-group">
      <h3 id={id} className="label">{title}</h3>
      <ul className="class-list">{kids}</ul>
    </section>
  );

  return (
    <>
      <button ref={button} type="button" className="btn btn-sm drawer-btn" aria-haspopup="dialog" onClick={open} onPointerEnter={() => { if (!data) void load(); }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <path d="M4 6h16M4 12h16M4 18h10" />
        </svg>
        <span className="btn-word">{w.cdButton}</span>
      </button>
      <dialog ref={dialog} className="drawer" aria-labelledby="drawer-title" aria-describedby="drawer-hint"
        onClose={() => button.current?.focus()}
        onClick={(e) => { if (e.target === dialog.current) close(); }}>
        <div className="drawer-in">
          <div className="row">
            <h2 id="drawer-title" style={{ fontSize: 22, flex: 1 }}>{w.cdTitle}</h2>
            <button type="button" className="btn btn-sm" onClick={close}>{w.close}</button>
          </div>
          <p id="drawer-hint" className="muted" style={{ margin: 0, fontSize: 14 }}>{w.cdHint}</p>
          <ul className="class-list">
            <Row href="/" name={w.cdGoHome} shape="s-circle" />
          </ul>
          {all >= FILTER_FROM && (
            <label className="stack" style={{ gap: 4 }}>
              <span className="label">{w.cdFilter}</span>
              <input className="field" type="search" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
            </label>
          )}
          {!data && !failed && <p className="muted" role="status" style={{ margin: 0 }}>{w.cdLoading}</p>}
          {failed && (
            <div className="notice notice-bad" role="alert">
              {w.cdFailed} <button type="button" className="btn btn-sm" onClick={() => void load()}>{w.tryAgain}</button>
            </div>
          )}
          {data && !data.ok && <div className="notice notice-bad" role="alert">{w.cdFailed}</div>}
          {data && (
            <>
              {teaching.length > 0 && <Group id="dr-teaching" title={w.teaching}>{teaching.map(courseRow)}</Group>}
              {learning.length > 0 && <Group id="dr-learning" title={w.learning}>{learning.map(courseRow)}</Group>}
              {clubs.length > 0 && <Group id="dr-clubs" title={w.clubsTitle}>{clubs.map(courseRow)}</Group>}
              {children.length > 0 && (
                <Group id="dr-children" title={w.yourChildren}>
                  {children.map((k) => <Row key={k.id} href={k.href} name={k.name} sub={w.seeAllWork} shape="s-circle" />)}
                </Group>
              )}
              {data.parent && !data.childrenOk && <div className="notice notice-bad" role="alert">{w.childrenFailed}</div>}
              {needle && shown === 0 && <p className="empty" role="status" style={{ margin: 0 }}>{w.cdNoMatch}</p>}
              {!needle && all === 0 && data.ok && <p className="empty" style={{ margin: 0 }}>{w.noCourses}</p>}
            </>
          )}
        </div>
      </dialog>
    </>
  );
}
