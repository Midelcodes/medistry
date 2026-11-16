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
  1. **Antivirus Scanning**: With real data (`DEMO_MODE=0`) every upload is scanned by ClamAV (clamd over TCP); if clamd is unreachable the upload is rejected (fail closed). Demo and tests use `TestPatternScannerAdapter`, which only matches the EICAR test string and is not antivirus.
  2. **File Type & Size Enforcement**: Content checked by magic bytes (PDF, PNG, JPEG only; must match the declared type and extension), `UPLOAD_MAX_MB` ceiling (default 10), and image metadata (EXIF, XMP, IPTC, comments, PNG text chunks) removed before storage.
  3. **Clinical Free-Text Sanitizer (`sanitizeClinicalText`)**: Automatically strips script tags, iframe elements, event handlers (`onload`, `onerror`), and `javascript:` URLs.
  4. **Strict Content-Security-Policy (CSP)**: `default-src 'self'; script-src 'self'` (no inline script or event handlers), `worker-src 'self'` for the scanner's service worker, `img-src 'self' data:`, `object-src 'none'; frame-ancestors 'none'; form-action 'self'`. Inline style attributes are still allowed (`style-src 'unsafe-inline'`). The camera is allowed only on the scanner page (`Permissions-Policy: camera=(self)` on `/s`).

### Threat 7: Session Hijack & Session Fixation
* **Attack**: An attacker intercepts session cookies or steals active tokens.
* **Mitigations**:
  1. **Session Regeneration**: Session IDs are regenerated upon authentication.
  2. **Short Clinician Session Timeouts**: 15-minute idle timeout for all medical staff.
  3. **Secure Cookie Flags**: `HttpOnly; Secure; SameSite=Strict`.
  4. **Strict HSTS**: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`.
  5. **Anti-CSRF Validation**: Cryptographic double-submit cookie verification on all state-altering endpoints.

---

## 2b. Sign-in (Phase 12)

| Threat | Mitigation | Limit |
|---|---|---|
| Guessing an SMS code | 6 digits, 5 minutes, 5 attempts per code, then dead; requests limited per phone and per IP; verification limited per IP | An attacker with many IPs and phone numbers can still spread attempts; SMS itself can be intercepted (SIM swap) |
| SIM swap / number recycling | Recovery needs the recovery email and the new phone; the old number gets an SMS when the account moves | A patient without a recovery email has no self-service recovery; clinic staff must re-link the number after an identity check |
| Stolen session token | Bearer only for API calls (no CSRF with cookies); 15-minute tokens; sign out everywhere; recovery revokes all sessions | Tokens are not bound to a device |
| Code stored in logs or database | Only HMAC(server key, challenge id + code) is kept; the message log stores "code not stored" instead of the text | The SMS provider sees the code (unavoidable) |
| Password guessing (clinicians, admins) | scrypt N=2^15; five failures lock the account; TOTP required as well | Lockout can be used to lock a clinician out on purpose (denial of service) |
| Fake clinician registration | Licence format check, encrypted licence document, PENDING until an admin of the claimed facility approves; PENDING has no clinical permissions | Format checks do not prove a licence is real; admins must check the register |
| Proxy overreach | Scopes per route; proxies act under their own identity and every audit entry names them; no scope edits clinical content | A proxy with `approve-consent` can share the record; patients choose scopes |
| Records pushed to a national exchange without consent | Push only with the patient's 'national-exchange' consent, re-checked at send time (withdrawn = cancelled); outbox holds ids only; every push audited | Once received, the exchange's own rules govern the copy |
| Exchange data mistaken for Medistry's own record | Inbound summaries need consent or break-glass, are labelled "National exchange (KE/NG)" and are never written into the record | A clinician can still act on outdated exchange data |
| Pharmacy overreach | Pharmacist role can only read active medications and record dispensing, under a time-limited consent obtained by OTP to the patient or a live check of the current card; the policy engine denies every other action; no route edits a prescription | Whoever holds the patient's card can grant a pharmacy access (the card scan is treated as presence and consent) |
| Lab result disclosure by SMS | The SMS says only that a result is ready (template, no values or test names); results stay in the app | The SMS still reveals that a test was done |
| Leak of national ID numbers | Stored only encrypted plus a blind index under a separate key (`IDENTITY_INDEX_KEY`); never logged, never in audit entries or responses (masked display); log redaction removes digit runs as a second line | Someone holding both the database and the index key can test guesses of a known number; keep the key apart from database backups |
| Wrong merge (two people joined) | Never automatic; a records officer of a facility involved, or a platform admin, decides; records are linked, not moved; unmerge restores both exactly; audited | While merged, the survivor's emergency summary shows both records' allergies and medications (safer than hiding them, but wrong if the merge was wrong) |
| Duplicate records split a patient's history | Exact identifier match at registration and import; probable matches queued for review | Without an identifier, a duplicate is caught only if names, date of birth and phone are close enough |
| Stolen facility API credentials | Secret shown once, stored as an scrypt hash; tokens last 5 minutes; revoking a client stops its tokens at once; rate limits on token and import endpoints; every import is audited with the client id | A stolen secret works until revoked; the facility must rotate it |
| A facility pushes records into the wrong patient | No patient is created by an import; matching needs the Medistry id or an identifier learnt from an earlier matched import; a disagreeing birth date rejects the bundle; the facility must already be connected to the patient; unsigned imports stay drafts | A facility with a wrong mapping can still file records against a patient it is connected to; drafts and audit make it visible (fuller identity matching: Phase 16) |
| AI intake invents or mis-reads values (hallucination, prompt injection in the note) | The model can only fill known fields per resource type; every value must point to a span of the source text (else confidence 0 and flagged); everything is a draft until a doctor reviews and signs; the audit names the model | A doctor who signs without reading can still accept a wrong value |
| SMS reveals health information (shared phones, lock screens, operator logs) | Every SMS comes from a template with no clinical fields; the break-glass reason stays out of SMS and email | The SMS still says that a doctor at a named facility opened the record |
| Forged delivery reports | Shared secret in the callback URL or header, compared in constant time; rate limited; a report can only change a delivery status | The secret is in a URL, so it can appear in provider or proxy logs; rotate it if exposed |
| USSD caller-ID spoofing or a stolen phone | Callback needs a shared secret (provider to server); caller number must match a patient phone AND a 4-digit PIN (scrypt); 3 wrong PINs lock USSD until reset in the app | A 4-digit PIN is weak against someone who has the phone and watched it being typed; the PIN travels in each USSD callback over the operator network |
| USSD lockout used against a patient | Locking needs the patient's own number to be presented by the provider | Someone holding the phone can lock USSD on purpose; the app still works |
| Guardian keeps control of an adult | Ends automatically on the 18th birthday (checked on every request and daily) | The age of majority is a product setting (18), not checked per jurisdiction |

## 2c. Facilities and billing (Phase 18)

| Threat | Mitigation | Limit |
|---|---|---|
| Fake facility signs up to recruit "clinicians" or get API access | Self-registered facilities stay PENDING (not listed, no clinician registration, no API clients) until a platform admin reviews the accreditation document and verifies them (audited); the document is scanned and stored encrypted | The review is manual: a convincing forged document can pass. TODO: check against the national facility registry when an official channel exists |
| Stolen or forwarded invitation link | Single use, expires (`FACILITY_INVITE_HOURS`), stored only as a hash; opening it sends a code to the invitee's own phone; the first sign-in sets a password and authenticator once | Someone holding both the link and the invitee's phone can accept |
| Facility admin reads patient records | Admin and staff tokens get 403 on every patient-portal, clinician-record and emergency-summary route; the policy enforcer has no PHI rule for FACILITY_ADMIN; the usage dashboard is counts only | An admin can invite a clinician who then applies; that clinician still needs approval and consent or break-glass for each patient |
| Demo admin backdoor on a self-registered facility | Passwordless demo admins (demo mode only) are created for seed facilities only, never for facilities with an application | Demo mode must never hold real data (startup checks) |
| Forged payment webhook activates a subscription | Paystack: HMAC-SHA512 signature (`Paystack-Signature` with timestamp, 5-minute window, or legacy `x-paystack-signature`), constant-time compare; M-Pesa: secret in the callback path (Daraja callbacks are unsigned); amount checked against the plan; events applied once; every rejection audited | The M-Pesa path secret appears in Safaricom's logs; rotate it if exposed. TODO: confirm the Daraja callback format and any signing option |
| Non-payment cuts off emergency care | Only admin and analytics routes check the subscription (402). Break-glass, offline scanning, patient records, imports, clinician approval and staff suspension never do | None known; covered by tests |

## 2d. Insider misuse and safety controls (Phase 19)

| Threat | Mitigation | Limit |
|---|---|---|
| A clinician snoops through emergency access | The audit agent flags many accesses in a shift, access with no follow-up encounter, access outside the clinician's facility country and repeated access to one patient; platform admins review every flag; the patient is notified of each access and can dispute it | Rules are heuristics with placeholder thresholds; a careful insider can stay under them. Flags are not proof, and nothing happens automatically |
| An admin buries a flag or dispute | Every flag creation and review decision is an audit-chain entry with the reviewer's id; the note is required | Platform admins are trusted; a second reviewer is not enforced (TODO) |
| A retention job deletes evidence | The retention job is report-only and has no delete path (checked by a test); clinical records cannot be hard-deleted | An archiving job, when built, needs its own review and a signed audit checkpoint |
| Triage scores trusted before validation | Banner on every score until `CLINICAL_VALIDATION_SIGNED=1`; out-of-band values refused | The banner can be ignored; the flag can be set without a real sign-off (process control) |

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
- **Key compromise:** a leaked signing key lets an attacker forge cards and passes. See the scenario below:
  a compromised key is removed at once; `OFFLINE_CARD_PREVIOUS_PUBLIC_KEYS` is only for planned rotation.
- **Notifications** use a console provider in the demo; real SMS or push delivery is not wired.

### Scenarios

| Scenario | What the attacker or mistake achieves | Mitigation in this build | What remains |
|---|---|---|---|
| **Lost card** | The finder can read the printed core fields and decode the QR, including any opted-in items. | Patient portal "Report lost card" revokes the current card (`OFFLINE_CARD_REVOKED` in the audit chain) and requires a reissue. Scanners receive `cardStatus: revoked` on their next sync and then show a banner when that card is scanned again. Patients choose what goes in the QR. | The data on the lost card is already exposed. An offline scanner that has not synced still shows the revoked card as genuine until its expiry (`OFFLINE_CARD_VALIDITY_DAYS`). |
| **Forged card** | Someone prints a card with false data (for example a wrong blood group). | Every card is ES256-signed by the server; scanners hold only public keys and verify on the device. Any change shows a full red "CARD NOT GENUINE" screen with no data. Only `ES256` with a known key id is accepted, which blocks `alg: none` and HS256 confusion. | A *copy* of a genuine card still verifies. The printed text on the back is not signed, so clinicians should trust the scanner result over the printed text when they differ. |
| **Stolen phone with a clinician pass** | The thief opens opt-in fields and creates scan events in the clinician's name. | The pass is bound to a non-extractable device key; a copied pass alone cannot sign events. The pass expires after 7 days. Suspending the clinician (status SUSPENDED; there is no admin UI for this yet) makes the server reject all their uploads; each scan names the device thumbprint. | Until the pass expires, the stolen phone can show opt-in fields offline. Device-key revocation is not implemented (TODO). Phone lock and OS encryption are the first line of defence. |
| **Replayed scan event** | An old event is uploaded again to repeat a notification or inflate the audit trail. | The eventId is idempotent: the same signed event returns `duplicate` and writes nothing. A reused eventId with different content is rejected. Scan time must be within 30 days and at most 5 minutes ahead; the pass must have been valid at scan time. | A device can create many genuine new events while its pass is valid; the per-IP upload limit (20 batches per minute) and the audit trail bound and expose this. |
| **Malicious insider scanning** | A verified clinician scans a card without a clinical reason (curiosity, a relative, a celebrity). | Opt-in fields need a reason first; the signed event names the clinician, facility, licence country and device. On upload: an `OFFLINE_EMERGENCY_SCAN` audit entry, a push to the patient naming who, where, when and why, and a dispute flow in the portal (by event id). | The core fields are visible without a reason, as they are printed on the card. A modified client or any QR reader can read the QR without logging. Accountability relies on the patient seeing the notification and disputing. |
| **Signing key compromise** | An attacker can mint cards and clinician passes that verify everywhere. | Remove the compromised key from the published key set immediately (do **not** list it in `OFFLINE_CARD_PREVIOUS_PUBLIC_KEYS`), generate a new key with `scripts/gen-card-key.mjs`, and ask every patient to reissue their card and every clinician to sign in again for a new pass. Scanners drop the old key when they next fetch the key set; cards then show "Cannot verify: connect once to update keys" until reissued. For a *planned* rotation, keep the old public key in `OFFLINE_CARD_PREVIOUS_PUBLIC_KEYS` until old cards expire. | Offline scanners that never reconnect keep trusting the old key. There is no push channel to scanners and no key-revocation list yet. The private key must live in a secret store (Railway/Vercel variables), never in the repository. |

### Open items

- Device-key revocation and a revocation list that scanners can cache (cards, passes and compromised signing keys).
- A cap on device keys per clinician (binding is rate-limited per IP, but not capped per clinician).
- Cross-border scans between separate per-country deployments: scanners only trust their own deployment's keys,
  and scan events would reach a deployment that does not know the patient. Needs a trusted key list and event routing.
- Patient authentication for the portal. Its card endpoints are demo-only today (closed when `DEMO_MODE=0`);
  when real patient sign-in is added, any cookie-based session must come with CSRF protection.
- Persistent storage for cards, device keys and scan events.
- Real notification delivery, and deciding whether emergency contacts should also be told about offline scans.
- Legal review of what may be printed on a card and shown without authentication, under the Nigeria
  Data Protection Act 2023.
