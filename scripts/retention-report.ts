#!/usr/bin/env node
// Retention report (report only): prints, as JSON, what each configured retention rule WOULD archive. It deletes,
// archives and changes nothing. Periods come from RETENTION_* variables (no defaults; see .env.example).
//   node --env-file-if-exists=.env --experimental-strip-types scripts/retention-report.ts
import { createPersistence } from '../src/lib/data/storage.ts';
import { createRuntime } from '../src/lib/runtime.ts';
import { retentionReport } from '../src/lib/ops/retention.ts';

const persistence = await createPersistence();
try {
  const rt = await createRuntime(persistence);
  console.log(JSON.stringify(retentionReport(rt), null, 2));
} catch (err: any) {
  console.error(`Retention report failed: ${String(err?.message || err).split(/\r?\n/).filter(Boolean).pop()}`);
  process.exitCode = 1;
} finally {
  await persistence.close().catch(() => {});
}
