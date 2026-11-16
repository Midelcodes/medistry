# Records of Processing Activities

> Draft, pre-filled from the code. Medistry is *designed to support* record-keeping duties; this is not a statement
> of legal compliance. Lawful bases and roles are in the DPIA templates ([NG](DPIA_TEMPLATE_NG.md),
> [KE](DPIA_TEMPLATE_KE.md)) and are **TO BE CONFIRMED BY COUNSEL**. Retention periods are settings with no default
> (`RETENTION_*`, reported by `src/lib/ops/retention.ts`); "not set" below means the period is still open.

Controller: _(operator legal name, address, contact)_ — DPO: _(name, contact)_ — Country deployment: _(NG / KE)_

## Activities

| # | Activity | Data subjects | Categories | Recipients | Transfers outside the country | Retention | Module |
|---|---|---|---|---|---|---|---|
| 1 | Patient registration and identity matching | patients, guardians | identity, contact, national ID | facility records officers; national ID verifier (stub) | none in code; verifier location TBC | not set (TODO counsel) | `src/lib/identity/registration.ts` |
| 2 | Keeping the medical record | patients | health records (FHIR R4) | clinicians with consent or break-glass | none | never hard-deleted | `src/lib/clinical/store.ts` |
| 3 | Consent requests and grants | patients, clinicians | consent scopes, durations, reasons | the requesting clinician | none | not set (TODO counsel) | `src/lib/consent/consentManager.ts` |
| 4 | Emergency break-glass | patients, clinicians | minimal emergency summary; clinician, facility, reason | treating clinician (60 minutes, read-only); co-signing clinician for full history | none | audit entries: `RETENTION_AUDIT_YEARS` (not set) | `src/lib/emergency/breakGlassEngine.ts` |
| 5 | Offline emergency card and scans | patients, clinicians | core card fields, opt-in items; scan events | anyone holding the card (by design); the scanning clinician | a card may be scanned in another country (patient-carried; legal position TBC) | scan events: `RETENTION_SCAN_EVENT_YEARS` (not set) | `src/lib/emergency/offlineCardStore.ts`, `src/lib/emergency/offlineScans.ts` |
| 6 | Access log and disputes | patients, clinicians, admins | access events, dispute reasons | the patient; platform admins | none | audit rule | `src/lib/audit/accessLogManager.ts` |
| 7 | Notifications (SMS, email, push) | patients, contacts, staff | phone, email, template text without clinical content | SMS gateway (Africa's Talking) | gateway hosting location TBC | delivery records: `RETENTION_DELIVERY_DAYS` (not set) | `src/lib/notifications/africasTalking.ts`, `src/lib/notifications/deliveries.ts` |
| 8 | USSD access | patients | phone, PIN hash, minimal record view | telco / gateway | TBC | sessions are not stored | `src/lib/ussd/ussdService.ts` |
| 9 | Patient and proxy sign-in | patients, proxies | phone, email, one-time code hashes, sessions | none | none | sessions expire (`SESSION_TIMEOUT_MINUTES`) | `src/lib/auth/patientAuth.ts`, `src/lib/auth/sessions.ts` |
| 10 | Clinician registration and verification | clinicians | licence number, licence document, contact | the facility admin who approves | none | not set (TODO counsel) | `src/lib/auth/staff.ts`, `src/lib/clinician/verification.ts` |
| 11 | Facility onboarding and staff | facility contacts, staff | contact, accreditation document, roles | platform admins | none | invites: `RETENTION_INVITE_DAYS`; rejected applications: `RETENTION_APPLICATION_DAYS` (not set) | `src/lib/facilities/onboarding.ts` |
| 12 | EMR imports | patients | FHIR resources, facility identifiers | none (inbound) | none | as activity 2 | `src/lib/integrations/fhirImport.ts`, `src/lib/integrations/emr/OpenMrsConnector.ts` |
| 13 | AI intake drafts | patients, clinicians | note photo, voice or text; draft fields | intake model provider, only when `INTAKE_LLM_PROVIDER` is set (the default is an in-process rule-based stand-in) | depends on the provider (must be in-country or approved: TBC) | sessions: `RETENTION_INTAKE_DAYS` (not set) | `src/lib/intake/intakeService.ts`, `src/lib/intake/adapters.ts` |
| 14 | National exchange sharing | patients | consented records, national ID | national exchange (adapter; not live) | none (national systems) | outbox messages: not set (TODO) | `src/lib/integrations/hie/nationalExchange.ts` |
| 15 | Pharmacy dispensing | patients, pharmacists | active medications, dispense records | the pharmacy, under a time-limited consent | none | as activity 2 | `src/lib/integrations/pharmacy.ts` |
| 16 | Lab results | patients, ordering clinicians | results linked to the order | the ordering clinician; "result ready" SMS without content | none | as activity 2 | `src/lib/integrations/fhirImport.ts` |
| 17 | Facility billing | facility admins | plan, status, provider reference, admin email/phone | Paystack (NG), Safaricom Daraja (KE), test/sandbox only | provider locations TBC | not set (TODO counsel; tax rules may apply) | `src/lib/billing/billingService.ts` |
| 18 | Usage dashboard | none (aggregate counts) | counts only | facility admins | none | computed on request | `src/lib/facilities/usage.ts` |
| 19 | Audit log and anomaly review | clinicians, admins, patients (by id) | access metadata; flags; reviewer notes (encrypted) | platform admins | none | `RETENTION_AUDIT_YEARS`, `RETENTION_ANOMALY_FLAG_DAYS` (not set) | `src/lib/audit/hashChain.ts`, `src/lib/audit/anomalyAgent.ts` |
| 20 | Triage decision support (MCP server) | patients (pseudonymous reference) | vital signs, minimised summary | the clinician's MCP client; the Gemini demo agent receives minimised data only and must not be used with real data | the demo LLM is hosted abroad: not for real data | not stored by the MCP server | `mcp/src/server.js`, `mcp/src/minimise.js` |
| 21 | Backups | everyone above | full database, encrypted to a GPG key | backup custodian | backup location must be in-country (TBC) | `BACKUP_KEEP_DAYS` | `scripts/backup.sh` |
| 22 | Operational logs | staff, patients (redacted) | event names, ids, redacted fields | hosting provider | TBC | hosting provider setting (TBC) | `src/lib/ops/logger.ts` |

## Processors and recipients (to complete)

| Processor | Activity | Agreement in place | Hosting location | Notes |
|---|---|---|---|---|
| Hosting provider | all | _(TBC)_ | must be in-country (TBC) | |
| Africa's Talking | 7, 8 | _(TBC)_ | _(TBC)_ | sender-ID registration TBC |
| Paystack | 17 | _(TBC)_ | _(TBC)_ | test mode only in this build |
| Safaricom (Daraja) | 17 | _(TBC)_ | _(TBC)_ | sandbox only in this build |
| Intake model provider | 13 | _(TBC)_ | _(TBC)_ | not configured by default |
| National ID verifier (NIMC route / Kenya channel) | 1 | _(TBC)_ | national | stub |
| National exchange (NG / KE) | 14 | data-sharing agreement _(TBC)_ | national | adapter, not live |
