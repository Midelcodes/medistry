/**
 * MEDISTRY Patient Code Deliverables Generator
 * Produces: (1) Printable Wallet Card, (2) Wristband/Sticker template,
 * (3) Lock Screen Wallpaper & Instructions, (4) NFC Tag NDEF URI Payload,
 * and (5) Cryptographically Signed Offline Emergency Payload.
 */

import QRCode from 'qrcode';
import type { PatientEntity } from '../patient/profile.ts';
import { signCompactJws, verifyCompactJws, getPublicJwks } from '../crypto/cardKeys.ts';

export interface DeliverablesConfig {
  domain: string;
  emergencyHotline: string;
  /** Base URL printed in QR codes (e.g. APP_URL). Defaults to https://<domain>. */
  baseUrl?: string;
}

export const DEFAULT_CONFIG: DeliverablesConfig = {
  domain: 'medistry.health',
  emergencyHotline: '+234 800 420 6337',
};

/** Issuer of offline cards. Medistry is not a government authority and the token must not claim to be one. */
export const OFFLINE_CARD_ISSUER = 'medistry';

// ---------------------------------------------------------------------------
// Real QR codes (qrcode package, error correction level M)
// ---------------------------------------------------------------------------

/** Offline card scanner page. The token goes after '#', so browsers never send it to the server. */
export const CARD_SCANNER_PATH = '/s';
export const QR_ERROR_CORRECTION = 'M';
const QR_QUIET_ZONE = 4; // modules of white border required by the QR specification

const scanBase = (config: DeliverablesConfig) => (config.baseUrl || `https://${config.domain}`).replace(/\/+$/, '');

/** QR text for an offline card: ${baseUrl}/s#<signed token>. */
export function buildCardQrText(token: string, baseUrl: string): string {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('Card token is not a compact JWS');
  return `${baseUrl.replace(/\/+$/, '')}${CARD_SCANNER_PATH}#${token}`;
}

/** Builds the QR symbol, failing with a clear message if the text does not fit (version 40 at level M). */
export function createQrSymbol(text: string): { version: number; size: number; isDark: (x: number, y: number) => boolean } {
  let qr: any;
  try {
    qr = QRCode.create(text, { errorCorrectionLevel: QR_ERROR_CORRECTION });
  } catch (err: any) {
    throw new Error(`QR content is too large (${text.length} characters) for a version 40 QR code at error correction level ${QR_ERROR_CORRECTION}: ${err?.message || err}`);
  }
  if (qr.version > 40) throw new Error(`QR version ${qr.version} exceeds 40`);
  const size: number = qr.modules.size;
  return { version: qr.version, size, isDark: (x, y) => !!qr.modules.get(y, x) };
}

/**
 * Renders a QR code as SVG: one dark square per module, a 4-module quiet zone, crisp edges.
 * The SVG contains no text, so nothing user-supplied is interpolated.
 */
export function generateQrSvg(text: string, opts: { sizeAttr?: string; label?: string } = {}): string {
  const { size, isDark } = createQrSymbol(text);
  const total = size + QR_QUIET_ZONE * 2;
  let path = '';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isDark(x, y)) path += `M${x + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h1v1h-1z`;
    }
  }
  const sizeAttr = opts.sizeAttr ? ` width="${opts.sizeAttr}" height="${opts.sizeAttr}"` : '';
  const label = (opts.label || 'QR code').replace(/[^A-Za-z0-9 .,:()-]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"${sizeAttr} shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="${total}" height="${total}" fill="#ffffff"/><path fill="#000000" d="${path}"/></svg>`;
}

/** PNG data URL of the same QR code (for download). */
export async function generateQrPngDataUrl(text: string, scale = 8): Promise<string> {
  createQrSymbol(text); // same size check and error message as the SVG
  return QRCode.toDataURL(text, { errorCorrectionLevel: QR_ERROR_CORRECTION, margin: QR_QUIET_ZONE, scale, color: { dark: '#000000', light: '#ffffff' } });
}

/** QR for an offline card token: the text, its version, an SVG and a PNG data URL. */
export async function generateCardQr(token: string, baseUrl: string): Promise<{ text: string; version: number; modules: number; svg: string; pngDataUrl: string }> {
  const text = buildCardQrText(token, baseUrl);
  const { version, size } = createQrSymbol(text);
  return {
    text,
    version,
    modules: size,
    svg: generateQrSvg(text, { label: 'Medistry emergency card QR code' }),
    pngDataUrl: await generateQrPngDataUrl(text),
  };
}

/** Embeds a QR SVG inside another SVG at (x, y) with the given width/height. */
function nestedQr(text: string, x: number, y: number, w: number): string {
  return generateQrSvg(text, { label: 'Emergency code QR' }).replace('<svg ', `<svg x="${x}" y="${y}" width="${w}" height="${w}" `);
}

/**
 * 1. Generates the SVG vector representation for a standard ID-1 Wallet Card (85.6mm x 53.98mm).
 */
export function generateWalletCardSvg(
  formattedCode: string,
  patientName: string,
  ifFoundContact?: string,
  config: DeliverablesConfig = DEFAULT_CONFIG
): string {
  const scanUrl = `${scanBase(config)}/e/${formattedCode}`;
  const foundText = ifFoundContact ? `IF FOUND CALL: ${ifFoundContact}` : `24/7 HELPLINE: ${config.emergencyHotline}`;

  return `
<svg width="684" height="432" viewBox="0 0 684 432" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Card Background -->
  <rect width="684" height="432" rx="28" fill="url(#cardGrad)"/>
  <rect x="2" y="2" width="680" height="428" rx="26" stroke="rgba(255,255,255,0.3)" stroke-width="2"/>

  <!-- Background Decorative Watermark Cross -->
  <circle cx="560" cy="216" r="160" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="3"/>
  <circle cx="560" cy="216" r="100" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="2"/>
  <path d="M560 176 V256 M520 216 H600" stroke="rgba(255,255,255,0.14)" stroke-width="12" stroke-linecap="round"/>

  <!-- Header Branding -->
  <g transform="translate(48, 48)">
    <rect width="40" height="40" rx="10" fill="#FFFFFF" fill-opacity="0.15"/>
    <path d="M20 12 V28 M12 20 H28" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round"/>
    <text x="52" y="28" fill="#FFFFFF" font-family="'Plus Jakarta Sans', sans-serif" font-size="24" font-weight="800" letter-spacing="-0.5">MEDISTRY</text>
    <text x="52" y="44" fill="rgba(255,255,255,0.7)" font-family="'Plus Jakarta Sans', sans-serif" font-size="11" font-weight="600">EMERGENCY MEDICAL RECORD ACCESS</text>
  </g>

  <!-- Left: Human-Readable Crockford Code & Warning -->
  <g transform="translate(48, 160)">
    <rect width="360" height="110" rx="16" fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.2)"/>
    <text x="24" y="36" fill="rgba(255,255,255,0.8)" font-family="'Plus Jakarta Sans', sans-serif" font-size="11" font-weight="700" letter-spacing="1">PATIENT EMERGENCY CODE</text>
    <text x="24" y="74" fill="#FFFFFF" font-family="'Space Grotesk', monospace" font-size="28" font-weight="700" letter-spacing="2">${formattedCode}</text>
    <text x="24" y="96" fill="#FDE047" font-family="'Plus Jakarta Sans', sans-serif" font-size="10" font-weight="700">SCAN ONLY BY VERIFIED CLINICIAN IN EMERGENCY</text>
  </g>

  <!-- Patient Name & Helplines -->
  <text x="48" y="324" fill="#FFFFFF" font-family="'Plus Jakarta Sans', sans-serif" font-size="18" font-weight="700">${patientName.toUpperCase()}</text>
  <text x="48" y="348" fill="rgba(255,255,255,0.7)" font-family="'Plus Jakarta Sans', sans-serif" font-size="11" font-weight="600">${foundText}</text>
  <text x="48" y="374" fill="rgba(255,255,255,0.5)" font-family="'Plus Jakarta Sans', sans-serif" font-size="9.5">NO MEDICAL DATA STORED ON CARD • BREAK-GLASS CLINICAL GATEWAY</text>

  <!-- Right: real QR code of the online emergency gate URL -->
  <g transform="translate(456, 108)">
    <rect width="180" height="180" rx="12" fill="#FFFFFF"/>
    ${nestedQr(scanUrl, 6, 6, 168)}
    <text x="90" y="204" text-anchor="middle" fill="#FFFFFF" font-family="'Plus Jakarta Sans', sans-serif" font-size="11" font-weight="800">BREAK-GLASS GATE</text>
  </g>

  <!-- Gradient Definition -->
  <defs>
    <linearGradient id="cardGrad" x1="0" y1="0" x2="684" y2="432" gradientUnits="userSpaceOnUse">
      <stop stop-color="#4F57E2"/>
      <stop offset="0.55" stop-color="#5E67EB"/>
      <stop offset="1" stop-color="#3C43B8"/>
    </linearGradient>
  </defs>
</svg>
`.trim();
}

/**
 * 2. Generates the SVG vector representation for a Hospital/Triage Wristband (254mm x 25mm).
 */
export function generateWristbandSvg(
  formattedCode: string,
  config: DeliverablesConfig = DEFAULT_CONFIG
): string {
  return `
<svg width="1000" height="100" viewBox="0 0 1000 100" fill="none" xmlns="http://www.w3.org/2000/svg">
  <!-- Wristband Strap Background -->
  <rect width="1000" height="100" rx="10" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="2"/>
  <rect x="0" y="0" width="24" height="100" fill="#E2E8F0"/>
  <circle cx="12" cy="50" r="5" fill="#94A3B8"/>

  <!-- Emergency Red Header Stripe -->
  <rect x="30" y="0" width="8" height="100" fill="#DC2626"/>

  <!-- Logo & Title -->
  <g transform="translate(60, 28)">
    <text x="0" y="24" fill="#1E2038" font-family="'Plus Jakarta Sans', sans-serif" font-size="22" font-weight="800">MEDISTRY EMERGENCY WRISTBAND</text>
    <text x="0" y="44" fill="#DC2626" font-family="'Plus Jakarta Sans', sans-serif" font-size="12" font-weight="700">HOSPITAL BREAK-GLASS GATEWAY • VERIFIED DOCTOR ACCESS ONLY</text>
  </g>

  <!-- Grouped Code Display -->
  <g transform="translate(560, 20)">
    <rect width="250" height="60" rx="10" fill="#F1F5F9" stroke="#CBD5E1"/>
    <text x="125" y="38" text-anchor="middle" fill="#0F172A" font-family="'Space Grotesk', monospace" font-size="20" font-weight="700">${formattedCode}</text>
  </g>

  <!-- Real QR code of the online emergency gate URL -->
  <g transform="translate(840, 6)">
    ${nestedQr(`${scanBase(config)}/e/${formattedCode}`, 0, 0, 88)}
  </g>
</svg>
`.trim();
}

/**
 * 3. Add-to-Lock-Screen & Mobile Wallpaper Specs and Instructions.
 */
export function getLockScreenGuide(formattedCode: string, config: DeliverablesConfig = DEFAULT_CONFIG) {
  const scanUrl = `${scanBase(config)}/e/${formattedCode}`;
  return {
    scanUrl,
    code: formattedCode,
    iosInstructions: [
      '1. Save the generated high-contrast emergency QR card to your Photos.',
      '2. In iOS Settings -> Wallpaper, select the emergency card as your Lock Screen.',
      '3. Open the Health app -> tap your profile -> Medical ID -> turn on "Show When Locked".',
      '4. Add your Emergency Contacts and your Medistry URL under Emergency Notes.',
    ],
    androidInstructions: [
      '1. Save the generated emergency lockscreen wallpaper to your gallery.',
      '2. Open Android Settings -> Safety & Emergency -> Emergency Information.',
      '3. Under "Emergency Info", paste your Medistry emergency link and 24/7 hotline.',
      '4. Set the downloaded wallpaper as your Lock Screen so the QR remains scannable while locked.',
    ],
  };
}

/**
 * 4. Generates an NFC NDEF URI Binary Payload (RFC NDEF Specification).
 * Formats: Well-Known Type 'U' (URI) with standard HTTPS prefix.
 */
export function generateNfcNdefPayload(
  formattedCode: string,
  config: DeliverablesConfig = DEFAULT_CONFIG
): { uriString: string; ndefMessageBuffer: Buffer } {
  const uriString = `https://${config.domain}/e/${formattedCode}`;
  
  // RFC NDEF URI Identifier Code: 0x04 represents "https://"
  const uriIdentifierCode = 0x04;
  const uriSuffix = `${config.domain}/e/${formattedCode}`;
  const uriSuffixBuffer = Buffer.from(uriSuffix, 'utf8');

  // NDEF Record Header:
  // MB=1, ME=1, CF=0, SR=1 (Short Record), IL=0, TNF=0x01 (NFC Forum well-known type) -> 0xD1
  const headerByte = 0xd1;
  const typeLength = 1; // 'U'
  const payloadLength = 1 + uriSuffixBuffer.length;
  const typeField = Buffer.from('U', 'utf8');

  const ndefBuffer = Buffer.concat([
    Buffer.from([headerByte, typeLength, payloadLength]),
    typeField,
    Buffer.from([uriIdentifierCode]),
    uriSuffixBuffer,
  ]);

  return {
    uriString,
    ndefMessageBuffer: ndefBuffer,
  };
}

/**
 * 5. Generates an ES256-signed offline emergency payload (compact JWS, see crypto/cardKeys.ts).
 * Scanners verify it offline with the published public key, which cannot be used to sign.
 * `config` is accepted for backward compatibility and is not used for signing.
 */
export function generateOfflineSignedPayload(
  patient: PatientEntity,
  formattedCode: string,
  expiresInDays = 30,
  _config: DeliverablesConfig = DEFAULT_CONFIG
): { token: string; payload: Record<string, any>; signature: string } {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + expiresInDays * 86400;

  // Minimal critical triage data only
  const payload = {
    iss: OFFLINE_CARD_ISSUER,
    sub: patient.id,
    code: formattedCode,
    bloodGroup: patient.bloodGroup,
    genotype: patient.genotype,
    advanceDirectiveDnr: patient.advanceDirectiveDnr,
    organDonor: patient.organDonor,
    criticalAllergies: patient.allergies.filter((a) => a.severity === 'severe'),
    emergencyContacts: patient.emergencyContacts.slice(0, 2),
    iat: now,
    exp,
  };

  const token = signCompactJws(payload);
  return {
    token,
    payload,
    signature: token.split('.')[2],
  };
}

/**
 * Verifies a signed offline emergency payload against a JWK set (default: this server's published keys).
 * Only ES256 is accepted.
 */
export function verifyOfflineSignedPayload(
  token: string,
  jwks: JsonWebKey[] = getPublicJwks()
): { valid: boolean; payload?: Record<string, any>; error?: string } {
  return verifyCompactJws(token, jwks);
}
