import type { GroupsShown } from "@/lib/groups";
import type { Dict } from "@/lib/i18n";

/**
 * A group set as a slide or a reader card shows it (story 01, D8): every
 * group, or only the student's own. The student's group is marked with a
 * word, never colour alone.
 */
export default function GroupsView({ shown, title, d, stage }: {
  shown?: GroupsShown; title: string; d: Pick<Dict, "blockGroups" | "grpNothing" | "grpYours" | "grpEmpty">; stage?: boolean;
}) {
  if (!shown || !shown.groups.length) {
    return <p className={stage ? "stage-foot" : "muted"}>{d.grpNothing}</p>;
  }
  return (
    <ul className={`group-grid${stage ? " is-stage" : ""}`} aria-label={title || shown.name || d.blockGroups}>
      {shown.groups.map((g, i) => {
        const mine = shown.mine === i;
        return (
          <li key={i} className={`group-card${mine ? " is-mine" : ""}`}>
            <p className="group-name">
              {g.name}
              {mine && <span className="chip">{d.grpYours}</span>}
            </p>
            {g.members.length
              ? <ul className="group-members">{g.members.map((m, j) => <li key={j}>{m}</li>)}</ul>
              : <p className="muted" style={{ margin: 0 }}>{d.grpEmpty}</p>}
          </li>
        );
      })}
    </ul>
  );
}
