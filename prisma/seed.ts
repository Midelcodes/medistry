/**
 * MEDISTRY Synthetic Seed Generator
 * Seeds 3 accredited Nigerian healthcare facilities, 6 verified MDCN clinicians,
 * and 10 rich multi-facility synthetic patients (including Sickle Cell SS + penicillin anaphylaxis).
 * STRICT RULE: Synthetic data only. No real patient data.
 */

import { createPatientRecord, type PatientEntity } from '../src/lib/patient/profile.ts';
import { generatePatientUniqueCode } from '../src/lib/code/crockford.ts';

export interface SeedFacility {
  id: string;
  name: string;
  region: string;
  countryCode: string;
  type: string;
  address: string;
}

export interface SeedClinician {
  id: string;
  userId: string;
  fullName: string;
  licenseNumber: string;
  specialty: string;
  facilityId: string;
  status: 'VERIFIED';
}

export interface SeedDatabasePayload {
  facilities: SeedFacility[];
  clinicians: SeedClinician[];
  patients: Array<{
    patient: PatientEntity;
    emergencyCode: { rawCode: string; formattedCode: string; scanUrl: string };
  }>;
}

export function generateSeedData(): SeedDatabasePayload {
  // 1. Three Accredited Nigerian Facilities
  const facilities: SeedFacility[] = [
    {
      id: 'fac-luth-001',
      name: 'Lagos University Teaching Hospital (LUTH)',
      region: 'Lagos',
      countryCode: 'NG',
      type: 'Tertiary Academic Medical Center',
      address: 'Idi-Araba, Surulere, Lagos, Nigeria',
    },
    {
      id: 'fac-abuja-001',
      name: 'National Hospital Abuja',
      region: 'Federal Capital Territory',
      countryCode: 'NG',
      type: 'National Referral Hospital',
      address: 'Plot 132 Central District, Abuja, Nigeria',
    },
    {
      id: 'fac-kano-001',
      name: 'Aminu Kano Teaching Hospital (AKTH)',
      region: 'Kano',
      countryCode: 'NG',
      type: 'Tertiary Teaching Hospital',
      address: 'Zaria Road, Kano, Nigeria',
    },
  ];

  // 2. Six Verified MDCN Clinicians
  const clinicians: SeedClinician[] = [
    {
      id: 'clinician-doc-1',
      userId: 'user-caldwell',
      fullName: 'Dr. Robert Caldwell',
      licenseNumber: 'MDCN/R/10294',
      specialty: 'Consultant Cardiothoracic Surgeon',
      facilityId: 'fac-luth-001',
      status: 'VERIFIED',
    },
    {
      id: 'clinician-doc-2',
      userId: 'user-adeleke-doc',
      fullName: 'Dr. Folashade Adeleke',
      licenseNumber: 'MDCN/F/28190',
      specialty: 'Emergency Medicine Specialist',
      facilityId: 'fac-luth-001',
      status: 'VERIFIED',
    },
    {
      id: 'clinician-doc-3',
      userId: 'user-thorne',
      fullName: 'Dr. Marcus Thorne',
      licenseNumber: 'MDCN/R/31045',
      specialty: 'Consultant Hematologist',
      facilityId: 'fac-abuja-001',
      status: 'VERIFIED',
    },
    {
      id: 'clinician-doc-4',
      userId: 'user-okoye',
      fullName: 'Dr. Ngozi Okoye',
      licenseNumber: 'MDCN/F/49201',
      specialty: 'Trauma & Critical Care Surgeon',
      facilityId: 'fac-abuja-001',
      status: 'VERIFIED',
    },
    {
      id: 'clinician-doc-5',
      userId: 'user-bello-doc',
      fullName: 'Dr. Aisha Bello',
      licenseNumber: 'MDCN/R/18472',
      specialty: 'Pediatric & General Surgeon',
      facilityId: 'fac-kano-001',
      status: 'VERIFIED',
    },
    {
      id: 'clinician-doc-6',
      userId: 'user-danladi',
      fullName: 'Dr. Ibrahim Danladi',
      licenseNumber: 'MDCN/R/55120',
      specialty: 'Intensive Care Specialist',
      facilityId: 'fac-kano-001',
      status: 'VERIFIED',
    },
  ];

  // 3. Ten Rich Multi-Facility Synthetic Patients
  const rawPatients = [
    {
      // Patient 1: Sickle Cell SS + Severe Penicillin Anaphylaxis
      demo: { firstName: 'Amara', lastName: 'Okonkwo', dateOfBirth: '1998-04-12', gender: 'female' as const },
      triage: {
        bloodGroup: 'O_POSITIVE' as const,
        genotype: 'SS' as const,
        allergies: [
          { substance: 'Penicillin', category: 'drug' as const, reaction: 'Anaphylaxis & Angioedema', severity: 'severe' as const },
          { substance: 'Peanuts', category: 'food' as const, reaction: 'Urticaria', severity: 'moderate' as const },
        ],
        chronicConditions: ['Sickle Cell Anemia (HbSS)', 'Recurrent Vaso-Occlusive Pain Crises'],
        activeMedications: [
          { medicationName: 'Hydroxyurea', dose: '500mg daily', route: 'oral', sinceDate: '2021-06-10' },
          { medicationName: 'Folic Acid', dose: '5mg daily', route: 'oral', sinceDate: '2015-01-01' },
          { medicationName: 'Proguanil', dose: '100mg daily', route: 'oral', sinceDate: '2020-03-15' },
        ],
        emergencyContacts: [
          { id: 'c-amara-1', name: 'Emeka Okonkwo', relationship: 'Brother', phone: '+234 802 111 2233', email: 'emeka@example.ng', priority: 1 },
          { id: 'c-amara-2', name: 'Dr. Chidi Okonkwo', relationship: 'Father', phone: '+234 803 444 5566', priority: 2 },
        ],
        advanceDirectiveDnr: false,
        organDonor: true,
        publicEmergencyOptIn: false,
      },
      originFacilityId: 'fac-luth-001',
    },
    {
      // Patient 2: Severe Asthma + DNR Directive on File
      demo: { firstName: 'Babajide', lastName: 'Adeleke', dateOfBirth: '1985-08-20', gender: 'male' as const },
      triage: {
        bloodGroup: 'B_NEGATIVE' as const,
        genotype: 'AA' as const,
        allergies: [
          { substance: 'Aspirin', category: 'drug' as const, reaction: 'Severe Bronchospasm', severity: 'severe' as const },
          { substance: 'Ibuprofen', category: 'drug' as const, reaction: 'Facial Swelling', severity: 'moderate' as const },
        ],
        chronicConditions: ['Severe Persistent Asthma', 'Nasal Polyposis'],
        activeMedications: [
          { medicationName: 'Salbutamol Inhaler', dose: '100mcg PRN', route: 'inhalation', sinceDate: '2018-02-11' },
          { medicationName: 'Fluticasone Inhaler', dose: '250mcg BID', route: 'inhalation', sinceDate: '2019-09-01' },
        ],
        emergencyContacts: [
          { id: 'c-baba-1', name: 'Kemi Adeleke', relationship: 'Spouse', phone: '+234 803 999 8877', email: 'kemi@example.ng', priority: 1 },
        ],
        advanceDirectiveDnr: true, // DNR ACTIVE
        organDonor: false,
        publicEmergencyOptIn: false,
      },
      originFacilityId: 'fac-luth-001',
    },
    {
      // Patient 3: Sickle Cell Trait AS + Hypertension
      demo: { firstName: 'Halima', lastName: 'Bello', dateOfBirth: '1995-12-05', gender: 'female' as const },
      triage: {
        bloodGroup: 'AB_POSITIVE' as const,
        genotype: 'AS' as const,
        allergies: [
          { substance: 'Amoxicillin', category: 'drug' as const, reaction: 'Anaphylaxis', severity: 'severe' as const },
          { substance: 'Shellfish', category: 'food' as const, reaction: 'Laryngeal Edema', severity: 'moderate' as const },
        ],
        chronicConditions: ['Essential Hypertension', 'Sickle Cell Trait'],
        activeMedications: [
          { medicationName: 'Amlodipine', dose: '5mg daily', route: 'oral', sinceDate: '2023-04-10' },
        ],
        emergencyContacts: [
          { id: 'c-hali-1', name: 'Aliyu Bello', relationship: 'Husband', phone: '+234 809 555 4433', priority: 1 },
        ],
        advanceDirectiveDnr: false,
        organDonor: true,
        publicEmergencyOptIn: true,
      },
      originFacilityId: 'fac-abuja-001',
    },
    {
      // Patient 4: Type 2 Diabetes
      demo: { firstName: 'Emeka', lastName: 'Chukwuma', dateOfBirth: '1971-03-14', gender: 'male' as const },
      triage: {
        bloodGroup: 'A_POSITIVE' as const,
        genotype: 'AA' as const,
        allergies: [
          { substance: 'Co-Trimoxazole (Sulfa)', category: 'drug' as const, reaction: 'Stevens-Johnson Syndrome Risk', severity: 'severe' as const },
        ],
        chronicConditions: ['Type 2 Diabetes Mellitus', 'Peripheral Neuropathy'],
        activeMedications: [
          { medicationName: 'Metformin', dose: '1000mg BID', route: 'oral', sinceDate: '2016-10-01' },
          { medicationName: 'Glimepiride', dose: '2mg daily', route: 'oral', sinceDate: '2020-05-12' },
        ],
        emergencyContacts: [
          { id: 'c-emeka-1', name: 'Adaora Chukwuma', relationship: 'Wife', phone: '+234 802 333 4455', priority: 1 },
        ],
        advanceDirectiveDnr: false,
        organDonor: true,
        publicEmergencyOptIn: false,
      },
      originFacilityId: 'fac-abuja-001',
    },
    {
      // Patient 5: Young adult, healthy baseline
      demo: { firstName: 'Fatima', lastName: 'Garba', dateOfBirth: '2001-02-14', gender: 'female' as const },
      triage: {
        bloodGroup: 'O_POSITIVE' as const,
        genotype: 'AA' as const,
        allergies: [],
        chronicConditions: [],
        activeMedications: [],
        emergencyContacts: [
          { id: 'c-fati-1', name: 'Musa Garba', relationship: 'Father', phone: '+234 803 222 1100', priority: 1 },
        ],
        advanceDirectiveDnr: false,
        organDonor: false,
        publicEmergencyOptIn: false,
      },
      originFacilityId: 'fac-kano-001',
    },
    {
      // Patient 6: Chronic Kidney Disease
      demo: { firstName: 'Tunde', lastName: 'Bakare', dateOfBirth: '1979-05-18', gender: 'male' as const },
      triage: {
        bloodGroup: 'A_POSITIVE' as const,
        genotype: 'AS' as const,
        allergies: [
          { substance: 'Codeine', category: 'drug' as const, reaction: 'Severe Respiratory Depression', severity: 'severe' as const },
        ],
        chronicConditions: ['Chronic Kidney Disease Stage 2', 'Hyperuricemia'],
        activeMedications: [
          { medicationName: 'Allopurinol', dose: '100mg daily', route: 'oral', sinceDate: '2022-11-01' },
        ],
        emergencyContacts: [
          { id: 'c-tunde-1', name: 'Ronke Bakare', relationship: 'Wife', phone: '+234 802 444 3322', priority: 1 },
        ],
        advanceDirectiveDnr: false,
        organDonor: true,
        publicEmergencyOptIn: false,
      },
      originFacilityId: 'fac-luth-001',
    },
    {
      // Patient 7: Epilepsy
      demo: { firstName: 'Zainab', lastName: 'Aliyu', dateOfBirth: '1992-10-30', gender: 'female' as const },
      triage: {
        bloodGroup: 'B_POSITIVE' as const,
        genotype: 'AA' as const,
        allergies: [
          { substance: 'Ciprofloxacin', category: 'drug' as const, reaction: 'Tendonitis & Rash', severity: 'moderate' as const },
        ],
        chronicConditions: ['Focal Epilepsy'],
        activeMedications: [
          { medicationName: 'Levetiracetam', dose: '500mg BID', route: 'oral', sinceDate: '2019-07-20' },
        ],
        emergencyContacts: [
          { id: 'c-zain-1', name: 'Kabiru Aliyu', relationship: 'Brother', phone: '+234 808 123 9876', priority: 1 },
        ],
        advanceDirectiveDnr: false,
        organDonor: false,
        publicEmergencyOptIn: true,
      },
      originFacilityId: 'fac-kano-001',
    },
    {
      // Patient 8: Universal Donor O-Negative
      demo: { firstName: 'Chinedu', lastName: 'Eze', dateOfBirth: '1987-11-25', gender: 'male' as const },
      triage: {
        bloodGroup: 'O_NEGATIVE' as const,
        genotype: 'AA' as const,
        allergies: [
          { substance: 'Diclofenac', category: 'drug' as const, reaction: 'Severe GI Bleed', severity: 'severe' as const },
        ],
        chronicConditions: ['Peptic Ulcer Disease'],
        activeMedications: [
          { medicationName: 'Omeprazole', dose: '20mg daily', route: 'oral', sinceDate: '2024-01-10' },
        ],
        emergencyContacts: [
          { id: 'c-chin-1', name: 'Ngozi Eze', relationship: 'Mother', phone: '+234 802 345 6789', priority: 1 },
        ],
        advanceDirectiveDnr: false,
        organDonor: true,
        publicEmergencyOptIn: false,
      },
      originFacilityId: 'fac-abuja-001',
    },
    {
      // Patient 9: Geriatric Heart Failure + DNR
      demo: { firstName: 'Khadijah', lastName: 'Usman', dateOfBirth: '1964-06-19', gender: 'female' as const },
      triage: {
        bloodGroup: 'A_NEGATIVE' as const,
        genotype: 'AA' as const,
        allergies: [
          { substance: 'Iodinated Radiocontrast', category: 'drug' as const, reaction: 'Anaphylactoid Shock', severity: 'severe' as const },
        ],
        chronicConditions: ['Congestive Heart Failure (NYHA Class III)', 'Atrial Fibrillation'],
        activeMedications: [
          { medicationName: 'Furosemide', dose: '40mg daily', route: 'oral', sinceDate: '2021-03-01' },
          { medicationName: 'Enalapril', dose: '5mg BID', route: 'oral', sinceDate: '2021-03-01' },
          { medicationName: 'Digoxin', dose: '0.125mg daily', route: 'oral', sinceDate: '2023-01-15' },
        ],
        emergencyContacts: [
          { id: 'c-khad-1', name: 'Suleiman Usman', relationship: 'Son', phone: '+234 803 777 6655', priority: 1 },
        ],
        advanceDirectiveDnr: true, // DNR
        organDonor: false,
        publicEmergencyOptIn: false,
      },
      originFacilityId: 'fac-kano-001',
    },
    {
      // Patient 10: Pediatric Sickle Cell SS
      demo: { firstName: 'Dayo', lastName: 'Ogundipe', dateOfBirth: '2007-09-08', gender: 'male' as const },
      triage: {
        bloodGroup: 'O_POSITIVE' as const,
        genotype: 'SS' as const,
        allergies: [
          { substance: 'Ibuprofen', category: 'drug' as const, reaction: 'Angioedema', severity: 'severe' as const },
        ],
        chronicConditions: ['Sickle Cell Disease (HbSS)'],
        activeMedications: [
          { medicationName: 'Hydroxyurea', dose: '500mg daily', route: 'oral', sinceDate: '2022-04-01' },
          { medicationName: 'Folic Acid', dose: '5mg daily', route: 'oral', sinceDate: '2016-08-01' },
        ],
        emergencyContacts: [
          { id: 'c-dayo-1', name: 'Folake Ogundipe', relationship: 'Mother', phone: '+234 802 888 7766', priority: 1 },
        ],
        advanceDirectiveDnr: false,
        organDonor: false,
        publicEmergencyOptIn: false,
      },
      originFacilityId: 'fac-luth-001',
    },
  ];

  const seededPatients = rawPatients.map((p, index) => {
    const patientEntity = createPatientRecord(
      p.demo,
      p.triage,
      {
        userId: `seed-user-${index + 1}`,
        countryCode: 'NG',
        primaryFacilityId: p.originFacilityId,
      }
    );

    const emergencyCode = generatePatientUniqueCode('medistry.health');
    patientEntity.activeEmergencyCodeId = emergencyCode.rawCode;

    return {
      patient: patientEntity,
      emergencyCode,
    };
  });

  return {
    facilities,
    clinicians,
    patients: seededPatients,
  };
}

// When executed directly in node / ts-node
if (process.argv[1]?.endsWith('seed.ts')) {
  const seedData = generateSeedData();
  console.log(`✅ Generated MEDISTRY Synthetic Database:`);
  console.log(`   • Facilities: ${seedData.facilities.length}`);
  console.log(`   • Clinicians: ${seedData.clinicians.length}`);
  console.log(`   • Synthetic Patients: ${seedData.patients.length}`);
  console.log(`   • Priority Patient: ${seedData.patients[0].patient.id} (Sickle Cell SS, Penicillin Anaphylaxis)`);
}

