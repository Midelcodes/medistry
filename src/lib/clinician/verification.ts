/**
 * MEDISTRY Clinician Onboarding & MDCN License Verification
 * Implements strict credential validation with pluggable registry adapter architecture.
 */

export type VerificationStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';

export interface ClinicianProfile {
  id: string;
  userId: string;
  fullName: string;
  licenseNumber: string; // e.g. MDCN/R/48201
  specialty: string;
  status: VerificationStatus;
  verifiedAt?: Date;
  verifiedByAdminId?: string;
  rejectionReason?: string;
}

/**
 * Validates the syntax of Nigerian MDCN (Medical and Dental Council of Nigeria) license numbers.
 * Formats: MDCN/R/XXXXX (Full Registration), MDCN/P/XXXXX (Provisional), MDCN/F/XXXXX (Fellowship/Specialist)
 */
export function validateMdcnLicenseFormat(licenseNumber: string): { valid: boolean; normalized?: string; error?: string } {
  if (!licenseNumber || typeof licenseNumber !== 'string') {
    return { valid: false, error: 'License number is required' };
  }

  const clean = licenseNumber.trim().toUpperCase();
  const mdcnPattern = /^MDCN\/[RPF]\/\d{4,6}$/;

  if (!mdcnPattern.test(clean)) {
    return {
      valid: false,
      error: 'Invalid MDCN license format. Expected format: MDCN/R/12345, MDCN/P/12345, or MDCN/F/12345',
    };
  }

  return { valid: true, normalized: clean };
}

/**
 * Pluggable registry adapter interface to allow seamless transition from manual verification
 * to future automated live MDCN online API verification.
 */
export interface IMdcnRegistryAdapter {
  queryRegistry(licenseNumber: string): Promise<{
    found: boolean;
    practitionerName?: string;
    isCurrent?: boolean;
    registeredSpecialty?: string;
  }>;
}

/**
 * Default Manual Verification Adapter: Simulates verified MDCN database records for onboarding.
 */
export class ManualMdcnRegistryAdapter implements IMdcnRegistryAdapter {
  private knownGoodFolios = new Map<string, { name: string; specialty: string }>([
    ['MDCN/R/10294', { name: 'Dr. Robert Caldwell', specialty: 'Cardiothoracic Surgery' }],
    ['MDCN/F/29103', { name: 'Dr. Elena Rostova', specialty: 'Neurology & Neurosurgery' }],
    ['MDCN/R/38492', { name: 'Dr. Marcus Thorne', specialty: 'Emergency Medicine & Critical Care' }],
    ['MDCN/R/49201', { name: 'Dr. Amina Bello', specialty: 'Pediatrics & Neonatal Care' }],
    ['MDCN/F/58203', { name: 'Dr. Chidi Okafor', specialty: 'Orthopedic Surgery' }],
    ['MDCN/R/67391', { name: 'Dr. Fatima Danjuma', specialty: 'General & Robotic Surgery' }],
  ]);

  async queryRegistry(licenseNumber: string) {
    const record = this.knownGoodFolios.get(licenseNumber.toUpperCase());
    if (record) {
      return {
        found: true,
        practitionerName: record.name,
        isCurrent: true,
        registeredSpecialty: record.specialty,
      };
    }
    return { found: false };
  }
}

/**
 * Verification state machine processor.
 */
export class ClinicianVerificationManager {
  private registryAdapter: IMdcnRegistryAdapter;

  constructor(registryAdapter: IMdcnRegistryAdapter = new ManualMdcnRegistryAdapter()) {
    this.registryAdapter = registryAdapter;
  }

  async processOnboardingSubmission(
    clinician: Omit<ClinicianProfile, 'status' | 'verifiedAt' | 'verifiedByAdminId'>
  ): Promise<{ profile: ClinicianProfile; message: string }> {
    const formatCheck = validateMdcnLicenseFormat(clinician.licenseNumber);
    if (!formatCheck.valid) {
      throw new Error(formatCheck.error);
    }

    const registryResult = await this.registryAdapter.queryRegistry(formatCheck.normalized!);

    return {
      profile: {
        ...clinician,
        licenseNumber: formatCheck.normalized!,
        status: 'PENDING',
      },
      message: registryResult.found
        ? 'MDCN license recognized in registry. Pending final Platform Admin sign-off.'
        : 'License submitted. Queued for manual MDCN registrar review.',
    };
  }

  approveVerification(
    clinician: ClinicianProfile,
    adminId: string
  ): ClinicianProfile {
    if (clinician.status === 'VERIFIED') {
      throw new Error('Clinician is already verified');
    }
    return {
      ...clinician,
      status: 'VERIFIED',
      verifiedAt: new Date(),
      verifiedByAdminId: adminId,
      rejectionReason: undefined,
    };
  }

  rejectVerification(
    clinician: ClinicianProfile,
    adminId: string,
    reason: string
  ): ClinicianProfile {
    return {
      ...clinician,
      status: 'REJECTED',
      verifiedAt: undefined,
      verifiedByAdminId: adminId,
      rejectionReason: reason,
    };
  }

  suspendClinician(
    clinician: ClinicianProfile,
    adminId: string,
    reason: string
  ): ClinicianProfile {
    return {
      ...clinician,
      status: 'SUSPENDED',
      verifiedByAdminId: adminId,
      rejectionReason: reason,
    };
  }
}
