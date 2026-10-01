#!/usr/bin/env node
// PostToolUse: records what a `baw` write or a Binance MCP write did, from its own JSON
// output: the order, the transaction, how it ended. Reports are queued and sent in the
// background. A swap answers only an order id, so a detached follower watches it to its end
// and the agent never waits.

import { spawn } from "node:child_process";
import { join } from "node:path";

import { hookWrites } from "./commands.mjs";
import { actionRef, answer, FOLDER, flushInBackground, input, parseJsonOutput, queueReports, readState } from "./lib.mjs";

const hook = await input();
const writes = hookWrites(hook);
if (writes.length === 0) await answer();

const output = parseJsonOutput(responseText(hook.tool_response));
const values = readState().values?.[actionRef(hook)] ?? [];
const failed = output?.success === false || hook.tool_response?.isError === true;
const data = output?.data ?? output ?? {};

const events = writes.map((write, index) => {
  // One write per command is the common case: the output is that write's.
  const own = writes.length === 1 ? data : {};
  const orderId = text(own.orderId) ?? text(own.strategyId) ?? text(own.requestId) ?? write.order_id;
  const txHash = text(own.txHash) ?? text(own.transactionHash);
  const status = failed
    ? "failed"
    : output === null
      ? "pending"
      : txHash || ["cancel_order", "approval_revoke", "exchange_cancel"].includes(write.action)
        ? "finished"
        : "submitted";
  const usd = values[index];
  return clean({
    ref: actionRef(hook, String(index)),
    at: new Date().toISOString(),
    action: write.action,
    status,
    chain: write.chain,
    from_token: write.from_token,
    from_qty: write.from_qty,
    to_token: write.to_token,
    usd: typeof usd === "number" ? usd.toFixed(2) : null,
    order_id: orderId && /^[\w.:-]{1,128}$/.test(orderId) ? orderId : null,
    tx_hash: txHash,
    detail: write.detail,
  });
});

await queueReports(events, hook.session_id ?? null);
flushInBackground();

// A submitted swap is followed to FINISHED or FAILED in the background.
for (const [index, event] of events.entries()) {
  if (writes[index].action === "swap" && event.status === "submitted" && event.order_id) {
    const child = spawn(
      process.execPath,
      [join(FOLDER, ".binference", "hooks", "follow-order.mjs"), event.ref, event.order_id, hook.session_id ?? ""],
      { detached: true, stdio: "ignore", cwd: FOLDER },
    );
    child.on("error", () => {});
    child.unref();
  }
}
await answer();

function responseText(response) {
  if (typeof response === "string") return response;
  if (response && typeof response === "object") {
    if (typeof response.stdout === "string") return response.stdout;
    if (typeof response.output === "string") return response.output;
    // An MCP result: content parts with text.
    const parts = Array.isArray(response.content) ? response.content : Array.isArray(response) ? response : [];
    const joined = parts.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
    if (joined) return joined;
    return JSON.stringify(response);
  }
  return "";
}

function text(value) {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value !== "" ? value : null;
}

function clean(event) {
  return Object.fromEntries(Object.entries(event).filter(([, value]) => value !== null && value !== undefined));
}
