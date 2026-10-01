// The Agentic Wallet as a session start reads it, and an action's dollar value. Mapping
// Binance's own output into the cockpit's contract happens here, so a change in `baw`'s
// output changes this file and nothing on binference.io.

import { isStablecoin, QUOTE_TOKEN } from "./commands.mjs";
import { baw, bawVersion } from "./lib.mjs";

const usd = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(number) : null;
};
const iso = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(typeof value === "number" && value < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const bool = (value) => (typeof value === "boolean" ? value : null);

/** `baw wallet settings` in the cockpit's words. */
export function mapSettings(data) {
  if (!data || typeof data !== "object") return null;
  return {
    daily_limit_usd: usd(data.dailyLimit),
    daily_used_usd: usd(data.quotaUsed),
    defi_daily_limit_usd: usd(data.defiDailyLimit),
    prediction_daily_limit_usd: usd(data.predictionDailyLimit),
    x402_daily_limit_usd: usd(data.x402DailyLimit),
    dev_mode_daily_limit_usd: usd(data.devMode?.dailyLimit),
    abnormal_txn_handling:
      data.abnormalTxnHandling === "AutoReject" || data.abnormalTxnHandling === "NeedConfirmation"
        ? data.abnormalTxnHandling
        : null,
    trade_all_tokens: bool(data.tradeAllTokens),
    prediction_enabled: bool(data.predictionEnabled),
    dev_mode_enabled: bool(data.devMode?.enabled),
    session_expires_at: iso(data.sessionExpireTime),
    inactive_sign_out_at: iso(data.inactiveSignOutTime),
  };
}

/** The wallet's BNB Chain address from `baw wallet address`. */
export function evmAddress(data) {
  const list = Array.isArray(data?.addresses) ? data.addresses : [];
  const found =
    list.find((entry) => entry?.binanceChainId === "56") ??
    list.find((entry) => /^0x[0-9a-fA-F]{40}$/.test(entry?.address ?? ""));
  return /^0x[0-9a-fA-F]{40}$/.test(found?.address ?? "") ? found.address.toLowerCase() : null;
}

/** The wallet as the cockpit takes it, read in about a second, or less when signed out. */
export async function readWallet() {
  const version = await bawVersion();
  if (!version) return { status: "not_installed", address: null, baw_version: null, settings: null };
  const status = await baw(["wallet", "status"]);
  if (status?.status !== "CONNECTED") {
    return {
      status: status ? "signed_out" : "unknown",
      address: null,
      baw_version: version,
      settings: null,
    };
  }
  const [settings, address] = await Promise.all([
    baw(["wallet", "settings"]),
    baw(["wallet", "address"]),
  ]);
  return {
    status: "connected",
    address: evmAddress(address),
    baw_version: version,
    settings: mapSettings(settings),
  };
}

/**
 * What an action is worth in dollars: its own amount in a stablecoin, an exchange order's
 * quote, or `baw market-order quote` into the chain's USDT (about a second). Null when it
 * cannot be told.
 */
export async function valueOf(write) {
  if (write.action === "exchange_order") return write.quote ?? null;
  if (!write.from_token || !write.from_qty) return null;
  const chain = write.chain ?? "56";
  if (isStablecoin(chain, write.from_token)) return Number(write.from_qty);
  const quoteToken = QUOTE_TOKEN[chain];
  if (!quoteToken) return null;
  const quote = await baw(
    [
      "market-order",
      "quote",
      "--fromTokenQty",
      write.from_qty,
      "--fromToken",
      write.from_token,
      "--toToken",
      quoteToken,
      "--binanceChainId",
      String(chain),
    ],
    8_000,
  );
  const dollars = Number(quote?.toCoinAmount);
  return Number.isFinite(dollars) ? dollars : null;
}
