# MEDISTRY Security Architecture & Threat Model

This document outlines the threat analysis, threat actors, attack vectors, and specific technical countermeasures engineered into the MEDISTRY platform.

---

## 1. Threat Actors
- **Anonymous Scanners / Opportunistic Finders**: Persons scanning lost or unattended QR cards, stickers, or NFC tags.
- **Malicious External Attackers**: Attackers attempting brute-force enumeration, token replay, XSS, CSRF, and timing side-channels.
- **Rogue / Curious Clinicians**: Verified medical staff attempting unauthorized access ("browsing" records of celebrities, relatives, or neighbors without clinical justification).
- **Insider Threats (Facility & Platform Staff)**: System administrators, database administrators, or facility coordinators attempting direct SQL inspection.

---

## 2. Threat Vector & Mitigation Matrix

### Threat 1: Code Enumeration (Brute-Force Guessing of Patient Emergency Codes)
* **Attack**: An attacker scripts automated HTTP requests against `/e/<code>` attempting to locate valid patient codes.
* **Mitigations**:
  1. **High Entropy**: 128-bit cryptographically secure pseudorandom number generator (`crypto.randomBytes(16)`), formatted in Crockford Base32 with Modulo-32 weighted check character ($32^{14} \approx 3.7 \times 10^{20}$ code space).
  2. **Check-Character Rejection**: Transcribed typos or random guesses fail the Modulo-32 checksum algorithm before database lookup.
  3. **Sliding-Window Rate Limiting**: Max 10 requests per minute per IP address.
  4. **Lockout Guard**: 5 invalid code attempts trigger an automatic 1-hour IP lockout (`CodeSecurityGuard` & `SlidingWindowRateLimiter`).
  5. **Constant-Time Evaluation**: Code hashes are compared using `crypto.timingSafeEqual` to defeat timing analysis.

### Threat 2: Stolen / Lost Emergency Card or Phone
* **Attack**: A thief or bystander finds a lost card, wallet, or phone displaying the emergency QR code and attempts to extract medical history.
* **Mitigations**:
  1. **Zero PHI on Card**: The physical card, sticker, and NFC tag encode strictly an opaque URL: `https://medistry.health/e/<code>`. No name, genotype, blood type, or condition is printed on the default card.
  2. **Emergency Gate**: Scanning the code requires a verified clinician with 2FA/TOTP credentials. Anonymous viewers see only a "Hospital Emergency Gateway" portal.
  3. **Instant Revocation & Reissuance**: If a card is lost, the patient can revoke the code with 1 click in their patient portal. The old code becomes immediately non-functional (`STATUS: REVOKED`), while all historical medical records and FHIR resources are preserved.

### Threat 3: Rogue Clinician Browsing Records
* **Attack**: An authenticated doctor abuses their medical credentials to look up records of individuals not under their care.
* **Mitigations**:
  1. **Deny-by-Default Central Policy Engine**: Doctors cannot search or view patients without an active consent grant, care relationship, or break-glass emergency activation.
  2. **60-Minute Emergency Time-Box**: Emergency grants auto-expire in 60 minutes.
  3. **Minimal Triage Only**: Emergency view is limited to critical life-safety metrics (blood group, genotype, drug allergies).
  4. **Dual Co-Sign Requirement**: Viewing complete multi-year clinical encounters, laboratory observations, or scans requires a second distinct verified clinician to co-sign on the terminal with a clinical reason. Self-co-signing is barred.
  5. **Instant Patient Alerts**: Every emergency access triggers real-time SMS, Email, and Push notifications to the patient and their emergency contacts.
  6. **Dispute Escalation Flow**: Patients can review the "Who accessed my record" ledger and file a formal dispute ticket against any unauthorized access for administrative and regulatory investigation.

### Threat 4: Insider Abuse (Direct Database Inspection)
* **Attack**: A compromised DBA or platform administrator inspects PostgreSQL disk tables or database dumps.
* **Mitigations**:
  1. **Field-Level Encryption (AES-256-GCM)**: All demographic identifiers (First Name, Last Name, Date of Birth, NIN) and clinical payloads (`resourceJson`) are encrypted at rest using AES-256-GCM with authenticated tags before insertion.
  2. **Separation of Keys**: Encryption keys are loaded via isolated KMS or environment key rings (`FIELD_ENCRYPTION_KEY`), never stored in plaintext within the database.
  3. **Immutable Append-Only Audit Chain**: Audit rows are linked via SHA-256 hash chains (`previousHash -> currentHash`). Any modification, deletion, or insertion by a database administrator immediately breaks cryptographic verification.

### Threat 5: Replay of Share Links & Expired Access
* **Attack**: An attacker captures a time-limited pre-share link or OTP and attempts to reuse it after the visit.
* **Mitigations**:
  1. **Hashed Tokens**: Pre-share tokens and OTPs are hashed using SHA-256 before storage; raw tokens are never persisted.
  2. **Single-Use OTPs with Attempt Countdowns**: OTPs expire after 10 minutes or 3 failed attempts.
  3. **Instant Revocation**: Patients can terminate any active pre-shared link at any time with 1 click.
  4. **Real-Time Policy Synchronization**: Revocation immediately flips consent status in memory and database, returning 403 Forbidden on the subsequent request.

### Threat 6: Cross-Site Scripting (XSS) in Uploaded Documents and Clinical Notes
* **Attack**: A compromised clinician or malicious file uploader injects `<script>` tags, event handlers, or infected PDFs into clinical notes or DocumentReference files.
* **Mitigations**:
  1. **Antivirus Scanning**: Uploaded documents are inspected using an in-line EICAR and malware scanner before storage.
  2. **File MIME & Size Enforcement**: Strict whitelist (`application/pdf`, `image/jpeg`, `image/png`) and 10 MB payload ceiling.
  3. **Clinical Free-Text Sanitizer (`sanitizeClinicalText`)**: Automatically strips script tags, iframe elements, event handlers (`onload`, `onerror`), and `javascript:` URLs.
  4. **Strict Content-Security-Policy (CSP)**: `default-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'`.

### Threat 7: Session Hijack & Session Fixation
* **Attack**: An attacker intercepts session cookies or steals active tokens.
* **Mitigations**:
  1. **Session Regeneration**: Session IDs are regenerated upon authentication.
  2. **Short Clinician Session Timeouts**: 15-minute idle timeout for all medical staff.
  3. **Secure Cookie Flags**: `HttpOnly; Secure; SameSite=Strict`.
  4. **Strict HSTS**: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
  5. **Anti-CSRF Validation**: Cryptographic double-submit cookie verification on all state-altering endpoints.

