#!/usr/bin/env node
// PreToolUse: applies the cockpit's limits before a `baw` write or a Binance MCP write runs,
// and keeps the agent away from the files that hold those limits. Any other tool call
// leaves at once, without a network call.
//
// The answer comes first: a refusal is queued for the cockpit's timeline and sent in the
// background. Once a trade is found, anything that goes wrong refuses it, and the hook
// always answers before its app's timeout, since an app runs the tool when a hook times out.

import { createHash } from "node:crypto";

import { hookWrites, protectedTarget } from "./commands.mjs";
import {
  actionRef,
  answer,
  appOf,
  cockpitState,
  deadline,
  flushInBackground,
  input,
  log,
  newCode,
  queueReports,
  todayEntry,
  tradedTodayHere,
  updateState,
} from "./lib.mjs";
import { decide, movesValue } from "./rules.mjs";
import { dollarValue } from "./wallet.mjs";

/** Well under the 30 s the folder's settings give this hook. */
const BUDGET_MS = 20_000;
const CONFIRM_MS = 10 * 60_000;
const NEVER_AROUND = "Do not try another way; tell the person.";

const hook = await input();
const app = appOf(hook);

const target = protectedTarget(hook);
if (target) {
  log("protected_refused", { target });
  await answer(
    decision(
      "deny",
      `This command touches ${target}, which holds this agent's limits and its key. Only the person changes those files. ${NEVER_AROUND}`,
    ),
  );
}

const writes = hookWrites(hook);
if (writes.length === 0) await answer();

deadline(BUDGET_MS, () => unchecked("the check took too long"));
try {
  await answer(await check());
} catch (error) {
  log("pre_tool_failed", { error: String(error?.message ?? error) });
  await answer(unchecked("the check failed"));
}

async function check() {
  const { state, source } = await cockpitState();
  if (!state) {
    // Never read from the site, and the site cannot be reached: Binance's own limits apply.
    log("rules_unchecked", { actions: writes.map((write) => write.action) });
    return undefined;
  }
  const rules = state.rules ?? {};
  const dollarRules = Boolean(rules.max_trade_usd || rules.day_trade_usd || rules.confirm_above_usd);
  // Quotes take about a second each: they run together, before the state is locked.
  const values = await Promise.all(
    writes.map((write) => (dollarRules && movesValue(write) ? dollarValue(write) : Promise.resolve(null))),
  );

  // The exact call, so a confirmation typed in Codex unlocks this call and no other.
  const callHash = createHash("sha256")
    .update(`${hook.tool_name}|${JSON.stringify(hook.tool_input ?? {})}`)
    .digest("hex");

  // Read today's dollars, decide and record in one step, so trades checked at the same time
  // in other sessions or sub-agents count against each other.
  let blocked = null;
  await updateState((local) => {
    const now = Date.now();
    const confirmed = (local.confirmed ?? []).filter((entry) => entry.expires > now);
    const confirmedIndex = confirmed.findIndex((entry) => entry.hash === callHash);
    const counted = Number(state.traded_today_usd) || 0;
    let here = tradedTodayHere(local);
    for (const [index, write] of writes.entries()) {
      const usd = values[index];
      const verdict = decide({
        state,
        write,
        usd,
        // The site's count and this folder's own may each miss trades the other has.
        extraToday: Math.max(0, here - counted),
        app,
        confirmed: confirmedIndex >= 0,
      });
      if (verdict.decision === "allow") {
        if (usd !== null && movesValue(write)) here += usd;
        continue;
      }
      blocked = { index, write, usd, verdict };
      break;
    }

    if (!blocked) {
      if (confirmedIndex >= 0) confirmed.splice(confirmedIndex, 1);
      // The values for the post-tool hook, so it never quotes the same trade twice: the last 50.
      const kept = Object.entries(local.values ?? {}).slice(-49);
      return {
        ...local,
        confirmed,
        today: todayEntry(here),
        values: Object.fromEntries([...kept, [actionRef(hook), values]]),
      };
    }
    if (blocked.verdict.decision === "confirm") {
      blocked.code = newCode();
      const pending = (local.pending_confirms ?? []).filter((entry) => entry.expires > now);
      pending.push({ code: blocked.code, hash: callHash, expires: now + CONFIRM_MS });
      return { ...local, confirmed, pending_confirms: pending.slice(-10) };
    }
    if (blocked.verdict.decision === "deny") {
      const recent = (local.refusals ?? []).filter((entry) => entry.at > now - CONFIRM_MS);
      blocked.repeats = recent.filter((entry) => entry.hash === callHash).length;
      return { ...local, confirmed, refusals: [...recent, { hash: callHash, at: now }].slice(-50) };
    }
    return undefined;
  });

  if (!blocked) {
    if (source === "stale") log("rules_from_copy", { actions: writes.length });
    return undefined;
  }

  const { index, write, usd, verdict } = blocked;
  await queueReports(
    [
      clean({
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
      }),
    ],
    hook.session_id ?? null,
  );
  flushInBackground();

  if (verdict.decision === "confirm") {
    return decision(
      "deny",
      `${verdict.reason} Ask the person to type exactly: confirm ${blocked.code}. Then run the same command again.`,
    );
  }
  // A model that keeps retrying a blocked trade spends its budget for nothing: in Claude
  // Code the third refusal in 10 minutes ends the turn (Codex cannot end one from here).
  if (verdict.decision === "deny" && app === "claude_code" && blocked.repeats >= 2) {
    return {
      continue: false,
      stopReason: "bInference stopped this turn: the agent kept retrying a trade its limits on binference.io block.",
      ...decision("deny", verdict.reason),
    };
  }
  return decision(verdict.decision, verdict.reason);
}

/** When the limits could not be checked: the person decides in Claude Code; Codex refuses. */
function unchecked(why) {
  const reason = `bInference could not check this trade against your limits on binference.io (${why}).`;
  return app === "codex"
    ? decision("deny", `${reason} ${NEVER_AROUND}`)
    : decision("ask", `${reason} The person decides.`);
}

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
