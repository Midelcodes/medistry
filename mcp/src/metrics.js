// Unit economics from measured runs (African Agentic AI Design Challenge: "The Unit Economics Teams Must Bring").
//   Cost per answer  = input tokens x input price + output tokens x output price
//   Cost per outcome = sum of the model calls in one completed outcome + SMS, API and hosting fees
// Token counts come from the provider's usage metadata for each call (never estimated). Prices are configured,
// because they differ by provider and change often: GEMINI_PRICE_INPUT_PER_M and GEMINI_PRICE_OUTPUT_PER_M (USD
// per 1M tokens), from the provider's current price page.

// List prices (USD per 1M tokens, standard tier) used when the environment does not set them. Check the provider's
// price page before quoting: prices change. Source: ai.google.dev/gemini-api/docs/pricing (Gemini 3.5 family).
export const LIST_PRICES = {
  "gemini-3.5-flash": { inputPerM: 1.5, outputPerM: 9.0 },
  "gemini-3.5-flash-lite": { inputPerM: 0.3, outputPerM: 2.5 },
};

export function pricesFromEnv(env = process.env, model) {
  const input = Number(env.GEMINI_PRICE_INPUT_PER_M);
  const output = Number(env.GEMINI_PRICE_OUTPUT_PER_M);
  const ok = Number.isFinite(input) && input > 0 && Number.isFinite(output) && output > 0;
  if (ok) return { inputPerM: input, outputPerM: output, source: "environment" };
  const listed = model && LIST_PRICES[String(model).trim().toLowerCase()];
  return listed ? { ...listed, source: "list price (metrics.js)" } : null;
}

export function modelCostUsd({ inputTokens = 0, outputTokens = 0 }, prices) {
  if (!prices) return null;
  return (inputTokens * prices.inputPerM + outputTokens * prices.outputPerM) / 1_000_000;
}

export function totals(modelCalls) {
  const t = modelCalls.reduce((a, c) => ({
    inputTokens: a.inputTokens + (c.inputTokens || 0),
    outputTokens: a.outputTokens + (c.outputTokens || 0),
    ms: a.ms + (c.ms || 0),
  }), { inputTokens: 0, outputTokens: 0, ms: 0 });
  return { ...t, totalTokens: t.inputTokens + t.outputTokens, calls: modelCalls.length };
}

export const fmtUsd = (v) => (v === null || v === undefined ? "n/a (set GEMINI_PRICE_INPUT_PER_M and GEMINI_PRICE_OUTPUT_PER_M)"
  : `$${v < 0.01 ? v.toFixed(5) : v.toFixed(4)}`);
export const fmtInt = (n) => Number(n || 0).toLocaleString("en-US");

/**
 * Cost, price and margin per outcome at pilot, 10x and 100x volume.
 * modelCostPerOutcome: measured average; smsPerOutcome x smsPrice: messages per outcome (patient alert, contacts);
 * hostingPerMonth: fixed, shared across the month's outcomes (the cost that falls with scale);
 * hostingStep: extra monthly hosting per 10x of volume (capacity that does not fall to zero).
 */
export function marginTable({ modelCostPerOutcome, smsPerOutcome, smsPrice, hostingPerMonth, hostingStep = 0, pilotVolume, price }) {
  return [1, 10, 100].map((mult) => {
    const volume = pilotVolume * mult;
    const hosting = hostingPerMonth + hostingStep * Math.log10(mult);
    const hostingPer = hosting / volume;
    const sms = smsPerOutcome * smsPrice;
    const cost = modelCostPerOutcome + sms + hostingPer;
    return { label: mult === 1 ? "Pilot" : `${mult}x`, volume, model: modelCostPerOutcome, sms, hostingPer, cost, price, margin: price - cost };
  });
}
