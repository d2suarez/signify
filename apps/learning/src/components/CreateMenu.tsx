import Link from "next/link";
import type { Dict } from "@/lib/i18n";
import { CREATE_SHAPE, createKindsFor, type CreateKind } from "@/lib/create-kinds";

export const CREATE_WORDS: Record<CreateKind, { name: keyof Dict; hint: keyof Dict }> = {
  folder: { name: "crFolder", hint: "crFolderHint" },
  page: { name: "crPage", hint: "crPageHint" },
  assignment: { name: "crAssignment", hint: "crAssignmentHint" },
  assessment: { name: "crAssessment", hint: "crAssessmentHint" },
  upload: { name: "crUpload", hint: "crUploadHint" },
  link: { name: "crLink", hint: "crLinkHint" },
  board: { name: "crBoard", hint: "crBoardHint" },
  text: { name: "crText", hint: "crTextHint" },
  classtool: { name: "crClassTool", hint: "crClassToolHint" },
  poll: { name: "crPoll", hint: "crPollHint" },
  lti: { name: "crLti", hint: "crLtiHint" },
};

/**
 * The class page's one "Create" button (and each folder's "Create here"):
 * a menu of everything a teacher can make. Each opens /courses/[id]/new,
 * which puts what is made into the folder it was asked from (`unitId`).
 * Plain links in a <details>, so it works before any script loads.
 */
export function CreateMenu({ courseId, unitId, club, tools, d, here = false }: {
  courseId: string; unitId?: string; club: boolean; tools: boolean; d: Dict;
  /** A folder's own menu ("Create here") rather than the class's. */
  here?: boolean;
}) {
  const kinds = createKindsFor({ club, tools });
  const q = (k: CreateKind) => `/courses/${courseId}/new?what=${k}${unitId ? `&in=${unitId}` : ""}`;
  return (
    <details className="menu create-menu">
      <summary className={here ? "btn btn-sm" : "btn btn-primary"}>
        <span aria-hidden="true">+</span> {here ? d.crCreateHere : d.crCreate}
      </summary>
      <div className="menu-pop card create-pop">
        <ul className="create-list">
          {kinds.map((k) => (
            <li key={k}>
              <Link href={q(k)} className="create-item">
                <span className={`shape ${CREATE_SHAPE[k]}`} aria-hidden="true" />
                <span className="create-words">
                  <b>{d[CREATE_WORDS[k].name]}</b>
                  <span className="muted">{d[CREATE_WORDS[k].hint]}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
