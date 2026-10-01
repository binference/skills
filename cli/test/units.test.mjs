// Pure pieces: output parsing, the lock, settings merges, input checks, typed data.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import { analyzeShell, bawWrites, classifyMcp } from "../hooks/commands.mjs";
import { newCode, parseJsonOutput } from "../hooks/lib.mjs";
import { decide } from "../hooks/rules.mjs";
import { apiUrl, checkModel, claudeSettings, codexHooks } from "../src/folder.mjs";
import { typedDataProblem } from "../src/link-wallet.mjs";
import { CLI } from "./helpers.mjs";

describe("parseJsonOutput", () => {
  it("finds the last object and never hangs on broken output", () => {
    assert.deepEqual(parseJsonOutput('progress...\n{"success":true}'), { success: true });
    for (const text of ['{"success":true,"data":{', '{"a":1}\nretry in {5}s', "{", "}{", '{"a":'.repeat(20_000)]) {
      // In a child process with a time limit: a hang fails the test instead of stalling it.
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", `import { parseJsonOutput } from "./hooks/lib.mjs"; parseJsonOutput(${JSON.stringify(text)}); console.log("done")`], { cwd: CLI, timeout: 5_000, encoding: "utf8" });
      assert.equal(out.trim(), "done");
    }
  });
});

it("makes four-digit codes", () => {
  for (let i = 0; i < 200; i += 1) assert.match(newCode(), /^[1-9]\d{3}$/);
});

describe("trade detection", () => {
  it("reads wallet calls inside wrappers and scripts, and leaves reads alone", () => {
    const swap = "baw market-order swap --fromTokenQty 1 --fromToken a --toToken b";
    for (const command of [`bash -lc '${swap}'`, `{ ${swap}; }`, "`" + swap + "`", `sudo -u me env A=1 nice -n 5 ${swap}`, `npm exec --package=@binance/agentic-wallet -- ${swap}`]) {
      assert.equal(bawWrites(command)[0]?.write.action, "swap", command);
    }
    for (const command of ["baw wallet status --json", "which baw", "baw --version", "baw market-order quote --fromTokenQty 1", "ls ~/.baw", "baw wallet --help"]) {
      assert.deepEqual(bawWrites(command), [], command);
    }
    assert.equal(analyzeShell(`B=baw; $B market-order swap`).opaque, true);
    assert.equal(bawWrites("baw wallet tx-lock --off")[0].write.unparsed, true);
  });

  it("treats Binance MCP tools as writes unless they clearly read", () => {
    assert.equal(classifyMcp("mcp__binance-mcp-server__withdraw", {}).moves_value, true);
    assert.equal(classifyMcp("mcp__binance-mcp-server__futures_order", {}).action, "exchange_order");
    assert.equal(classifyMcp("mcp__binance-mcp-server__get_open_orders", {}), null);
    assert.equal(classifyMcp("mcp__binance-mcp-server__futures_change_leverage", {}).unparsed, true);
  });

  it("sends unread calls to the person when any limit is set", () => {
    const write = { action: "other", command: "x", moves_value: true, unparsed: true };
    const state = (rules) => ({ rules });
    assert.equal(decide({ state: state({ allowed_tokens: ["0x1"] }), write, usd: null, app: "claude_code" }).decision, "ask");
    assert.equal(decide({ state: state({ max_trade_usd: "5" }), write, usd: null, app: "codex" }).decision, "confirm");
    assert.equal(decide({ state: state({}), write, usd: null, app: "claude_code" }).decision, "allow");
  });
});

describe("folder settings", () => {
  it("merges bInference's settings into Claude Code's without dropping the person's", () => {
    const merged = claudeSettings({
      model: "opus",
      permissions: { allow: ["Bash(ls:*)"], deny: ["Read(./secrets)"] },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] },
    });
    assert.equal(merged.model, "opus");
    assert.deepEqual(merged.permissions.allow, ["Bash(ls:*)"]);
    assert.ok(merged.permissions.deny.includes("Read(./secrets)") && merged.permissions.deny.includes("Edit(./.binference/**)"));
    assert.equal(merged.hooks.Stop.length, 2);
    assert.equal(claudeSettings(merged).hooks.Stop.length, 2, "merging twice adds nothing");
    assert.equal(merged.sandbox, undefined);
    assert.equal(claudeSettings({}, { sandbox: true }).sandbox.allowUnsandboxedCommands, false);
  });

  it("writes only the hooks key for Codex", () => {
    assert.deepEqual(Object.keys(codexHooks({ hooks: {}, description: "x" }, "/f")), ["hooks"]);
  });

  it("accepts https addresses and model ids only", () => {
    assert.equal(apiUrl("https://binference.io/"), "https://binference.io");
    assert.equal(apiUrl("http://localhost:3000"), "http://localhost:3000");
    assert.throws(() => apiUrl("http://binference.io"));
    assert.throws(() => apiUrl("binference.io"));
    assert.equal(checkModel("anthropic/claude-sonnet-5.5"), "anthropic/claude-sonnet-5.5");
    assert.throws(() => checkModel('x"\nweb_search = "live'));
  });
});

describe("wallet link message", () => {
  const address = "0x1111111111111111111111111111111111111111";
  const link = {
    primaryType: "LinkWallet",
    domain: { name: "bInference", version: "1", chainId: 56 },
    message: { statement: "Link this wallet to agent c1", agent: "c1", wallet: address, nonce: "abc" },
  };

  it("accepts a plain link message for this wallet", () => {
    assert.equal(typedDataProblem(link, address), null);
  });

  it("refuses permits, contracts, other wallets and extra fields", () => {
    const permit = {
      primaryType: "PermitSingle",
      domain: { name: "Permit2", chainId: 56, verifyingContract: "0x000000000022d473030f116ddee9f6b43ac78ba3" },
      message: { details: { token: "0x2", amount: "1" }, spender: "0x3", sigDeadline: "1" },
    };
    assert.ok(typedDataProblem(permit, address));
    assert.ok(typedDataProblem({ ...link, domain: { ...link.domain, verifyingContract: "0x4" } }, address));
    assert.ok(typedDataProblem({ ...link, message: { ...link.message, wallet: "0x2222222222222222222222222222222222222222" } }, address));
    assert.ok(typedDataProblem({ ...link, message: { ...link.message, spender: "0x3" } }, address));
  });
});
