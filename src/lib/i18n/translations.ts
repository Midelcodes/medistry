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
    scan_pass_title: 'Clinician pass',
    scan_pass_none: 'No pass on this device',
    scan_pass_valid: '{name}, pass valid until {date}',
    scan_pass_expired: 'Pass expired. Sign in again when online.',
    scan_signin_needed: 'Sign in as a clinician to see conditions and medications',
    scan_signin_button: 'Sign in',
    scan_signin_offline: 'Connect to the internet to sign in.',
    scan_signin_submit: 'Sign in and get offline pass',
    scan_clinician: 'Clinician',
    scan_auth_code: 'Authenticator code',
    scan_show_demo_code: 'Show demo code',
    scan_remove_pass: 'Remove pass from this device',
    scan_reason_title: 'Reason for this emergency access',
    scan_reason_UNCONSCIOUS: 'Patient unconscious',
    scan_reason_LIFE_THREATENING: 'Life-threatening emergency',
    scan_reason_PATIENT_UNABLE_TO_CONSENT: 'Patient unable to consent',
    scan_reason_OTHER: 'Other (explain)',
    scan_reason_details: 'Details',
    scan_reason_details_needed: 'Explain the reason (at least 5 characters).',
    scan_record_and_show: 'Record scan and show conditions and medicines',
    scan_record_only: 'Record scan',
    scan_recorded: 'Scan recorded. It uploads when this device is online, and the patient is notified.',
    scan_queue_waiting: '{n} scan(s) waiting to upload',
    scan_queue_empty: 'All scans uploaded',
    scan_card_superseded: 'At the last sync, the server reported that this card was replaced by a newer version. Ask for the current card.',
    scan_card_revoked: 'At the last sync, the server reported that this card was revoked. Do not rely on it.',
    scan_audit_note: 'Every scan with a pass is logged and the patient is notified.',
    scan_no_optins: 'The patient did not add conditions or medicines to this card.',
    scan_patient_reported: 'Patient-reported, not clinician-verified',
    // Printed offline card and patient notifications
    card_doc_title: 'Medistry emergency medical card',
    card_title: 'EMERGENCY MEDICAL CARD',
    card_instruct: 'Clinicians: scan with Medistry. Works offline.',
    card_print: 'Print card',
    // No script on the card page (CSP script-src 'self', no inline handlers): printing uses the browser.
    card_print_hint: "To print, use your browser's Print command (Ctrl+P, or Share then Print on a phone).",
    card_print_aria: 'Print emergency card, front and back',
    card_front_aria: 'Card front',
    card_back_aria: 'Card back',
    card_blood_group: 'Blood group',
    card_genotype: 'Genotype',
    card_dnr_label: 'DNR',
    card_dnr_on: 'DNR ON FILE',
    card_dnr_off: 'No DNR',
    card_allergies: 'Severe allergies',
    card_no_allergies: 'No severe allergies recorded',
    card_contact: 'Emergency contact',
    card_none: 'None recorded',
    card_code: 'Code',
    card_issued: 'Issued',
    card_version: 'Card v{v}',
    card_expires: 'Expires',
    card_patient_reported: 'Patient-reported, not clinician-verified',
    notify_scan_title: 'Emergency card scanned',
    notify_card_scanned: 'Your emergency card was scanned by {name} at {facility} on {when} UTC for reason: {reason}. Dispute it in the patient portal if this was not you.',
    notify_reason_UNCONSCIOUS: 'patient unconscious',
    notify_reason_LIFE_THREATENING: 'life-threatening emergency',
    notify_reason_PATIENT_UNABLE_TO_CONSENT: 'patient unable to consent',
    notify_reason_OTHER: 'other',
    notify_review_title: 'Emergency card needs review',
    notify_record_changed: 'Your record changed. Review and reissue your emergency card.',
    notify_optins_removed_one: ' We removed {items} from your card choices because it was discontinued or resolved.',
    notify_optins_removed_many: ' We removed {items} from your card choices because they were discontinued or resolved.',
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
    scan_pass_title: 'Kibali cha mhudumu wa afya',
    scan_pass_none: 'Hakuna kibali kwenye kifaa hiki',
    scan_pass_valid: '{name}, kibali ni halali hadi {date}',
    scan_pass_expired: 'Kibali kimeisha muda. Ingia tena ukiwa mtandaoni.',
    scan_signin_needed: 'Ingia kama mhudumu wa afya ili kuona magonjwa na dawa',
    scan_signin_button: 'Ingia',
    scan_signin_offline: 'Unganisha mtandao ili kuingia.',
    scan_signin_submit: 'Ingia na upate kibali cha nje ya mtandao',
    scan_clinician: 'Mhudumu wa afya',
    scan_auth_code: 'Msimbo wa uthibitishaji',
    scan_show_demo_code: 'Onyesha msimbo wa majaribio',
    scan_remove_pass: 'Ondoa kibali kwenye kifaa hiki',
    scan_reason_title: 'Sababu ya kufikia taarifa hizi za dharura',
    scan_reason_UNCONSCIOUS: 'Mgonjwa amepoteza fahamu',
    scan_reason_LIFE_THREATENING: 'Dharura inayohatarisha maisha',
    scan_reason_PATIENT_UNABLE_TO_CONSENT: 'Mgonjwa hawezi kutoa idhini',
    scan_reason_OTHER: 'Nyingine (eleza)',
    scan_reason_details: 'Maelezo',
    scan_reason_details_needed: 'Eleza sababu (angalau herufi 5).',
    scan_record_and_show: 'Rekodi uchanganuzi na uonyeshe magonjwa na dawa',
    scan_record_only: 'Rekodi uchanganuzi',
    scan_recorded: 'Uchanganuzi umerekodiwa. Utapakiwa kifaa kikiwa mtandaoni, na mgonjwa atajulishwa.',
    scan_queue_waiting: 'Uchanganuzi {n} unasubiri kupakiwa',
    scan_queue_empty: 'Uchanganuzi wote umepakiwa',
    scan_card_superseded: 'Katika usawazishaji wa mwisho, seva iliripoti kuwa kadi hii imebadilishwa na toleo jipya. Omba kadi ya sasa.',
    scan_card_revoked: 'Katika usawazishaji wa mwisho, seva iliripoti kuwa kadi hii imefutwa. Usiitegemee.',
    scan_audit_note: 'Kila uchanganuzi wenye kibali hurekodiwa na mgonjwa hujulishwa.',
    scan_no_optins: 'Mgonjwa hakuongeza magonjwa wala dawa kwenye kadi hii.',
    scan_patient_reported: 'Imeripotiwa na mgonjwa, haijathibitishwa na mhudumu wa afya',
    // Printed offline card and patient notifications. Needs native-speaker review before clinical use.
    card_doc_title: 'Kadi ya matibabu ya dharura ya Medistry',
    card_title: 'KADI YA MATIBABU YA DHARURA',
    card_instruct: 'Wahudumu wa afya: changanua kwa Medistry. Inafanya kazi bila mtandao.',
    card_print: 'Chapisha kadi',
    card_print_hint: 'Ili kuchapisha, tumia amri ya Chapisha ya kivinjari (Ctrl+P, au Shiriki kisha Chapisha kwenye simu).',
    card_print_aria: 'Chapisha kadi ya dharura, mbele na nyuma',
    card_front_aria: 'Mbele ya kadi',
    card_back_aria: 'Nyuma ya kadi',
    card_blood_group: 'Kundi la damu',
    card_genotype: 'Aina ya jeni (genotype)',
    card_dnr_label: 'DNR',
    card_dnr_on: 'DNR IMEANDIKWA',
    card_dnr_off: 'Hakuna DNR',
    card_allergies: 'Mzio mkali',
    card_no_allergies: 'Hakuna mzio mkali ulioandikwa',
    card_contact: 'Mtu wa kuwasiliana naye wakati wa dharura',
    card_none: 'Hakuna kilichoandikwa',
    card_code: 'Msimbo',
    card_issued: 'Ilitolewa',
    card_version: 'Kadi toleo {v}',
    card_expires: 'Inaisha muda',
    card_patient_reported: 'Imeripotiwa na mgonjwa, haijathibitishwa na mhudumu wa afya',
    notify_scan_title: 'Kadi ya dharura imechanganuliwa',
    notify_card_scanned: 'Kadi yako ya dharura ilichanganuliwa na {name} katika {facility} tarehe {when} UTC kwa sababu: {reason}. Ipinge kwenye tovuti ya mgonjwa kama haikuwa wewe.',
    notify_reason_UNCONSCIOUS: 'mgonjwa amepoteza fahamu',
    notify_reason_LIFE_THREATENING: 'dharura inayohatarisha maisha',
    notify_reason_PATIENT_UNABLE_TO_CONSENT: 'mgonjwa hawezi kutoa idhini',
    notify_reason_OTHER: 'nyingine',
    notify_review_title: 'Kadi ya dharura inahitaji kukaguliwa',
    notify_record_changed: 'Rekodi yako imebadilika. Kagua na utoe upya kadi yako ya dharura.',
    notify_optins_removed_one: ' Tumeondoa {items} kwenye chaguo za kadi yako kwa sababu imesitishwa au imepona.',
    notify_optins_removed_many: ' Tumeondoa {items} kwenye chaguo za kadi yako kwa sababu zimesitishwa au zimepona.',
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

/**
 * SMS templates (Phase 13). Every SMS the platform sends is rendered from one of these, so no free text (and no
 * clinical detail: no blood group, genotype, allergy, condition, medication or break-glass reason) can reach an SMS.
 * Kept to 160 characters or fewer where possible, without characters outside the GSM 7-bit set (tone marks and
 * some accents are left out on purpose, so a message stays one 160-character part).
 * TODO: the sw, ha, yo, ig and fr texts are drafts; have native speakers review them before production.
 */
export type SmsTemplateId =
  | 'access_alert' | 'contact_alert' | 'sign_in_code' | 'new_phone_code' | 'account_moved' | 'proxy_invite'
  | 'guardian_added' | 'guardian_ended' | 'majority_patient' | 'clinician_approved' | 'clinician_rejected'
  | 'licence_expiring' | 'licence_expired';

type SmsFragments = Record<SmsTemplateId | 'action_app_ussd' | 'action_app', string>;

export const SMS_TEMPLATES: Record<SupportedLocale, SmsFragments> = {
  en: {
    access_alert: 'Your Medistry record was accessed by {doctor} at {facility}. {action}',
    action_app_ussd: 'Open the app or dial {ussd} to review or dispute.',
    action_app: 'Open the app to review or dispute.',
    contact_alert: "Medistry: emergency access to {patient}'s record by {doctor} at {facility}.",
    sign_in_code: 'Your Medistry sign-in code is {code}. It expires in 5 minutes. Never share it.',
    new_phone_code: 'Your Medistry code to confirm your new phone is {code}. It expires in 5 minutes. Never share it.',
    account_moved: 'Your Medistry account was moved to a new phone number. If this was not you, contact your clinic now.',
    proxy_invite: 'A Medistry patient invited you to help with their record. Sign in to Medistry with this number to accept or decline.',
    guardian_added: "You are now the guardian on a child's Medistry record. Sign in to Medistry with this number to manage it.",
    guardian_ended: 'The person whose Medistry record you managed has turned {age}. Your guardian access has ended.',
    majority_patient: "You have turned {age}: you now control your own Medistry record. Your guardian's access has ended.",
    clinician_approved: 'Your Medistry clinician account is verified. You can now sign in and use clinical features.',
    clinician_rejected: 'Your Medistry clinician registration was not approved. Contact your facility admin.',
    licence_expiring: 'Your licence on record with Medistry expires on {date}. Renew it and ask your facility admin to re-verify you.',
    licence_expired: 'Your licence on record with Medistry expired on {date}. Ask your facility admin to re-verify you.',
  },
  sw: {
    access_alert: 'Rekodi yako Medistry imefunguliwa na {doctor} katika {facility}. {action}',
    action_app_ussd: 'Fungua programu au piga {ussd} kukagua au kupinga.',
    action_app: 'Fungua programu kukagua au kupinga.',
    contact_alert: 'Medistry: {doctor} katika {facility} amefungua rekodi ya dharura ya {patient}.',
    sign_in_code: 'Nambari yako ya kuingia Medistry ni {code}. Itaisha baada ya dakika 5. Usimpe mtu yeyote.',
    new_phone_code: 'Nambari ya kuthibitisha simu yako mpya ya Medistry ni {code}. Itaisha baada ya dakika 5. Usimpe mtu.',
    account_moved: 'Akaunti yako ya Medistry imehamishiwa nambari mpya ya simu. Kama si wewe, wasiliana na kliniki yako sasa.',
    proxy_invite: 'Mgonjwa wa Medistry amekualika kumsaidia na rekodi yake. Ingia Medistry kwa nambari hii kukubali au kukataa.',
    guardian_added: 'Sasa wewe ni mlezi kwenye rekodi ya Medistry ya mtoto. Ingia Medistry kwa nambari hii kuisimamia.',
    guardian_ended: 'Mtu ambaye ulisimamia rekodi yake ya Medistry ametimiza miaka {age}. Ufikiaji wako wa mlezi umekwisha.',
    majority_patient: 'Umetimiza miaka {age}: sasa unasimamia rekodi yako ya Medistry. Ufikiaji wa mlezi wako umekwisha.',
    clinician_approved: 'Akaunti yako ya mhudumu wa afya ya Medistry imethibitishwa. Sasa unaweza kuingia na kutumia huduma za kliniki.',
    clinician_rejected: 'Usajili wako wa mhudumu wa afya wa Medistry haukuidhinishwa. Wasiliana na msimamizi wa kituo chako.',
    licence_expiring: 'Leseni yako iliyo Medistry inaisha tarehe {date}. Ifanye upya na umwombe msimamizi wa kituo akuthibitishe tena.',
    licence_expired: 'Leseni yako iliyo Medistry iliisha tarehe {date}. Mwombe msimamizi wa kituo akuthibitishe tena.',
  },
  ha: {
    access_alert: '{doctor} a {facility} ya duba bayananka na Medistry. {action}',
    action_app_ussd: 'Bude manhajar ko ka danna {ussd} don dubawa ko kalubalanta.',
    action_app: 'Bude manhajar don dubawa ko kalubalanta.',
    contact_alert: 'Medistry: {doctor} a {facility} ya duba bayanan gaggawa na {patient}.',
    sign_in_code: 'Lambar shiga Medistry dinka ita ce {code}. Za ta kare bayan minti 5. Kada ka ba kowa.',
    new_phone_code: 'Lambar tabbatar da sabuwar wayarka a Medistry ita ce {code}. Za ta kare bayan minti 5. Kada ka ba kowa.',
    account_moved: 'An mayar da asusunka na Medistry zuwa sabuwar lambar waya. Idan ba kai ba ne, tuntubi asibitinka yanzu.',
    proxy_invite: 'Wani mara lafiya a Medistry ya gayyace ka don taimaka da bayanansa. Shiga Medistry da wannan lamba don karba ko ki.',
    guardian_added: 'Yanzu kai ne mai kula da bayanan Medistry na yaro. Shiga Medistry da wannan lamba don sarrafa su.',
    guardian_ended: 'Wanda kake kula da bayanansa na Medistry ya cika shekara {age}. Damar ka ta mai kula ta kare.',
    majority_patient: 'Ka cika shekara {age}: yanzu kai ke sarrafa bayananka na Medistry. Damar mai kula da kai ta kare.',
    clinician_approved: 'An tabbatar da asusunka na likita a Medistry. Yanzu za ka iya shiga ka yi amfani da ayyukan asibiti.',
    clinician_rejected: 'Ba a amince da rajistar ka ta likita a Medistry ba. Tuntubi mai kula da cibiyarka.',
    licence_expiring: 'Lasisinka da ke Medistry zai kare a ranar {date}. Sabunta shi ka nemi mai kula da cibiya ya sake tabbatar da kai.',
    licence_expired: 'Lasisinka da ke Medistry ya kare a ranar {date}. Nemi mai kula da cibiya ya sake tabbatar da kai.',
  },
  yo: {
    access_alert: '{doctor} ni {facility} wo akosile Medistry re. {action}',
    action_app_ussd: 'Si app naa tabi te {ussd} lati wo tabi tako re.',
    action_app: 'Si app naa lati wo tabi tako re.',
    contact_alert: 'Medistry: {doctor} ni {facility} wo akosile pajawiri {patient}.',
    sign_in_code: 'Koodu iwole Medistry re ni {code}. Yoo pari ni iseju 5. Ma se fi han enikeni.',
    new_phone_code: 'Koodu lati jerisi foonu titun re lori Medistry ni {code}. Yoo pari ni iseju 5. Ma se fi han enikeni.',
    account_moved: 'A ti gbe akanti Medistry re lo si nomba foonu titun. Ti kii ba se iwo, kan si ile-iwosan re bayii.',
    proxy_invite: 'Alaisan Medistry kan pe o lati ran an lowo pelu akosile re. Wole si Medistry pelu nomba yii lati gba tabi ko.',
    guardian_added: 'Iwo ni alagbato lori akosile Medistry omode kan bayii. Wole si Medistry pelu nomba yii lati sakoso re.',
    guardian_ended: 'Eni ti o n sakoso akosile Medistry re ti pe omo odun {age}. Aaye alagbato re ti pari.',
    majority_patient: 'O ti pe omo odun {age}: iwo ni o n sakoso akosile Medistry re bayii. Aaye alagbato re ti pari.',
    clinician_approved: 'A ti jerisi akanti onisegun Medistry re. O le wole bayii ki o lo awon ise ile-iwosan.',
    clinician_rejected: 'A ko fowo si iforukosile onisegun Medistry re. Kan si alakoso ile-iwosan re.',
    licence_expiring: 'Iwe-ase re lori Medistry yoo pari ni {date}. Tun un se ki o si beere ki alakoso ile-iwosan jerisi re lekan si.',
    licence_expired: 'Iwe-ase re lori Medistry ti pari ni {date}. Beere ki alakoso ile-iwosan jerisi re lekan si.',
  },
  ig: {
    access_alert: '{doctor} na {facility} lere ndeko Medistry gi anya. {action}',
    action_app_ussd: 'Mepee app ma o bu pia {ussd} iji lelee ma o bu mee mkpesa.',
    action_app: 'Mepee app iji lelee ma o bu mee mkpesa.',
    contact_alert: 'Medistry: {doctor} na {facility} lere ndeko mberede nke {patient}.',
    sign_in_code: 'Koodu nbanye Medistry gi bu {code}. O ga-agwu na nkeji 5. Egosila onye obula.',
    new_phone_code: 'Koodu iji kwado ekwenti ohuru gi na Medistry bu {code}. O ga-agwu na nkeji 5. Egosila onye obula.',
    account_moved: 'Ebugara akauntu Medistry gi na nomba ekwenti ohuru. O buru na o bughi gi, kpoo ulo ogwu gi ugbu a.',
    proxy_invite: 'Onye oria na Medistry kporo gi ka i nyere ya aka na ndeko ya. Banye Medistry site na nomba a iji nabata ma o bu ju.',
    guardian_added: 'I bu ugbu a onye nlekota na ndeko Medistry nke nwatakiri. Banye Medistry site na nomba a iji jikwaa ya.',
    guardian_ended: 'Onye i na-elekota ndeko Medistry ya agbaala afo {age}. Ohere nlekota gi akwusila.',
    majority_patient: 'I gbaala afo {age}: ugbu a i na-achi ndeko Medistry gi. Ohere onye nlekota gi akwusila.',
    clinician_approved: 'Akwadola akauntu dibia Medistry gi. I nwere ike ibanye ugbu a ma jiri oru ahuike.',
    clinician_rejected: 'Anabataghi ndebanye aha dibia Medistry gi. Kpoo onye njikwa ulo oru gi.',
    licence_expiring: 'Akwukwo ikike gi na Medistry ga-agwu na {date}. Megharia ya ma rio onye njikwa ulo oru ka o kwado gi ozo.',
    licence_expired: 'Akwukwo ikike gi na Medistry agwula na {date}. Rio onye njikwa ulo oru ka o kwado gi ozo.',
  },
  fr: {
    access_alert: 'Dossier Medistry consulté par {doctor} à {facility}. {action}',
    action_app_ussd: "Ouvrez l'appli ou composez {ussd} pour vérifier ou contester.",
    action_app: "Ouvrez l'application pour vérifier ou contester.",
    contact_alert: "Medistry : accès d'urgence au dossier de {patient} par {doctor} à {facility}.",
    sign_in_code: 'Votre code de connexion Medistry est {code}. Il expire dans 5 minutes. Ne le partagez jamais.',
    new_phone_code: 'Votre code Medistry pour confirmer votre nouveau numéro est {code}. Il expire dans 5 minutes. Ne le partagez jamais.',
    account_moved: "Votre compte Medistry a été transféré vers un nouveau numéro. Si ce n'est pas vous, contactez votre clinique.",
    proxy_invite: "Un patient Medistry vous invite à l'aider pour son dossier. Connectez-vous avec ce numéro pour accepter ou refuser.",
    guardian_added: "Vous devenez le tuteur du dossier Medistry d'un enfant. Connectez-vous avec ce numéro pour le gérer.",
    guardian_ended: 'La personne dont vous gériez le dossier Medistry a {age} ans. Votre accès de tuteur a pris fin.',
    majority_patient: "Vous avez {age} ans : vous gérez désormais votre dossier Medistry. L'accès de votre tuteur a pris fin.",
    clinician_approved: 'Votre compte clinicien Medistry est vérifié. Vous pouvez vous connecter et utiliser les fonctions cliniques.',
    clinician_rejected: "Votre inscription de clinicien Medistry n'a pas été approuvée. Contactez l'administrateur de votre établissement.",
    licence_expiring: 'Votre licence enregistrée sur Medistry expire le {date}. Renouvelez-la et demandez une nouvelle vérification.',
    licence_expired: 'Votre licence enregistrée sur Medistry a expiré le {date}. Demandez une nouvelle vérification à votre établissement.',
  },
};

export const SMS_TEMPLATE_IDS = Object.keys(SMS_TEMPLATES.en).filter((k) => !k.startsWith('action_')) as SmsTemplateId[];

/**
 * USSD short code shown in access alerts (USSD_SERVICE_CODE, e.g. "*123*45#").
 * TODO: the short code must be provisioned with the SMS/USSD provider and the telcos; until then alerts say
 * "Open the app" only.
 */
export function ussdServiceCode(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = (env.USSD_SERVICE_CODE || '').trim();
  return /^\*[0-9*]{1,20}#$/.test(v) ? v : null;
}

/** Renders an SMS template in the locale (English if unknown). Values are inserted as given. */
export function renderSms(id: SmsTemplateId, locale: string | undefined, vars: Record<string, string | number> = {}): string {
  const lang: SupportedLocale = SUPPORTED_LOCALES.includes(locale as SupportedLocale) ? (locale as SupportedLocale) : 'en';
  const table = SMS_TEMPLATES[lang];
  const fill = (text: string, values: Record<string, string | number>) =>
    text.replace(/\{(\w+)\}/g, (m, k) => (values[k] !== undefined ? String(values[k]) : m));
  const ussd = ussdServiceCode();
  const action = ussd ? fill(table.action_app_ussd, { ussd }) : table.action_app;
  return fill(table[id], { ...vars, action });
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

