/**
 * Storage selection. STORAGE=postgres with DATABASE_URL uses PostgreSQL through Prisma (write-through);
 * anything else uses memory, so `npm start` and `npm test` need no database.
 *
 * Postgres also needs stable secrets: data encrypted with a random per-process key could not be read after a
 * restart, and cards or clinician passes signed with one would stop verifying. So with STORAGE=postgres the
 * server refuses to start unless FIELD_ENCRYPTION_KEY, JWT_SECRET and OFFLINE_CARD_PRIVATE_KEY are set.
 */
import type { Persistence, StorageMode } from './repositories.ts';
import { createMemoryPersistence } from './memory/persistence.ts';

export function storageMode(env: NodeJS.ProcessEnv = process.env): StorageMode {
  if ((env.STORAGE || '').trim().toLowerCase() !== 'postgres') return 'memory';
  if (!(env.DATABASE_URL || '').trim()) {
    // Asked for Postgres but not configured: fail rather than silently keep data only in memory.
    throw new Error('STORAGE=postgres needs DATABASE_URL (for example postgresql://medistry:...@localhost:5432/medistry).');
  }
  return 'postgres';
}

/** Throws with the missing variable names if Postgres storage cannot keep data readable across restarts. */
export function assertPostgresSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const missing: string[] = [];
  if (!/^[0-9a-fA-F]{64}$/.test((env.FIELD_ENCRYPTION_KEY || '').trim())) missing.push('FIELD_ENCRYPTION_KEY (64 hex characters)');
  if ((env.JWT_SECRET || '').trim().length < 32) missing.push('JWT_SECRET (32+ characters)');
  if (!(env.OFFLINE_CARD_PRIVATE_KEY || '').trim()) missing.push('OFFLINE_CARD_PRIVATE_KEY (node scripts/gen-card-key.mjs)');
  if (!/^[0-9a-fA-F]{64}$/.test((env.IDENTITY_INDEX_KEY || '').trim())) missing.push('IDENTITY_INDEX_KEY (64 hex characters, not the field key)');
  if (missing.length) {
    throw new Error(`STORAGE=postgres needs stable secrets so stored data stays readable after a restart. Set: ${missing.join(', ')}.`);
  }
}

export async function createPersistence(env: NodeJS.ProcessEnv = process.env): Promise<Persistence> {
  if (storageMode(env) === 'memory') return createMemoryPersistence();
  assertPostgresSecrets(env);
  const { createPrismaPersistence } = await import('./prisma/persistence.ts'); // loads @prisma/client only when used
  return createPrismaPersistence();
}
