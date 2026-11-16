# Personal Data Breach Response

> A working procedure, *designed to support* breach-notification duties. Notification deadlines, thresholds and
> the content regulators require are **TODO: to be confirmed by counsel for each country**. Nothing here is legal advice.

## 1. Detection sources

| Source | What it signals | Where to look | Code |
|---|---|---|---|
| Audit chain verification failure | the stored audit log was changed or corrupted | the server refuses to start; GET `/api/audit/verify`; `scripts/verify-restore.ts` after a restore | `src/lib/audit/hashChain.ts`, `src/lib/runtime.ts` |
| Audit agent flags | unusual emergency access: too many in a shift, no follow-up encounter, outside the clinician's country, the same patient repeatedly | GET `/api/admin/anomalies` (platform admins); run on demand with POST `/api/admin/anomalies/run` | `src/lib/audit/anomalyAgent.ts` |
| Patient disputes | a patient says an access was not expected | GET `/api/admin/disputes`; resolving one as `RESOLVED_BREACH` starts this procedure | `src/lib/audit/accessLogManager.ts` |
| Forged or rejected webhooks | someone is probing payment callbacks | audit entries `BILLING_WEBHOOK_REJECTED` | `src/lib/billing/billingService.ts` |
| Sign-in lockouts and rate limits | password or code guessing | audit and logs | `src/lib/auth/staff.ts`, `src/lib/auth/patientAuth.ts`, `src/lib/security/rateLimiter.ts` |
| Malware in uploads | an infected document was submitted | upload refused; logs | `src/lib/clinical/virusScanners.ts`, `src/lib/clinical/fileSafety.ts` |
| Health check DEGRADED | failed writes or the malware scanner is down | GET `/api/health` | `src/server.ts` |
| Operational logs | errors, unusual volumes | hosting logs (redacted) | `src/lib/ops/logger.ts` |
| Reports from staff, facilities, patients or researchers | anything | POST `/api/contact`, support channels | |

## 2. Roles

| Role | Who | Responsibilities |
|---|---|---|
| Incident lead | _(name, phone)_ | runs the response, keeps the incident log, decides on escalation |
| Data protection officer | _(name)_ | assesses risk to individuals, decides on notifications, contacts the regulator |
| Engineering lead | _(name)_ | containment, evidence preservation, fixes, key rotation |
| Clinical safety officer | _(name)_ | clinical impact (wrong or missing data used in care) |
| Counsel | _(name)_ | legal duties per country |
| Communications | _(name)_ | patient, facility and public messages |
| Facility contacts | facility admins | facility-side containment; their own duties as controller (TBC) |

## 3. Steps

1. **Record** the time of discovery, the source and the first facts in the incident log (template 4.4). Do not
   copy personal data into the log beyond what is needed.
2. **Contain.** Tools in the product:
   - suspend a staff member (sessions end at once): POST `/api/admin/staff/:id/suspend`;
   - revoke an EMR API client: POST `/api/admin/facility-api-clients/:id/revoke`;
   - a patient can end all sessions (POST `/api/auth/patient/sessions/revoke`) and revoke a lost card
     (POST `/api/patients/:id/offline-card/revoke`);
   - rotate the field-encryption key: `scripts/rotate-field-key.ts`; rotate the card signing key: see
     [DEPLOYMENT.md](../DEPLOYMENT.md) (section 4);
   - restore from an encrypted backup if data was destroyed: `scripts/restore.sh`, then `scripts/verify-restore.ts`.
3. **Preserve evidence**: export the relevant audit entries (ids and hashes), logs and the database snapshot before
   any fix.
4. **Assess** what data, how many people, which countries, and the likely harm (template 4.1). Health data and
   national identifiers raise the risk.
5. **Notify** as required (deadlines in section 5): the regulator, affected patients, affected facilities.
6. **Fix and review**: root cause, fix, a test that would have caught it, and an update to the
   [threat model](../THREAT_MODEL.md) and the DPIA.

## 4. Templates

### 4.1 Assessment (internal)

```
Incident id:
Discovered at (date, time, timezone):        By / source:
Country deployment(s):
What happened (facts only):
Data involved (categories; health data? national IDs?):
Approximate number of people:              Number of records:
Contained at:                              How:
Likely consequences for people:
Risk level (DPO):                          Reasoning:
Notify regulator? (Y/N, why)               Notify people? (Y/N, why)
```

### 4.2 Regulator notification (NDPC / ODPC)

The required form and fields: **TODO: confirm with counsel and the regulator's current guidance.** Draft content:

```
Controller: <legal name, address>          DPO contact: <name, email, phone>
Nature of the breach: <what happened, when, how it was found>
Categories and approximate numbers of data subjects and records:
Likely consequences:
Measures taken or proposed (containment, mitigation):
Whether and how affected people were told:
If late: reasons for the delay:
```

### 4.3 Patient notice

SMS has room for little and must not carry clinical content (the rule for every Medistry SMS). Send a short SMS that
points to the portal or a call-back number; put the detail in the portal notice or a letter.

```
SMS: Medistry: we are contacting you about a security incident affecting your account. Please sign in at <link> or call <number>. We will never ask for your code.

Portal / letter:
What happened: <plain words>
What information was involved: <categories, no clinical details in transit>
What we have done: <containment>
What you can do: <sign out everywhere, check your access log, dispute any access, revoke your card>
Contact: <DPO contact>      Your right to complain to <NDPC / ODPC>: <contact>
```

The SMS text must be added to `src/lib/i18n/translations.ts` (all six locales) before use, so it goes through the
same no-clinical-content checks (TODO when the wording is approved).

### 4.4 Incident log entry

```
Time | Who | Action or finding | Evidence reference (audit id, log id, file)
```

## 5. Notification timelines (TODO per country)

| Notification | Nigeria (NDPA) | Kenya (Data Protection Act, 2019) |
|---|---|---|
| To the regulator | **TODO: confirm deadline and threshold with counsel** | **TODO: confirm deadline and threshold with counsel** |
| To affected people | **TODO** | **TODO** |
| Processor to controller (e.g. a facility, the SMS gateway) | **TODO** | **TODO** |
| Health-sector or other regulators (MDCN, KMPDC, health ministries, DHA) | **TODO: whether required** | **TODO: whether required** |

## 6. Exercises

Run a tabletop exercise before go-live and yearly: a tampered audit chain (the server refuses to start), a stolen
clinician phone with a valid offline pass, and an anomaly flag that turns out to be snooping. Record the outcome here.

| Date | Scenario | Participants | Findings | Actions |
|---|---|---|---|---|
| | | | | |
