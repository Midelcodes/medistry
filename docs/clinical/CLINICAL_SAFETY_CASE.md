# Clinical Safety Case and Hazard Log

> **Status: DRAFT, not signed.** Prepared by the engineering team from the code and tests. A named clinical safety
> officer must review every hazard, assign severity and likelihood, accept or reject the residual risk, and sign
> section 5. Until then Medistry is for synthetic data only, and the triage scoring shows the banner
> "Triage scoring not clinically validated".

## 1. Scope

- **In scope:** the emergency summary after break-glass, the offline emergency card and scanner, AI-drafted records
  that a doctor signs, the triage decision-support tools in the MCP server (SATS TEWS), allergy display, record
  matching and merging.
- **Intended use:** decision support for trained clinicians. Medistry never makes a clinical decision; the clinician
  does. Triage scoring is for adults and children aged 12 or over only (`mcp/src/server.js` refuses younger ages).
- **Out of scope here:** data protection (see [compliance](../compliance/)) and infrastructure security (see the
  [threat model](../THREAT_MODEL.md)), except where they cause clinical harm.

## 2. How to read the hazard log

Each hazard lists its causes, the controls in the code, the tests that check those controls, and the residual risk
in words. **Severity, likelihood and risk acceptance are left blank on purpose:** they are clinical judgements for the
clinical safety officer. Test files are in `tests/` (main app) and `mcp/test/` (triage).

## 3. Hazard log

### H1. Wrong patient's card or record used

| | |
|---|---|
| Causes | A card found on, or handed over for, the wrong person; a mistyped emergency code; two records for one person, or one record for two people; an EMR import matched to the wrong patient |
| Effect | Treatment based on someone else's blood group, allergies or DNR status |
| Controls | Emergency codes carry a check character that catches single typos and transpositions (`src/lib/code/crockford.ts`). The card shows its own card reference and an emergency contact to call. Imports never create patients, and need the Medistry id or a known facility identifier plus a matching birth date (`src/lib/integrations/fhirImport.ts`). National-ID blind index for exact matches; probable duplicates go to a human; merges are reversible (`src/lib/identity/mpi.ts`) |
| Verified by | `tests/phase3.test.ts` ("Check character detects single-character substitution and transposition typos"); `tests/phase15-intake.test.ts` ("Patients are never created: ..."); `tests/phase16-identity.test.ts` ("A swapped name order ... is flagged as a candidate and NOT merged", "Merge then unmerge restores the original state") |
| Residual risk | **The card carries no name or photo** (data minimisation), so the card itself cannot prove whose it is. Clinicians must confirm identity by other means when they can. Severity / likelihood: _(CSO)_ |
| Actions | Decide whether the printed card should carry a name or photo, weighing privacy against this hazard _(CSO, counsel)_ |

### H2. Stale card

| | |
|---|---|
| Causes | The record changed (new allergy, stopped medication) after the card was printed; the card was replaced or revoked |
| Effect | Treatment based on out-of-date information |
| Controls | A signed record change marks the card stale and notifies the patient to reissue (`src/lib/emergency/cardSync.ts`); opt-in items that were discontinued are removed. Cards expire; the scanner shows expiry and card version. When the scanner syncs, a superseded or revoked card is reported (`src/lib/emergency/offlineScans.ts`) |
| Verified by | `tests/phase8-lifecycle.test.ts` ("A signed medication change marks the card stale and notifies the patient", "A revoked card shows as revoked in offline-scan sync responses"); `tests/phase8-offline-scan.test.ts` ("A superseded card version returns cardStatus superseded; a revoked one returns revoked"); `tests/phase8-scanner.test.ts` ("Expired: genuine signature, payload returned for UNVERIFIED-CURRENT display") |
| Residual risk | Offline, the scanner cannot know a newer card exists until it syncs. The card shows when it was issued; clinicians should prefer the online summary when connected. Severity / likelihood: _(CSO)_ |

### H3. Forged or altered card

| | |
|---|---|
| Causes | Someone prints a card with false data, or edits a genuine one |
| Effect | Wrong blood group, missing allergy, false DNR |
| Controls | Every card is ES256-signed; the scanner verifies on the device with known public keys only and accepts only `ES256` with a known key id; any change shows "CARD NOT GENUINE" with no data (`src/lib/emergency/offlineCard.ts`, `src/lib/crypto/cardKeys.ts`) |
| Verified by | `tests/phase8-scanner.test.ts` ("Tampered: one changed payload character is NOT GENUINE and returns no data", "Wrong alg: HS256, none and RS256 headers are rejected", "Unknown kid: cannot verify, no data"); `tests/phase8-es256.test.ts` |
| Residual risk | The printed text on the back is not signed: a forger can print false text next to a genuine QR. Clinicians must trust the scanner result over the printed text. A stolen signing key defeats the control (key handling: [DEPLOYMENT.md](../DEPLOYMENT.md)). Severity / likelihood: _(CSO)_ |

### H4. AI intake error

| | |
|---|---|
| Causes | The model misreads a handwritten note or a voice recording, invents a value, or follows instructions hidden in the note |
| Effect | A wrong diagnosis, dose or allergy enters the record |
| Controls | The model can fill only known fields per resource type; each value must cite a span that exists in the source text, or it is dropped; low-confidence fields are flagged; everything stays a draft, invisible to the summary and the card, until a verified doctor reviews, edits and signs it; signing is audited and names the adapter (`src/lib/intake/intakeService.ts`, `src/lib/intake/adapters.ts`). A real model is used only when configured |
| Verified by | `tests/phase15-intake.test.ts` ("The fake LLM returns drafts with source spans; low-confidence fields are flagged; nothing is signed", "Model output is checked: spans must be in the source, unknown fields are dropped; real models are gated", "The doctor edits, discards and signs all ..."); `tests/phase8-lifecycle.test.ts` ("A draft is not visible in the emergency summary or on the card until a doctor signs it") |
| Residual risk | A doctor may sign without reading carefully; a span can exist in the source and still be misread (e.g. a misheard dose). Severity / likelihood: _(CSO)_ |

### H5. Triage misclassification

| | |
|---|---|
| Causes | TEWS bands or discriminators that differ from the official SATS manual; wrong or missing vital signs; a sign not covered by the discriminator lists; use outside the intended population |
| Effect | Under-triage (a sick patient waits) or over-triage |
| Controls | Emergency signs force RED; very-urgent signs upgrade to ORANGE and never downgrade (`mcp/src/tews.js`). Every result carries "Decision support only. A clinician makes the final triage decision." and, until sign-off, the "Triage scoring not clinically validated" banner (`mcp/src/validation.js`). Ages under 12 are refused. **Fixed in Phase 19:** a fractional rate or pressure (e.g. RR 8.5) fell between two integer bands, made the total invalid, and the patient came out GREEN; the tool now requires whole numbers and the scorer refuses any value outside every band |
| Verified by | `mcp/test/tews.test.js` (bands, thresholds, overrides, "fractional or missing vitals are refused, not scored as GREEN", "every integer band boundary scores as implemented"); `mcp/test/validation.test.js` (banner; fractional rate refused) |
| Residual risk | **The bands have not been checked against the official SATS manual** ([TEWS_VALIDATION_CHECKLIST.md](TEWS_VALIDATION_CHECKLIST.md)). No paediatric scale. Accuracy against real outcomes is unmeasured. Severity / likelihood: _(CSO)_ |

### H6. Missed allergy

| | |
|---|---|
| Causes | The allergy was never recorded; it sits in an unsigned draft; it was recorded by the patient but not confirmed; the card is stale; the summary is long and the allergy is overlooked |
| Effect | An allergen is given |
| Controls | The emergency summary lists drug allergies first (`src/lib/emergency/breakGlassEngine.ts`). Allergies are core card fields and are never dropped to make the QR fit (`src/lib/emergency/cardPayload.ts`). Patient-reported allergies are shown, labelled as patient-reported, rather than hidden. Allergy names are escaped when printed |
| Verified by | `tests/phase6.test.ts` ("Compiles emergency summary data with drug allergies prioritized first"); `tests/phase8-card-content.test.ts` ("Drops dx, then med from the end, then cond from the end, and never core fields"); `tests/phase8-lifecycle.test.ts` ("Patient-reported allergies are labelled on the card back and flagged in the QR payload"); `tests/phase8-qr.test.ts` ("An injected allergy name like <script> is escaped in the card HTML") |
| Residual risk | Medistry can only show what was recorded; an allergy in an unsigned draft is not shown (by design, see H4). Severity / likelihood: _(CSO)_ |

### H7. Emergency access unavailable

| | |
|---|---|
| Causes | The facility's subscription has lapsed; the network is down; the clinician is not yet verified |
| Effect | Delay in getting critical information |
| Controls | Billing never gates break-glass or offline scanning (`src/lib/site/portalApi.ts`); the offline card works with no network (verification on the device); the card back carries the core fields as plain text |
| Verified by | `tests/phase18-facility.test.ts` ("An expired subscription still allows break-glass and offline scan; ..."); `tests/phase8-qr.test.ts` ("Card HTML has the core fields as plain text ...") |
| Residual risk | A PENDING clinician cannot break glass (by design: `tests/phase12-auth.test.ts`); another verified clinician must. Severity / likelihood: _(CSO)_ |

## 4. Monitoring after go-live

- Patient disputes and record flags (GET `/api/admin/disputes`; flags reach the signing clinician).
- Audit agent flags (GET `/api/admin/anomalies`) reviewed by platform admins with clinical governance.
- Incidents reported by clinicians: _(channel, owner)_.
- Review this hazard log after every incident, every change to the triage logic, card content or intake, and at
  least yearly.

## 5. Sign-off

| | |
|---|---|
| Clinical safety officer (name) | |
| Professional registration (body and number) | |
| Organisation | |
| Hazards reviewed (H1 to H7, plus any added) | |
| Residual risks accepted? (yes / no / with conditions) | |
| Conditions | |
| Signature | |
| Date | |

The operator sets `CLINICAL_VALIDATION_SIGNED=1` only after this section **and** the
[TEWS validation checklist](TEWS_VALIDATION_CHECKLIST.md) are signed.
