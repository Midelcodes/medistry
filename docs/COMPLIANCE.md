# MEDISTRY Regulatory & Privacy Compliance Mapping (NDPA 2023 / MDCN)

> [!CAUTION]
> **Legal Disclaimer**: This document serves as a technical engineering mapping of system features to the provisions of the **Nigeria Data Protection Act (NDPA) 2023** and **Medical and Dental Council of Nigeria (MDCN)** guidelines. This document **does not** constitute formal legal advice or clinical validation. Independent review by qualified healthcare legal counsel and certified data protection officers is strictly required prior to commercial clinical deployment.

---

## 1. Statutory Context & Principles

MEDISTRY is *designed to support* the **Nigeria Data Protection Act (NDPA) 2023**, regulated by the **Nigeria Data Protection Commission (NDPC)**; whether it acts as controller or processor for each activity is TO BE CONFIRMED BY COUNSEL. No claim of legal compliance is made. The working documents are in [docs/compliance/](compliance/) (DPIA templates for NG and KE, records of processing, data subject rights, breach response, regulator actions). Health and genetic data are classified as **Sensitive Personal Data** under Section 30 of the Act, demanding heightened technical and organizational safeguards.

---

## 2. Technical Mapping Matrix

| NDPA 2023 Provision | Principle & Requirement | MEDISTRY Technical Implementation |
| :--- | :--- | :--- |
| **Section 24(1)(a)** | Lawfulness, Fairness & Transparency | Consent-first architecture. Patient owns record, determines granular scopes (All vs specific FHIR resources), and specifies access duration (one-time, 7 days, 30 days). |
| **Section 24(1)(b)** | Purpose Limitation | Break-glass emergency access is strictly time-boxed (60 minutes) and restricted to minimal triage data (blood group, genotype, allergies). Full history requires verified dual-clinician co-sign. |
| **Section 24(1)(c)** | Data Minimization | Emergency QR cards and NFC payloads contain zero clinical data—only an opaque, unguessable URL (`/e/<code>`). No personal data is exposed to anonymous scanners. |
| **Section 30(1)** | Processing of Sensitive Personal Data (Health & Genotypes) | Multi-layered field-level encryption (AES-256-GCM) with key rotation. Clinical observations and diagnoses are stored in encrypted FHIR R4 containers. |
| **Section 34** | Rights of the Data Subject (Right to be Informed & Access) | Immutable, patient-facing **"Who accessed my record"** audit trail. Patients receive instant alerts (SMS/push) upon any emergency break-glass event with dispute escalation. |
| **Section 34(1)(d)** | Right to Data Portability | FHIR R4 JSON export bundle (`GET /api/patients/:id/export`); a human-readable summary exists in code without an endpoint. |
| **Section 39** | Security of Processing & Technical Safeguards | Argon2id/scrypt memory-hard password hashing, mandatory RFC 6238 TOTP MFA for clinicians, 15-minute clinician session timeouts, and SHA-256 hash-chained audit trails. |
| **Section 41 & 42** | Cross-Border Data Transfer Restrictions | Single-region in-country data residency (`DEPLOYMENT_COUNTRY=NG`). All primary databases, logs, and cryptographic keys reside in the authorized regional zone. |

> [!WARNING]
> **Review notes added on the offline-card branch (not legal advice):**
> - The **Data Minimization** row describes the online code card, wristband and NFC tag. It is **not true for
>   the offline emergency card**, which prints core fields and carries a signed, unencrypted copy of them (plus
>   any items the patient opted in) in its QR. See section 4.
> - Some entries in this table have not been checked against the code or the Act on this branch: the section
>   numbers; "Argon2id" (the code uses scrypt); the "PDF" summary (the code produces print-ready HTML);
>   "key rotation" for field encryption (not found in the code); and SMS/push alerts (a console provider in
>   the demo). Treat them as intended design until reviewed.

---

## 3. Clinician Licensing & Regulatory Oversight (MDCN)

Designed to support the **Medical and Dental Practitioners Act (Cap M8, LFN 2004)** (not legally reviewed):
1. **Practitioner Folio Validation**: Clinicians must submit valid Folio credentials (`MDCN/R/XXXXX`, `MDCN/P/XXXXX`, `MDCN/F/XXXXX`).
2. **Multi-Tenant Facility Affiliation**: Clinicians must be tied to verified healthcare facilities with verifiable operating permits.
3. **Pluggable MDCN Registry**: Onboarding is governed by the `IMdcnRegistryAdapter` interface, enabling immediate manual registrar vetting and future automated live lookup against the MDCN electronic register.

---

## 4. Offline Emergency Card: Data Minimisation and Patient Opt-In

Status: design and engineering only. **Compliance has not been assessed or achieved.**

- **Core fields only by default.** A card always carries blood group, genotype, severe allergies, DNR flag,
  organ-donor flag and one primary emergency contact, the minimum a clinician needs when the patient cannot speak.
- **Everything else is opt-in, item by item.** Chronic conditions, medications and the most recent diagnosis
  appear on the card only if the patient chooses each one in the portal. The portal warns that anyone who reads
  the QR can see what is in it, and that conditions or medicines can reveal sensitive diagnoses.
- **Signed, not encrypted.** The QR is signed (ES256) so it cannot be altered or forged, but it is not encrypted.
  Patient opt-in is the real privacy control; the scanner's split between core and opt-in fields is a
  presentation and audit boundary (see `docs/THREAT_MODEL.md`, section 3).
- **Nothing extra in the card.** No name, date of birth, national ID, address or online emergency code is in the
  QR. The patient id (`sub`) is present so that scans can be audited and disputed.
- **Patients change visibility only.** They choose what is shown, and can revoke a lost card; they cannot write
  clinical content. Clinician-signed record changes mark the card for review and remove discontinued opt-ins.
- **Minimised downstream.** The MCP tool `verify_offline_card` returns no contact or patient id. The LLM agent
  strips names, contacts, ids and free-text notes before anything is sent to a model.
- **Audit and transparency.** Scans by clinicians with a pass become audit-chain entries; the patient is
  notified and can dispute them. Offline scans are recorded on upload, so this is best effort (see the threat model).

## 5. Per-Country Deployment (Data Stays In-Country)

- Each deployment serves one country (`DEPLOYMENT_COUNTRY`, for example `NG` or `KE`). New patients and records
  take that country by default, and `/api/health` reports the country and its medical regulator.
- The intended model is **one deployment per country, hosted in that country**, with its own database, keys and
  logs. There is no server-to-server replication between countries in this codebase.
- The MCP triage server only contacts `MEDISTRY_URL`, and refuses any host not in `MEDISTRY_ALLOWED_HOSTS`.
- The public demo is hosted outside Nigeria and Kenya and uses synthetic data only. A real deployment needs an
  in-country region; this has not been set up.
- The Gemini agent is a demo. Real patient data must not be sent to a foreign-hosted LLM without a lawful basis;
  production should use an in-country or self-hosted model.

## 6. Cross-Border Model: Patient-Carried Card

- Emergencies cross borders. A clinician licensed in one country (for example a KMPDC demo clinician in Kenya)
  may scan a card issued in another (for example Nigeria). The scanner verifies the card **on the device**,
  using public keys it has already cached.
- **No server-to-server transfer of patient data takes place.** The data travels with the patient, on the card
  they carry and chose to fill. The scanning clinician's server receives only the scan event (card subject,
  version and key id, plus the clinician, reason and time) when the clinician's device uploads it to the
  deployment that issued the pass. Each scan event records both countries (`clinicianCountry`, `cardCountry`).
- Whether a cross-border scan event itself is a regulated transfer, and which country's law governs it, has not
  been assessed (see the TODO list).
- **Limit of this build:** the demo runs both countries in one deployment, so cross-border scans work there. With
  one deployment per country they would not yet: a scanner fetches public keys only from its own deployment, so
  it would not have another country's keys, and its scan upload would go to a deployment that does not know the
  patient. A trusted list of other deployments' public keys, and a way to route scan events to the issuing
  country without moving patient records, still need to be designed.

## 7. TODO Before Any Real Deployment

These are open. None of them has been done.

The owner-by-owner checklist is [compliance/REGULATOR_ACTIONS.md](compliance/REGULATOR_ACTIONS.md) (Phase 19); this list is kept for history.

- [ ] Register with the **Nigeria Data Protection Commission (NDPC)** as required for the controller or processor
      role Medistry takes in Nigeria.
- [ ] Register with Kenya's **Office of the Data Protection Commissioner (ODPC)** as required under the Kenya
      Data Protection Act 2019.
- [ ] Complete a **Data Protection Impact Assessment (DPIA)** covering the offline card, the scanner, clinician
      passes and device keys, offline scan events, the MCP tools and the LLM agent.
- [ ] Confirm the **KMPDC** licence number format and an online register lookup (the code accepts a generic
      format and uses a manual demo list; see `src/lib/clinician/verification.ts`).
- [ ] Confirm the **Kenya Digital Health Agency (DHA)** solution-registration requirements for a digital health
      product, and register if required.
- [ ] Confirm the MDCN licence number format and register lookup (the current format check is unverified).
- [ ] Legal review of what may be printed on a card and shown without authentication, the lawful basis for
      processing, and cross-border scan events.
- [ ] Design cross-deployment trust for cross-border scans: distribution of other countries' public keys to
      scanners, and routing of scan events to the issuing country.
- [ ] Verify the section references and the controls in the mapping table above.
- [ ] Confirm, per country, the age at which a minor controls their own health record and whether a guardian may
      keep any access after it (the code ends guardian control at 18, as specified; `src/lib/auth/proxies.ts`).
- [ ] Decide how a facility verifies a guardian's authority and a patient's identity before linking a phone number
      (the endpoints record who did it; the checks themselves are a facility process).
- [ ] Choose a production SMS provider and review the content of sign-in and notification messages.
- [ ] Provision the USSD short code with the provider and each telco, and confirm any sender-ID registration
      the SMS provider or regulators require in each country (not researched; the code only reads `AT_SENDER_ID`).
- [ ] Native-speaker review of the Swahili, Hausa, Yoruba, Igbo and French SMS templates.
- [ ] NIN verification: obtain access through NIMC or a licensed verification partner (contract, permitted purpose,
      consent wording, data handling). Never use an unofficial NIN lookup service. (`src/lib/identity/IdentityVerifier.ts`)
- [ ] Kenya: confirm the official channel and legal basis for national ID and SHA number verification.
- [ ] National exchanges (Kenya DHA shared health record, Nigeria NDHI): sandbox access, conformance requirements,
      data-sharing agreement and the legal basis for pushing records and querying summaries; confirm whether the
      patient's 'national-exchange' consent in Medistry is required, sufficient or replaced by the national rules.
- [ ] Pharmacies: confirm what a pharmacy may see and record under each country's rules, and the consent duration
      (`PHARMACY_ACCESS_HOURS`).
- [ ] Decide who may see the duplicate review queue (it shows names and dates of birth side by side) and set
      `MPI_REVIEW_THRESHOLD` from real review outcomes.
- [ ] Billing: set the real plan prices (`src/config/plans.json`, all placeholders); complete merchant onboarding
      with Paystack (Nigeria) and Safaricom Daraja (Kenya, Go-Live); confirm invoicing and tax (VAT) requirements in
      each country (not researched). This build accepts test/sandbox credentials only.
- [ ] Facility verification: confirm which accreditation document each country's regulator issues and whether the
      national facility registry can be checked online (`src/lib/facilities/onboarding.ts`).
- [ ] Confirm the Africa's Talking recipient status codes and delivery-report fields against the current
      documentation (the request format follows the official SDK source; see `src/lib/notifications/africasTalking.ts`).
