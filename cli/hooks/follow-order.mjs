#!/usr/bin/env node
// Runs detached after a swap: polls `baw market-order list --orderId` until the order is
// FINISHED or FAILED (two minutes at most) and reports the end, with its transaction.
//
//   node follow-order.mjs <ref> <orderId> <sessionId>

import { baw, report } from "./lib.mjs";

const [ref, orderId, sessionId] = process.argv.slice(2);
if (!ref || !orderId) process.exit(0);

const STEP_MS = 3_000;
const TRIES = 40;

for (let attempt = 0; attempt < TRIES; attempt += 1) {
  await new Promise((resume) => setTimeout(resume, STEP_MS));
  const data = await baw(["market-order", "list", "--orderId", orderId]);
  const order = Array.isArray(data?.list) ? data.list[0] : null;
  if (!order || (order.status !== "FINISHED" && order.status !== "FAILED")) continue;
  const symbol = (value) =>
    typeof value === "string" && value.length > 0 && value.length <= 32 && !/[\u0000-\u001f]/.test(value)
      ? value
      : undefined;
  await report(
    [
      {
        ref,
        at: new Date().toISOString(),
        action: "swap",
        status: order.status === "FINISHED" ? "finished" : "failed",
        ...(symbol(order.fromTokenName) ? { from_symbol: order.fromTokenName } : {}),
        ...(symbol(order.toTokenName) ? { to_symbol: order.toTokenName } : {}),
        ...(/^\d+(\.\d+)?$/.test(order.toTokenQty ?? "") ? { to_qty: order.toTokenQty } : {}),
        ...(/^0x[0-9a-fA-F]{64}$/.test(order.txHash ?? "") ? { tx_hash: order.txHash } : {}),
      },
    ],
    sessionId || null,
  );
  process.exit(0);
}
process.exit(0);
