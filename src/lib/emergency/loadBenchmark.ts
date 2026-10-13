/**
 * MEDISTRY Emergency Summary Load & Latency Benchmark Engine
 * Evaluates server-side triage compilation and HTML rendering speed
 * across iterations to guarantee sub-1.5s p95 budget even over high-latency 3G networks.
 */

import { performance } from 'node:perf_hooks';
import { AuditChainManager } from '../audit/hashChain.ts';
import { ClinicalDataStore } from '../clinical/store.ts';
import { ClinicalTimelineEngine } from '../clinical/timeline.ts';
import { NotificationDispatcher } from '../notifications/dispatcher.ts';
import { EmergencyBreakGlassEngine } from './breakGlassEngine.ts';
import { renderEmergencySummaryHtml } from './summaryRenderer.ts';
import { createPatientRecord, type PatientEntity } from '../patient/profile.ts';
import type { ActorContext } from '../policy/enforcer.ts';

export interface LatencyMetrics {
  iterations: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  throughputPerSecond: number;
  payloadByteSize: number;
  meets3GBudget: boolean; // Server overhead < 10ms ensures network delivery remains well under 1500ms
}

export async function benchmarkEmergencySummaryPath(iterations = 1000): Promise<LatencyMetrics> {
  const auditManager = new AuditChainManager();
  const clinicalStore = new ClinicalDataStore(auditManager);
  const timelineEngine = new ClinicalTimelineEngine(clinicalStore);
  const dispatcher = new NotificationDispatcher();
  const engine = new EmergencyBreakGlassEngine(auditManager, clinicalStore, timelineEngine, dispatcher);

  const patient = createPatientRecord(
    { firstName: 'Amara', lastName: 'Okonkwo', dateOfBirth: '1998-04-12', gender: 'female' },
    {
      bloodGroup: 'O_POSITIVE',
      genotype: 'SS',
      allergies: [
        { substance: 'Penicillin', category: 'drug', reaction: 'Anaphylaxis', severity: 'severe' },
        { substance: 'Peanuts', category: 'food', reaction: 'Urticaria', severity: 'moderate' },
      ],
      chronicConditions: ['Sickle Cell Anemia', 'Vaso-occlusive pain episodes'],
      activeMedications: [{ medicationName: 'Hydroxyurea', dose: '500mg daily', route: 'oral', sinceDate: '2021-06-10' }],
      emergencyContacts: [{ id: 'c1', name: 'Emeka Okonkwo', relationship: 'Brother', phone: '+234 802 111 2233', priority: 1 }],
      advanceDirectiveDnr: false,
      organDonor: true,
      publicEmergencyOptIn: false,
    },
    { userId: 'bench-user-1', countryCode: 'NG', primaryFacilityId: 'fac-luth-001' }
  );

  const doctorActor: ActorContext = {
    userId: 'user-doc-bench',
    role: 'DOCTOR',
    clinicianId: 'clinician-mdcn-10294',
    isVerifiedClinician: true,
  };

  const { grant } = await engine.initiateBreakGlass({
    patient,
    emergencyCode: 'K7QM-4T9X-2HDP-8W2',
    actor: doctorActor,
    treatingDoctorName: 'Dr. Robert Caldwell',
    facilityId: 'fac-luth-001',
    facilityName: 'LUTH Emergency Department',
    reason: 'LIFE_THREATENING',
  });

  const latencies: number[] = [];
  let samplePayloadSize = 0;

  // Warm up JIT
  for (let i = 0; i < 50; i++) {
    const s = engine.buildEmergencySummary(patient, grant.id);
    renderEmergencySummaryHtml(s);
  }

  const startTotal = performance.now();

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    const summaryData = engine.buildEmergencySummary(patient, grant.id);
    const html = renderEmergencySummaryHtml(summaryData);
    const t1 = performance.now();

    latencies.push(t1 - t0);
    if (i === 0) {
      samplePayloadSize = Buffer.byteLength(html, 'utf-8');
    }
  }

  const totalTimeMs = performance.now() - startTotal;
  latencies.sort((a, b) => a - b);

  const getPercentile = (pct: number) => {
    const idx = Math.min(latencies.length - 1, Math.floor((pct / 100) * latencies.length));
    return latencies[idx];
  };

  const sum = latencies.reduce((acc, v) => acc + v, 0);
  const meanMs = sum / iterations;
  const p50Ms = getPercentile(50);
  const p90Ms = getPercentile(90);
  const p95Ms = getPercentile(95);
  const p99Ms = getPercentile(99);

  return {
    iterations,
    minMs: latencies[0],
    maxMs: latencies[latencies.length - 1],
    meanMs,
    p50Ms,
    p90Ms,
    p95Ms,
    p99Ms,
    throughputPerSecond: Math.round((iterations / (totalTimeMs / 1000))),
    payloadByteSize: samplePayloadSize,
    meets3GBudget: p95Ms < 10.0 && samplePayloadSize < 50 * 1024,
  };
}

