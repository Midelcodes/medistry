#!/usr/bin/env node
// Checks a database (normally a freshly restored backup): loads everything the app would load, verifies the audit
// hash chain, and prints one line of row counts (no personal data). Exit 1 if the chain does not verify.
//   DATABASE_URL=<restored db> node --experimental-strip-types scripts/verify-restore.ts
import { createPrismaPersistence } from '../src/lib/data/prisma/persistence.ts';
import { AuditChainManager } from '../src/lib/audit/hashChain.ts';

const db = createPrismaPersistence();
try {
  const snap = await db.loadSnapshot();
  const chain = new AuditChainManager(snap.audit).verifyChain();
  const counts = {
    patients: snap.patients.length, records: snap.records.length, audit: snap.audit.length, cards: snap.offlineCards.length,
    accounts: snap.userAccounts?.length ?? 0, auditChainValid: chain.valid,
    latestAuditHash: snap.audit.at(-1)?.currentHash ?? null,
  };
  console.log(JSON.stringify(counts));
  if (!chain.valid) process.exitCode = 1;
} catch (err: any) {
  console.error(`Verification failed: ${String(err?.message || err).split(/\r?\n/).filter(Boolean).pop()}`);
  process.exitCode = 1;
} finally {
  await db.close().catch(() => {});
}
