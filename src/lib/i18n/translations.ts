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

