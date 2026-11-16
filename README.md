# MEDISTRY — Patient Medical-Record Portability & Emergency Break-Glass Platform

[![CI](https://github.com/Midelcodes/medistry/actions/workflows/ci.yml/badge.svg)](https://github.com/Midelcodes/medistry/actions/workflows/ci.yml)

**MEDISTRY** is a patient medical-record portability platform designed to allow patients' clinical histories to seamlessly follow them across hospitals, while giving attending doctors an instant, break-glass emergency scan when a patient is unconscious and their phone is locked.

---

## Status and known limits

- **Storage.** By default `npm start` seeds synthetic data in memory and resets on restart. With `STORAGE=postgres` and `DATABASE_URL`, every change is written through to PostgreSQL (Prisma) and the server rebuilds its state from the database at start-up (see "PostgreSQL storage" below). One app instance per database: the in-memory working set is not shared between instances. Redis is not used yet.
- **Demo mode (default).** The patient directory, patient portal and card generators are unauthenticated by design so visitors can explore. With `DEMO_MODE=0` the directory and generators are off, the patient portal needs a phone sign-in, clinicians and admins need a password and an authenticator, and the demo authenticator endpoint is gone (see "Sign-in" below). The legal and operational items in [docs/COMPLIANCE.md](docs/COMPLIANCE.md) section 7 still stand before any real data.
- **Secrets.** `JWT_SECRET` and `FIELD_ENCRYPTION_KEY` must be set to private values (`openssl rand -hex 32`). If unset or equal to a value published in this repo, a random per-process key is used. `OFFLINE_CARD_PRIVATE_KEY` (ES256 card signing key) comes from `node scripts/gen-card-key.mjs`; without it a random per-process key is used in dev, and the server refuses to start in production with `DEMO_MODE=0`.
- **Sessions** last `SESSION_TIMEOUT_MINUTES` (default 15). The emergency summary needs the clinician's session and the grant must belong to that clinician.
- Hosting is outside Nigeria for the public demo; the data is synthetic. A real deployment needs an in-country region.
- Compliance wording describes design intent only and has had no legal review.
- **Running with real data:** read [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) first: one deployment per country
  (`DEPLOYMENT_COUNTRY`, `DEPLOYMENT_REGION`), clamd malware scanning (fail closed), key management and rotation,
  daily encrypted backups with a tested restore, redacted JSON logs, and the LLM agent disabled for real data.

---

## 🛡️ Key Pillars & Capabilities

1. **Patient-Controlled Record Portability**:
   - Records conform to **HL7 FHIR R4** standards (`Patient`, `Encounter`, `Condition`, `Observation`, `DiagnosticReport`, `MedicationStatement`, `AllergyIntolerance`, `DocumentReference`).
   - Patients own their records, approve hospital-to-hospital data sharing via in-app authorization or SMS OTP, and can revoke clinician access instantly with one click.
   - Versioned, append-only clinical store with cryptographic field encryption (AES-256-GCM); hard deletion is strictly prohibited.

2. **Locked-Phone Emergency QR / NFC Break-Glass**:
   - Each patient is issued an unguessable 128-bit random Crockford Base32 code with Modulo-32 check character (`K7QM-4T9X-2HDP-8W2`).
   - Printable ISO ID-1 wallet cards, wristband templates, lock-screen wallpapers, and NFC NDEF URI tags.
   - Scanning `https://medistry.health/e/<code>` reveals **no personal data** to anonymous viewers.
   - Verified clinicians (RFC 6238 TOTP; a password step is planned) can trigger an emergency break-glass procedure with a mandatory clinical reason.

3. **Ultra-Fast Sub-50KB Emergency Summary**:
   - Server-rendered, semantic HTML template weighing ~10 KB (zero heavy JavaScript frameworks).
   - Designed for instant loading (p95 < 1.5s) on throttled 3G connections and low-end mobile browsers.
   - Critical triage attributes prioritized: Blood Group & Rh, Hemoglobin Genotype, active **Do Not Resuscitate (DNR)** warning banner, drug allergies (prioritized first), chronic conditions, active medications, and one-touch click-to-call emergency contacts.

4. **Time-Boxed Access & Dual Co-Signing**:
   - Emergency access is read-only, minimal, and automatically time-boxed to **60 minutes**.
   - Comprehensive multi-year medical history remains locked; unlocking full history requires a second, distinct attending clinician to co-sign on the terminal with stated justification.

5. **Multi-Channel Alerts & Audit Chain**:
   - Instant SMS notifications dispatched to patient and emergency contacts upon break-glass access, with automated fallback to email and push if telecom networks experience outages.
   - Append-only, SHA-256 hash-chained audit ledger linking every read and write to detect tampering.
   - Patient-visible **"Who accessed my record"** dashboard with dispute escalation tickets for Platform Admin review.

6. **Offline Emergency Card (signed by Medistry)**:
   - A printable card whose QR code is signed by **Medistry** with ES256 (ECDSA P-256). Medistry is not a government or health authority, and the card does not claim to be issued by one.
   - Clinicians verify it offline at `/s` with Medistry's public keys (`/.well-known/medistry-keys.json`), which cannot be used to forge cards. The QR is signed, not encrypted: patients choose what goes on it. See "Offline emergency card" below.

---

## MCP server (Agentic Africa Challenge)

`mcp/` contains an MCP server that connects Medistry's audited break-glass summary to SATS/TEWS triage,
queue management and in-country referral routing, plus a LangGraph demo. See [`mcp/README.md`](mcp/README.md).

---

## Sign-in

All of this is active when `DEMO_MODE=0`. In demo mode the synthetic patient picker and the demo authenticator stay.

- **Patients (phone first).** `POST /api/auth/patient/otp/request {phone}` sends a 6-digit code by SMS (through the
  notification dispatcher); `POST /api/auth/patient/otp/verify {phone, otp}` returns a session token (Bearer). Codes
  live 5 minutes, allow 5 attempts, and are kept only as an HMAC; requests are limited per phone number and per IP
  (`OTP_MAX_PER_PHONE`, `OTP_MAX_PER_IP`). A facility admin links a phone number to a patient record after an
  identity check (`POST /api/admin/patients/:id/account`). Optional recovery email; recovery = code to that email,
  then a code to the new phone number, then every old session is revoked. Sign-ins, recovery, lockouts and
  session revocations are audited. `/api/patients/:id/...` needs the patient, or a proxy whose scopes cover the route.
- **Clinicians.** Password (scrypt, N=2^15, r=8, p=1, 16-byte salt, compared with `timingSafeEqual`) then TOTP;
  five failures lock the account (`ACCOUNT_LOCKOUT_SECONDS`). `POST /api/clinician/register` checks the licence
  format against the country registry, stores the licence document encrypted, and returns an `otpauth://` URI
  and QR code for the authenticator app. New clinicians are `PENDING`: they can sign in but cannot break glass,
  get an offline scanner pass, or read records until a facility admin of the claimed facility (or a platform
  admin) approves them (`/api/admin/clinicians/:id/approve|reject`). A reminder goes out `LICENCE_REMINDER_DAYS`
  before a recorded licence expiry date.
- **Admins.** The first platform admin comes from `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD_HASH` and
  `PLATFORM_ADMIN_TOTP_SECRET` (generate with `node --experimental-strip-types scripts/admin-credentials.ts`); it
  creates facility admins (`POST /api/admin/facility-admins`).
- **Guardians and proxies.** A patient invites a proxy (parent, guardian, caregiver, spouse, other) with scopes
  `view`, `manage-card`, `approve-consent`. Proxies sign in with their own phone; every audit entry of their
  requests reads "Proxy X (relationship) on behalf of patient Y". No scope edits clinical content. A facility
  admin records a minor's parent or guardian, who manages the account until the patient's 18th birthday (from the
  encrypted date of birth); control then passes to the patient and both are notified.

## Records without double entry

- **From existing EMRs (FHIR import).** A facility admin creates an API client
  (`POST /api/admin/facility-api-clients`, the secret is shown once). The EMR gets a short-lived token at
  `POST /api/fhir/token` (client credentials) and pushes a FHIR R4 Bundle (transaction or collection) to
  `POST /api/fhir/import`. Supported: Encounter, Condition, AllergyIntolerance, MedicationStatement, Observation,
  DiagnosticReport, DocumentReference (Patient and Practitioner entries are used for matching only). All or nothing:
  any invalid entry rejects the whole bundle with an OperationOutcome. Patients are never created: a Patient entry
  must match by the Medistry patient id (`urn:medistry:patient-id`) or a facility identifier learnt from an earlier
  matched import, and the facility must already be connected to the patient. Records from a verified author at the
  facility are final; otherwise they are drafts a doctor must sign. Re-imports are idempotent (facility + identifier).
- **OpenMRS / KenyaEMR.** `OpenMrsConnector` pulls a patient's records through the OpenMRS FHIR module
  (`/ws/fhir2/R4/...`, `_lastUpdated` for incremental pulls) and feeds the same import pipeline. Site-specific
  mapping (encounter classes, concept codes, providers) is configuration with TODOs.
- **From paper (AI intake).** In the clinician console, "Intake from paper": paste text, take a photo or record a
  voice note. The assistant proposes draft records; each value shows the words it came from, and uncertain values are
  flagged. The doctor edits, discards or signs (one tap signs all). Nothing is signed by the assistant. The default
  model is a deterministic local stand-in; real models and OCR/speech-to-text providers are pluggable (see
  docs/DEPLOYMENT.md for the rules on real patient data).

## SMS and USSD (feature phones)

- **SMS.** `SMS_PROVIDER=africastalking` sends SMS through Africa's Talking (`AT_USERNAME`, `AT_API_KEY`,
  `AT_SENDER_ID`, `AT_ENV=sandbox|production`); the console provider stays the default. Network errors, HTTP
  429/5xx and gateway errors are retried 3 times with exponential backoff (1 s, 2 s); after that the dispatcher
  falls back to email and push. Each SMS gets a delivery record (`NotificationDelivery`): the phone number only
  as a keyed hash plus its last 3 digits, the template id, status, provider message id, attempts, last error.
- **No clinical detail in SMS.** Every SMS is rendered from a template (`SMS_TEMPLATES` in
  `src/lib/i18n/translations.ts`, in en, sw, ha, yo, ig and fr). A break-glass alert reads, in full: "Your Medistry
  record was accessed by Dr X at Facility Y. Open the app or dial *CODE# to review or dispute." Patients get it on
  their own sign-in phone (fallback: their recovery email), and their emergency contacts get a short notice.
  The non-English texts are drafts awaiting native-speaker review.
- **Delivery reports.** Register `POST /api/webhooks/sms/delivery/<SMS_WEBHOOK_SECRET>` as the delivery-report
  callback (the secret can also go in an `X-Medistry-Webhook-Secret` header). Constant-time check, rate limited.
- **USSD.** Register `POST /api/ussd/<USSD_CALLBACK_SECRET>` as the USSD callback. The caller's number must be a
  patient's sign-in phone, plus a 4-digit USSD PIN the patient sets in the portal (scrypt; three wrong PINs lock
  USSD until a new PIN is set). Menu: 1 emergency summary (blood group, genotype, allergies), 2 last 3 accesses,
  3 dispute the last access, 4 lock (revoke) the emergency card. Every action is audited; every screen is at most
  182 characters. TODO: the short code (`USSD_SERVICE_CODE`) must be provisioned with the provider and the telcos.

## Offline emergency card

A credit-card-sized card whose QR code a clinician can verify with no internet. Synthetic data only.

- **Signed, not encrypted.** The QR holds `${APP_URL}/s#<token>`, an ES256-signed (ECDSA P-256) token. Scanners
  verify it with Medistry's public keys (`/.well-known/medistry-keys.json`), which cannot be used to forge cards.
  Anyone who decodes the QR can read it, so patient opt-in is the privacy control.
- **Patient-chosen content.** Core fields (blood group, genotype, severe allergies, DNR, organ donor, one emergency
  contact) are always on the card; conditions, medications and the recent diagnosis appear only if the patient
  opts each one in. The card back prints the core fields; the patient can print, download, reissue or revoke it
  in the portal (Patients → Emergency kit → My emergency card).
- **Works offline.** The scanner at `/s` caches itself with a service worker after one online visit and verifies
  cards with WebCrypto on the device. It shows GENUINE, NOT GENUINE (no data), EXPIRED (marked unverified-current)
  or "connect once to update keys".
- **Accountable scans.** A clinician who signs in on the scanner gets a 7-day pass bound to a non-extractable
  device key. Opt-in fields need a reason, which creates a signed scan event; events upload when online, are
  written to the audit chain and notify the patient, who can dispute them.
- **Kept in step.** Doctor-signed record changes mark the card stale and remove discontinued opt-ins; drafts by
  nurses or records officers never reach the card. The MCP tool `verify_offline_card` lets the triage agent use a
  card (see `mcp/README.md`).

Generate the signing key once per environment and store it as a secret (never commit it):

```bash
node scripts/gen-card-key.mjs
# prints OFFLINE_CARD_PRIVATE_KEY=<base64 PKCS8> on stdout; the key id and public key go to stderr
```

| Variable | Purpose |
|---|---|
| `OFFLINE_CARD_PRIVATE_KEY` | ES256 signing key (PKCS8 as PEM, base64 PEM or base64 DER). Required when `NODE_ENV=production` and `DEMO_MODE=0` (the server refuses to start without it). Blank in dev: a random per-process key, so cards stop verifying after a restart. |
| `OFFLINE_CARD_PREVIOUS_PUBLIC_KEYS` | Optional, comma-separated SPKI public keys still accepted during a **planned** rotation. Never list a compromised key. |
| `OFFLINE_CARD_VALIDITY_DAYS` | Card lifetime in days (default 180). |
| `APP_URL` | Public base URL printed in QR codes. Set it in every deployment; otherwise the request's own host is used. |
| `DEPLOYMENT_COUNTRY` | Country this deployment serves (`NG` default, `KE` supported); default for new patients and records. |
| `OFFLINE_CARD_SIGNING_KEY` | Deprecated and ignored (old HMAC cards). |

Testing: `docs/OFFLINE_CARD_TESTING.md` (manual airplane-mode checklist). Risks and limits: `docs/THREAT_MODEL.md`
section 3. Data protection design and open TODOs: `docs/COMPLIANCE.md` sections 4 to 7.

---

## 🏗️ Technology Stack

| Component | Technology | Rationale |
| :--- | :--- | :--- |
| **Language & Runtime** | TypeScript, Node.js v22 (ESM) | Native type safety and high-throughput async I/O |
| **Database & ORM** | PostgreSQL 16 & Prisma ORM | Relational integrity, JSONB support, multi-tenant isolation |
| **Cache & Tokens** | Redis 7 | Sliding-window rate limiting, lockout counters, short-lived tokens |
| **Clinical Data Model** | HL7 FHIR R4 | Global interoperability and healthcare standardization |
| **Encryption & KDF** | AES-256-GCM, Scrypt, HMAC-SHA256 | Field-level encryption of patient demographics and clinical payloads in the demo store |
| **Infrastructure** | Docker Compose | One-command local development and reproducible deployments |
| **Regulatory Scope** | Single Region (Nigeria, `countryCode: "NG"`) | Designed around **NDPA 2023** and **MDCN** licensing. Not legally reviewed. |

---

## 🌐 Website Pages & Demo Flows

`npm start` serves the full site on http://localhost:3000 (no Docker needed; data is synthetic and in memory).

| Page | What it does |
|---|---|
| `/` , `/about`, `/features`, `/how-it-works` | Product, principles, compliance and the break-glass flow |
| `/patients` | Patient portal: timeline, access log + disputes, consent approve/reject/revoke, emergency kit (wallet card, wristband, reissue code, public badge), alerts |
| `/clinicians` | Clinician console: TOTP sign-in, safe lookup, consent request by one-time code, record view, break-glass sessions, dual co-sign and full history |
| `/emergency`, `/e/:code` | Emergency code entry and the break-glass gateway |
| `/facilities` | Facilities and their demo clinicians (licence checked) |
| `/contact` | Contact form, stored in `data/contact-messages.jsonl` |

Demo notes: there is no patient login (pick a synthetic patient on the page). Clinician sign-in uses real TOTP verification, and the "Show the current demo code" button is disabled when `NODE_ENV=production`. Pages live in `site/` (`layout.html` + `pages/`), APIs in `src/lib/site/portalApi.ts`.

---

## 🚀 Quickstart & Local Development

### 1. Prerequisites
- Docker & Docker Compose
- Node.js v22+ and npm

### 2. Environment Configuration
Copy the sample environment file:
```bash
cp .env.example .env
```
Key configuration values in `.env`:
- `FIELD_ENCRYPTION_KEY`: 32-byte hexadecimal key for AES-256-GCM demographic and clinical encryption.
- `OFFLINE_CARD_PRIVATE_KEY`: ES256 private key for offline emergency cards (`node scripts/gen-card-key.mjs`). `OFFLINE_CARD_SIGNING_KEY` is deprecated and ignored.
- `DEPLOYMENT_COUNTRY`: `NG` (Single-region residency).

### 3. Run with PostgreSQL (optional)
The default needs no database. To keep data across restarts, use PostgreSQL through Prisma:

```bash
npm install
cp .env.example .env              # then fill in the three secrets below
#   FIELD_ENCRYPTION_KEY=$(openssl rand -hex 32)
#   JWT_SECRET=$(openssl rand -hex 32)
#   OFFLINE_CARD_PRIVATE_KEY from: node scripts/gen-card-key.mjs
docker compose up -d && STORAGE=postgres npm run seed && STORAGE=postgres npm start
```

- `npm start` and `npm run seed` read `.env` if it exists; real environment variables win over it.
- `npm run seed` applies pending migrations (`prisma migrate deploy`), then writes the synthetic dataset. If the
  database already has patients it writes nothing; `SEED_RESET=1` wipes and reseeds (demo only). It refuses to
  run when `DEMO_MODE=0`, so fake patients can never be seeded into a real deployment.
- With `STORAGE=postgres` the server refuses to start without the three secrets (data encrypted with a random
  key could not be read after a restart), on an empty database, or if the stored audit chain does not verify.
- Health, contact and free-text data are encrypted in the application (AES-256-GCM) before they reach the
  database, as the demographic fields always were. See the comments in `prisma/schema.prisma`.
- Audit appends are serialised in the database (a table lock inside a transaction), so the hash chain cannot fork.
- Limit: run one app instance per database. Serverless or multi-instance hosting is not supported yet.

### 4. Seed Synthetic Data
```bash
npm run seed
```
Without `STORAGE=postgres` this only prints a summary; the server seeds memory itself. The synthetic dataset contains:
- **3 Nigerian facilities**: Lagos University Teaching Hospital (LUTH), National Hospital Abuja, Aminu Kano Teaching Hospital.
- **2 synthetic Kenyan facilities** in Nairobi (not real; `DEMO-KMFL-` registry codes are not real Kenya Master Facility List codes).
- **6 synthetic Nigerian clinicians (licence-checked in the demo)**: Surgeons, hematologists, emergency medicine specialists, and intensivists.
- **3 synthetic Kenyan clinicians** with `DEMO-KE-` licences, verified through a manual demo list. The KMPDC licence format and online register are not confirmed yet.
- **10 Synthetic Patients**: Including **Amara Okonkwo** (Genotype SS Sickle Cell Anemia, severe penicillin anaphylaxis, hydroxyurea regimen).

### 5. Run the Automated Test Suite
```bash
npm test
```
Runs the whole suite (unit, integration and the offline-card phases) with memory storage; no database needed.
`tests/postgres-storage.test.ts` runs only with `STORAGE=postgres` and `DATABASE_URL` (the CI postgres job).
The original suite covers the first 7 architectural phases:
- Auth, RBAC & ReBAC Policy, Clinician Verification, Hash-Chain Audit (16 tests)
- Crockford Base32 Code Generation, Field Encryption, Code Reissuance, Deliverables (14 tests)
- FHIR R4 Clinical Store, Versioning, Timeline Aggregator, Document Antivirus Scanner (10 tests)
- Safe Patient Lookup, In-App Consent, OTP Verification, Pre-Shared Links, Access Logs (8 tests)
- Public Emergency Gate, Break-Glass Engine, Sub-50KB Summary, Notifications, Dual Co-Sign, Offline Card (12 tests)
- Sliding-Window Rate Limiter, Anti-CSRF, XSS Sanitization, WCAG 2.1 AA Audit, i18n, Seed Verification, Load Benchmark (12 tests)

---

## 🏛️ Directory Architecture

```text
medical/
├── docker-compose.yml              # Local PostgreSQL 16 and Redis 7 definitions
├── .env.example                    # Template environment variables
├── package.json                    # Scripts and dependencies
├── prisma/
│   ├── schema.prisma               # Multi-tenant schema with hash-chained audit model
│   └── seed.ts                     # 3 NG + 2 synthetic KE facilities, 6 NG + 3 synthetic KE clinicians, 10 synthetic patients
├── src/
│   ├── lib/
│   │   ├── auth/                   # Scrypt KDF, RFC 6238 TOTP engine, session tokens
│   │   ├── policy/                 # Central Deny-by-Default RBAC & ReBAC engine
│   │   ├── clinician/              # MDCN license verification state machine
│   │   ├── audit/                  # SHA-256 hash-chained audit log & dispute manager
│   │   ├── code/                   # Crockford Base32, SVG wallet card, wristband, NFC
│   │   ├── patient/                # AES-256-GCM field encryption & profile manager
│   │   ├── clinical/               # Versioned FHIR R4 store, multi-facility timeline, upload
│   │   ├── consent/                # In-app consent, OTP verification, pre-shared links
│   │   ├── emergency/              # Break-glass engine, sub-50KB HTML summary, offline cards
│   │   ├── notifications/          # Multi-channel alerts with telecom fallback
│   │   ├── security/               # Sliding-window rate limiter, CSRF, XSS, WCAG 2.1 AA audit
│   │   └── i18n/                   # English, Hausa, Yoruba, Igbo, Swahili, French translations
├── tests/                          # 72 comprehensive end-to-end and unit tests
└── docs/
    ├── COMPLIANCE.md               # Legal mapping to Nigeria Data Protection Act (NDPA 2023)
    ├── THREAT_MODEL.md             # In-depth threat analysis and cryptographic mitigations
    └── PHASE[1-7]_SUMMARY.md       # Progressive phase documentation and architectural decisions
```

---

## 🔒 Security & Privacy Guarantees

- **No Plaintext PHI**: All patient demographics and clinical observation payloads are encrypted via AES-256-GCM before storage.
- **Append-Only Immutability**: Clinical records are versioned (`versionId = n + 1`); attempting to hard-delete clinical data throws `ERR_HARD_DELETE_PROHIBITED`.
- **Tamper-Evident Ledger**: The hash-chained audit log links every read and write (`SHA-256(payload + previousHash)`). Any unauthorized modification breaks the chain.
- **Timing-Safe Protection**: All codes, tokens, and secrets are evaluated using constant-time comparisons (`crypto.timingSafeEqual`).
- **WCAG 2.1 AA checks**: An automated audit covers contrast, 44px touch targets and zoom on the emergency and consent screens. No manual accessibility audit has been done.

---

## 📄 License & Regulatory Notice

This project is licensed under the MIT License. Clinical data mappings follow HL7 FHIR R4 standards. Compliance implementations map to the **Nigeria Data Protection Act (NDPA) 2023** and **Medical and Dental Council of Nigeria (MDCN)** guidelines. Formal legal review by qualified healthcare counsel is required before production clinical deployment.
