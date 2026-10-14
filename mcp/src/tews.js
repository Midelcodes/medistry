// Adult triage logic based on the South African Triage Scale (SATS) TEWS.
// DECISION SUPPORT ONLY. Thresholds must be validated against the official SATS
// manual and by clinicians before any real-world use. Adults / age >= 12 only.

export const CATEGORIES = {
  RED: { rank: 0, label: "Emergency", targetMinutes: 0 },
  ORANGE: { rank: 1, label: "Very urgent", targetMinutes: 10 },
  YELLOW: { rank: 2, label: "Urgent", targetMinutes: 60 },
  GREEN: { rank: 3, label: "Routine", targetMinutes: 240 },
};

const band = (v, rules) => rules.find(([lo, hi]) => v >= lo && v <= hi)?.[2];

export function scoreTews(o) {
  const parts = {};
  parts.mobility = { walking: 0, with_help: 1, immobile: 2 }[o.mobility];
  parts.respiratoryRate = band(o.respiratoryRate, [
    [0, 8, 2], [9, 14, 0], [15, 20, 1], [21, 29, 2], [30, 200, 3],
  ]);
  parts.heartRate = band(o.heartRate, [
    [0, 40, 2], [41, 50, 1], [51, 100, 0], [101, 110, 1], [111, 129, 2], [130, 300, 3],
  ]);
  parts.systolicBP = band(o.systolicBP, [
    [0, 70, 3], [71, 80, 2], [81, 100, 1], [101, 199, 0], [200, 400, 2],
  ]);
  parts.temperature = o.temperatureC < 35 || o.temperatureC > 38.4 ? 2 : 0;
  parts.avpu = { alert: 0, voice: 1, pain: 2, unresponsive: 3 }[o.avpu];
  parts.trauma = o.trauma ? 1 : 0;
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { total, parts };
}

// Clinical discriminators that override the numeric score.
export const EMERGENCY_SIGNS = [
  "airway_compromised", "not_breathing", "active_seizure",
  "facial_burn_or_inhalation", "hypoglycaemia", "cardiac_arrest",
];
export const VERY_URGENT_SIGNS = [
  "shortness_of_breath", "coughing_blood", "chest_pain", "uncontrolled_haemorrhage",
  "post_ictal", "focal_neurology", "reduced_consciousness", "severe_pain",
  "poisoning_or_overdose", "stab_wound_neck_or_chest", "pregnancy_with_bleeding",
];

export function triage(input) {
  const { total, parts } = scoreTews(input);
  const signs = input.signs ?? [];
  const reasons = [];
  let cat;

  const emergency = signs.filter((s) => EMERGENCY_SIGNS.includes(s));
  const veryUrgent = signs.filter((s) => VERY_URGENT_SIGNS.includes(s));

  if (emergency.length) { cat = "RED"; reasons.push(`Emergency sign(s): ${emergency.join(", ")}`); }
  else if (total >= 7) { cat = "RED"; reasons.push(`TEWS ${total} >= 7`); }
  else if (total >= 5) { cat = "ORANGE"; reasons.push(`TEWS ${total} in 5-6`); }
  else if (total >= 3) { cat = "YELLOW"; reasons.push(`TEWS ${total} in 3-4`); }
  else { cat = "GREEN"; reasons.push(`TEWS ${total} in 0-2`); }

  if (veryUrgent.length && CATEGORIES[cat].rank > CATEGORIES.ORANGE.rank) {
    cat = "ORANGE";
    reasons.push(`Very-urgent discriminator(s) upgrade to ORANGE: ${veryUrgent.join(", ")}`);
  }
  return {
    category: cat,
    ...CATEGORIES[cat],
    tews: total,
    tewsBreakdown: parts,
    reasons,
    disclaimer: "Decision support only. A clinician makes the final triage decision.",
  };
}

// Deterioration across ordered observation sets (oldest -> newest).
export function detectDeterioration(series) {
  const scores = series.map((o) => scoreTews(o).total);
  const first = scores[0], last = scores.at(-1);
  const delta = last - first;
  const prev = scores.length > 1 ? scores.at(-2) : first;
  const flags = [];
  if (delta >= 2) flags.push(`TEWS rose by ${delta} over the series`);
  if (last - prev >= 2) flags.push(`Sudden jump of ${last - prev} since last observation`);
  if (last >= 7) flags.push("Current TEWS >= 7 (emergency threshold)");
  else if (last >= 5 && first < 5) flags.push("Crossed into ORANGE range (TEWS >= 5)");
  if (series.length > 1 && series.at(-2).avpu === "alert" && series.at(-1).avpu !== "alert")
    flags.push("Drop in consciousness (AVPU) from alert");
  return {
    scores, delta, deteriorating: flags.length > 0, flags,
    action: flags.length
      ? "Escalate: re-triage immediately and alert the clinician in charge."
      : "Continue routine observations.",
  };
}
