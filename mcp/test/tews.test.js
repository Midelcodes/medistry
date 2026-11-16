import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreTews, triage, detectDeterioration } from "../src/tews.js";

const normal = { mobility: "walking", respiratoryRate: 16, heartRate: 80, systolicBP: 120, temperatureC: 36.8, avpu: "alert", trauma: false };

test("normal vitals: RR 15-20 band scores 1, everything else 0 -> GREEN", () => {
  const r = triage(normal);
  assert.equal(r.tews, 1); assert.equal(r.category, "GREEN");
});
test("score bands", () => {
  assert.equal(scoreTews({ ...normal, respiratoryRate: 8 }).parts.respiratoryRate, 2);
  assert.equal(scoreTews({ ...normal, respiratoryRate: 30 }).parts.respiratoryRate, 3);
  assert.equal(scoreTews({ ...normal, heartRate: 130 }).parts.heartRate, 3);
  assert.equal(scoreTews({ ...normal, systolicBP: 70 }).parts.systolicBP, 3);
  assert.equal(scoreTews({ ...normal, systolicBP: 200 }).parts.systolicBP, 2);
  assert.equal(scoreTews({ ...normal, temperatureC: 34.9 }).parts.temperature, 2);
  assert.equal(scoreTews({ ...normal, avpu: "pain" }).parts.avpu, 2);
});
test("TEWS >= 7 is RED", () => {
  const r = triage({ mobility: "immobile", respiratoryRate: 32, heartRate: 135, systolicBP: 75, temperatureC: 38.9, avpu: "voice", trauma: true });
  assert.equal(r.category, "RED");
});
test("TEWS 5-6 is ORANGE, 3-4 is YELLOW", () => {
  assert.equal(triage({ ...normal, mobility: "immobile", respiratoryRate: 25, heartRate: 115, avpu: "alert" }).category, "ORANGE");
  assert.equal(triage({ ...normal, respiratoryRate: 25, heartRate: 105 }).category, "YELLOW");
});
test("emergency sign overrides a normal score", () => {
  assert.equal(triage({ ...normal, signs: ["active_seizure"] }).category, "RED");
});
test("very-urgent discriminator upgrades GREEN to ORANGE but never downgrades RED", () => {
  assert.equal(triage({ ...normal, signs: ["chest_pain"] }).category, "ORANGE");
  assert.equal(triage({ ...normal, signs: ["active_seizure", "chest_pain"] }).category, "RED");
});
test("deterioration: rising score is flagged, stable is not", () => {
  const worse = { ...normal, respiratoryRate: 26, heartRate: 118, avpu: "voice" };
  assert.equal(detectDeterioration([normal, worse]).deteriorating, true);
  assert.equal(detectDeterioration([normal, { ...normal }]).deteriorating, false);
});
test("deterioration: AVPU drop from alert flagged", () => {
  const r = detectDeterioration([normal, { ...normal, avpu: "pain" }]);
  assert.ok(r.flags.some((f) => f.includes("consciousness")));
});
// Phase 19 (clinical safety): a value outside every band must never fall through to GREEN.
test("fractional or missing vitals are refused, not scored as GREEN", () => {
  for (const bad of [{ respiratoryRate: 8.5 }, { heartRate: 50.5 }, { systolicBP: 100.5 }, { respiratoryRate: undefined }, { temperatureC: NaN }, { mobility: "crawling" }, { avpu: "confused" }]) {
    assert.throws(() => triage({ ...normal, ...bad }), /Cannot score TEWS/, JSON.stringify(bad));
  }
});
test("every integer band boundary scores as implemented (see docs/clinical/TEWS_VALIDATION_CHECKLIST.md)", () => {
  const at = (k, v) => scoreTews({ ...normal, [k]: v }).parts[k];
  const cases = {
    respiratoryRate: [[8, 2], [9, 0], [14, 0], [15, 1], [20, 1], [21, 2], [29, 2], [30, 3]],
    heartRate: [[40, 2], [41, 1], [50, 1], [51, 0], [100, 0], [101, 1], [110, 1], [111, 2], [129, 2], [130, 3]],
    systolicBP: [[70, 3], [71, 2], [80, 2], [81, 1], [100, 1], [101, 0], [199, 0], [200, 2]],
  };
  for (const [k, list] of Object.entries(cases)) for (const [v, want] of list) assert.equal(at(k, v), want, `${k}=${v}`);
  const temp = (t) => scoreTews({ ...normal, temperatureC: t }).parts.temperature;
  assert.deepEqual([temp(34.9), temp(35), temp(38.4), temp(38.5)], [2, 0, 0, 2]);
});
