# Data Subject Rights: How They Work in the Product

> Medistry is *designed to support* patients' rights over their data. This page describes what the product does
> today, with the endpoints, and what is still open. Which rights apply, their exact scope, response deadlines and
> exemptions under the NDPA (Nigeria) and the Data Protection Act, 2019 (Kenya) are **TO BE CONFIRMED BY COUNSEL**.

All patient endpoints need the patient's own session (phone sign-in with a one-time code:
POST `/api/auth/patient/otp/request`, then POST `/api/auth/patient/otp/verify`) or a proxy whose scopes cover the
route (`src/lib/auth/proxies.ts`). Staff and admin tokens are refused on every patient route (403). Each request
that reads or changes data is written to the audit chain.

## Access

| What the patient sees | Endpoint | Code |
|---|---|---|
| Their profile | GET `/api/patients/:id` | `src/lib/site/portalApi.ts` |
| Their record as a timeline (latest versions; drafts excluded) | GET `/api/patients/:id/timeline` | `src/lib/clinical/timeline.ts` |
| Who opened their record, when and why ("Who accessed my record") | GET `/api/patients/:id/access-log` | `src/lib/audit/accessLogManager.ts` |
| Their consents and pending requests | GET `/api/patients/:id/consents` | `src/lib/consent/consentManager.ts` |
| Their offline cards (versions, status) | GET `/api/patients/:id/offline-cards` | `src/lib/emergency/offlineCardStore.ts` |
| Messages sent to them | GET `/api/patients/:id/notifications` | `src/lib/notifications/dispatcher.ts` |
| Whether national-exchange sharing is on | GET `/api/patients/:id/national-exchange` | `src/lib/integrations/hie/nationalExchange.ts` |

Feature-phone users can read a minimal view by USSD after a PIN (`src/lib/ussd/ussdService.ts`).

## Export (portability)

GET `/api/patients/:id/export` returns the patient's records as an HL7 FHIR R4 `Bundle` (type `document`, latest
versions, drafts excluded), built by `src/lib/clinical/export.ts`. Each export is audited (`PATIENT_EXPORTED_RECORD`).
Open: the bundle holds clinical resources only; the profile (demographics) and the access log are separate
endpoints above. A human-readable summary exists in code (`exportHumanReadableReport` in
`src/lib/clinical/export.ts`) but has no endpoint yet (TODO).

## Correction

Clinical records are never overwritten or deleted; a correction is a new signed version by a verified clinician.

1. The patient flags a record they believe is wrong: POST `/api/patients/:id/records/:recordId/flag` with a note
   (`src/lib/clinical/recordFlags.ts`). The record is not changed; the signing clinician is notified and sees the flag.
2. A verified clinician at a linked facility writes the corrected version (`src/lib/clinical/store.ts`), which keeps
   the history. A correction to card data marks the card for reissue (`src/lib/emergency/cardSync.ts`).
3. Demographic corrections (name, date of birth) are made by a records officer at registration
   (`src/lib/identity/registration.ts`). Open: there is no patient-initiated demographic change request yet (TODO).

## Restriction and objection

| The patient can | Endpoint |
|---|---|
| Reject a clinician's access request | POST `/api/patients/:id/consents/requests/:requestId/reject` |
| Revoke a consent they gave | POST `/api/patients/:id/consents/grants/:grantId/revoke` |
| Turn national-exchange sharing on or off (when off, queued messages are cancelled at send time) | POST `/api/patients/:id/national-exchange` |
| Choose what the offline card and the public emergency badge show | PATCH `/api/patients/:id/settings` |
| Revoke a lost card | POST `/api/patients/:id/offline-card/revoke` |
| Reissue the emergency code | POST `/api/patients/:id/emergency-code/reissue` |
| Remove a proxy | POST `/api/patients/:id/proxies/:proxyId/revoke` |
| End all their sessions | POST `/api/auth/patient/sessions/revoke` |

Limit by design: emergency access (break-glass and the core card fields) cannot be switched off by the patient,
because it exists for when they cannot consent. Whether this needs a specific legal basis or notice:
**TO BE CONFIRMED BY COUNSEL**.

## Complaints

1. **About an access:** the patient disputes any entry in their access log or any offline scan:
   POST `/api/patients/:id/disputes` (`src/lib/audit/accessLogManager.ts`). Platform admins review disputes
   (GET `/api/admin/disputes`) and resolve them as valid or as a breach
   (POST `/api/admin/disputes/:ticketId/resolve`); a breach resolution starts the
   [breach response](BREACH_RESPONSE.md).
2. **About a record:** the flag flow above.
3. **Anything else:** the contact form, POST `/api/contact` ("Regulator or partner" and patient enquiries).
4. **To the regulator:** NDPC (Nigeria) or ODPC (Kenya). The contact details to show patients, and where: TODO
   (counsel).

## Erasure

Not supported for clinical records: they are never hard-deleted (`ERR_HARD_DELETE_PROHIBITED` in
`src/lib/clinical/store.ts`), so that clinicians and patients can rely on the history. Whether health-record
retention rules override an erasure request, and what may be erased (for example contact details, an unused account):
**TO BE CONFIRMED BY COUNSEL**. There is no account-deletion endpoint yet (TODO, after counsel's answer).

## Response handling (to complete)

| Item | Value |
|---|---|
| Who handles requests | _(DPO / support team)_ |
| Identity check for requests outside the app | _(TODO)_ |
| Response deadline | **TO BE CONFIRMED BY COUNSEL** per country |
| Request log | _(where requests and answers are recorded)_ |
