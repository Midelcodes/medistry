/**
 * Patient registration with identity checks and duplicate prevention (Phase 16). Done by a facility admin, a
 * records officer, or a platform admin, after seeing the person.
 *
 *   1. National identifiers are checked against the blind index: an exact match is the same person, so the existing
 *      record is returned and nothing is created.
 *   2. Identifiers are verified with the country's verifier. 'mismatch' or 'not_found' stops the registration (the
 *      number or the details are wrong); 'unavailable' does not (the identifier is kept as unverified).
 *   3. The new record is created, and probable duplicates (name, date of birth, gender, phone) at or above the
 *      review threshold are queued for a records officer. Nothing is merged automatically.
 */
import crypto from 'node:crypto';
import { createPatientRecord, type PatientEntity } from '../patient/profile.ts';
import { generatePatientUniqueCode } from '../code/crockford.ts';
import type { SeedDatabasePayload } from '../../../prisma/seed.ts';
import type { AuditChainManager } from '../audit/hashChain.ts';
import type { EmergencyCodeRepo, PatientRepo } from '../data/repositories.ts';
import type { UserAccount } from '../auth/accounts.ts';
import { normalizePhone } from '../auth/accounts.ts';
import { AuthError, type PatientAuthService, type RequestInfo } from '../auth/patientAuth.ts';
import { evaluatePolicy } from '../policy/enforcer.ts';
import { deploymentCountry } from '../security/config.ts';
import { ID_TYPES, normaliseIdNumber, type IdentityVerifier } from './IdentityVerifier.ts';
import { IdentityStore } from './identityStore.ts';
import type { MasterPatientIndex } from './mpi.ts';

const NAME = /^[\p{L}\p{M}][\p{L}\p{M}' .-]{0,79}$/u;

export class PatientRegistrationService {
  private deps: {
    seedData: SeedDatabasePayload; patientsById: Map<string, PatientEntity>; patientsByCode: Map<string, PatientEntity>;
    codeByPatient: Map<string, { rawCode: string; formattedCode: string }>; auditManager: AuditChainManager;
    identity: IdentityStore; mpi: MasterPatientIndex; verifierFor: (country: string) => IdentityVerifier; patientAuth: PatientAuthService;
  };
  persistence?: PatientRepo & EmergencyCodeRepo;

  constructor(deps: PatientRegistrationService['deps']) {
    this.deps = deps;
  }

  private parseIdentifiers(raw: unknown): Array<{ country: string; idType: string; idNumber: string }> {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > 5) throw new AuthError(400, 'identifiers must be a list (at most 5)');
    return raw.map((x: any) => {
      const country = String(x?.country || '').toUpperCase();
      const idType = String(x?.idType || '').toUpperCase();
      const format = ID_TYPES[country]?.[idType];
      if (!format) throw new AuthError(400, `Unsupported identifier type ${idType.slice(0, 20)} for ${country.slice(0, 2)}`);
      const idNumber = normaliseIdNumber(x?.idNumber);
      // The message never repeats the number.
      if (!format.test(idNumber)) throw new AuthError(400, `The ${idType} number is not in the expected format`);
      return { country, idType, idNumber };
    });
  }

  async register(actor: UserAccount, body: any, info: RequestInfo) {
    const facilityId = actor.role === 'PLATFORM_ADMIN' ? String(body.facilityId || '') : actor.facilityId || '';
    const decision = evaluatePolicy({ actor: { userId: actor.id, role: actor.role as any, facilityId: actor.facilityId, isVerifiedStaff: true }, action: 'PATIENT_REGISTER', targetFacilityId: facilityId });
    if (!decision.allowed || !facilityId) throw new AuthError(403, decision.allowed ? 'Give the facilityId' : decision.reason);

    const firstName = String(body.firstName || '').trim();
    const otherNames = String(body.otherNames || '').trim();
    const lastName = String(body.lastName || '').trim();
    if (!NAME.test(firstName) || !NAME.test(lastName) || (otherNames && !NAME.test(otherNames))) throw new AuthError(400, 'Give the first and last name (letters, spaces, hyphens, apostrophes)');
    const dob = String(body.dateOfBirth || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob)) || Date.parse(dob) > Date.now()) throw new AuthError(400, 'dateOfBirth must be a past date (YYYY-MM-DD)');
    const gender = String(body.gender || '').toLowerCase();
    if (!['male', 'female', 'other'].includes(gender)) throw new AuthError(400, 'gender must be male, female or other');
    const phone = body.phone ? normalizePhone(body.phone) : undefined;
    if (body.phone && !phone) throw new AuthError(400, 'phone must be in international format, for example +234 800 000 0000');
    const identifiers = this.parseIdentifiers(body.identifiers);
    const givenNames = [firstName, otherNames].filter(Boolean).join(' ');
    const fullName = `${givenNames} ${lastName}`;

    // 1. Exact identity match: the same person.
    const holders = new Set(identifiers.map((i) => this.deps.identity.findPatient(i.country, i.idType, i.idNumber)).filter((x): x is string => !!x));
    if (holders.size > 1) throw new AuthError(409, 'These identifiers belong to different existing patients. Ask a records officer to review.');
    if (holders.size === 1) {
      const existing = this.deps.mpi.canonical([...holders][0]);
      this.deps.auditManager.appendEntry({ actorId: actor.id, subjectId: existing, action: 'PATIENT_REGISTRATION_EXISTING', accessType: 'SYSTEM_ADMIN', facilityId, ipAddress: info.ipAddress, userAgent: info.userAgent, reason: 'Registration matched an existing patient by national identifier; no new record created' });
      return { outcome: 'existing' as const, patientId: existing, identity: this.deps.identity.forPatient(existing).map(IdentityStore.masked), duplicateCandidates: [] };
    }

    // 2. Verify with the national channel. 'unavailable' never blocks.
    const verifications = [];
    for (const id of identifiers) {
      const v = await this.deps.verifierFor(id.country).verify({ ...id, name: fullName, dob });
      if (v.status === 'mismatch') throw new AuthError(422, `The ${id.idType} details do not match the national record. Check the number, name and date of birth.`);
      if (v.status === 'not_found') throw new AuthError(422, `The ${id.idType} number was not found. Check it with the patient.`);
      verifications.push(v);
    }

    // 3. Create the record, then queue probable duplicates for review.
    const candidates = this.deps.mpi.findCandidates({ name: fullName, dob, gender, phone });
    const patient = createPatientRecord(
      { firstName: givenNames, lastName, dateOfBirth: dob, gender: gender as 'male' | 'female' | 'other' },
      { bloodGroup: 'UNKNOWN', genotype: 'UNKNOWN', emergencyContacts: [], allergies: [], chronicConditions: [], activeMedications: [] },
      { userId: crypto.randomUUID(), countryCode: deploymentCountry(), primaryFacilityId: facilityId },
    );
    const code = generatePatientUniqueCode('medistry.health');
    patient.activeEmergencyCodeId = code.rawCode;
    this.deps.patientsById.set(patient.id, patient);
    this.deps.patientsByCode.set(code.rawCode, patient);
    this.deps.patientsByCode.set(code.formattedCode, patient);
    this.deps.codeByPatient.set(patient.id, { rawCode: code.rawCode, formattedCode: code.formattedCode });
    this.deps.seedData.patients.push({ patient, emergencyCode: { rawCode: code.rawCode, formattedCode: code.formattedCode, scanUrl: code.scanUrl }, encounters: [] });
    this.persistence?.savePatient(patient);
    this.persistence?.saveEmergencyCode({ patientId: patient.id, rawCode: code.rawCode, formattedCode: code.formattedCode, isActive: true, createdAt: patient.createdAt });
    identifiers.forEach((id, i) => this.deps.identity.add(patient.id, id, verifications[i]));
    // The phone may already be another record's sign-in (often the duplicate itself): then it stays there, and
    // the duplicate review decides; registration does not fail.
    let phoneLinked = false;
    if (phone) {
      try {
        this.deps.patientAuth.linkPatient(patient, phone, { ...info, adminId: actor.id });
        phoneLinked = true;
      } catch (err: any) {
        if (err?.status !== 409) throw err;
      }
    }
    const reviews = this.deps.mpi.queueReviews(patient.id, candidates, facilityId, 'registration');
    this.deps.auditManager.appendEntry({
      actorId: actor.id, subjectId: patient.id, action: 'PATIENT_REGISTERED', accessType: 'SYSTEM_ADMIN', facilityId, ipAddress: info.ipAddress, userAgent: info.userAgent,
      reason: `Registered with ${identifiers.length} identifier(s) (${verifications.map((v) => v.status).join(', ') || 'none'}); ${reviews.length} possible duplicate(s) queued for review`,
    });
    return {
      outcome: 'created' as const, patientId: patient.id, emergencyCode: code.formattedCode, phoneLinked,
      identity: this.deps.identity.forPatient(patient.id).map(IdentityStore.masked),
      duplicateCandidates: reviews.map((r) => ({ reviewId: r.id, candidatePatientId: r.candidatePatientId, score: r.score })),
    };
  }
}
