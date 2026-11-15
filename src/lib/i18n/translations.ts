/**
 * MEDISTRY Internationalization (i18n) Engine
 * Primary locale: English (en)
 * Regional locales: Hausa (ha), Yoruba (yo), Igbo (ig), Swahili (sw), French (fr).
 */

export type SupportedLocale = 'en' | 'ha' | 'yo' | 'ig' | 'sw' | 'fr';

export const SUPPORTED_LOCALES: SupportedLocale[] = ['en', 'ha', 'yo', 'ig', 'sw', 'fr'];

export const TRANSLATIONS: Record<SupportedLocale, Record<string, string>> = {
  en: {
    emergency_title: 'EMERGENCY MEDICAL SUMMARY',
    blood_group: 'Blood Group & Rh',
    genotype: 'Hemoglobin Genotype',
    allergies: 'Allergies & Adverse Reactions',
    drug_allergies_priority: 'Drug Allergies Prioritized',
    chronic_conditions: 'Chronic Conditions',
    medications: 'Current Medications',
    dnr_warning: 'DO NOT RESUSCITATE (DNR) ON FILE',
    emergency_contacts: 'Emergency Contacts',
    remaining_time: 'Expires in {m} minutes',
    full_history_locked: 'Full history is locked. Requires second clinician co-sign.',
    full_history_unlocked: 'Full Clinical History Unlocked via Dual Co-Sign',
    offline_verified: 'OFFLINE VERIFIED',
    // Offline card scanner (/s)
    scan_title: 'Emergency card scanner',
    scan_intro: 'Scan a Medistry emergency card. The signature is checked on this device and nothing is sent to a server.',
    scan_start_camera: 'Scan with camera',
    scan_stop_camera: 'Stop camera',
    scan_paste_label: 'Or paste the card link or code',
    scan_verify: 'Verify',
    scan_again: 'Scan another card',
    scan_online: 'Online',
    scan_offline: 'Offline',
    scan_camera_unavailable: 'Camera not available. Paste the card link instead.',
    scan_camera_denied: 'Camera permission was refused. Paste the card link instead.',
    scan_aim: 'Point the camera at the QR code on the front of the card.',
    scan_checking: 'Checking signature…',
    scan_no_token: 'That is not a Medistry card code.',
    scan_valid_badge: 'GENUINE CARD',
    scan_not_genuine: 'CARD NOT GENUINE: do not rely on this data',
    scan_not_genuine_detail: 'The signature does not match. The card was altered or not issued by Medistry.',
    scan_expired: 'Card expired on {date}',
    scan_unverified_current: 'UNVERIFIED-CURRENT: genuine when issued, but may be out of date',
    scan_unknown_key: 'Cannot verify: connect once to update keys',
    scan_future: 'Cannot verify: check this device\'s date and time',
    scan_unsupported: 'Cannot read this card format. Connect once to update the scanner.',
    scan_blood_group: 'Blood group',
    scan_genotype: 'Genotype',
    scan_severe_allergies: 'Severe allergies',
    scan_no_allergies: 'No severe allergies recorded on this card',
    scan_dnr: 'DO NOT RESUSCITATE (DNR) ON FILE',
    scan_conditions: 'Conditions',
    scan_medications: 'Medicines',
    scan_recent_dx: 'Most recent diagnosis',
    scan_contact: 'Emergency contact',
    scan_call: 'Call {name}',
    scan_organ_donor: 'Registered organ donor',
    scan_footer_verified: 'Card v{cv}, issued {date}, verified offline',
    scan_footer_unverified: 'Card v{cv}, issued {date}. Signature genuine, card expired',
    scan_valid_until: 'Valid until {date}',
    scan_unknown: 'unknown',
  },
  ha: { // Hausa (Northern Nigeria & West Africa)
    emergency_title: 'TAƘAITACCEN BAYANIN GAGGAWA NA LAFIYA',
    blood_group: 'Nau’in Jini da Rh',
    genotype: 'Nau’in Kwayar Halittar Jini (Genotype)',
    allergies: 'Abubuwan da ke Haifar da Rashin Lafiya (Allergies)',
    drug_allergies_priority: 'Magungunan da ke Haifar da Rashin Lafiya',
    chronic_conditions: 'Cututtuka Masu Tsanani',
    medications: 'Magunguna Masu Aiki a Yanzu',
    dnr_warning: 'KADA A FARFAƊO (DNR) AKAN SHAFIN SHARI’A',
    emergency_contacts: 'Lambar Gaggawa ta Iyali',
    remaining_time: 'Zai ƙare a cikin mintuna {m}',
    full_history_locked: 'Cikakken tarihin na kulle. Ana buƙatar sa hannun likita na biyu.',
    full_history_unlocked: 'An buɗe cikakken tarihin asibiti ta hanyar sa hannun likitoci biyu',
    offline_verified: 'AN TATTASE TARE DA FITAR DA YANAR GIZO',
  },
  yo: { // Yoruba (Southwestern Nigeria & West Africa)
    emergency_title: 'ÀKÒPÒ ÌRÒHÌN ÌTỌ́JÚ PÀWÁDÀ',
    blood_group: 'Ẹ̀yà Ẹ̀jẹ̀ àti Rh',
    genotype: 'Àbùdá Ẹ̀jẹ̀ (Genotype)',
    allergies: 'Àwọn Ohun Tó Ń Fa Ẹsín/Àrùn (Allergies)',
    drug_allergies_priority: 'Àwọn Oògùn Tó Lè Fa Ẹsín Lákọ̀ọ́kọ́',
    chronic_conditions: 'Àwọn Àrùn Tó Ti Pẹ́',
    medications: 'Àwọn Oògùn Tó Ń Lò Lọ́wọ́lọ́wọ́',
    dnr_warning: 'MÁ ṢE TÚN JÍ DÌDE (DNR) NÍNU ÀKỌSÍLẸ̀',
    emergency_contacts: 'Àwọn Ẹni Ìpàdé Pàjáwìrì',
    remaining_time: 'Yóò parí ní ìṣẹ́jú {m}',
    full_history_locked: 'Àkọsílẹ̀ kíkún wà ní tìtìpa. Ó nílò ìfọwọ́sí oníṣègùn kejì.',
    full_history_unlocked: 'Àkọsílẹ̀ gbogbo ti ṣí pẹ̀lú ìfọwọ́sí àwọn oníṣègùn méjì',
    offline_verified: 'A TI FIDI RẸ MULẸ LÁÌSÍ ÍNTÁNẸ́Ẹ̀TÌ',
  },
  ig: { // Igbo (Southeastern Nigeria)
    emergency_title: 'NKENKE OZI AHỤIKE MBEREDE',
    blood_group: 'Ụdị Ọbara na Rh',
    genotype: 'Ọdịdị Mkpụrụ Ndụ Ọbara (Genotype)',
    allergies: 'Ihe Ndị Na-adịghị Ahụ Mma (Allergies)',
    drug_allergies_priority: 'Ọgwụ Ndị Na-adịghị Ahụ Mma',
    chronic_conditions: 'Ọrịa Na-adịte Aka',
    medications: 'Ọgwụ Na-arụ Ọrụ Ugbu A',
    dnr_warning: 'EKWELA KA E KWEGHARỊA NDỤ (DNR) N’AKWỤKWỌ',
    emergency_contacts: 'Ndị Enwere Ike Ịkpọ na Mberede',
    remaining_time: 'Ọ ga-agwụ n’ime nkeji {m}',
    full_history_locked: 'E mechiri akụkọ ahụike zuru oke. Chọrọ nkwado dọkịta nke abụọ.',
    full_history_unlocked: 'Emegheela akụkọ ahụike site na nkwado dọkịta abụọ',
    offline_verified: 'EKWADORO N’ANWỤGHỊ ỊNTANET',
  },
  sw: { // Swahili (East Africa)
    emergency_title: 'MUHTASARI WA MATIBABU YA DHARURA',
    blood_group: 'Kundi la Damu na Rh',
    genotype: 'Jeni la Himoglobini (Genotype)',
    allergies: 'Mizio na Athari Mbaya za Kiafya',
    drug_allergies_priority: 'Mizio ya Dawa Imewekwa Kipaumbele',
    chronic_conditions: 'Magonjwa ya Muda Mrefu',
    medications: 'Dawa Zinazotumika Sasa',
    dnr_warning: 'USIHUISHE (DNR) KWENYE FAILI LA KISHERIA',
    emergency_contacts: 'Wawasiliani wa Dharura',
    remaining_time: 'Muda unaisha baada ya dakika {m}',
    full_history_locked: 'Rekodi kamili imefungwa. Inahitaji idhini ya daktari wa pili.',
    full_history_unlocked: 'Rekodi kamili ya kliniki imefunguliwa kwa idhini ya madaktari wawili',
    offline_verified: 'IMETHIBITISHWA BILA MTANDAO',
    // Offline card scanner (/s). Needs native-speaker review before clinical use.
    scan_title: 'Kisomaji cha kadi ya dharura',
    scan_intro: 'Changanua kadi ya dharura ya Medistry. Sahihi inakaguliwa kwenye kifaa hiki na hakuna kinachotumwa kwa seva.',
    scan_start_camera: 'Changanua kwa kamera',
    scan_stop_camera: 'Zima kamera',
    scan_paste_label: 'Au bandika kiungo au msimbo wa kadi',
    scan_verify: 'Thibitisha',
    scan_again: 'Changanua kadi nyingine',
    scan_online: 'Mtandaoni',
    scan_offline: 'Nje ya mtandao',
    scan_camera_unavailable: 'Kamera haipatikani. Bandika kiungo cha kadi badala yake.',
    scan_camera_denied: 'Ruhusa ya kamera imekataliwa. Bandika kiungo cha kadi badala yake.',
    scan_aim: 'Elekeza kamera kwenye msimbo wa QR ulio mbele ya kadi.',
    scan_checking: 'Inakagua sahihi…',
    scan_no_token: 'Huu si msimbo wa kadi ya Medistry.',
    scan_valid_badge: 'KADI HALALI',
    scan_not_genuine: 'KADI SI HALALI: usitegemee taarifa hizi',
    scan_not_genuine_detail: 'Sahihi hailingani. Kadi imebadilishwa au haikutolewa na Medistry.',
    scan_expired: 'Muda wa kadi uliisha tarehe {date}',
    scan_unverified_current: 'HAIJATHIBITISHWA KUWA YA SASA: ilikuwa halali ilipotolewa, lakini huenda imepitwa na wakati',
    scan_unknown_key: 'Haiwezi kuthibitisha: unganisha mtandao mara moja ili kusasisha funguo',
    scan_future: 'Haiwezi kuthibitisha: kagua tarehe na saa ya kifaa hiki',
    scan_unsupported: 'Haiwezi kusoma muundo huu wa kadi. Unganisha mtandao mara moja ili kusasisha kisomaji.',
    scan_blood_group: 'Kundi la damu',
    scan_genotype: 'Aina ya jeni (genotype)',
    scan_severe_allergies: 'Mzio mkali',
    scan_no_allergies: 'Hakuna mzio mkali ulioandikwa kwenye kadi hii',
    scan_dnr: 'USIMFUFUE (DNR): AGIZO LIMEANDIKWA',
    scan_conditions: 'Magonjwa',
    scan_medications: 'Dawa',
    scan_recent_dx: 'Utambuzi wa hivi karibuni',
    scan_contact: 'Mtu wa kuwasiliana naye wakati wa dharura',
    scan_call: 'Mpigie {name}',
    scan_organ_donor: 'Mtoaji wa viungo aliyesajiliwa',
    scan_footer_verified: 'Kadi toleo {cv}, ilitolewa {date}, imethibitishwa bila mtandao',
    scan_footer_unverified: 'Kadi toleo {cv}, ilitolewa {date}. Sahihi ni halali, muda wa kadi umeisha',
    scan_valid_until: 'Halali hadi {date}',
    scan_unknown: 'haijulikani',
  },
  fr: { // French (West & Central Africa)
    emergency_title: "RÉSUMÉ MÉDICAL D'URGENCE",
    blood_group: 'Groupe Sanguin & Rh',
    genotype: 'Génotype de l’Hémoglobine',
    allergies: 'Allergies & Réactions Indésirables',
    drug_allergies_priority: 'Allergies Médicamenteuses Priorisées',
    chronic_conditions: 'Pathologies Chroniques',
    medications: 'Médicaments Actuels',
    dnr_warning: 'NE PAS RÉANIMER (DNR) DÉCLARÉ',
    emergency_contacts: "Contacts d'Urgence",
    remaining_time: 'Expire dans {m} minutes',
    full_history_locked: 'Historique complet verrouillé. Nécessite la cosignature d’un second médecin.',
    full_history_unlocked: 'Historique complet déverrouillé par cosignature médicale double',
    offline_verified: 'VÉRIFIÉ HORS-LIGNE',
  },
};

/**
 * Translates a key for a given locale, with parameter interpolation and fallback to English.
 */
/** Keys used by the offline card scanner page (/s), embedded in that page for offline use. */
export const SCANNER_KEYS = Object.keys(TRANSLATIONS.en).filter((k) => k.startsWith('scan_'));

/** Scanner strings for every locale (English fallback per key), for embedding in the /s page. */
export function scannerStrings(): Record<SupportedLocale, Record<string, string>> {
  const out = {} as Record<SupportedLocale, Record<string, string>>;
  for (const locale of SUPPORTED_LOCALES) {
    out[locale] = Object.fromEntries(SCANNER_KEYS.map((k) => [k, t(k, locale)]));
  }
  return out;
}

export function t(key: string, locale: SupportedLocale = 'en', params?: Record<string, string | number>): string {
  const dictionary = TRANSLATIONS[locale] || TRANSLATIONS.en;
  let text = dictionary[key] || TRANSLATIONS.en[key] || key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }

  return text;
}

