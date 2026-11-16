/**
 * AI intake adapters (Phase 15). Each step is pluggable so a deployment can use an in-country provider:
 *
 *   OcrAdapter           photo or scan of a paper record -> text
 *   SpeechToTextAdapter  voice note -> text
 *   LlmAdapter           text -> proposed FHIR fields, each with the source text span it came from
 *
 * Defaults: OCR and speech-to-text are stubs that refuse (no provider configured); the LLM is a deterministic,
 * rule-based fake that never leaves the process. A real LLM is used only when INTAKE_LLM_PROVIDER is set, and with
 * real data (DEMO_MODE=0) only when LLM_IN_COUNTRY_APPROVED=1 says the model is in-country or self-hosted, or
 * another lawful basis for transfer exists (docs/DEPLOYMENT.md).
 */
import { DeterministicFakeLlmAdapter } from './fakeLlm.ts';

export interface SourceSpan { start: number; end: number; text: string }

export interface ProposedField {
  /** Where the value goes in the FHIR resource, from a fixed list per resource type (see intakeService.ts). */
  path: string;
  value: string | number;
  span: SourceSpan;
  /** 0..1. Below LOW_CONFIDENCE the field is flagged for the doctor. */
  confidence: number;
}

export type IntakeResourceType = 'Condition' | 'AllergyIntolerance' | 'MedicationStatement' | 'Observation' | 'Encounter';

export interface ProposedResource { resourceType: IntakeResourceType; fields: ProposedField[] }

export interface LlmStructuring { model: string; resources: ProposedResource[] }

export interface OcrAdapter { readonly name: string; extractText(file: Buffer, mimeType: string): Promise<{ text: string; confidence?: number }> }
export interface SpeechToTextAdapter { readonly name: string; transcribe(audio: Buffer, mimeType: string): Promise<{ text: string; confidence?: number }> }
export interface LlmAdapter { readonly name: string; structure(text: string): Promise<LlmStructuring> }

export const LOW_CONFIDENCE = 0.6;

/** The adapter cannot run (not configured, or not allowed for real data). Maps to HTTP 503. */
export class IntakeAdapterUnavailable extends Error {
  status = 503;
}

/** TODO: an in-country OCR provider (or a self-hosted engine) for photos of paper records. */
export class StubOcrAdapter implements OcrAdapter {
  readonly name = 'ocr-not-configured';
  async extractText(): Promise<{ text: string }> {
    throw new IntakeAdapterUnavailable('No OCR provider is configured, so photos cannot be read yet. Paste or type the text instead.');
  }
}

/** TODO: an in-country speech-to-text provider (or a self-hosted model) for voice notes. */
export class StubSpeechToTextAdapter implements SpeechToTextAdapter {
  readonly name = 'speech-to-text-not-configured';
  async transcribe(): Promise<{ text: string }> {
    throw new IntakeAdapterUnavailable('No speech-to-text provider is configured, so voice notes cannot be transcribed yet. Paste or type the text instead.');
  }
}

/**
 * A self-hosted structuring service behind INTAKE_LLM_URL (INTAKE_LLM_PROVIDER=http). Contract (Medistry's own,
 * not a vendor API): POST JSON {"task":"medistry-fhir-intake-v1","text":"..."} with Authorization: Bearer
 * INTAKE_LLM_API_KEY; the response is JSON {"model":"...","resources":[{resourceType, fields:[{path,value,span:
 * {start,end,text},confidence}]}]}. Wrap the deployment's model in a service that speaks this. The response is
 * checked field by field in intakeService.ts (paths, spans against the source text).
 */
export class HttpLlmAdapter implements LlmAdapter {
  readonly name: string;
  private url: string;
  private apiKey: string;
  private fetchImpl: typeof fetch;

  constructor(opts: { url: string; apiKey: string; model?: string; fetch?: typeof fetch }) {
    this.url = opts.url;
    this.apiKey = opts.apiKey;
    this.name = `http:${(opts.model || 'unnamed-model').replace(/[^\w.:-]/g, '').slice(0, 60)}`;
    this.fetchImpl = opts.fetch || fetch;
  }

  async structure(text: string): Promise<LlmStructuring> {
    const res = await this.fetchImpl(this.url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ task: 'medistry-fhir-intake-v1', text }), signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new IntakeAdapterUnavailable(`The intake model service answered HTTP ${res.status}`);
    const data: any = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.resources)) throw new IntakeAdapterUnavailable('The intake model service returned an unreadable response');
    return { model: String(data.model || this.name).slice(0, 80), resources: data.resources };
  }
}

/** Adapters for this environment. Throws IntakeAdapterUnavailable when a configured real LLM is not allowed. */
export function createIntakeAdapters(env: NodeJS.ProcessEnv = process.env): { ocr: OcrAdapter; stt: SpeechToTextAdapter; llm: () => LlmAdapter } {
  const provider = (env.INTAKE_LLM_PROVIDER || '').trim().toLowerCase();
  const llm = (): LlmAdapter => {
    if (!provider || provider === 'fake') return new DeterministicFakeLlmAdapter();
    if (env.DEMO_MODE === '0' && env.LLM_IN_COUNTRY_APPROVED !== '1') {
      throw new IntakeAdapterUnavailable('A real intake model is configured, but real patient data may only go to an in-country or self-hosted model (set LLM_IN_COUNTRY_APPROVED=1 only when that holds). See docs/DEPLOYMENT.md.');
    }
    if (provider === 'http' && /^https?:\/\//.test(env.INTAKE_LLM_URL || '') && env.INTAKE_LLM_API_KEY) {
      return new HttpLlmAdapter({ url: env.INTAKE_LLM_URL!, apiKey: env.INTAKE_LLM_API_KEY, model: env.INTAKE_LLM_MODEL });
    }
    throw new IntakeAdapterUnavailable('INTAKE_LLM_PROVIDER must be fake, or http with INTAKE_LLM_URL and INTAKE_LLM_API_KEY');
  };
  // TODO: plug in in-country OCR and speech-to-text providers here (INTAKE_OCR_PROVIDER, INTAKE_STT_PROVIDER).
  return { ocr: new StubOcrAdapter(), stt: new StubSpeechToTextAdapter(), llm };
}
