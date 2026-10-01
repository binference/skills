#!/usr/bin/env node
// SessionStart: reports the session with the wallet as it is now, and gives the model a
// short status block: the budget, the rules, the wallet's sign-out time and what to fix.

import { spawn } from "node:child_process";
import { join } from "node:path";

import { answer, api, appOf, config, FOLDER, flushOutbox, input, log, readState, saveCockpit } from "./lib.mjs";
import { dollars } from "./rules.mjs";
import { readWallet } from "./wallet.mjs";

const hook = await input();
const cfg = config();
if (!cfg) answer();

const sessionId =
  typeof hook.session_id === "string" && /^[\w.:-]{1,128}$/.test(hook.session_id)
    ? hook.session_id
    : `s-${Date.now()}`;
const app = appOf(hook);
const wallet = cfg.report === false ? null : await readWallet();

const started = await api("POST", "/api/v1/cockpit/sessions", {
  app_session_id: sessionId,
  app,
  app_version: null,
  wallet,
});
if (started.ok) saveCockpit(started.json);
else log("session_unreported", { status: started.status });
await flushOutbox(sessionId);

// A linked wallet's history is synced in the background, from where the last sync stopped.
const linked = started.ok ? started.json.wallet : null;
if (linked && wallet?.status === "connected" && wallet.address === linked.address) {
  const child = spawn(
    process.execPath,
    [join(FOLDER, ".binference", "hooks", "sync-history.mjs"), linked.synced_through ?? linked.linked_at],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

const state = started.ok ? started.json : readState().cockpit;
answer({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: statusBlock(state, wallet, started.status),
  },
});

function hoursUntil(isoTime) {
  const ms = new Date(isoTime).getTime() - Date.now();
  return Number.isFinite(ms) ? ms / 3_600_000 : null;
}

function statusBlock(cockpit, walletNow, status) {
  if (!cockpit) {
    return status === 401
      ? "bInference cockpit: this folder's key no longer works (revoked, or the agent was stopped). Tell the person to run `npx binference doctor` in this folder."
      : "bInference cockpit: binference.io could not be reached, so the trading rules are unknown this session. Trade only with the person's explicit yes.";
  }
  const lines = [`bInference cockpit for "${cockpit.cockpit?.name}" (${cockpit.cockpit?.url}):`];
  if (app === "claude_code" && !(process.env.ANTHROPIC_BASE_URL ?? "").startsWith(cfg.api_url)) {
    lines.push(
      "- This session does not think through bInference, so its AI spend is missing from the cockpit. Tell the person to start it with `npx binference start` in this folder.",
    );
  }
  if (cockpit.paused || cockpit.stopped) {
    lines.push(
      "- This agent is PAUSED by its owner. Do not trade or start long work. Tell the person to resume it in the cockpit.",
    );
  }
  const budget = cockpit.budget ?? {};
  const runway =
    budget.runway_days === null || budget.runway_days === undefined
      ? ""
      : `, about ${budget.runway_days} days at the last day's pace`;
  const keyLimit = budget.key_limit
    ? ` This key stops at ${dollars(budget.key_limit.usd)} a ${budget.key_limit.reset === "daily" ? "day" : budget.key_limit.reset === "weekly" ? "week" : "month"} (${dollars(budget.key_limit.left_usd)} left).`
    : "";
  lines.push(`- AI budget: ${dollars(budget.spendable_usd ?? 0)} to spend${runway}.${keyLimit}`);

  const rules = cockpit.rules ?? {};
  const parts = [
    rules.max_trade_usd ? `at most ${dollars(rules.max_trade_usd)} a trade` : null,
    rules.day_trade_usd ? `${dollars(rules.day_trade_usd)} a day` : null,
    rules.confirm_above_usd ? `the person confirms above ${dollars(rules.confirm_above_usd)}` : null,
    Array.isArray(rules.allowed_tokens) ? `only ${rules.allowed_tokens.length} listed tokens` : null,
  ].filter(Boolean);
  lines.push(`- Trade limits: ${parts.length ? parts.join(", ") : "none set"}. Hooks apply them before each trade.`);

  if (walletNow?.status === "connected") {
    const hours = hoursUntil(walletNow.settings?.session_expires_at);
    const signOut =
      hours !== null && hours < 6
        ? ` Its sign-in ends in about ${Math.max(0, Math.round(hours))} h and Binance signs it out silently: tell the person now.`
        : "";
    const daily = Number(walletNow.settings?.daily_limit_usd);
    const loose =
      Number.isFinite(daily) && daily > 1_000
        ? ` Its daily limit is ${dollars(daily)}: suggest the person lowers it in the Binance App (Agentic Wallet → Settings).`
        : "";
    lines.push(`- Agentic Wallet: signed in.${signOut}${loose}`);
  } else if (walletNow?.status === "signed_out") {
    lines.push("- Agentic Wallet: signed out. Say so before any on-chain action.");
  }
  lines.push(
    "- If a hook blocks an action, tell the person the reason. Never retry it another way or split it.",
  );
  return lines.join("\n");
}
