#!/usr/bin/env node
// Runs detached after a session starts, once the agent's wallet is linked: reads the
// wallet's BNB Chain history from Binance (`baw wallet tx-history`) since the last sync and
// sends it to the cockpit, where each transaction is checked against the chain before it
// counts. Only what moved: hashes, tokens and amounts. One sync runs at a time per folder.
//
//   node sync-history.mjs <sinceIso>

import { api, baw, log, withLock } from "./lib.mjs";

const PAGES = 10;
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
// Control characters, and zero-width or bidirectional ones that can disguise a symbol.
const HIDDEN = [[0x0, 0x1f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]];
const hidden = (value) =>
  [...value].some((char) => HIDDEN.some(([low, high]) => char.codePointAt(0) >= low && char.codePointAt(0) <= high));
const symbolOk = (value) => typeof value === "string" && value.length > 0 && value.length <= 32 && !hidden(value);

/** One leg of Binance's history in the cockpit's words, or null when it cannot be read. */
function legOf(dir, entry) {
  const token = String(entry?.tokenInfo?.contractAddress ?? "").toLowerCase();
  const amount = String(entry?.amount ?? "");
  const decimals = Number(entry?.tokenInfo?.decimals);
  if (!/^0x[0-9a-f]{40}$/.test(token) || !/^\d{1,78}$/.test(amount) || !Number.isInteger(decimals)) return null;
  return {
    dir,
    token: token === NATIVE ? NATIVE : token,
    symbol: symbolOk(entry.tokenInfo.symbol) ? entry.tokenInfo.symbol : null,
    amount,
    decimals,
  };
}

async function sync(since) {
  const txs = [];
  let cursor;
  for (let page = 0; page < PAGES; page += 1) {
    const data = await baw(
      [
        "wallet",
        "tx-history",
        "--binanceChainId",
        "56",
        "--type",
        "confirmed",
        "--size",
        "100",
        "--startTime",
        String(since - 60_000),
        ...(cursor ? ["--nextCursor", cursor] : []),
      ],
      15_000,
    );
    if (!data) break;
    for (const item of data.transactions ?? []) {
      for (const part of item.txHashList ?? [item]) {
        if (String(part.binanceChainId ?? item.binanceChainId) !== "56") continue;
        if (!/^0x[0-9a-fA-F]{64}$/.test(part.txHash ?? "")) continue;
        const legs = [
          ...(part.instructions?.send ?? []).map((entry) => legOf("out", entry)),
          ...(part.instructions?.receive ?? []).map((entry) => legOf("in", entry)),
        ].filter(Boolean);
        const at = Date.parse(item.txTime);
        if (!Number.isFinite(at)) continue;
        txs.push({
          hash: part.txHash.toLowerCase(),
          at: new Date(at).toISOString(),
          kind: /^[\w-]{1,32}$/.test(item.txType ?? "") ? item.txType : null,
          legs: legs.slice(0, 20),
        });
      }
    }
    if (!data.hasMore || !data.nextCursor) break;
    cursor = data.nextCursor;
  }

  for (let i = 0; i < txs.length; i += 50) {
    const sent = await api("POST", "/api/v1/cockpit/wallet/txs", { txs: txs.slice(i, i + 50) }, 10_000);
    if (!sent.ok) {
      log("history_unsent", { status: sent.status, count: txs.length - i });
      break;
    }
  }
}

const since = Date.parse(process.argv[2] ?? "");
if (!Number.isFinite(since)) process.exit(0);

// Never longer than five minutes, whatever a call does.
setTimeout(() => process.exit(0), 5 * 60_000).unref();
await withLock("sync", () => sync(since), { waitMs: 0, staleMs: 10 * 60_000 }).catch((error) => {
  if (!String(error?.message).includes("busy")) log("sync_failed", { error: String(error?.message ?? error) });
});
process.exit(0);
