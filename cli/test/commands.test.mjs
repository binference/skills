import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bawCalls,
  bawWrites,
  classifyMcp,
  exchangeDollars,
  isStablecoin,
  NATIVE,
  shellCommands,
} from "../hooks/commands.mjs";

const USDT = "0x55d398326f99059fF775485246999027B3197955";
const BNB = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

describe("shellCommands", () => {
  it("splits on the separators agents write and keeps quoted words whole", () => {
    assert.deepEqual(
      shellCommands(`cd "my dir" && baw wallet status --json; echo 'a && b' | cat`),
      [["cd", "my dir"], ["baw", "wallet", "status", "--json"], ["echo", "a && b"], ["cat"]],
    );
    assert.deepEqual(shellCommands("baw \\\n  wallet status"), [["baw", "wallet", "status"]]);
  });
});

describe("baw commands", () => {
  it("reads a swap with its tokens, amount and chain", () => {
    const [write] = bawWrites(
      `baw market-order swap --fromTokenQty 0.1 --fromToken ${BNB} --toToken ${USDT} --binanceChainId 56 --json`,
    );
    assert.equal(write.write.action, "swap");
    assert.equal(write.write.from_token, NATIVE);
    assert.equal(write.write.to_token, USDT.toLowerCase());
    assert.equal(write.write.from_qty, "0.1");
    assert.equal(write.write.chain, "56");
  });

  it("finds baw however it is run: a path, npx, env assignments, chained", () => {
    for (const command of [
      `/usr/local/bin/baw market-order swap --fromTokenQty 1 --fromToken ${USDT} --toToken ${BNB} --binanceChainId 56`,
      `npx -y @binance/agentic-wallet@1.10.0 market-order swap --fromTokenQty 1 --fromToken ${USDT} --toToken ${BNB} --binanceChainId 56`,
      `FOO=1 baw market-order swap --fromTokenQty=1 --fromToken=${USDT} --toToken=${BNB} --binanceChainId=56`,
      `cd x && baw wallet status --json && baw market-order swap --fromTokenQty 1 --fromToken ${USDT} --toToken ${BNB} --binanceChainId 56`,
    ]) {
      const writes = bawWrites(command);
      assert.equal(writes.length, 1, command);
      assert.equal(writes[0].write.from_qty, "1", command);
    }
  });

  it("leaves reads alone", () => {
    assert.deepEqual(bawWrites("baw wallet balance --json && baw market-order quote --fromTokenQty 1 --fromToken x --toToken y --binanceChainId 56"), []);
    assert.equal(bawCalls("echo hello").length, 0);
  });

  it("reads limit orders, sends, DeFi and the two-step writes", () => {
    const limit = bawWrites(
      `baw limit-order sell --triggerPrice 100 --fromTokenQty 10.1 --fromToken ${BNB} --toToken ${USDT} --binanceChainId 56 --json`,
    )[0].write;
    assert.deepEqual(limit.detail, { side: "SELL", type: "LIMIT", price: "100" });
    const send = bawWrites(
      `baw wallet send --max --recipient 0x1234 --binanceChainId 56 --tokenAddress ${USDT} --json`,
    )[0].write;
    assert.equal(send.action, "send");
    assert.equal(send.from_qty, null);
    assert.equal(
      bawWrites("baw defi deposit --investmentId 0e82 --tokenAddress 0x55d398326f99059fF775485246999027B3197955 --amount 1.5 --json")[0]
        .write.detail.type,
      "DEPOSIT",
    );
    assert.equal(bawWrites("baw contract-call execute --requestId abc --json")[0].write.action, "contract_call");
    assert.equal(bawWrites("baw contract-call preview --binanceChainId 56 --from a --to b --json").length, 0);
    assert.equal(bawWrites("baw x402-payment sign --paymentId p1 --selectedIndex 1 --json")[0].write.order_id, "p1");
    assert.equal(
      bawWrites("baw prediction trade place-order --quoteId q1 --slippageBps 1000 --json")[0].write.action,
      "prediction",
    );
  });

  it("knows the dollar stablecoins per chain", () => {
    assert.equal(isStablecoin("56", USDT), true);
    assert.equal(isStablecoin("56", BNB), false);
    assert.equal(isStablecoin("CT_501", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), true);
  });
});

describe("Binance MCP Server tools", () => {
  it("tells orders, cancels and transfers from reads", () => {
    assert.equal(classifyMcp("mcp__binance-mcp-server__get_ticker_price", { symbol: "BTCUSDT" }), null);
    assert.equal(classifyMcp("mcp__binance-mcp-server__spot_account_balance", {}), null);
    const order = classifyMcp("mcp__binance-mcp-server__spot_new_order", {
      symbol: "bnbusdt",
      side: "BUY",
      type: "MARKET",
      quoteOrderQty: "100",
    });
    assert.equal(order.action, "exchange_order");
    assert.equal(order.quote, 100);
    assert.deepEqual(order.detail, { tool: "spot_new_order", pair: "BNBUSDT", side: "BUY", type: "MARKET" });
    assert.equal(classifyMcp("mcp__binance-mcp-server__cancel_order", { symbol: "BNBUSDT" }).action, "exchange_cancel");
    assert.equal(classifyMcp("mcp__binance-mcp-server__wallet_transfer", {}).action, "exchange_transfer");
    assert.equal(classifyMcp("mcp__other__place_order", {}), null);
  });

  it("values an exchange order only when it says its dollars", () => {
    assert.equal(exchangeDollars("BNBUSDT", { quantity: "2", price: "600" }), 1200);
    assert.equal(exchangeDollars("BNBUSDT", { quantity: "2" }), null);
    assert.equal(exchangeDollars("BNBBTC", { quoteOrderQty: "1" }), null);
  });
});
