// PostgreSQL storage, against a real database. Runs only with STORAGE=postgres and DATABASE_URL (the CI
// "postgres" job: migrations applied, FIELD_ENCRYPTION_KEY / JWT_SECRET / OFFLINE_CARD_PRIVATE_KEY set).
// Skipped everywhere else. This file wipes the database it is pointed at: never point it at real data.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { AuditChainManager } from '../src/lib/audit/hashChain.ts';
import { generateSeedData } from '../prisma/seed.ts';
import type { PrismaPersistence } from '../src/lib/data/prisma/persistence.ts';

const enabled = process.env.STORAGE === 'postgres' && !!process.env.DATABASE_URL;

function startServer(port: number) {
  const out: string[] = [];
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], {
    env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (d) => out.push(String(d)));
  child.stderr!.on('data', (d) => out.push(String(d)));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, out, exited };
}
async function waitUp(base: string, server: { out: string[]; exited: Promise<number | null> }) {
  let done = false;
  server.exited.then(() => { done = true; });
  for (let i = 0; i < 100 && !done; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start:\n${server.out.join('').slice(-2000)}`);
}
async function stop(server: { child: ChildProcess; exited: Promise<number | null> }) {
  server.child.kill('SIGTERM'); // the server flushes queued writes before it exits
  return server.exited;
}

describe('PostgreSQL storage', { skip: enabled ? false : 'needs STORAGE=postgres and DATABASE_URL (runs in the CI postgres job)' }, () => {
  let db: PrismaPersistence;

  before(async () => {
    const { createPrismaPersistence } = await import('../src/lib/data/prisma/persistence.ts');
    db = createPrismaPersistence();
  });
  after(async () => { await db?.close(); });

  test('20 concurrent audit appends form one valid chain', async () => {
    await db.wipe();
    const entries = await Promise.all(Array.from({ length: 20 }, (_, i) => db.appendComputed({
      actorId: `concurrency-${i}`, action: 'CONCURRENCY_TEST', accessType: 'SYSTEM_ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', reason: `append ${i}`,
    })));
    assert.deepStrictEqual(entries.map((e) => e.sequenceNumber).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
    const stored = (await db.loadSnapshot()).audit;
    assert.strictEqual(stored.length, 20);
    const chain = new AuditChainManager(stored).verifyChain();
    assert.strictEqual(chain.valid, true, chain.error);
    assert.ok(stored.every((e) => e.reason?.startsWith('append ')), 'reasons decrypt');
  });

  test('A write-through append that does not continue the stored chain is refused', async () => {
    const before = db.stats().failedWrites;
    const stored = (await db.loadSnapshot()).audit;
    db.appendAudit({ ...stored[4], id: crypto.randomUUID() }); // sequence 5 again: would fork the chain
    await db.flush();
    assert.strictEqual(db.stats().failedWrites, before + 1);
    assert.strictEqual((await db.loadSnapshot()).audit.length, 20);
  });

  test('The server refuses to start on an empty database', async () => {
    await db.wipe();
    const server = startServer(44100 + Math.floor(Math.random() * 300));
    const code = await server.exited;
    assert.strictEqual(code, 1);
    assert.match(server.out.join(''), /The database is empty\. Seed it first/);
  });

  test('npm run seed writes the dataset, and personal and health data are encrypted at rest', async () => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/seed.ts'], { env: { ...process.env, SEED_RESET: '1' }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /Seeded PostgreSQL: 10 synthetic patients/);
    const again = spawnSync(process.execPath, ['--experimental-strip-types', 'scripts/seed.ts'], { env: { ...process.env }, encoding: 'utf8' });
    assert.match(again.stdout, /already holds 10 patients\. Nothing written/);

    const seed = generateSeedData();
    const first = seed.patients[0];
    const raw = JSON.stringify(await Promise.all(['Patient', 'EmergencyCode', 'AuditLog', 'PatientRecord', 'NotificationLog', 'ConsentGrant']
      .map((t) => db.client.$queryRawUnsafe(`SELECT * FROM "${t}"`))));
    const banned = ['Amara', 'Okonkwo', '1998-04-12', 'Penicillin', 'Sickle Cell', 'Hydroxyurea', first.patient.emergencyContacts[0].phone,
      first.emergencyCode.formattedCode, first.emergencyCode.rawCode, 'Vaso-occlusive'];
    for (const b of banned) assert.ok(!raw.includes(b), `database must not hold plaintext ${b}`);
    const snap = await db.loadSnapshot();
    assert.strictEqual(snap.patients.length, 10);
    assert.strictEqual(new AuditChainManager(snap.audit).verifyChain().valid, true);
  });

  test('Restart persistence: a card and its audit entry survive a server restart', async () => {
    const port = 44500 + Math.floor(Math.random() * 300);
    const base = `http://localhost:${port}`;
    let server = startServer(port);
    await waitUp(base, server);
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.strictEqual(health.storage.mode, 'postgres');
    const { patients } = await (await fetch(`${base}/api/patients`)).json();
    const id = patients[0].id;
    const issued = await (await fetch(`${base}/api/patients/${id}/offline-card`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    assert.ok(issued.token);
    assert.strictEqual(await stop(server), 0);

    server = startServer(port);
    await waitUp(base, server);
    try {
      const card = await (await fetch(`${base}/api/patients/${id}/offline-card`)).json();
      assert.strictEqual(card.cardVersion, issued.cardVersion);
      assert.strictEqual(card.token, issued.token, 'the same signed card, not a new one');
      const { cards } = await (await fetch(`${base}/api/patients/${id}/offline-cards`)).json();
      assert.strictEqual(cards.at(-1).version, issued.cardVersion);
      const { logs } = await (await fetch(`${base}/api/patients/${id}/access-log`)).json();
      assert.ok(logs.some((l: { action: string }) => l.action === 'OFFLINE_CARD_ISSUED'), 'audit entry survived');
      const chain = await (await fetch(`${base}/api/audit/verify`)).json();
      assert.strictEqual(chain.valid, true);
      const after = await (await fetch(`${base}/api/health`)).json();
      assert.deepStrictEqual([after.storage.mode, after.storage.failedWrites], ['postgres', 0]);
    } finally {
      await stop(server);
    }
  });
});
