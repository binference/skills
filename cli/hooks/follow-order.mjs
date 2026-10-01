#!/usr/bin/env node
// Runs detached after a swap: polls `baw market-order list --orderId` until the order is
// FINISHED or FAILED, waiting longer between tries (about three minutes in all), and
// reports the end with its transaction.
//
//   node follow-order.mjs <ref> <orderId> <sessionId>

import { baw, flushOutbox, queueReports } from "./lib.mjs";

const [ref, orderId, sessionId] = process.argv.slice(2);
if (!ref || !orderId) process.exit(0);

// Never outlives its job, whatever a call does.
setTimeout(() => process.exit(0), 4 * 60_000).unref();

const WAITS_MS = [2_000, 3_000, 5_000, 8_000, 13_000, 20_000, 30_000, 30_000, 30_000, 30_000];
const symbol = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 32 && !/\p{Cc}/u.test(value)
    ? value
    : undefined;

for (const wait of WAITS_MS) {
  await new Promise((resume) => setTimeout(resume, wait));
  const data = await baw(["market-order", "list", "--orderId", orderId]);
  const order = Array.isArray(data?.list) ? data.list[0] : null;
  if (!order || (order.status !== "FINISHED" && order.status !== "FAILED")) continue;
  await queueReports(
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
  await flushOutbox().catch(() => {});
  break;
}
process.exit(0);
