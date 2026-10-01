import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decide } from "../hooks/rules.mjs";

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const BNB = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const swap = { action: "swap", from_token: BNB, to_token: USDT };

const state = (rules = {}, extra = {}) => ({
  paused: false,
  stopped: false,
  traded_today_usd: "0",
  rules: {
    max_trade_usd: null,
    day_trade_usd: null,
    confirm_above_usd: null,
    allowed_tokens: null,
    ...rules,
  },
  ...extra,
});

describe("decide", () => {
  it("allows anything with no rules, and a read-like action whatever the rules", () => {
    assert.equal(decide({ state: state(), write: swap, usd: 1e6, app: "claude_code" }).decision, "allow");
    assert.equal(
      decide({ state: state({ max_trade_usd: "1" }), write: { action: "cancel_order" }, usd: null, app: "codex" }).decision,
      "allow",
    );
  });

  it("refuses everything while paused", () => {
    const result = decide({ state: state({}, { paused: true }), write: swap, usd: 1, app: "claude_code" });
    assert.equal(result.decision, "deny");
    assert.equal(result.rule, "paused");
  });

  it("refuses a token outside the list, in either direction", () => {
    const listed = state({ allowed_tokens: [USDT] });
    assert.equal(decide({ state: listed, write: swap, usd: 1, app: "codex" }).rule, "token");
    const both = state({ allowed_tokens: [USDT, BNB.toUpperCase().replace("0X", "0x")] });
    assert.equal(decide({ state: both, write: swap, usd: 1, app: "codex" }).decision, "allow");
  });

  it("refuses over the most per trade and per day, counting what the server has not seen yet", () => {
    const ruled = state({ max_trade_usd: "50", day_trade_usd: "100" }, { traded_today_usd: "60" });
    assert.equal(decide({ state: ruled, write: swap, usd: 51, app: "claude_code" }).rule, "max_trade");
    assert.equal(decide({ state: ruled, write: swap, usd: 30, app: "claude_code" }).decision, "allow");
    assert.equal(
      decide({ state: ruled, write: swap, usd: 30, extraToday: 20, app: "claude_code" }).rule,
      "day_trade",
    );
  });

  it("asks in Claude Code and wants a typed code in Codex above the confirm line", () => {
    const ruled = state({ confirm_above_usd: "20" });
    assert.equal(decide({ state: ruled, write: swap, usd: 25, app: "claude_code" }).decision, "ask");
    assert.equal(decide({ state: ruled, write: swap, usd: 25, app: "codex" }).decision, "confirm");
    assert.equal(
      decide({ state: ruled, write: swap, usd: 25, app: "codex", confirmed: true }).decision,
      "allow",
    );
    assert.equal(decide({ state: ruled, write: swap, usd: 15, app: "codex" }).decision, "allow");
  });

  it("sends an action it cannot value to the person when any dollar rule is set", () => {
    const ruled = state({ max_trade_usd: "50" });
    assert.equal(decide({ state: ruled, write: { action: "contract_call" }, usd: null, app: "claude_code" }).decision, "ask");
    assert.equal(decide({ state: state(), write: { action: "contract_call" }, usd: null, app: "claude_code" }).decision, "allow");
  });

  it("still refuses over the limit after a confirmation: confirming never lifts a limit", () => {
    const ruled = state({ max_trade_usd: "50", confirm_above_usd: "20" });
    assert.equal(decide({ state: ruled, write: swap, usd: 80, app: "codex", confirmed: true }).rule, "max_trade");
  });
});
