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
* **Note (offline emergency card)**: the points above describe the online code card, wristband and NFC tag. The **offline emergency card is different**: it prints the core fields (blood group, genotype, severe allergies, DNR, emergency contact) on the back, and its QR carries a signed, **unencrypted** copy of those fields plus anything the patient opted in. A lost offline card exposes that data to whoever finds it, and revoking or reissuing it does not stop the old card from verifying offline. See section 3.

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

---

## 3. Offline Emergency Card (Signed QR), Clinician Passes and Offline Scans

Scope: the signed QR emergency card, the offline scanner at `/s`, clinician passes, device keys and
offline scan events. Synthetic data only. Nothing here has had a legal or regulatory review.

### The most important fact

**The QR data is signed, not encrypted.** Anyone with any QR reader can decode the card and read
everything in it, including any conditions, medicines or recent diagnosis the patient opted in.

- The signature (ES256) proves the card was issued by Medistry and has not been altered. It does not
  hide anything.
- In the scanner, the split between **core fields** (blood group, genotype, severe allergies, DNR, organ
  donor, emergency contact) and **opt-in fields** (conditions, medicines, recent diagnosis) is a
  **presentation and audit boundary, not cryptographic secrecy.** The Medistry scanner shows opt-in fields
  only to a signed-in clinician who records a reason, so that scan is logged and the patient is notified.
  Someone using a different QR reader is not stopped and is not logged.
- **The real privacy control is the patient's opt-in.** Nothing beyond the core fields is on the card
  unless the patient chose it, item by item, in the patient portal, which warns that anyone who reads the
  QR can see what is in it.
- The core fields are also printed in plain text on the back of the card.

### Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Card signing key (ES256 private key) | Server only (`OFFLINE_CARD_PRIVATE_KEY`) | Whoever holds it can forge cards and clinician passes |
| Public keys (JWKS) | `/.well-known/medistry-keys.json`, embedded in `/s`, cached on scanners | Verify only; cannot sign |
| Card contents | Inside the QR, and core fields printed on the card | Patient health data |
| Clinician pass | Scanner IndexedDB; 7-day ES256 token naming clinician, facility, licence, device key | Lets a device unlock opt-in fields and create scan events |
| Device private key | Scanner WebCrypto, **non-extractable**, in IndexedDB | Signs scan events; binds the pass to one device |
| Scan events | Scanner queue, then the server registry and the audit chain | Accountability for each scan |

### What each mechanism does and does not prove

#### Card signature (ES256)
- Proves: issued by Medistry, unchanged since issue, not expired (if `exp` has not passed).
- Does not prove: that the card is still the current one. A superseded or revoked card still verifies
  offline. The scanner learns otherwise only after a sync, and then shows a banner the next time that
  card is scanned.
- Scanners hold only public keys, so a compromised scanner cannot forge cards.
- The same key signs clinician passes. They are kept apart by claims: a pass has `typ: "clinician-pass"`
  and no card fields, and the card verifier rejects it; a card has no `typ` or `dk`, and the pass
  verifier rejects it.

#### Clinician pass + device key
- The pass is issued only to a clinician whose status is `VERIFIED`, at sign-in, and is bound to the
  RFC 7638 thumbprint of a device public key.
- A copied pass alone cannot create events: every event must also be signed by the device's private key,
  which WebCrypto will not export.
- A stolen, unlocked device can create events and show opt-in fields until the pass expires (up to
  7 days). Suspending the clinician makes the server reject that clinician's uploads, but an offline
  device cannot learn about the suspension until it syncs. There is **no offline revocation** of passes
  or device keys. Device-key revocation is not implemented yet (TODO; `ClinicianDeviceKey.revokedAt`
  exists in the schema).
- Clinician verification itself is still a manual, demo-level check in this build; see the README.

#### Offline scan events
- An event is the clinician device's **signed statement** that it scanned card (subject, version, key id)
  for a stated reason at a stated time. The server cannot prove a physical scan happened or that the
  reason is true.
- The event never contains the card token or its medical contents.
- Server checks: pass signature and expiry **at scan time** (a pass that expired later is fine), device
  signature against the bound key, clinician still `VERIFIED` at upload, scan time within the last
  30 days and no more than 5 minutes ahead, known patient, at most 50 events per batch.
- Replay: the eventId is idempotent. The same signed event again is `duplicate` and writes nothing; a
  reused eventId with different content is rejected.
- Withholding: a device can simply never upload. The Medistry scanner queues the event before showing
  opt-in fields and retries every 60 seconds while online, but a modified client could skip this.
  Accountability is therefore best effort for offline scans. Unexplained gaps (for example a patient
  reporting a scan that never appears) should be investigated.
- The device clock sets `scannedAt`. A clinician could back-date a scan within the pass lifetime and the
  30-day window.
- Each accepted event writes an `OFFLINE_EMERGENCY_SCAN` entry (access type emergency, with reason,
  facility and device thumbprint) to the tamper-evident audit chain, and notifies the patient by push.
  Emergency contacts are not notified of offline scans (online break-glass does notify them). The patient
  can dispute the scan by its event id.

### Other risks and limits

- **Photographed or copied cards** are still genuine cards. Anyone who copies one can read its contents.
- **Device clock wrong:** a card whose issue time looks more than 5 minutes in the future is not shown.
  A clinician would then have to rely on the printed core fields.
- **Development keys:** without `OFFLINE_CARD_PRIVATE_KEY`, the server uses a random per-process key, so
  cards and passes from a previous run stop verifying. Production with `DEMO_MODE=0` refuses to start
  without the key.
- **In-memory build:** card rows, device-key bindings, passes and scan events are lost on restart in this
  build. `prisma/schema.prisma` has the persistent design (`OfflineCard`, `ClinicianDeviceKey`,
  `OfflineScanEvent`), which is not wired yet.
- **Key compromise:** a leaked signing key lets an attacker forge cards and passes. Rotate it with
  `OFFLINE_CARD_PREVIOUS_PUBLIC_KEYS` for a transition, then remove the old key. Scanners pick up the
  change only when they come online.
- **Notifications** use a console provider in the demo; real SMS or push delivery is not wired.

### Open items

- Device-key revocation and a revocation list that scanners can cache.
- Persistent storage for cards, device keys and scan events.
- Real notification delivery, and deciding whether emergency contacts should also be told about offline scans.
- Legal review of what may be printed on a card and shown without authentication, under the Nigeria
  Data Protection Act 2023.
