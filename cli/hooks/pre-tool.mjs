#!/usr/bin/env node
// PreToolUse: applies the cockpit's limits before a `baw` write or a Binance MCP write runs.
// Any other tool call leaves at once, without a network call. A refusal is recorded on the
// cockpit's timeline; the reason goes to the model and the person.

import { createHash } from "node:crypto";

import { hookWrites } from "./commands.mjs";
import {
  actionRef,
  addTradedToday,
  answer,
  appOf,
  cockpitState,
  input,
  log,
  newCode,
  readState,
  report,
  tradedTodayHere,
  writeState,
} from "./lib.mjs";
import { decide, VALUE_ACTIONS } from "./rules.mjs";
import { valueOf } from "./wallet.mjs";

const hook = await input();
const writes = hookWrites(hook);
if (writes.length === 0) answer();

const app = appOf(hook);
const { state, source } = await cockpitState();
if (!state) {
  // Never read from the site, and the site cannot be reached: Binance's own limits apply.
  log("rules_unchecked", { actions: writes.map((write) => write.action) });
  answer();
}

/** The exact call, for a confirmation typed in Codex to unlock this call and no other. */
const callHash = createHash("sha256")
  .update(`${hook.tool_name}|${JSON.stringify(hook.tool_input ?? {})}`)
  .digest("hex");

const needsValue = (write) => {
  const rules = state.rules ?? {};
  return (
    VALUE_ACTIONS.has(write.action) &&
    (rules.max_trade_usd || rules.day_trade_usd || rules.confirm_above_usd)
  );
};

const local = readState();
const confirmedIndex = (local.confirmed ?? []).findIndex(
  (entry) => entry.hash === callHash && entry.expires > Date.now(),
);

const values = [];
let extraToday = tradedTodayHere();
for (const [index, write] of writes.entries()) {
  const usd = needsValue(write) ? await valueOf(write) : null;
  values.push(usd);
  const verdict = decide({
    state,
    write,
    usd,
    extraToday,
    app,
    confirmed: confirmedIndex >= 0,
  });
  if (verdict.decision === "allow") {
    if (usd !== null && VALUE_ACTIONS.has(write.action)) extraToday += usd;
    continue;
  }

  const event = {
    ref: actionRef(hook, String(index)),
    at: new Date().toISOString(),
    action: write.action,
    status: verdict.decision === "deny" ? "blocked" : "asked",
    chain: write.chain,
    from_token: write.from_token,
    from_qty: write.from_qty,
    to_token: write.to_token,
    usd: usd === null ? null : usd.toFixed(2),
    order_id: write.order_id,
    rule: verdict.rule,
    detail: write.detail,
  };
  await report([clean(event)], hook.session_id);

  if (verdict.decision === "confirm") {
    const code = newCode();
    const pending = (local.pending_confirms ?? []).filter((entry) => entry.expires > Date.now());
    pending.push({ code, hash: callHash, expires: Date.now() + 10 * 60_000 });
    writeState({ ...readState(), pending_confirms: pending.slice(-10) });
    answer(decision("deny", `${verdict.reason} Ask the person to type exactly: confirm ${code}. Then run the same command again.`));
  }
  if (verdict.decision === "deny") {
    // A model that keeps retrying a blocked trade spends its budget for nothing: in Claude
    // Code the third refusal in 10 minutes ends the turn (Codex cannot end one from here).
    const now = Date.now();
    const refusals = (readState().refusals ?? []).filter((entry) => entry.hash === callHash && entry.at > now - 10 * 60_000);
    writeState({ ...readState(), refusals: [...(readState().refusals ?? []).filter((entry) => entry.at > now - 10 * 60_000), { hash: callHash, at: now }].slice(-50) });
    if (app === "claude_code" && refusals.length >= 2) {
      answer({
        continue: false,
        stopReason: "bInference stopped this turn: the agent kept retrying a trade its limits on binference.io block.",
        ...decision("deny", verdict.reason),
      });
    }
  }
  answer(decision(verdict.decision, verdict.reason));
}

// Allowed: a confirmation is used up, and the dollars count toward today here until the
// site's next count.
if (confirmedIndex >= 0) {
  const confirmed = [...(local.confirmed ?? [])];
  confirmed.splice(confirmedIndex, 1);
  writeState({ ...readState(), confirmed });
}
const traded = values.reduce(
  (sum, usd, index) => (usd !== null && VALUE_ACTIONS.has(writes[index].action) ? sum + usd : sum),
  0,
);
if (traded > 0) addTradedToday(traded);
if (source === "stale") log("rules_from_copy", { actions: writes.length });
// The values for the post-tool hook, so it never quotes the same trade twice: the last 50.
const kept = Object.entries(readState().values ?? {}).slice(-49);
writeState({ ...readState(), values: Object.fromEntries([...kept, [actionRef(hook), values]]) });
answer();

function decision(kind, reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: kind,
      permissionDecisionReason: reason,
    },
  };
}

function clean(event) {
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== null && value !== undefined));
}
