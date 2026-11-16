# Regulator and Approval Actions (checklist)

> None of these is done. Until they are, Medistry is a synthetic-data system *designed to support* the duties below
> and must not hold real patient data. Owners: **Operator** (the team running Medistry), **Counsel**, **Clinician**
> (clinical safety officer or reviewer), **Agency / provider** (an outside body that must answer or grant access).

## Data protection

| # | Action | Country | Owner | Status | Evidence / where it shows in the code |
|---|---|---|---|---|---|
| D1 | Register with the Nigeria Data Protection Commission (NDPC) for the role Medistry takes (role TBC) | NG | Counsel, Operator | open | — |
| D2 | Register with the Office of the Data Protection Commissioner (ODPC) as data controller and/or processor (role TBC) | KE | Counsel, Operator | open | — |
| D3 | Complete and approve the DPIA | NG | Operator, Counsel, DPO | open (template ready) | [DPIA_TEMPLATE_NG.md](DPIA_TEMPLATE_NG.md) |
| D4 | Complete and approve the DPIA | KE | Operator, Counsel, DPO | open (template ready) | [DPIA_TEMPLATE_KE.md](DPIA_TEMPLATE_KE.md) |
| D5 | Confirm the lawful basis for each purpose, including emergency access without consent | NG, KE | Counsel | open | DPIA section 3 |
| D6 | Decide whether a DPO is required and appoint one | NG, KE | Counsel, Operator | open | — |
| D7 | Set retention periods for every category, then review the report before any archiving is built | NG, KE | Counsel, Operator | open | `RETENTION_*` settings; `src/lib/ops/retention.ts` (report only) |
| D8 | Confirm breach-notification deadlines and forms | NG, KE | Counsel | open | [BREACH_RESPONSE.md](BREACH_RESPONSE.md) section 5 |
| D9 | Confirm data-subject-rights deadlines; decide on erasure and account deletion | NG, KE | Counsel | open | [DATA_SUBJECT_RIGHTS.md](DATA_SUBJECT_RIGHTS.md) |
| D10 | Assess cross-border offline-card scans (is a scan event a transfer? which law?) | NG, KE | Counsel | open | `src/lib/emergency/offlineScans.ts` (`clinicianCountry`, `cardCountry`) |
| D11 | Processor agreements and hosting locations (SMS gateway, payment providers, intake model, hosting) | NG, KE | Operator, Counsel | open | [RECORDS_OF_PROCESSING.md](RECORDS_OF_PROCESSING.md) |

## Hosting

| # | Action | Country | Owner | Status | Evidence |
|---|---|---|---|---|---|
| H1 | In-country hosting for the database, backups, logs and keys | NG | Operator | open (the demo is hosted abroad, synthetic data only) | [DEPLOYMENT.md](../DEPLOYMENT.md) section 1 |
| H2 | In-country hosting for the database, backups, logs and keys | KE | Operator | open | [DEPLOYMENT.md](../DEPLOYMENT.md) section 1 |
| H3 | Disable the foreign-hosted LLM agent, or approve an in-country model | NG, KE | Operator, Counsel | open | `mcp/src/agent.js`, `src/lib/intake/adapters.ts` |

## Health sector

| # | Action | Country | Owner | Status | Evidence |
|---|---|---|---|---|---|
| S1 | Find out the Kenya Digital Health Agency's solution-registration (or certification) requirements for a digital health product, and meet them | KE | Operator, Counsel; DHA | open | — |
| S2 | Confirm the KMPDC licence-number format and whether an online register lookup is available for automated checks | KE | Operator; KMPDC | open (manual verification and a generic format today) | `src/lib/clinician/verification.ts` |
| S3 | Confirm the MDCN online register lookup for automated checks | NG | Operator; MDCN | open (format check and manual approval today) | `src/lib/clinician/verification.ts` |
| S4 | National exchange access: sandbox, conformance requirements, data-sharing agreement | NG, KE | Operator; national agencies | open (adapters only, not live) | `src/lib/integrations/hie/HieConnector.ts` |
| S5 | Confirm what a pharmacy may see and record, and for how long | NG, KE | Counsel, Clinician | open | `src/lib/integrations/pharmacy.ts` |
| S6 | Facility accreditation: which document each regulator issues; online registry checks | NG, KE | Operator, Counsel | open | `src/lib/facilities/onboarding.ts` |

## Identity

| # | Action | Country | Owner | Status | Evidence |
|---|---|---|---|---|---|
| I1 | NIN verification: obtain access through NIMC or a licensed verification partner (contract, permitted purpose, consent wording). Never an unofficial lookup service | NG | Operator, Counsel; NIMC / partner | open (stub answers "unavailable") | `src/lib/identity/IdentityVerifier.ts` |
| I2 | National ID and SHA number verification: official channel and legal basis | KE | Operator, Counsel; agency | open (stub) | `src/lib/identity/IdentityVerifier.ts` |

## Clinical safety

| # | Action | Owner | Status | Evidence |
|---|---|---|---|---|
| C1 | Appoint a named clinical safety officer; review and sign the safety case | Clinician, Operator | open | [CLINICAL_SAFETY_CASE.md](../clinical/CLINICAL_SAFETY_CASE.md) |
| C2 | Check every TEWS band and discriminator against the official SATS manual; then set `CLINICAL_VALIDATION_SIGNED=1` | Clinician | open (banner shown) | [TEWS_VALIDATION_CHECKLIST.md](../clinical/TEWS_VALIDATION_CHECKLIST.md), `mcp/src/validation.js` |
| C3 | Set the audit-agent thresholds (`ANOMALY_*`) from clinical governance; defaults are placeholders | Clinician, Operator | open | `src/lib/audit/anomalyAgent.ts` |
| C4 | Native-speaker review of SMS templates (Swahili, Hausa, Yoruba, Igbo, French) | Operator | open | `src/lib/i18n/translations.ts` |

## Messaging and payments

| # | Action | Country | Owner | Status | Evidence |
|---|---|---|---|---|---|
| M1 | SMS sender-ID registration and USSD short code with the gateway and telcos | NG, KE | Operator; provider, telcos | open | `src/lib/notifications/africasTalking.ts` |
| M2 | Paystack merchant onboarding; real prices; tax and invoicing rules | NG | Operator, Counsel; Paystack | open (test mode only) | `src/config/plans.json`, `src/lib/billing/PaystackProvider.ts` |
| M3 | Safaricom Daraja go-live; confirm the callback format and any signing option | KE | Operator; Safaricom | open (sandbox only) | `src/lib/billing/MpesaDarajaProvider.ts` |
