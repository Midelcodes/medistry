# Deploying Medistry with real data

This document covers what a deployment needs before it holds real patient data (`DEMO_MODE=0`). It does not
replace the legal and regulatory work listed in [COMPLIANCE.md](COMPLIANCE.md) section 7, which must be done first.

## 1. One deployment per country

Each country gets its own, separate deployment: its own application instance, database, backups, keys and logs,
hosted inside that country. Deployments do not share a database. A patient's record lives in the deployment of the
country where they registered; the offline card (signed QR) is how information travels across borders
(COMPLIANCE.md section 6).

The server refuses to start with `DEMO_MODE=0` unless both are set:

| Variable | Meaning |
|---|---|
| `DEPLOYMENT_COUNTRY` | ISO 3166-1 alpha-2 code of the country this deployment serves, e.g. `NG`, `KE` |
| `DEPLOYMENT_REGION` | The in-country hosting region, e.g. the cloud region or data centre name |

At start-up the server logs one JSON line with the country, region, storage backend, key provider, malware
scanner and SMS provider (no secrets, no personal data), for example:

```json
{"ts":"...","level":"info","event":"startup","version":"1.0.0","demoMode":false,"country":"NG","region":"lagos-1","storage":"postgres","keyProvider":"env","malwareScanner":"clamd (clamav:3310)","smsProvider":"africastalking"}
```

TODO: which hosting regions qualify as "in-country" for each country is a legal question; confirm it per country.

## 2. Data that must stay in-country

Everything below is stored or processed only inside the deployment country:

- The PostgreSQL database (all patient, clinical, consent, audit, account and delivery data).
- Backups (encrypted dumps) and the backup storage.
- Application logs (they are redacted, see section 6, but they still describe activity).
- Uploaded documents (stored encrypted inside the database).
- Keys: `FIELD_ENCRYPTION_KEY` (and previous versions), `JWT_SECRET`, `OFFLINE_CARD_PRIVATE_KEY`, the backup
  GPG private key, and any KMS keys (section 4).
- The malware scanner (clamd): uploads are streamed to it, so it runs next to the application.
- SMS and USSD traffic passes through the SMS provider and the telcos; choose a provider and configuration that
  meet the country's rules (COMPLIANCE.md section 7).

What leaves the deployment: the patient's own printed offline card (they carry it), and the public card keys
(`/.well-known/medistry-keys.json`), which contain no personal data.

### The LLM path (MCP agent)

The Gemini agent in `mcp/` sends task text and tool results to an external model API. For real data this path must
be **disabled**, or the model must run **in-country** under an approved agreement. The agent refuses to run when
`DEMO_MODE=0` unless `LLM_IN_COUNTRY_APPROVED=1` is set; set that only when the model endpoint is in-country and
approved. The minimiser in the agent (Phase 8) reduces what is sent but does not make an external model acceptable
for real data.

### The AI intake model (clinician intake from paper or voice)

**Real patient data (PHI) may only be sent to an in-country or self-hosted model, or to a model provider for which
there is a lawful basis for the transfer.** By default intake uses a deterministic, rule-based stand-in that never
leaves the process. A real model is used only when `INTAKE_LLM_PROVIDER` is set (`http`, with `INTAKE_LLM_URL`,
`INTAKE_LLM_API_KEY`, `INTAKE_LLM_MODEL`), and with `DEMO_MODE=0` only when `LLM_IN_COUNTRY_APPROVED=1` records that
one of those conditions holds. The `http` adapter speaks a small Medistry contract (documented in
`src/lib/intake/adapters.ts`); wrap the deployment's own model in a service that implements it. OCR and
speech-to-text have no provider yet (photos and voice notes are refused with a clear message): TODO choose
in-country providers, under the same rule. Whatever the model returns is checked (only known fields, spans must be
in the source text) and saved only as drafts; nothing becomes part of a record until a doctor signs it.

## 3. Required services and settings

| Need | How |
|---|---|
| PostgreSQL | `STORAGE=postgres`, `DATABASE_URL`; apply migrations with `npx prisma migrate deploy` |
| Secrets | `FIELD_ENCRYPTION_KEY` (64 hex), `JWT_SECRET` (32+ chars), `OFFLINE_CARD_PRIVATE_KEY` (`node scripts/gen-card-key.mjs`) |
| Malware scanning | clamd reachable at `CLAMD_HOST`/`CLAMD_PORT` (default `localhost:3310`). With `DEMO_MODE=0` uploads are rejected when clamd is unreachable (fail closed). `docker compose up -d clamav` runs one; the first start downloads signatures and takes several minutes. |
| Uploads | `UPLOAD_MAX_MB` (default 10). Only PDF, PNG and JPEG, checked by content (magic bytes); image metadata is removed before storage. |
| First admin | `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD_HASH`, `PLATFORM_ADMIN_TOTP_SECRET` (`scripts/admin-credentials.ts`) |
| SMS / USSD | `SMS_PROVIDER=africastalking`, `AT_*`, `SMS_WEBHOOK_SECRET`, `USSD_CALLBACK_SECRET`, `USSD_SERVICE_CODE` (README, "SMS and USSD") |
| One instance | One application instance per database (README, "Status and known limits") |
| EMR integration | A facility admin creates an API client (`POST /api/admin/facility-api-clients`); the EMR exchanges it at `POST /api/fhir/token` (client credentials, `API_TOKEN_TTL_SECONDS`, default 300) and pushes FHIR R4 bundles to `POST /api/fhir/import`. The OpenMRS/KenyaEMR pull connector reads `OPENMRS_BASE_URL`, `OPENMRS_USERNAME`, `OPENMRS_PASSWORD` (site-specific mapping TODOs in `src/lib/integrations/emr/OpenMrsConnector.ts`). |

`GET /api/health` reports `version`, `uptimeSeconds`, `storage` (mode, pending and failed writes, status) and
`malwareScanner` (`up`, `down`, or `not-antivirus` for the demo test-pattern scanner). `status` is `DEGRADED` when
stored writes have failed or clamd is down. It contains no personal data. Point the hosting platform's health check
and alerting at it.

## 4. Keys

All key use goes through a `KeyProvider` (`src/lib/crypto/keyProvider.ts`).

- `KEY_PROVIDER=env` (default): keys from environment variables.
- `KEY_PROVIDER=cloud-kms`: a stub. The intended design signs cards and passes inside the KMS (the private key never
  enters the application) and uses envelope encryption for field keys. Startup fails until it is implemented.
  TODO: implement against the chosen cloud KMS, in-country.

### Field-encryption key rotation

Ciphertexts start with `v<version>:`; values written before versioning count as version 1.

1. Generate a new key (`openssl rand -hex 32`). Set `FIELD_ENCRYPTION_KEY=<new>`,
   `FIELD_ENCRYPTION_KEY_VERSION=<old version + 1>` and `FIELD_ENCRYPTION_PREVIOUS_KEYS=<old version>:<old key>`
   (comma-separate more than one). Restart: the app reads every listed version and writes the new one. Phone and
   email lookups try every version, so sign-in keeps working.
2. Re-encrypt stored data: `STORAGE=postgres node --experimental-strip-types scripts/rotate-field-key.ts --dry-run`
   to count, then without `--dry-run`. It works in batches (`--batch=200`), can be interrupted and re-run, and also
   rewrites phone and email lookup hashes. It finishes by printing `"remaining":0`.
3. Take a backup, then remove the old key from `FIELD_ENCRYPTION_PREVIOUS_KEYS` at the next restart. Backups made
   before the rotation still need the old key: keep it with the backup custodian for as long as those backups are kept.

### Card key rotation

1. Generate a new key with `node scripts/gen-card-key.mjs` and set it as `OFFLINE_CARD_PRIVATE_KEY`. New cards carry
   the new `kid`.
2. Add the old **public** key to `OFFLINE_CARD_PREVIOUS_PUBLIC_KEYS` as `<SPKI>@<date>`, where the date is when the
   last card signed with the old key expires: rotation date + `OFFLINE_CARD_VALIDITY_DAYS`. The old key stays in the
   JWKS (so scanners keep accepting those cards) until that date, then drops out.
3. If a key is compromised, do not keep it: remove it at once and ask patients to reissue (THREAT_MODEL.md section 3).

## 5. Backups and restore

### Daily backup

`scripts/backup.sh` streams `pg_dump --format=custom` straight into GPG, encrypted to a public key; no plaintext dump
touches the disk. Only the public key is on the server. The private key is held offline by the backup custodian.

```sh
export DATABASE_URL=...  BACKUP_DIR=/backups/medistry  BACKUP_GPG_RECIPIENT=backup@your-org.example
scripts/backup.sh        # writes medistry-<UTC>.dump.gpg + .sha256, deletes dumps older than BACKUP_KEEP_DAYS (14)
```

Run it daily (cron, or the platform's scheduled jobs), for example `15 2 * * * /app/scripts/backup.sh`. Keep
`BACKUP_DIR` in-country and on storage separate from the database. Needs `pg_dump` matching the server's major
version, and `gpg`.

### Restore procedure (tested)

Restore into a **new, empty** database, never over the live one.

1. Create an empty database and point `RESTORE_DATABASE_URL` at it.
2. Import the custodian's GPG private key on the restore machine.
3. `scripts/restore.sh /backups/medistry/medistry-<UTC>.dump.gpg`: checks the `.sha256`, decrypts and runs
   `pg_restore`.
4. `DATABASE_URL=<restored> node --experimental-strip-types scripts/verify-restore.ts`: loads everything the app
   loads, verifies the audit hash chain, and prints row counts and the latest audit hash. Compare with the same
   command against the source (or with the counts recorded at backup time).
5. Start the application against the restored database. It refuses to start if the stored audit chain does not
   verify.
6. Switch traffic, then keep the old database until the restored one has been checked by people.

The CI `postgres` job runs this drill on every push: backup with a throwaway GPG key, restore into a second
database, and compare `verify-restore.ts` output for source and restore (they must be identical). Repeat the drill
by hand in each deployment at least once per quarter, and record the date.

## 6. Logs

Logs are one JSON object per line with `ts`, `level`, `event` and fields, and a `requestId` per HTTP request (from a
well-formed `X-Request-Id` header, or generated; it is echoed in the response). Request lines record method, path
(no query string), status and duration. Every line goes through a redaction function
(`src/lib/ops/logger.ts`) that removes phone numbers and other long digit runs (NIN), emails, emergency codes, bearer
and JWS/session tokens, and blanks fields named for personal data (names, contact details, codes, secrets, free
text). Redaction is a safety net: code must not log personal data in the first place. Keep logs in-country, with
access limited to operators.

## 7. Before going live

- [ ] COMPLIANCE.md section 7 items done for this country.
- [ ] `DEMO_MODE=0`, `DEPLOYMENT_COUNTRY`, `DEPLOYMENT_REGION` set; startup log line checked.
- [ ] `/api/health` shows `storage.status: ok` and `malwareScanner.status: up`.
- [ ] Daily backup scheduled; one restore drill done and recorded.
- [ ] Key custody written down (who holds what, where, how to rotate).
- [ ] LLM agent disabled (or in-country and approved).
- [ ] `npm audit` reviewed (CI reports it).
