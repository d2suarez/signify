export type FormFieldDef = {
  id: string;
  label: string;
  type: "TEXT" | "TEXTAREA" | "SELECT" | "CHECKBOX" | "DATE";
  required: boolean;
  options: string[];
};

export type TicketFieldValue = { label: string; value: string };

export const FIELD_TYPES: Record<string, string> = {
  TEXT: "Short answer",
  TEXTAREA: "Paragraph",
  SELECT: "Dropdown",
  CHECKBOX: "Checkbox",
  DATE: "Date",
};

export const FIELD_TYPE_VALUES = Object.keys(FIELD_TYPES);

export function parseFields(json: string): FormFieldDef[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f) => f && typeof f.id === "string" && typeof f.label === "string"
    );
  } catch {
    return [];
  }
}

export function parseRoles(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((r) => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/** Admins can open any form (management/preview); others need a listed role on an active form. */
export function canUseForm(
  user: { role: string },
  form: { active: boolean; roles: string }
): boolean {
  if (user.role === "ADMIN") return true;
  if (!form.active) return false;
  return parseRoles(form.roles).includes(user.role);
}

export function parseTicketFields(json: string | null | undefined): TicketFieldValue[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v) => v && typeof v.label === "string" && typeof v.value === "string");
  } catch {
    return [];
  }
}
