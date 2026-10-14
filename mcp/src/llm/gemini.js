// Gemini provider for the agent (official @google/genai SDK, function calling).
// Provider interface, shared by any future provider:
//   generate({ system, messages, tools }) -> { text, toolCalls: [{ id, name, args }], raw }
// messages are provider-neutral:
//   { role: "user", text }
//   { role: "assistant", text, toolCalls, raw }   raw = provider content, replayed as-is (keeps Gemini thought signatures)
//   { role: "tool", results: [{ id, name, result }] }
// tools are MCP tool listings: { name, description, inputSchema } (JSON Schema).
import { GoogleGenAI } from "@google/genai";

// JSON Schema (as emitted by the MCP SDK from zod) -> Gemini Schema subset.
// Drops keywords Gemini rejects ($schema, additionalProperties, default, ...). A non-string `const`
// (z.literal(true)) cannot be an enum in Gemini, so it becomes a plain type plus a "must be" note.
export function toGeminiSchema(s = {}) {
  const out = {};
  let type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  if (!type && s.const !== undefined) type = typeof s.const;
  if (!type && s.enum) type = "string";
  if (type) out.type = type.toUpperCase();
  const notes = [];
  if (s.description) notes.push(s.description);
  if (s.const !== undefined) {
    if (typeof s.const === "string") out.enum = [s.const];
    else notes.push(`Must be ${JSON.stringify(s.const)}.`);
  }
  if (notes.length) out.description = notes.join(" ");
  if (s.enum) out.enum = s.enum.map(String);
  if (s.format && type === "string" && ["date-time", "enum"].includes(s.format)) out.format = s.format;
  for (const k of ["minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength"]) {
    if (typeof s[k] === "number") out[k] = s[k];
  }
  if (typeof s.exclusiveMinimum === "number" && out.minimum === undefined) out.minimum = s.exclusiveMinimum;
  if (typeof s.exclusiveMaximum === "number" && out.maximum === undefined) out.maximum = s.exclusiveMaximum;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    if (s.required?.length) out.required = s.required;
  }
  return out;
}

export const toFunctionDeclarations = (tools) => tools.map((t) => ({
  name: t.name,
  description: t.description ?? t.title ?? t.name,
  parameters: toGeminiSchema(t.inputSchema ?? { type: "object", properties: {} }),
}));

function toContents(messages) {
  return messages.map((m) => {
    if (m.role === "user") return { role: "user", parts: [{ text: m.text }] };
    if (m.role === "assistant") {
      if (m.raw) return m.raw;
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { id: c.id, name: c.name, args: c.args } });
      return { role: "model", parts };
    }
    if (m.role === "tool") {
      return { role: "user", parts: m.results.map((r) => ({
        functionResponse: { id: r.id, name: r.name, response: r.result } })) };
    }
    throw new Error(`Unknown message role ${m.role}`);
  });
}

// client is injectable for tests; by default a real GoogleGenAI client is built from apiKey.
export function createGeminiProvider({ apiKey, model, client } = {}) {
  if (!model) throw new Error("GEMINI_MODEL is not set.");
  const ai = client ?? new GoogleGenAI({ apiKey });
  return {
    name: "gemini",
    async generate({ system, messages, tools = [] }) {
      const res = await ai.models.generateContent({
        model,
        contents: toContents(messages),
        config: {
          systemInstruction: system,
          ...(tools.length ? { tools: [{ functionDeclarations: toFunctionDeclarations(tools) }] } : {}),
        },
      });
      const toolCalls = (res.functionCalls ?? []).map((c, i) => ({ id: c.id ?? `call-${i}`, name: c.name, args: c.args ?? {} }));
      const text = toolCalls.length ? null : (res.text ?? null);
      return { text, toolCalls, raw: res.candidates?.[0]?.content };
    },
  };
}
