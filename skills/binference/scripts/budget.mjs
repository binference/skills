#!/usr/bin/env node
// Estimates what a task will cost on one or more models and compares it with the AI budget.
//
//   node scripts/budget.mjs --calls 288 --input 3000 --output 300 \
//     --model deepseek/deepseek-v4.1-flash --model anthropic/claude-sonnet-5.5
//
// --calls   model calls the task will make
// --input   input tokens per call: system prompt, conversation, tool definitions, tool results
// --output  output tokens per call: the max_tokens the calls will set
// --model   a model id from GET /models; repeat to compare
//
// Prints JSON: the budget, and for each model the cost per call, the total and a verdict.
// Without BINF_API_KEY it still prices the task, with no budget and the verdict "unknown".
//
//   node scripts/budget.mjs
//
// With no flags it prints the budget alone: what new calls can spend, what running calls
// reserve, the key's own limit and what expires soonest. Run it first on a 402.

import { api, done, fail, flags, key, usd } from "./lib.mjs";

// A task estimated at under half the budget goes ahead: agents' inputs grow turn by turn and
// usually run past the estimate, and other calls share the same budget.
const GO_SHARE = 0.5;

const args = flags(
  {
    calls: { type: "string" },
    input: { type: "string" },
    output: { type: "string" },
    model: { type: "string", multiple: true },
  },
  "node scripts/budget.mjs [--calls N --input TOKENS --output TOKENS --model ID [--model ID ...]]",
);

if (Object.keys(args).length === 0) {
  if (!key()) fail("Set BINF_API_KEY to read the budget.");
  const balance = await api("/balance");
  done({
    ok: true,
    spendable_usd: balance.spendable_usd,
    reserved_usd: balance.reserved_usd,
    running_calls: balance.running_calls,
    key_limit: balance.key_limit,
    expiring: balance.expiring,
    meaning:
      "spendable_usd is what new calls can reserve now. When key_limit is set, its remaining_usd is this key's own cap, and the lower of the two is the budget.",
  });
}

const calls = Number(args.calls);
const input = Number(args.input);
const output = Number(args.output);
const wanted = args.model ?? [];
for (const [name, value] of [
  ["calls", calls],
  ["input", input],
  ["output", output],
]) {
  if (!Number.isFinite(value) || value < 0) fail(`--${name} must be a number of 0 or more.`);
}
if (wanted.length === 0) fail("Name at least one --model, as listed by GET /models.");

const [{ data: models }, balance] = await Promise.all([
  api("/models", { auth: false }),
  key() ? api("/balance") : Promise.resolve(null),
]);

let budget = null;
let source = null;
if (balance) {
  const spendable = Number(balance.spendable_usd);
  const remaining = balance.key_limit ? Number(balance.key_limit.remaining_usd) : null;
  if (remaining !== null && remaining < spendable) {
    budget = remaining;
    source = "key_limit.remaining_usd";
  } else {
    budget = spendable;
    source = "spendable_usd";
  }
}

const byId = new Map(models.map((model) => [model.id.toLowerCase(), model]));
const estimates = wanted.map((id) => {
  const model = byId.get(id.trim().toLowerCase());
  if (!model) {
    const term = id.split("/").at(-1).toLowerCase();
    return {
      model: id,
      error: "Not in GET /models, so not served.",
      similar: models
        .map((m) => m.id)
        .filter((m) => m.toLowerCase().includes(term))
        .slice(0, 5),
    };
  }
  if (!model.pricing) {
    return { model: model.id, error: "This model has no fixed price, so it cannot be estimated." };
  }
  const prompt = Number(model.pricing.prompt);
  const completion = Number(model.pricing.completion);
  const request = Number(model.pricing.request ?? 0);
  const perCall = input * prompt + output * completion + request;
  const total = perCall * calls;
  const share = budget && budget > 0 ? total / budget : null;
  return {
    model: model.id,
    per_call_usd: usd(perCall),
    total_usd: usd(total),
    budget_used_percent: share === null ? null : Math.round(share * 1000) / 10,
    verdict:
      budget === null
        ? "unknown"
        : total <= budget * GO_SHARE
          ? "go"
          : total <= budget
            ? "tight"
            : "over",
  };
});

done({
  ok: true,
  task: { calls, input_tokens_per_call: input, output_tokens_per_call: output },
  budget_usd: budget,
  budget_source: source,
  expiring_soonest: balance?.expiring?.[0] ?? null,
  estimates,
  verdicts: {
    go: `Under ${GO_SHARE * 100}% of the budget: start, with max_tokens set to --output.`,
    tight:
      "Between that and the whole budget: tell the user, offer a cheaper model or fewer calls.",
    over: "More than the budget: do not start. Tell the user the numbers.",
    unknown: "No BINF_API_KEY: costs are priced, the budget is not known.",
  },
});
