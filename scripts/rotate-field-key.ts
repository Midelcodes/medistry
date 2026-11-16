#!/usr/bin/env node
// Field-encryption key rotation, step 2 of 3 (docs/DEPLOYMENT.md, "Key rotation"): re-encrypts every stored
// ciphertext that is not yet under the current key version, in batches, and rewrites phone/email lookup hashes.
//
//   1. Set FIELD_ENCRYPTION_KEY=<new key>, FIELD_ENCRYPTION_KEY_VERSION=<n+1> and
//      FIELD_ENCRYPTION_PREVIOUS_KEYS=<n>:<old key>[,...]; restart the app (it reads old, writes new).
//   2. Run this:  STORAGE=postgres node --env-file=.env --experimental-strip-types scripts/rotate-field-key.ts [--dry-run] [--batch=200]
//   3. When it reports 0 remaining, remove the old key from FIELD_ENCRYPTION_PREVIOUS_KEYS at the next restart.
//
// Safe to re-run and to interrupt: rows already under the current version are skipped. Prints counts only.
import { PrismaClient } from '@prisma/client';
import { keyProvider } from '../src/lib/crypto/keyProvider.ts';
import { decryptField, reencryptField } from '../src/lib/patient/profile.ts';
import { identifierHash } from '../src/lib/auth/accounts.ts';

/** Every encrypted column (see src/lib/data/prisma/mappers.ts). */
const TARGETS: Array<{ model: string; id: string; columns: string[] }> = [
  { model: 'user', id: 'id', columns: ['encryptedPhone', 'encryptedEmail', 'twoFactorSecret'] },
  { model: 'clinician', id: 'id', columns: ['encryptedRejectionReason'] },
  { model: 'patient', id: 'id', columns: ['encryptedFirstName', 'encryptedLastName', 'encryptedDob', 'encryptedNin', 'encryptedEmergencyProfile'] },
  { model: 'clinicianLicenceDocument', id: 'id', columns: ['encryptedFilename', 'encryptedPayload'] },
  { model: 'offlineCard', id: 'id', columns: ['encryptedCurrentToken'] },
  { model: 'offlineScanEvent', id: 'id', columns: ['encryptedDetails'] },
  { model: 'emergencyCode', id: 'id', columns: ['encryptedCode'] },
  { model: 'patientRecord', id: 'id', columns: ['encryptedPayload'] },
  { model: 'recordFlag', id: 'id', columns: ['encryptedNote'] },
  { model: 'consentRequest', id: 'id', columns: ['encryptedClinicalReason'] },
  { model: 'consentGrant', id: 'id', columns: ['encryptedClinicalReason'] },
  { model: 'emergencyAccessGrant', id: 'id', columns: ['encryptedEmergencyCode', 'encryptedReasonDetails', 'encryptedCoSignReason'] },
  { model: 'disputeTicket', id: 'ticketId', columns: ['encryptedDisputeReason'] },
  { model: 'notificationLog', id: 'id', columns: ['encryptedRecipient', 'encryptedTitle', 'encryptedBody'] },
  { model: 'auditLog', id: 'id', columns: ['encryptedReason'] }, // the audit hash covers the plaintext, so the chain is unaffected
  { model: 'intakeSession', id: 'id', columns: ['encryptedSourceText', 'encryptedFile', 'encryptedProposals'] },
  { model: 'facilityPatientLink', id: 'valueHash', columns: ['encryptedValue'] }, // lookups try every key version meanwhile
];

async function main(): Promise<number> {
  if (process.env.STORAGE !== 'postgres' || !process.env.DATABASE_URL) {
    console.error('Nothing to rotate: set STORAGE=postgres and DATABASE_URL (memory storage keeps nothing at rest).');
    return 1;
  }
  const dryRun = process.argv.includes('--dry-run');
  const batch = Math.min(1000, Math.max(1, parseInt(process.argv.find((a) => a.startsWith('--batch='))?.split('=')[1] || '200', 10) || 200));
  const version = keyProvider().getFieldEncryptionKey().version;
  const prefix = `v${version}:`;
  const client = new PrismaClient();
  let total = 0;
  try {
    for (const t of TARGETS) {
      const delegate = (client as any)[t.model];
      // NULL columns never match NOT LIKE, so only stored ciphertexts under another version are selected.
      const where = { OR: t.columns.map((c) => ({ NOT: { [c]: { startsWith: prefix } } })) };
      if (dryRun) {
        const n = await delegate.count({ where });
        console.log(JSON.stringify({ table: t.model, toReencrypt: n }));
        total += n;
        continue;
      }
      const seen = new Set<string>();
      let done = 0;
      for (;;) {
        const rows: any[] = await delegate.findMany({ where, take: batch, select: Object.fromEntries([t.id, ...t.columns].map((c) => [c, true])) });
        const fresh = rows.filter((r) => !seen.has(r[t.id]));
        if (!fresh.length) break; // nothing new: done (or rows that cannot change)
        await client.$transaction(fresh.map((r) => {
          seen.add(r[t.id]);
          const data: Record<string, string> = {};
          for (const c of t.columns) if (typeof r[c] === 'string' && !r[c].startsWith(prefix)) data[c] = reencryptField(r[c]);
          // Lookup hashes follow the key version too (accounts.ts tries every version meanwhile).
          if (t.model === 'user' && data.encryptedPhone) data.phoneHash = identifierHash('phone', decryptField(data.encryptedPhone));
          if (t.model === 'user' && data.encryptedEmail) data.emailHash = identifierHash('email', decryptField(data.encryptedEmail));
          return delegate.update({ where: { [t.id]: r[t.id] }, data });
        }));
        done += fresh.length;
      }
      const remaining = await delegate.count({ where });
      console.log(JSON.stringify({ table: t.model, reencrypted: done, remaining }));
      total += remaining;
    }
    console.log(JSON.stringify({ event: dryRun ? 'rotation_dry_run' : 'rotation_complete', keyVersion: version, [dryRun ? 'toReencrypt' : 'remaining']: total }));
    return dryRun || total === 0 ? 0 : 1;
  } finally {
    await client.$disconnect();
  }
}

main().then((code) => process.exit(code), (err: any) => {
  console.error(`Rotation failed: ${String(err?.message || err).split(/\r?\n/).filter(Boolean).pop()}`);
  process.exit(1);
});
