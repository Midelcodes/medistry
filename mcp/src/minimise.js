// Minimiser for everything the agent sends to an LLM (task text and tool results).
//
// Real patient data must not be sent to a foreign-hosted LLM without a lawful basis (for Nigeria, the
// Nigeria Data Protection Act 2023; for Kenya, the Data Protection Act 2019). This minimiser reduces
// what leaves the machine, but it is not a lawful basis on its own. Production should use an in-country
// or self-hosted model. All data in this repository is synthetic.
//
// What it does:
//  - Drops person fields entirely: names, contacts, phone, email, address, date of birth, photo, NIN,
//    free-text notes and details, card tokens and clinician passes. A facility's `name` is kept (it is not
//    personal data) when the object also has a facilityId.
//  - Replaces identifiers with placeholders ([REF_1], [ID_1], [CODE_1], [CARD_1]) that the agent maps back
//    locally before calling a tool, so the model can still direct tools without ever seeing the values.
//  - Scrubs free text: card links and tokens, emergency codes, patient references, UUIDs, emails, phone
//    numbers and titled names (Dr/Mr/Mrs/Ms/Prof + name). Name detection in free text is heuristic: do not
//    put untitled names in task text.

const DROP_KEYS = new Set([
  "name", "fullname", "firstname", "lastname", "patientname", "cliniciandname", "clinicianname", "treatingdoctorname",
  "cosigndoctorname", "phone", "email", "contact", "contacts", "emergencycontacts", "ec", "address", "nin",
  "dateofbirth", "dob", "photourl", "note", "notes", "details", "reasondetails", "token", "pass",
]);
const PSEUDO_KEYS = new Map([
  ["patientref", "REF"], ["cardref", "REF"], ["patientid", "REF"], ["sub", "REF"],
  ["id", "ID"], ["grantid", "ID"], ["eventid", "ID"], ["code", "CODE"],
]);

const TEXT_RULES = [
  // Card link or bare compact JWS
  { kind: "CARD", re: /(?:https?:\/\/[^\s#]+\/s#)?[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{40,}/g },
  // Medistry emergency code (Crockford Base32, 4-4-4-3)
  { kind: "CODE", re: /\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{3}\b/gi },
  { kind: "ID", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { kind: "REF", re: /\b(?:PT|CARD)-[A-Za-z0-9][A-Za-z0-9-]*\b/g },
  { drop: "[email removed]", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  // International (+234 803 444 5566) and Nigerian/Kenyan local (0803 444 5566, 0712 345 678) numbers
  { drop: "[phone removed]", re: /\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3}[\s-]?\d{3,4}\b|\b0[17-9]\d{2}[\s-]?\d{3}[\s-]?\d{3,4}\b/g },
  { drop: "[name removed]", re: /\b(?:Dr|Mr|Mrs|Ms|Miss|Prof)\.?\s+[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+)?/g },
];

export function createMinimiser() {
  const real = new Map();   // placeholder -> real value
  const holder = new Map(); // real value -> placeholder
  const counters = {};

  const placeholder = (kind, value) => {
    if (holder.has(value)) return holder.get(value);
    counters[kind] = (counters[kind] || 0) + 1;
    const p = `[${kind}_${counters[kind]}]`;
    real.set(p, value);
    holder.set(value, p);
    return p;
  };

  function text(s) {
    let out = String(s);
    for (const rule of TEXT_RULES) {
      out = out.replace(rule.re, (m) => (rule.drop ? rule.drop : placeholder(rule.kind, m)));
    }
    return out;
  }

  function value(v) {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(value);
    if (!v || typeof v !== "object") return v;
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      const key = k.toLowerCase();
      if (key === "name" && "facilityId" in v) { out[k] = typeof val === "string" ? text(val) : val; continue; }
      if (DROP_KEYS.has(key)) continue;
      if (PSEUDO_KEYS.has(key) && (typeof val === "string" || typeof val === "number")) { out[k] = placeholder(PSEUDO_KEYS.get(key), String(val)); continue; }
      out[k] = value(val);
    }
    return out;
  }

  /** Replaces placeholders in tool arguments with the real values, on this machine only. */
  function restore(v) {
    if (typeof v === "string") return v.replace(/\[(?:REF|ID|CODE|CARD)_\d+\]/g, (p) => (real.has(p) ? real.get(p) : p));
    if (Array.isArray(v)) return v.map(restore);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, restore(val)]));
    return v;
  }

  return { text, value, restore, placeholders: () => new Map(real) };
}
