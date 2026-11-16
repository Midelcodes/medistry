#!/usr/bin/env node
// Team fact sheet and margin table from MEASURED agent runs (output/runs/*.json written by `npm run agent`).
// Usage: npm run costs -- [--price 1.00] [--volume 600] [--sms-price 0.01] [--sms-per-outcome 2] [--hosting 5]
//   --price            price per completed outcome charged to the facility, USD (proposed; validate with payers)
//   --volume           completed outcomes per month at pilot
//   --sms-price        USD per SMS (patient break-glass alert, emergency contact)
//   --sms-per-outcome  SMS sent per outcome
//   --hosting          hosting per month at pilot, USD (Railway)
//   --hosting-step     extra hosting per month for each 10x of volume, USD
//   --today            the user's cost today for the same outcome, USD (repeat tests)
// Prices per 1M tokens come from GEMINI_PRICE_INPUT_PER_M / GEMINI_PRICE_OUTPUT_PER_M, or the run logs.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pricesFromEnv, modelCostUsd, marginTable, fmtInt } from "./metrics.js";

const here = dirname(fileURLToPath(import.meta.url));
const RUNS = resolve(here, "..", "output", "runs");
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? Number(process.argv[i + 1]) : def;
};
const opts = {
  price: arg("price", 1.0), volume: arg("volume", 600), smsPrice: arg("sms-price", 0.01), smsPerOutcome: arg("sms-per-outcome", 2),
  hosting: arg("hosting", 5), hostingStep: arg("hosting-step", 20), today: arg("today", 35),
};

let files = [];
try { files = readdirSync(RUNS).filter((f) => f.endsWith(".json")).sort(); } catch { /* none yet */ }
const runs = files.map((f) => JSON.parse(readFileSync(resolve(RUNS, f), "utf-8"))).filter((r) => r.outcomeCompleted);
if (!runs.length) {
  console.error(`No completed agent runs in ${RUNS}. Run \`npm run agent -- "<case>"\` first (it saves a log per run).`);
  process.exit(1);
}

const prices = pricesFromEnv(process.env, runs[0]?.model) || runs.find((r) => r.prices)?.prices || null;
const per = runs.map((r) => {
  const t = r.totals;
  const answers = r.modelCalls.map((c) => modelCostUsd(c, prices));
  return { model: r.model, calls: t.calls, input: t.inputTokens, output: t.outputTokens, tools: t.toolCalls, errors: t.toolErrors,
    cost: modelCostUsd(t, prices), perAnswerTokens: (t.inputTokens + t.outputTokens) / Math.max(1, t.calls),
    perAnswerCost: answers.length && answers[0] !== null ? answers.reduce((a, b) => a + b, 0) / answers.length : null, board: r.postedToBoard };
});
const avg = (k) => per.reduce((a, r) => a + (r[k] ?? 0), 0) / per.length;
const max = (k) => Math.max(...per.map((r) => r[k] ?? 0));
const usd = (v, d = 4) => (v === null || v === undefined || Number.isNaN(v) ? "n/a" : `$${v.toFixed(d)}`);

const modelCostPerOutcome = prices ? avg("cost") : 0;
const table = marginTable({ modelCostPerOutcome, smsPerOutcome: opts.smsPerOutcome, smsPrice: opts.smsPrice, hostingPerMonth: opts.hosting,
  hostingStep: opts.hostingStep, pilotVolume: opts.volume, price: opts.price });

const L = [];
L.push("# Medistry: team fact sheet (measured)", "");
L.push(`Generated ${new Date().toISOString()} from ${runs.length} completed agent run(s) in mcp/output/runs.`, "");
L.push("| Figure | Team's number | Source |", "|---|---|---|");
L.push(`| Model(s) and price per 1M input/output tokens | ${[...new Set(per.map((r) => r.model))].join(", ")}: ${prices ? `$${prices.inputPerM} / $${prices.outputPerM}` : "price not set"} | Provider price page; model id from the run logs |`);
L.push(`| Tokens per answer (input + output) | avg ${fmtInt(Math.round(avg("perAnswerTokens")))} | API usage metadata, every model call logged |`);
L.push(`| Model calls per completed outcome | avg ${avg("calls").toFixed(1)}, worst ${max("calls")} | Run logs |`);
L.push(`| Tokens per completed outcome | avg ${fmtInt(Math.round(avg("input")))} in + ${fmtInt(Math.round(avg("output")))} out | Run logs |`);
L.push(`| Model cost per answer / per outcome | ${usd(avg("perAnswerCost"), 5)} / ${usd(modelCostPerOutcome, 4)} (worst ${usd(prices ? max("cost") : null, 4)}) | Tokens x price |`);
L.push(`| Tool, SMS, API and hosting fees per outcome | SMS ${usd(opts.smsPerOutcome * opts.smsPrice)} (${opts.smsPerOutcome} x ${usd(opts.smsPrice, 3)}) + hosting ${usd(opts.hosting / opts.volume)} ($${opts.hosting}/month over ${opts.volume} outcomes); MCP tools and Medistry API: no per-call fee | Assumptions in brackets |`);
L.push(`| Cost per completed outcome (USD) | ${usd(table[0].cost)} | Sum of the above at pilot volume |`);
L.push(`| User's cost today for the same outcome | ${usd(opts.today, 2)} in repeat tests, plus 30+ minutes | Repeat genotype ($15) + blood group ($20) tests, Nisa Premier Hospital, Abuja; allergy panel $30 to $150 more |`);
L.push(`| Price, and who pays | ${usd(opts.price, 2)} per completed outcome, paid by the facility | Proposed; to validate with payers |`);
L.push(`| Margin per outcome at pilot / 10x / 100x | ${table.map((r) => usd(r.margin)).join(" / ")} | Table below |`, "");
L.push("## Margin per outcome", "", "| Volume | Outcomes / month | Model | SMS | Hosting | Cost / outcome | Price | Margin |", "|---|---|---|---|---|---|---|---|");
for (const r of table) L.push(`| ${r.label} | ${fmtInt(r.volume)} | ${usd(r.model)} | ${usd(r.sms)} | ${usd(r.hostingPer)} | ${usd(r.cost)} | ${usd(r.price, 2)} | ${usd(r.margin)} |`);
L.push("", "What falls with scale: hosting per outcome. What does not: model tokens and SMS (linear per outcome).");
L.push("Levers: the offline scan uses no model at all; the LangGraph path uses 0 tokens; context caching and a smaller model (e.g. a Flash-Lite tier) cut model cost further.", "");
L.push("## Runs", "", "| # | Model calls | Tokens in | Tokens out | Tool calls | Tool errors | Model cost | On board |", "|---|---|---|---|---|---|---|---|");
per.forEach((r, i) => L.push(`| ${i + 1} | ${r.calls} | ${fmtInt(r.input)} | ${fmtInt(r.output)} | ${r.tools} | ${r.errors} | ${usd(r.cost, 5)} | ${r.board ? "yes" : "no"} |`));
const md = L.join("\n");
mkdirSync(resolve(here, "..", "output"), { recursive: true });
const out = resolve(here, "..", "output", "fact-sheet.md");
writeFileSync(out, md);
console.log(md);
console.log(`\nSaved: ${out}`);
