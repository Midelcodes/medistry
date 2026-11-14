/**
 * MEDISTRY Offline Emergency Card Export & Verification Engine
 * Generates tamper-proof, server-signed offline emergency cards and QR payloads
 * allowing ambulance crews and EMTs to verify critical medical data without network access.
 */

import type { PatientEntity } from '../patient/profile.ts';
import { generateOfflineSignedPayload, verifyOfflineSignedPayload } from '../code/deliverables.ts';
import { getKid, getPublicJwks } from '../crypto/cardKeys.ts';

export interface OfflineEmergencyCardExport {
  patientId: string;
  emergencyCode: string;
  signedToken: string;
  signature: string;
  expiresAt: string;
  triageData: {
    bloodGroup: string;
    genotype: string;
    advanceDirectiveDnr: boolean;
    organDonor: boolean;
    criticalAllergies: Array<{ substance: string; reaction: string; severity: string }>;
    emergencyHotlines: Array<{ name: string; phone: string }>;
  };
  printableCardHtml: string;
}

export class OfflineEmergencyCardManager {
  /**
   * Cards are signed with ES256 keys from crypto/cardKeys.ts (OFFLINE_CARD_PRIVATE_KEY).
   * The optional argument is the old HMAC key from OFFLINE_CARD_SIGNING_KEY; it is deprecated and ignored.
   * Loading the key here makes a missing production key fail at startup rather than on first use.
   */
  constructor(_deprecatedHmacKey?: string) {
    getKid();
  }

  /**
   * Generates a complete signed offline emergency card bundle.
   */
  exportOfflineEmergencyCard(patient: PatientEntity, formattedCode: string, validityDays = 30): OfflineEmergencyCardExport {
    const signed = generateOfflineSignedPayload(patient, formattedCode, validityDays);
    const expDate = new Date(signed.payload.exp * 1000).toISOString();

    const printableCardHtml = this.renderPrintableOfflineCard({
      patientId: patient.id,
      code: formattedCode,
      bloodGroup: patient.bloodGroup.replace('_', ' '),
      genotype: patient.genotype,
      dnr: patient.advanceDirectiveDnr,
      organDonor: patient.organDonor,
      allergies: signed.payload.criticalAllergies || [],
      contacts: signed.payload.emergencyContacts || [],
      signedToken: signed.token,
      signature: signed.signature,
      expDate,
    });

    return {
      patientId: patient.id,
      emergencyCode: formattedCode,
      signedToken: signed.token,
      signature: signed.signature,
      expiresAt: expDate,
      triageData: {
        bloodGroup: patient.bloodGroup.replace('_', ' '),
        genotype: patient.genotype,
        advanceDirectiveDnr: patient.advanceDirectiveDnr,
        organDonor: patient.organDonor,
        criticalAllergies: signed.payload.criticalAllergies || [],
        emergencyHotlines: signed.payload.emergencyContacts || [],
      },
      printableCardHtml,
    };
  }

  /**
   * Verifies an offline emergency token from a QR scan or manual input.
   */
  verifyOfflineCardToken(token: string): {
    valid: boolean;
    payload?: Record<string, any>;
    error?: string;
  } {
    return verifyOfflineSignedPayload(token, getPublicJwks());
  }

  /**
   * Generates a printable, high-contrast, credit-card sized emergency card template.
   */
  private renderPrintableOfflineCard(data: {
    patientId: string;
    code: string;
    bloodGroup: string;
    genotype: string;
    dnr: boolean;
    organDonor: boolean;
    allergies: Array<{ substance: string; reaction: string }>;
    contacts: Array<{ name: string; phone: string }>;
    signedToken: string;
    signature: string;
    expDate: string;
  }): string {
    const allergyText = data.allergies.length > 0
      ? data.allergies.map(a => `${a.substance} (${a.reaction})`).join(', ')
      : 'No known severe drug allergies';

    const contactsText = data.contacts
      .map(c => `${c.name}: ${c.phone}`)
      .join(' • ');

    return `
<div class="medistry-offline-card" style="width: 380px; border: 2px solid #b91c1c; border-radius: 12px; font-family: sans-serif; background: #fff; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
  <div style="background: #b91c1c; color: #fff; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center;">
    <strong style="font-size: 14px; letter-spacing: 0.05em;">MEDISTRY OFFLINE EMERGENCY CARD</strong>
    <span style="font-size: 11px; background: #7f1d1d; padding: 2px 6px; border-radius: 4px;">OFFLINE VERIFIED</span>
  </div>
  <div style="padding: 12px 14px;">
    ${data.dnr ? '<div style="background:#fee2e2; border:1px solid #ef4444; color:#991b1b; padding:6px; border-radius:4px; font-size:12px; font-weight:bold; margin-bottom:8px; text-align:center;">⚠️ DO NOT RESUSCITATE (DNR) ON FILE</div>' : ''}
    <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
      <div>
        <div style="font-size: 11px; color: #64748b; font-weight: bold;">BLOOD GROUP & RH</div>
        <div style="font-size: 22px; font-weight: 900; color: #dc2626;">${data.bloodGroup}</div>
      </div>
      <div>
        <div style="font-size: 11px; color: #64748b; font-weight: bold;">GENOTYPE</div>
        <div style="font-size: 22px; font-weight: 900; color: #0f172a;">${data.genotype}</div>
      </div>
      <div>
        <div style="font-size: 11px; color: #64748b; font-weight: bold;">DONOR</div>
        <div style="font-size: 16px; font-weight: 700; color: #166534; margin-top: 4px;">${data.organDonor ? 'YES (🫀)' : 'NO'}</div>
      </div>
    </div>
    <div style="margin-bottom: 8px;">
      <div style="font-size: 11px; color: #64748b; font-weight: bold;">CRITICAL ALLERGIES:</div>
      <div style="font-size: 12px; color: #991b1b; font-weight: bold;">${allergyText}</div>
    </div>
    <div style="margin-bottom: 8px;">
      <div style="font-size: 11px; color: #64748b; font-weight: bold;">EMERGENCY CONTACTS:</div>
      <div style="font-size: 12px; color: #1e293b;">${contactsText}</div>
    </div>
    <div style="border-top: 1px dashed #cbd5e1; padding-top: 8px; font-size: 11px; color: #475569;">
      <div>EMERGENCY CODE: <strong>${data.code}</strong></div>
      <div>VALID UNTIL: ${data.expDate.split('T')[0]}</div>
      <div style="word-break: break-all; margin-top: 4px; font-family: monospace; font-size: 9px; color: #94a3b8;">
        SIG: ${data.signature.substring(0, 32)}...
      </div>
    </div>
  </div>
</div>
`.trim();
  }
}

