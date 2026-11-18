/**
 * Signify ID roles (the `role` claim) that run a school in Learning: grading
 * periods, scales, LTI, moderating whole-school updates, answering share
 * requests. ID's built-in school admin is `local_admin` (Desmond, 2026-11-17:
 * count it); `admin` is kept for the dev person and older tokens;
 * `super_admin` is a platform admin.
 */
export const SCHOOL_ADMIN_ROLES = new Set(["local_admin", "admin", "super_admin"]);

export function isSchoolAdminRole(role: string | null | undefined): boolean {
  return !!role && SCHOOL_ADMIN_ROLES.has(role);
}
