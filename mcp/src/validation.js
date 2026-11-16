// Clinical validation status of the triage scoring (TEWS bands and discriminators in tews.js).
// Until a named clinician has checked every band and discriminator against the official SATS manual
// (docs/clinical/TEWS_VALIDATION_CHECKLIST.md) and the operator sets CLINICAL_VALIDATION_SIGNED=1, every
// place that shows a triage score also shows this banner: the server's start-up log, each scoring tool
// result and the handover report. No dependencies, so the root test suite can import it.

export const VALIDATION_BANNER = "Triage scoring not clinically validated";

/** True only when the sign-off flag is exactly "1". */
export const triageValidated = (env = process.env) => String(env.CLINICAL_VALIDATION_SIGNED ?? "").trim() === "1";

/** The banner text, or null once validation is signed. */
export const validationBanner = (env = process.env) => (triageValidated(env) ? null : VALIDATION_BANNER);

/** Start-up line for the log (stderr on a stdio MCP server), or null once signed. */
export function startupBanner(env = process.env) {
  const b = validationBanner(env);
  return b ? `WARNING: ${b}. Decision support only; see docs/clinical/TEWS_VALIDATION_CHECKLIST.md. Set CLINICAL_VALIDATION_SIGNED=1 only after clinical sign-off.` : null;
}

/** Adds the banner to a scoring result (first field, so a client shows it first). Unchanged once signed. */
export function withValidationBanner(result, env = process.env) {
  const b = validationBanner(env);
  return b ? { validationBanner: b, ...result } : result;
}

/** Markdown lines for the top of a report. */
export const reportBannerLines = (env = process.env) => {
  const b = validationBanner(env);
  return b ? [`> **${b}.** Decision support only; a clinician makes the triage decision.`, ""] : [];
};
