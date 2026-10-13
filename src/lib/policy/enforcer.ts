/**
 * MEDISTRY Central Authorization Policy Engine
 * Strict Deny-By-Default: Role-Based & Relationship-Based Access Control (RBAC + ReBAC).
 */

export type UserRole = 'PATIENT' | 'DOCTOR' | 'FACILITY_ADMIN' | 'PLATFORM_ADMIN';

export type PolicyAction = 
  | 'PATIENT_READ_RECORD'
  | 'PATIENT_WRITE_RECORD'
  | 'PATIENT_EXPORT_ALL'
  | 'EMERGENCY_BREAK_GLASS'
  | 'EMERGENCY_READ_SUMMARY'
  | 'EMERGENCY_READ_FULL_HISTORY'
  | 'CONSENT_REQUEST'
  | 'CONSENT_GRANT_OR_REVOKE'
  | 'CLINICIAN_VERIFY'
  | 'AUDIT_LOG_READ';

export interface ActorContext {
  userId: string;
  role: UserRole;
  clinicianId?: string;
  facilityId?: string;
  isVerifiedClinician?: boolean;
}

export interface ConsentContext {
  id: string;
  patientId: string;
  targetFacilityId?: string;
  targetClinicianId?: string;
  scopes: string[]; // ['all'] or specific resource types
  validUntil: Date;
  isRevoked: boolean;
}

export interface EmergencyGrantContext {
  id: string;
  patientId: string;
  clinicianId: string;
  facilityId: string;
  expiresAt: Date;
  fullHistoryAccess: boolean;
  coSignClinicianId?: string;
}

export interface PolicyEvaluationRequest {
  actor: ActorContext;
  action: PolicyAction;
  targetPatientId?: string;
  requestedResourceType?: string;
  activeConsent?: ConsentContext | null;
  activeEmergencyGrant?: EmergencyGrantContext | null;
}

export interface PolicyDecision {
  allowed: boolean;
  statusCode: 200 | 401 | 403;
  reason: string;
}

/**
 * Central evaluation function - Evaluates every read, write, and administrative action.
 * Fails closed (deny by default).
 */
export function evaluatePolicy(request: PolicyEvaluationRequest): PolicyDecision {
  const { actor, action, targetPatientId, requestedResourceType, activeConsent, activeEmergencyGrant } = request;

  // 1. Unauthenticated or malformed actors are denied immediately
  if (!actor || !actor.userId || !actor.role) {
    return { allowed: false, statusCode: 401, reason: 'Authentication required' };
  }

  // 2. PATIENT role authorizations
  if (actor.role === 'PATIENT') {
    if (action === 'PATIENT_READ_RECORD' || action === 'PATIENT_EXPORT_ALL' || action === 'AUDIT_LOG_READ') {
      if (targetPatientId && targetPatientId === actor.userId) {
        return { allowed: true, statusCode: 200, reason: 'Patient accessing own health record' };
      }
      return { allowed: false, statusCode: 403, reason: 'Patients cannot access records belonging to others' };
    }

    if (action === 'CONSENT_GRANT_OR_REVOKE') {
      if (targetPatientId && targetPatientId === actor.userId) {
        return { allowed: true, statusCode: 200, reason: 'Patient managing consent for own record' };
      }
      return { allowed: false, statusCode: 403, reason: 'Cannot manage consent for other patients' };
    }

    return { allowed: false, statusCode: 403, reason: 'Patient role not permitted for this action' };
  }

  // 3. PLATFORM_ADMIN role authorizations
  if (actor.role === 'PLATFORM_ADMIN') {
    if (action === 'CLINICIAN_VERIFY' || action === 'AUDIT_LOG_READ') {
      return { allowed: true, statusCode: 200, reason: 'Platform admin governance privileges' };
    }
    // Platform admins CANNOT view patient clinical records arbitrarily
    if (action === 'PATIENT_READ_RECORD' || action === 'EMERGENCY_READ_SUMMARY' || action === 'EMERGENCY_READ_FULL_HISTORY') {
      return { allowed: false, statusCode: 403, reason: 'Platform admins have no clinical PHI read permission' };
    }
    return { allowed: false, statusCode: 403, reason: 'Action outside platform administration scope' };
  }

  // 4. FACILITY_ADMIN role authorizations
  if (actor.role === 'FACILITY_ADMIN') {
    if (action === 'CONSENT_REQUEST') {
      return { allowed: true, statusCode: 200, reason: 'Facility admin may initiate record transfer requests' };
    }
    return { allowed: false, statusCode: 403, reason: 'Facility admins cannot read or write patient clinical PHI' };
  }

  // 5. DOCTOR / CLINICIAN role authorizations
  if (actor.role === 'DOCTOR') {
    // Unverified clinicians have zero clinical permissions
    if (!actor.isVerifiedClinician) {
      return { allowed: false, statusCode: 403, reason: 'Clinician license is pending or unverified' };
    }

    // Action A: Request normal consent
    if (action === 'CONSENT_REQUEST') {
      return { allowed: true, statusCode: 200, reason: 'Verified clinician can request patient consent' };
    }

    // Action B: Initiate Emergency Break-Glass
    if (action === 'EMERGENCY_BREAK_GLASS') {
      return { allowed: true, statusCode: 200, reason: 'Verified clinician can initiate emergency break-glass' };
    }

    // Action C: Emergency Read Summary (Minimal triage data only)
    if (action === 'EMERGENCY_READ_SUMMARY') {
      if (!activeEmergencyGrant) {
        return { allowed: false, statusCode: 403, reason: 'No active emergency break-glass grant found' };
      }
      if (activeEmergencyGrant.clinicianId !== actor.clinicianId) {
        return { allowed: false, statusCode: 403, reason: 'Emergency grant is assigned to a different clinician' };
      }
      if (new Date() > new Date(activeEmergencyGrant.expiresAt)) {
        return { allowed: false, statusCode: 403, reason: 'Emergency break-glass grant has expired (60-min window elapsed)' };
      }
      return { allowed: true, statusCode: 200, reason: 'Active emergency break-glass grant verified' };
    }

    // Action D: Emergency Read Full History (Requires second clinician co-sign)
    if (action === 'EMERGENCY_READ_FULL_HISTORY') {
      if (!activeEmergencyGrant) {
        return { allowed: false, statusCode: 403, reason: 'No active emergency break-glass grant found' };
      }
      if (new Date() > new Date(activeEmergencyGrant.expiresAt)) {
        return { allowed: false, statusCode: 403, reason: 'Emergency break-glass grant has expired' };
      }
      if (!activeEmergencyGrant.fullHistoryAccess || !activeEmergencyGrant.coSignClinicianId) {
        return { allowed: false, statusCode: 403, reason: 'Full history in emergency requires a verified second clinician co-sign' };
      }
      return { allowed: true, statusCode: 200, reason: 'Emergency grant with dual clinician co-sign authorized' };
    }

    // Action E: Normal Clinical Read/Write (Requires active patient consent)
    if (action === 'PATIENT_READ_RECORD' || action === 'PATIENT_WRITE_RECORD') {
      if (!activeConsent) {
        return { allowed: false, statusCode: 403, reason: 'Access denied: Patient has not consented to record access' };
      }
      if (activeConsent.isRevoked) {
        return { allowed: false, statusCode: 403, reason: 'Access denied: Patient has revoked this consent' };
      }
      if (new Date() > new Date(activeConsent.validUntil)) {
        return { allowed: false, statusCode: 403, reason: 'Access denied: Patient consent has expired' };
      }
      // Check clinician/facility match
      if (activeConsent.targetClinicianId && activeConsent.targetClinicianId !== actor.clinicianId) {
        return { allowed: false, statusCode: 403, reason: 'Consent is restricted to a different clinician' };
      }
      if (activeConsent.targetFacilityId && activeConsent.targetFacilityId !== actor.facilityId) {
        return { allowed: false, statusCode: 403, reason: 'Consent is restricted to a different facility' };
      }
      // Check scope
      if (!activeConsent.scopes.includes('all') && requestedResourceType && !activeConsent.scopes.includes(requestedResourceType)) {
        return { allowed: false, statusCode: 403, reason: `Consent does not cover requested resource: ${requestedResourceType}` };
      }

      return { allowed: true, statusCode: 200, reason: 'Valid active consent grant confirmed' };
    }
  }

  // Default fall-through: DENY
  return { allowed: false, statusCode: 403, reason: 'Action forbidden by policy' };
}

