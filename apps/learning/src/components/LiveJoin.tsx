import Link from "next/link";

/**
 * "Live now" as a button: the live dot and the words, and pressing it joins
 * the class's live lesson (students follow, teachers go back to presenting).
 * `href` from `liveJoinHref`.
 */
export function LiveJoin({ href, label, text, onClick }: { href: string; label: string; text: string; onClick?: () => void }) {
  return (
    <Link href={href} className="btn btn-sm btn-live" aria-label={label} onClick={onClick}>
      <span className="live-dot" aria-hidden="true" />{text}
    </Link>
  );
}
