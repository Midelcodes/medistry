# TEWS Validation Checklist (SATS, adults and children aged 12 or over)

For a clinician to check every band, threshold and discriminator **as implemented** in `mcp/src/tews.js` against
the **official SATS manual** (record the edition and page). The "Implemented" column is copied from the code and
pinned by `mcp/test/tews.test.js`; the "Expected" column is for the reviewer. Do not edit the code to match a
reviewer's value without a new review of this checklist.

Until every row passes and the [clinical safety case](CLINICAL_SAFETY_CASE.md) is signed, every triage result shows
"Triage scoring not clinically validated" (`mcp/src/validation.js`). The operator then sets
`CLINICAL_VALIDATION_SIGNED=1`.

| Reviewer | Registration | SATS manual edition | Date |
|---|---|---|---|
| | | | |

How values are scored: rates and blood pressure are whole numbers; a value is scored by the band whose range
includes it; any value outside every band is refused (it is never scored as 0).

## 1. Mobility

| # | Input | Implemented points | Expected (SATS, page) | Pass / Fail | Reviewer |
|---|---|---|---|---|---|
| M1 | walking | 0 | | | |
| M2 | with help | 1 | | | |
| M3 | immobile (stretcher / wheelchair) | 2 | | | |

## 2. Respiratory rate (breaths per minute)

| # | Range | Implemented points | Expected (SATS, page) | Pass / Fail | Reviewer |
|---|---|---|---|---|---|
| R1 | 0 to 8 | 2 | | | |
| R2 | 9 to 14 | 0 | | | |
| R3 | 15 to 20 | 1 | | | |
| R4 | 21 to 29 | 2 | | | |
| R5 | 30 or more | 3 | | | |

## 3. Heart rate (beats per minute)

| # | Range | Implemented points | Expected (SATS, page) | Pass / Fail | Reviewer |
|---|---|---|---|---|---|
| H1 | 0 to 40 | 2 | | | |
| H2 | 41 to 50 | 1 | | | |
| H3 | 51 to 100 | 0 | | | |
| H4 | 101 to 110 | 1 | | | |
| H5 | 111 to 129 | 2 | | | |
| H6 | 130 or more | 3 | | | |

## 4. Systolic blood pressure (mmHg)

| # | Range | Implemented points | Expected (SATS, page) | Pass / Fail | Reviewer |
|---|---|---|---|---|---|
| B1 | 0 to 70 | 3 | | | |
| B2 | 71 to 80 | 2 | | | |
| B3 | 81 to 100 | 1 | | | |
| B4 | 101 to 199 | 0 | | | |
| B5 | 200 or more | 2 | | | |

## 5. Temperature (°C)

| # | Range | Implemented points | Expected (SATS, page) | Pass / Fail | Reviewer |
|---|---|---|---|---|---|
| T1 | below 35 ("cold") | 2 | | | |
| T2 | 35 to 38.4 | 0 | | | |
| T3 | above 38.4 ("hot") | 2 | | | |

## 6. Level of consciousness (AVPU)

| # | Input | Implemented points | Expected (SATS, page) | Pass / Fail | Reviewer |
|---|---|---|---|---|---|
| A1 | alert | 0 | | | |
| A2 | reacts to voice | 1 | | | |
| A3 | reacts to pain | 2 | | | |
| A4 | unresponsive | 3 | | | |
| A5 | any other state the manual scores (e.g. "confused", new onset) | **not implemented**: refused | | | |

## 7. Trauma

| # | Input | Implemented points | Expected (SATS, page) | Pass / Fail | Reviewer |
|---|---|---|---|---|---|
| X1 | trauma: yes | 1 | | | |
| X2 | trauma: no | 0 | | | |

## 8. Category from the total score

| # | Total TEWS | Implemented category | Target time to clinician (implemented) | Expected (SATS, page) | Pass / Fail | Reviewer |
|---|---|---|---|---|---|---|
| C1 | 7 or more | RED (Emergency) | immediate (0 minutes) | | | |
| C2 | 5 to 6 | ORANGE (Very urgent) | 10 minutes | | | |
| C3 | 3 to 4 | YELLOW (Urgent) | 60 minutes | | | |
| C4 | 0 to 2 | GREEN (Routine) | 240 minutes | | | |

## 9. Emergency signs (force RED whatever the score)

| # | Code name | Implemented meaning | In the SATS emergency list? Wording? (page) | Pass / Fail | Reviewer |
|---|---|---|---|---|---|
| E1 | `airway_compromised` | airway compromised | | | |
| E2 | `not_breathing` | not breathing | | | |
| E3 | `active_seizure` | seizure, current | | | |
| E4 | `facial_burn_or_inhalation` | burn to the face or inhalation injury | | | |
| E5 | `hypoglycaemia` | hypoglycaemia (the threshold glucose value is **not implemented**: the sign is entered by the clinician) | | | |
| E6 | `cardiac_arrest` | cardiac arrest | | | |
| E7 | emergency signs in the manual that are missing from this list | _(list them)_ | | | |

## 10. Very urgent signs (upgrade to ORANGE; never downgrade RED)

| # | Code name | Implemented meaning | In the SATS very-urgent list? Wording? (page) | Pass / Fail | Reviewer |
|---|---|---|---|---|---|
| V1 | `shortness_of_breath` | shortness of breath | | | |
| V2 | `coughing_blood` | coughing blood | | | |
| V3 | `chest_pain` | chest pain | | | |
| V4 | `uncontrolled_haemorrhage` | haemorrhage, uncontrolled | | | |
| V5 | `post_ictal` | post-ictal | | | |
| V6 | `focal_neurology` | focal neurology | | | |
| V7 | `reduced_consciousness` | reduced level of consciousness | | | |
| V8 | `severe_pain` | severe pain | | | |
| V9 | `poisoning_or_overdose` | poisoning or overdose | | | |
| V10 | `stab_wound_neck_or_chest` | stab wound to the neck or chest | | | |
| V11 | `pregnancy_with_bleeding` | pregnancy with bleeding (or abdominal pain, per the manual?) | | | |
| V12 | very-urgent signs in the manual that are missing from this list | _(list them)_ | | | |
| V13 | urgent (YELLOW) discriminators | **not implemented**: there is no YELLOW discriminator list | | | |

## 11. Rules and population

| # | Rule as implemented | Expected (SATS, page) | Pass / Fail | Reviewer |
|---|---|---|---|---|
| P1 | Emergency signs override the score (RED) | | | |
| P2 | A very-urgent sign raises GREEN or YELLOW to ORANGE and never lowers a category | | | |
| P3 | Ages 12 and over only; younger patients are refused (no paediatric scale) | | | |
| P4 | Deterioration flags (`detectDeterioration`): a rise of 2 or more over the series, a jump of 2 or more since the last set, current TEWS 7 or more, crossing into 5 or more, AVPU dropping from alert. These are Medistry's own rules, not SATS: confirm they are safe and useful | | | |
| P5 | Missing or out-of-range vitals are refused rather than scored as 0 (Phase 19 fix) | | | |

## 12. Result

| | |
|---|---|
| Rows failed (ids) | |
| Changes requested | |
| All rows pass after changes? | |
| Reviewer signature and date | |
| Operator: `CLINICAL_VALIDATION_SIGNED=1` set on (date, deployment) | |
