// Break-glass reasons accepted by Medistry. Models sometimes misspell or reword them
// ("UNCONCONSCIOUS", "unconscious patient"), so map close matches to the allowed value.
export const BREAK_GLASS_REASONS = ["UNCONSCIOUS", "LIFE_THREATENING", "PATIENT_UNABLE_TO_CONSENT"];

export function normaliseReason(value) {
  if (typeof value !== "string") return value;
  const v = value.toUpperCase().replace(/[^A-Z]+/g, "_").replace(/^_|_$/g, "");
  if (BREAK_GLASS_REASONS.includes(v)) return v;
  if (/CONSENT/.test(v)) return "PATIENT_UNABLE_TO_CONSENT";
  if (/LIFE|THREAT/.test(v)) return "LIFE_THREATENING";
  if (/UNCON|UNRESP|COLLAPS|COMA/.test(v)) return "UNCONSCIOUS";
  return value;
}
