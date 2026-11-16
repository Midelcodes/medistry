/**
 * Deterministic, rule-based stand-in for the intake LLM (the default, and the one used in tests). It reads labelled
 * lines of a clinical note ("Diagnosis: ...", "Allergy: ...", "BP 120/80") and proposes FHIR fields, each with the
 * exact character span of the source text it came from. Nothing leaves the process. It is not a model and is not
 * meant to understand free prose: unlabelled lines are ignored, so the doctor sees nothing invented.
 */
import type { LlmAdapter, LlmStructuring, ProposedField, ProposedResource } from './adapters.ts';

const LABELS: Array<{ re: RegExp; kind: 'condition' | 'allergy' | 'medication' | 'reason' }> = [
  { re: /^\s*(?:diagnosis|dx|impression|assessment)\s*[:\-]\s*(.+)$/i, kind: 'condition' },
  { re: /^\s*(?:allerg(?:y|ies)|allergic to)\s*[:\-]?\s*(.+)$/i, kind: 'allergy' },
  { re: /^\s*(?:medications?|meds|rx|drugs?)\s*[:\-]\s*(.+)$/i, kind: 'medication' },
  { re: /^\s*(?:complaint|c\/o|presenting complaint|reason for visit|reason)\s*[:\-]\s*(.+)$/i, kind: 'reason' },
];

const VITALS: Array<{ re: RegExp; name: string; unit?: string; unitRe?: RegExp }> = [
  { re: /\b(?:bp|blood pressure)\s*[:\-]?\s*(\d{2,3}\s*\/\s*\d{2,3})/i, name: 'Blood pressure', unit: 'mmHg' },
  { re: /\b(?:temp|temperature)\s*[:\-]?\s*(\d{2}(?:\.\d)?)\s*(°?\s*[cC])?/i, name: 'Body temperature', unitRe: /[cC]/, unit: '°C' },
  { re: /\b(?:pulse|hr|heart rate)\s*[:\-]?\s*(\d{2,3})\b/i, name: 'Heart rate', unit: '/min' },
  { re: /\b(?:spo2|sats?|oxygen saturation)\s*[:\-]?\s*(\d{2,3})\s*%/i, name: 'Oxygen saturation', unit: '%' },
];

export class DeterministicFakeLlmAdapter implements LlmAdapter {
  readonly name = 'fake-deterministic-v1';

  async structure(text: string): Promise<LlmStructuring> {
    const resources: ProposedResource[] = [];
    let offset = 0;
    for (const line of text.split('\n')) {
      const lineStart = offset;
      offset += line.length + 1;
      const span = (sub: string, from = 0) => {
        const at = line.indexOf(sub, from);
        return { start: lineStart + at, end: lineStart + at + sub.length, text: sub };
      };
      const label = LABELS.map((l) => ({ ...l, m: l.re.exec(line) })).find((l) => l.m);
      if (label?.m) {
        const body = label.m[1].trim();
        const bodyAt = line.lastIndexOf(body);
        // A comma-separated list gives one resource per item.
        const items = label.kind === 'reason' ? [body] : body.split(/\s*[,;]\s*/).filter(Boolean);
        let from = bodyAt;
        for (const item of items) {
          const itemSpan = span(item, from);
          from = itemSpan.end - lineStart;
          const fields: ProposedField[] = [];
          if (label.kind === 'condition') fields.push({ path: 'code.text', value: item, span: itemSpan, confidence: 0.9 });
          if (label.kind === 'reason') fields.push({ path: 'reasonCode[0].text', value: item, span: itemSpan, confidence: 0.85 });
          if (label.kind === 'allergy') {
            const sev = /\((mild|moderate|severe)\)/i.exec(item);
            const name = item.replace(/\s*\((mild|moderate|severe)\)\s*/i, '').trim();
            fields.push({ path: 'code.text', value: name, span: span(name, itemSpan.start - lineStart), confidence: 0.9 });
            if (sev) fields.push({ path: 'reaction[0].severity', value: sev[1].toLowerCase(), span: span(sev[0], itemSpan.start - lineStart), confidence: 0.85 });
          }
          if (label.kind === 'medication') {
            const dose = /\s(\d.*)$/.exec(item);
            const name = dose ? item.slice(0, dose.index).trim() : item;
            fields.push({ path: 'medicationCodeableConcept.text', value: name, span: span(name, itemSpan.start - lineStart), confidence: dose ? 0.85 : 0.5 });
            if (dose) fields.push({ path: 'dosage[0].text', value: dose[1].trim(), span: span(dose[1].trim(), itemSpan.start - lineStart), confidence: 0.8 });
          }
          resources.push({ resourceType: label.kind === 'condition' ? 'Condition' : label.kind === 'allergy' ? 'AllergyIntolerance' : label.kind === 'medication' ? 'MedicationStatement' : 'Encounter', fields });
        }
        continue;
      }
      for (const v of VITALS) {
        const m = v.re.exec(line);
        if (!m) continue;
        const valueText = m[1].replace(/\s+/g, '');
        const unitGiven = v.unitRe ? !!(m[2] && v.unitRe.test(m[2])) : true;
        resources.push({
          resourceType: 'Observation',
          fields: [
            { path: 'code.text', value: v.name, span: span(m[0].slice(0, m[0].indexOf(m[1])).replace(/[:\-\s]+$/, '')), confidence: 0.9 },
            { path: 'value', value: `${valueText} ${v.unit}`, span: span(m[1]), confidence: unitGiven ? 0.85 : 0.5 },
          ],
        });
      }
    }
    return { model: this.name, resources };
  }
}
