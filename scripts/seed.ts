#!/usr/bin/env node
// `npm run seed`: with STORAGE=postgres, writes the synthetic dataset into PostgreSQL; otherwise prints a summary.
// Refuses to run when DEMO_MODE=0: synthetic patients must never be seeded into a real deployment.
// If the database already has patients nothing is written, unless SEED_RESET=1 (wipes and reseeds; demo only).

async function main(): Promise<number> {
  if (process.env.DEMO_MODE === '0') {
    console.error('Refusing to seed: DEMO_MODE=0. Synthetic patients must never be written into a real deployment.');
    return 1;
  }
  const { createPersistence } = await import('../src/lib/data/storage.ts');
  const persistence = await createPersistence();
  if (persistence.mode !== 'postgres') {
    const { generateSeedData } = await import('../prisma/seed.ts');
    const seedData = generateSeedData();
    console.log('✅ Generated MEDISTRY Synthetic Database (memory; set STORAGE=postgres and DATABASE_URL to store it):');
    console.log(`   • Facilities: ${seedData.facilities.length} (${seedData.facilities.filter((f) => f.countryCode === 'KE').length} synthetic Kenyan)`);
    console.log(`   • Clinicians: ${seedData.clinicians.length}`);
    console.log(`   • Synthetic Patients: ${seedData.patients.length}`);
    return 0;
  }

  // Apply pending migrations first (idempotent), so `docker compose up -d && STORAGE=postgres npm run seed` works
  // on a fresh database.
  const { spawnSync } = await import('node:child_process');
  const migrate = spawnSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { stdio: 'inherit' });
  if (migrate.status !== 0) {
    await persistence.close().catch(() => {});
    console.error('Seeding failed: database migrations could not be applied (see above).');
    return 1;
  }

  const { seedDatabase } = await import('../src/lib/runtime.ts');
  try {
    const existing = await persistence.loadSnapshot();
    if (existing && existing.patients.length && process.env.SEED_RESET !== '1') {
      console.log(`The database already holds ${existing.patients.length} patients. Nothing written. Set SEED_RESET=1 to wipe and reseed (demo only).`);
      return 0;
    }
    if (existing && existing.patients.length) await (persistence as unknown as { wipe(): Promise<void> }).wipe();
    const result = await seedDatabase(persistence);
    const { failedWrites } = persistence.stats();
    if (failedWrites) {
      console.error(`Seeding finished with ${failedWrites} failed writes (see the [storage] errors above).`);
      return 1;
    }
    console.log(`✅ Seeded PostgreSQL: ${result.patients} synthetic patients, ${result.records} encounters, ${result.auditEntries} audit entries.`);
    return 0;
  } finally {
    await persistence.close().catch(() => {});
  }
}

main().then((code) => process.exit(code), (err: any) => {
  // One clear line (database unreachable, missing secrets), never a stack dump of the database client.
  console.error(`Seeding failed: ${String(err?.message || err).split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean).pop()}`);
  process.exit(1);
});
