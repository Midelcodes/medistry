# MEDISTRY — Patient Medical-Record Portability & Emergency Break-Glass Platform

**MEDISTRY** is a secure, zero-compromise patient medical-record portability platform designed to allow patients' clinical histories to seamlessly follow them across hospitals, while giving attending doctors an instant, break-glass emergency scan when a patient is unconscious and their phone is locked.

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
   - Verified clinicians (password + RFC 6238 TOTP) can trigger an emergency break-glass procedure with a mandatory clinical reason.

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

6. **Offline First-Responder Signed Card**:
   - Exportable offline emergency card signed via HMAC-SHA256 by the regional health authority, allowing ambulance EMTs to verify blood group and severe allergies without cellular connectivity.

---

## 🏗️ Technology Stack

| Component | Technology | Rationale |
| :--- | :--- | :--- |
| **Language & Runtime** | TypeScript, Node.js v22 (ESM) | Native type safety and high-throughput async I/O |
| **Database & ORM** | PostgreSQL 16 & Prisma ORM | Relational integrity, JSONB support, multi-tenant isolation |
| **Cache & Tokens** | Redis 7 | Sliding-window rate limiting, lockout counters, short-lived tokens |
| **Clinical Data Model** | HL7 FHIR R4 | Global interoperability and healthcare standardization |
| **Encryption & KDF** | AES-256-GCM, Scrypt, HMAC-SHA256 | Zero plaintext clinical PHI stored at rest |
| **Infrastructure** | Docker Compose | One-command local development and reproducible deployments |
| **Regulatory Scope** | Single Region (Nigeria, `countryCode: "NG"`) | Full compliance with **NDPA 2023** and **MDCN** licensing |

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
- `OFFLINE_CARD_SIGNING_KEY`: Secret key for HMAC-SHA256 offline signed emergency cards.
- `DEPLOYMENT_COUNTRY`: `NG` (Single-region residency).

### 3. Start Database and Redis Services
Launch the PostgreSQL and Redis containers with Docker Compose:
```bash
docker compose up -d
```

### 4. Install Dependencies & Seed Synthetic Database
```bash
npm install
npm run seed
```
The seed script populates the database with:
- **3 Accredited Facilities**: Lagos University Teaching Hospital (LUTH), National Hospital Abuja, Aminu Kano Teaching Hospital.
- **6 Verified MDCN Clinicians**: Surgeons, hematologists, emergency medicine specialists, and intensivists.
- **10 Synthetic Patients**: Including **Amara Okonkwo** (Genotype SS Sickle Cell Anemia, severe penicillin anaphylaxis, hydroxyurea regimen).

### 5. Run the Automated Test Suite
```bash
npm test
```
Executes all **72 automated tests** across all 7 architectural phases:
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
│   └── seed.ts                     # 3 facilities, 6 clinicians, 10 synthetic patients
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
- **WCAG 2.1 AA Compliant**: All emergency triage views and consent screens pass strict contrast, 44px touch-target, and mobile-zoom criteria.

---

## 📄 License & Regulatory Notice

This project is licensed under the MIT License. Clinical data mappings follow HL7 FHIR R4 standards. Compliance implementations map to the **Nigeria Data Protection Act (NDPA) 2023** and **Medical and Dental Council of Nigeria (MDCN)** guidelines. Formal legal review by qualified healthcare counsel is required before production clinical deployment.
