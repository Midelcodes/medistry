/**
 * MEDISTRY Clinician Onboarding & Licence Verification, pluggable per country.
 * COUNTRY_REGISTRIES maps an ISO 3166-1 alpha-2 country code to its medical regulator, licence format
 * (null when the format is not confirmed) and a registry adapter.
 *   NG: Medical and Dental Council of Nigeria (MDCN). Rules and adapter unchanged from earlier phases.
 *   KE: Kenya Medical Practitioners and Dentists Council (KMPDC). Format NOT confirmed; manual verification.
 */

export type VerificationStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';

export interface ClinicianProfile {
  id: string;
  userId: string;
  fullName: string;
  countryCode?: string;  // licensing country; NG when omitted (earlier behaviour)
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
export const MDCN_LICENCE_FORMAT = /^MDCN\/[RPF]\/\d{4,6}$/;

export function validateMdcnLicenseFormat(licenseNumber: string): { valid: boolean; normalized?: string; error?: string } {
  if (!licenseNumber || typeof licenseNumber !== 'string') {
    return { valid: false, error: 'License number is required' };
  }

  const clean = licenseNumber.trim().toUpperCase();

  if (!MDCN_LICENCE_FORMAT.test(clean)) {
    return {
      valid: false,
      error: 'Invalid MDCN license format. Expected format: MDCN/R/12345, MDCN/P/12345, or MDCN/F/12345',
    };
  }

  return { valid: true, normalized: clean };
}

/**
 * Pluggable registry adapter: manual lists today, a regulator's online register later.
 */
export interface IRegistryAdapter {
  queryRegistry(licenseNumber: string): Promise<{
    found: boolean;
    practitionerName?: string;
    isCurrent?: boolean;
    registeredSpecialty?: string;
  }>;
}

/** @deprecated use IRegistryAdapter; kept so existing callers still compile. */
export type IMdcnRegistryAdapter = IRegistryAdapter;

/**
 * Default Manual Verification Adapter: Simulates verified MDCN database records for onboarding.
 */
export class ManualMdcnRegistryAdapter implements IRegistryAdapter {
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
 * Manual KMPDC adapter for the demo. These three clinicians are SYNTHETIC: the 'DEMO-' prefix is not a real
 * KMPDC licence format, and no real practitioner is represented.
 * TODO: Confirm KMPDC licence format and online register lookup before production.
 */
export class ManualKmpdcRegistryAdapter implements IRegistryAdapter {
  private knownDemoLicences = new Map<string, { name: string; specialty: string }>([
    ['DEMO-KE-1001', { name: 'Dr. Synthetic Wanjiku (demo)', specialty: 'Emergency Medicine' }],
    ['DEMO-KE-1002', { name: 'Dr. Synthetic Otieno (demo)', specialty: 'Internal Medicine' }],
    ['DEMO-KE-1003', { name: 'Dr. Synthetic Mwangi (demo)', specialty: 'Paediatrics' }],
  ]);

  async queryRegistry(licenseNumber: string) {
    const record = this.knownDemoLicences.get(licenseNumber.trim().toUpperCase());
    return record
      ? { found: true, practitionerName: record.name, isCurrent: true, registeredSpecialty: record.specialty }
      : { found: false };
  }
}

export interface CountryRegistry {
  regulatorName: string;
  regulatorShortName: string;
  licenceFormat: RegExp | null;   // null: format not confirmed, so only the generic check applies
  formatHint: string;
  verificationMode: 'manual' | 'online';
  adapter: IRegistryAdapter;
  normalize: (licence: string) => string;
}

/** Used when a country's licence format is not confirmed: trimmed, 3 to 20 letters, digits, '/' or '-'. */
export const GENERIC_LICENCE_FORMAT = /^[A-Za-z0-9/-]{3,20}$/;

export const COUNTRY_REGISTRIES: Record<string, CountryRegistry> = {
  NG: {
    regulatorName: 'Medical and Dental Council of Nigeria (MDCN)',
    regulatorShortName: 'MDCN',
    licenceFormat: MDCN_LICENCE_FORMAT,
    formatHint: 'MDCN/R/12345, MDCN/P/12345, or MDCN/F/12345',
    verificationMode: 'manual',
    adapter: new ManualMdcnRegistryAdapter(),
    normalize: (l) => l.trim().toUpperCase(),
  },
  KE: {
    regulatorName: 'Kenya Medical Practitioners and Dentists Council (KMPDC)',
    regulatorShortName: 'KMPDC',
    // TODO: Confirm KMPDC licence format and online register lookup before production.
    licenceFormat: null,
    formatHint: '3 to 20 letters, digits, "/" or "-"',
    verificationMode: 'manual',
    adapter: new ManualKmpdcRegistryAdapter(),
    normalize: (l) => l.trim().toUpperCase(),
  },
};

export function registryFor(countryCode: string | undefined): CountryRegistry {
  const reg = COUNTRY_REGISTRIES[(countryCode || 'NG').toUpperCase()];
  if (!reg) throw new Error(`Clinician licensing for country ${countryCode} is not supported yet`);
  return reg;
}

/** Validates a licence number against the rules of the clinician's licensing country. */
export function validateLicenceFormat(countryCode: string | undefined, licenseNumber: string): { valid: boolean; normalized?: string; error?: string } {
  const country = (countryCode || 'NG').toUpperCase();
  if (country === 'NG') return validateMdcnLicenseFormat(licenseNumber); // unchanged behaviour and messages
  let reg: CountryRegistry;
  try { reg = registryFor(country); } catch (err: any) { return { valid: false, error: err.message }; }
  if (!licenseNumber || typeof licenseNumber !== 'string' || !licenseNumber.trim()) {
    return { valid: false, error: 'License number is required' };
  }
  const clean = reg.normalize(licenseNumber);
  const format = reg.licenceFormat || GENERIC_LICENCE_FORMAT;
  if (!format.test(clean)) {
    return { valid: false, error: `Invalid ${reg.regulatorShortName} licence. Expected ${reg.formatHint}` };
  }
  return { valid: true, normalized: clean };
}

/**
 * Verification state machine processor.
 */
export class ClinicianVerificationManager {
  private registries: Record<string, CountryRegistry>;

  /** An adapter argument replaces the Nigerian (MDCN) adapter, as before; other countries use COUNTRY_REGISTRIES. */
  constructor(registryAdapter?: IRegistryAdapter) {
    this.registries = { ...COUNTRY_REGISTRIES };
    if (registryAdapter) this.registries.NG = { ...COUNTRY_REGISTRIES.NG, adapter: registryAdapter };
  }

  async processOnboardingSubmission(
    clinician: Omit<ClinicianProfile, 'status' | 'verifiedAt' | 'verifiedByAdminId'>
  ): Promise<{ profile: ClinicianProfile; message: string; regulator: string; registryMatch: boolean; verificationMode: 'manual' | 'online' }> {
    const country = (clinician.countryCode || 'NG').toUpperCase();
    const reg = this.registries[country];
    if (!reg) throw new Error(`Clinician licensing for country ${country} is not supported yet`);
    const formatCheck = validateLicenceFormat(country, clinician.licenseNumber);
    if (!formatCheck.valid) {
      throw new Error(formatCheck.error);
    }

    const registryResult = await reg.adapter.queryRegistry(formatCheck.normalized!);

    const message = country === 'NG'
      ? (registryResult.found
        ? 'MDCN license recognized in registry. Pending final Platform Admin sign-off.'
        : 'License submitted. Queued for manual MDCN registrar review.')
      : (registryResult.found
        ? `${reg.regulatorShortName} licence found in the demo list. Pending manual review and Platform Admin sign-off.`
        : `Licence submitted. Queued for manual ${reg.regulatorShortName} review.`);

    return {
      profile: {
        ...clinician,
        countryCode: country,
        licenseNumber: formatCheck.normalized!,
        status: 'PENDING',
      },
      message,
      regulator: reg.regulatorName,
      registryMatch: registryResult.found,
      verificationMode: reg.verificationMode,
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
